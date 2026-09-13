// Vanilla loot table evaluation (subset sufficient for block + entity drops).
import type { DataBundle } from '../assets';
import type { BlockRegistry } from '../blocks/registry';
import type { ItemRegistry } from './registry';
import { ItemStack } from './stack';

export interface LootContext {
  tool?: ItemStack | null;
  blockState?: number;
  explosion?: boolean;
  killedByPlayer?: boolean;
  lootingLevel?: number;
  onFire?: boolean;
  luck?: number;
  entityProps?: Record<string, any>; // e.g. sheep colour
  rnd?: () => number;
}

export class LootTables {
  constructor(private items: ItemRegistry, private blocks: BlockRegistry, private data: DataBundle) {}

  /** Drops for breaking a block state. */
  blockDrops(state: number, ctx: LootContext = {}): ItemStack[] {
    const b = this.blocks.block(state);
    if (!b) return [];
    const table = this.data.lootTables['blocks/' + b.name];
    if (!table) return [];
    return this.evaluate(table, { ...ctx, blockState: state });
  }

  entityDrops(entityName: string, ctx: LootContext = {}): ItemStack[] {
    const table = this.data.lootTables['entities/' + entityName];
    if (!table) return [];
    return this.evaluate(table, ctx);
  }

  evaluate(table: any, ctx: LootContext): ItemStack[] {
    const out: ItemStack[] = [];
    const rnd = ctx.rnd ?? Math.random;
    if (!table || !table.pools) return out;
    for (const pool of table.pools) {
      if (!this.conditions(pool.conditions, ctx, rnd)) continue;
      const rolls = this.number(pool.rolls, ctx, rnd) + Math.floor(this.number(pool.bonus_rolls, ctx, rnd) * (ctx.luck ?? 0));
      for (let i = 0; i < rolls; i++) {
        const entries = (pool.entries ?? []).filter((e: any) => this.conditions(e.conditions, ctx, rnd));
        if (!entries.length) continue;
        let total = 0;
        for (const e of entries) total += (e.weight ?? 1) + (e.quality ?? 0) * (ctx.luck ?? 0);
        let r = rnd() * total;
        let chosen = entries[entries.length - 1];
        for (const e of entries) { r -= (e.weight ?? 1) + (e.quality ?? 0) * (ctx.luck ?? 0); if (r < 0) { chosen = e; break; } }
        this.entry(chosen, ctx, rnd, out, table.functions);
      }
    }
    if (table.functions) for (const s of out) this.applyFunctions(s, table.functions, ctx, rnd);
    return out.filter((s) => s.count > 0);
  }

  private entry(e: any, ctx: LootContext, rnd: () => number, out: ItemStack[], _tableFns?: any[]): boolean {
    const type = String(e.type).replace('minecraft:', '');
    if (!this.conditions(e.conditions, ctx, rnd)) return false;
    switch (type) {
      case 'item': {
        const it = this.items.get(e.name);
        if (!it) return true;
        const s = new ItemStack(it, 1);
        this.applyFunctions(s, e.functions, ctx, rnd);
        if (s.count > 0) out.push(s);
        return true;
      }
      case 'alternatives':
        for (const c of e.children ?? []) if (this.entry(c, ctx, rnd, out)) return true;
        return false;
      case 'group': { let any = false; for (const c of e.children ?? []) any = this.entry(c, ctx, rnd, out) || any; return any; }
      case 'sequence': { for (const c of e.children ?? []) if (!this.entry(c, ctx, rnd, out)) break; return true; }
      case 'loot_table': {
        const ref = typeof e.value === 'string' ? e.value : e.name;
        const t = ref ? this.data.lootTables[String(ref).replace('minecraft:', '')] : e.value;
        if (t) out.push(...this.evaluate(t, ctx));
        return true;
      }
      case 'tag': {
        const names = [...this.items.tag(String(e.name).replace('minecraft:', ''))];
        if (e.expand) { const n = names[Math.floor(rnd() * names.length)]; const it = n && this.items.get(n); if (it) { const s = new ItemStack(it, 1); this.applyFunctions(s, e.functions, ctx, rnd); out.push(s); } }
        else for (const n of names) { const it = this.items.get(n); if (it) { const s = new ItemStack(it, 1); this.applyFunctions(s, e.functions, ctx, rnd); out.push(s); } }
        return true;
      }
      case 'empty': return true;
      case 'dynamic': return true; // contents (shulker boxes) handled by block entity code
    }
    return true;
  }

  private number(n: any, ctx: LootContext, rnd: () => number): number {
    if (n === undefined || n === null) return 0;
    if (typeof n === 'number') return n;
    const type = String(n.type ?? 'uniform').replace('minecraft:', '');
    if (type === 'uniform') { const min = this.number(n.min, ctx, rnd), max = this.number(n.max, ctx, rnd); return Number.isInteger(min) && Number.isInteger(max) ? min + Math.floor(rnd() * (max - min + 1)) : min + rnd() * (max - min); }
    if (type === 'constant') return n.value ?? 0;
    if (type === 'binomial') { const nn = this.number(n.n, ctx, rnd), p = this.number(n.p, ctx, rnd); let c = 0; for (let i = 0; i < nn; i++) if (rnd() < p) c++; return c; }
    if (type === 'enchantment_level' || type === 'score') return 0;
    return n.value ?? 0;
  }

  private conditions(conds: any[] | undefined, ctx: LootContext, rnd: () => number): boolean {
    if (!conds) return true;
    for (const c of conds) if (!this.condition(c, ctx, rnd)) return false;
    return true;
  }

  private condition(c: any, ctx: LootContext, rnd: () => number): boolean {
    const type = String(c.condition).replace('minecraft:', '');
    switch (type) {
      case 'survives_explosion': return !ctx.explosion || rnd() < 1;
      case 'match_tool': return this.matchTool(c.predicate, ctx.tool ?? null);
      case 'block_state_property': {
        if (ctx.blockState === undefined) return false;
        const props = this.blocks.getProps(ctx.blockState);
        for (const [k, v] of Object.entries(c.properties ?? {})) {
          if (typeof v === 'object' && v !== null) { const val = +props[k]; if ((v as any).min !== undefined && val < (v as any).min) return false; if ((v as any).max !== undefined && val > (v as any).max) return false; }
          else if (props[k] !== String(v)) return false;
        }
        return true;
      }
      case 'table_bonus': { const lvl = ctx.tool?.enchantLevel(String(c.enchantment).replace('minecraft:', '')) ?? 0; const ch = c.chances[Math.min(lvl, c.chances.length - 1)]; return rnd() < ch; }
      case 'random_chance': return rnd() < this.number(c.chance, ctx, rnd);
      case 'random_chance_with_enchanted_bonus': { const lvl = ctx.lootingLevel ?? 0; const ch = typeof c.enchanted_chance === 'number' ? c.enchanted_chance : (c.unenchanted_chance ?? 0) + lvl * (c.enchanted_chance?.per_level_above_first ?? 0.01); return rnd() < (lvl > 0 ? ch : (c.unenchanted_chance ?? 0)); }
      case 'killed_by_player': return !!ctx.killedByPlayer;
      case 'inverted': return !this.condition(c.term, ctx, rnd);
      case 'any_of': return (c.terms ?? []).some((t: any) => this.condition(t, ctx, rnd));
      case 'all_of': return (c.terms ?? []).every((t: any) => this.condition(t, ctx, rnd));
      case 'entity_properties': {
        const p = c.predicate ?? {};
        if (p.flags?.is_on_fire !== undefined && !!ctx.onFire !== p.flags.is_on_fire) return false;
        if (p.type_specific) { // sheep colour etc
          const ts = p.type_specific; const col = ts.color ?? ts.variant;
          if (col !== undefined && ctx.entityProps?.color !== undefined && String(col).replace('minecraft:', '') !== ctx.entityProps.color) return false;
          if (ts.is_sheared !== undefined && !!ctx.entityProps?.sheared !== ts.is_sheared) return false;
        }
        if (p.components || p.predicates) { if (p.predicates?.['minecraft:sheep'] && ctx.entityProps?.sheared !== undefined) { const sh = p.predicates['minecraft:sheep'].sheared; if (sh !== undefined && !!ctx.entityProps.sheared !== sh) return false; } }
        if (c.entity === 'this' && p['minecraft:vehicle']) return false;
        return true;
      }
      case 'location_check': return true;
      case 'damage_source_properties': return true;
      case 'weather_check': return false;
      case 'time_check': return true;
      case 'value_check': return true;
      case 'enchantment_active_check': return false;
      default: return true;
    }
  }

  private matchTool(pred: any, tool: ItemStack | null): boolean {
    if (!pred) return true;
    if (pred.items) {
      const names = Array.isArray(pred.items) ? pred.items : [pred.items];
      const ok = names.some((n: string) => { n = n.replace('minecraft:', ''); if (n.startsWith('#')) return tool && this.items.inTag(tool.item.name, n.slice(1)); return tool && tool.item.name === n; });
      if (!ok) return false;
    }
    const ench = pred.predicates?.['minecraft:enchantments'] ?? pred.enchantments;
    if (ench) {
      for (const e of ench) {
        const names = Array.isArray(e.enchantments) ? e.enchantments : [e.enchantments ?? e.enchantment];
        const lvl = tool ? Math.max(...names.map((n: string) => tool.enchantLevel(String(n).replace('minecraft:', '')))) : 0;
        const min = e.levels?.min ?? 1, max = e.levels?.max ?? 999;
        if (lvl < min || lvl > max) return false;
      }
    }
    return true;
  }

  private applyFunctions(s: ItemStack, fns: any[] | undefined, ctx: LootContext, rnd: () => number): void {
    if (!fns) return;
    for (const f of fns) {
      if (!this.conditions(f.conditions, ctx, rnd)) continue;
      const type = String(f.function).replace('minecraft:', '');
      switch (type) {
        case 'set_count': { const n = this.number(f.count, ctx, rnd); s.count = f.add ? s.count + n : n; break; }
        case 'apply_bonus': {
          const lvl = ctx.tool?.enchantLevel(String(f.enchantment).replace('minecraft:', '')) ?? 0;
          const formula = String(f.formula).replace('minecraft:', '');
          if (lvl > 0) {
            if (formula === 'ore_drops') { const m = Math.floor(rnd() * (lvl + 2)) - 1; if (m > 0) s.count *= m + 1; }
            else if (formula === 'uniform_bonus_count') s.count += Math.floor(rnd() * (lvl * (f.parameters?.bonusMultiplier ?? 1) + 1));
            else if (formula === 'binomial_with_bonus_count') { const n = lvl + (f.parameters?.extra ?? 0), p = f.parameters?.probability ?? 0.5; let c = 0; for (let i = 0; i < n; i++) if (rnd() < p) c++; s.count += c; }
          }
          break;
        }
        case 'enchanted_count_increase': { const lvl = ctx.lootingLevel ?? 0; if (lvl > 0) { s.count += Math.floor(this.number(f.count, ctx, rnd) * lvl); if (f.limit && s.count > f.limit) s.count = f.limit; } break; }
        case 'looting_enchant': { const lvl = ctx.lootingLevel ?? 0; if (lvl > 0) s.count += Math.floor(this.number(f.count, ctx, rnd) * lvl); break; }
        case 'limit_count': { const min = this.number(f.limit?.min, ctx, rnd), max = f.limit?.max !== undefined ? this.number(f.limit.max, ctx, rnd) : 999; s.count = Math.max(min, Math.min(max, s.count)); break; }
        case 'furnace_smelt': { if (ctx.onFire) { const cooked = COOK_MAP[s.item.name]; const it = cooked && this.items.get(cooked); if (it) s.item = it; } break; }
        case 'explosion_decay': { if (ctx.explosion) { let c = 0; for (let i = 0; i < s.count; i++) if (rnd() < 1 / (ctx.explosion ? 3 : 1)) c++; s.count = c; } break; }
        case 'set_damage': { if (s.isDamageable) { const d = this.number(f.damage, ctx, rnd); s.damage = Math.floor((1 - d) * s.maxDurability); } break; }
        case 'set_potion': case 'set_nbt': case 'set_components': case 'copy_components': case 'copy_state': case 'copy_name': case 'set_name': case 'set_lore': case 'set_enchantments': case 'enchant_randomly': case 'enchant_with_levels': case 'set_ominous_bottle_amplifier': case 'exploration_map': case 'set_stew_effect': case 'set_instrument': case 'set_book_cover': case 'set_written_book_pages': case 'set_writable_book_pages': case 'set_custom_data': case 'set_custom_model_data': case 'set_item': case 'set_attributes': case 'fill_player_head': case 'set_banner_pattern': case 'set_contents': case 'set_loot_table': case 'sequence': case 'reference': case 'modify_contents': case 'filtered': case 'toggle_tooltips': case 'set_fireworks': case 'set_firework_explosion':
          break;
      }
    }
  }
}

const COOK_MAP: Record<string, string> = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato' };
