// Crafting / smelting / stonecutting / smithing recipe matching from vanilla recipe JSON.
import type { DataBundle } from '../assets';
import { ItemRegistry, type Item } from './registry';
import { ItemStack } from './stack';

type IngredientSpec = string | string[] | { item?: string; tag?: string } | { item?: string; tag?: string }[];

export interface CraftingRecipe {
  id: string; type: 'shaped' | 'shapeless';
  width: number; height: number;
  pattern: (Set<string> | null)[]; // for shaped: width*height; for shapeless: list of ingredient sets
  result: { item: Item; count: number };
  group?: string;
  category?: string;
  transmute?: { input: Set<string>; material: Set<string> };
}
export interface CookingRecipe { id: string; type: 'smelting' | 'blasting' | 'smoking' | 'campfire_cooking'; ingredient: Set<string>; result: Item; experience: number; time: number }
export interface StonecuttingRecipe { id: string; ingredient: Set<string>; result: Item; count: number }
export interface SmithingRecipe { id: string; template: Set<string>; base: Set<string>; addition: Set<string>; result: Item | null; trim: boolean }

export class RecipeManager {
  crafting: CraftingRecipe[] = [];
  cooking: CookingRecipe[] = [];
  stonecutting: StonecuttingRecipe[] = [];
  smithing: SmithingRecipe[] = [];
  private byIngredient = new Map<string, CraftingRecipe[]>();
  private byResult = new Map<string, CraftingRecipe[]>();

  constructor(private items: ItemRegistry, data: DataBundle) {
    for (const [id, r] of Object.entries(data.recipes)) {
      try { this.load(id, r); } catch (e) { /* skip malformed */ }
    }
    for (const r of this.crafting) {
      const names = new Set<string>();
      for (const p of r.pattern) if (p) for (const n of p) names.add(n);
      for (const n of names) { let l = this.byIngredient.get(n); if (!l) this.byIngredient.set(n, l = []); l.push(r); }
      let lr = this.byResult.get(r.result.item.name); if (!lr) this.byResult.set(r.result.item.name, lr = []); lr.push(r);
    }
  }

  private ingredient(spec: IngredientSpec | undefined): Set<string> | null {
    if (spec === undefined || spec === null) return null;
    const out = new Set<string>();
    const add = (s: any) => {
      if (typeof s === 'string') {
        if (s.startsWith('#')) for (const n of this.items.tag(s.slice(1).replace('minecraft:', ''))) out.add(n);
        else out.add(s.replace('minecraft:', ''));
      } else if (Array.isArray(s)) s.forEach(add);
      else if (s && typeof s === 'object') { if (s.item) add(s.item); if (s.tag) add('#' + s.tag); }
    };
    add(spec);
    return out.size ? out : null;
  }

  private load(id: string, r: any): void {
    const type = String(r.type).replace('minecraft:', '');
    const resultItem = (res: any): Item | undefined => { const n = typeof res === 'string' ? res : res?.id ?? res?.item; return n ? this.items.get(n) : undefined; };
    if (type === 'crafting_shaped') {
      const pattern: string[] = r.pattern;
      const h = pattern.length, w = Math.max(...pattern.map((p: string) => p.length));
      const cells: (Set<string> | null)[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ch = pattern[y][x] ?? ' ';
        cells.push(ch === ' ' ? null : this.ingredient(r.key[ch]));
      }
      const item = resultItem(r.result);
      if (!item) return;
      this.crafting.push({ id, type: 'shaped', width: w, height: h, pattern: cells, result: { item, count: r.result.count ?? 1 }, group: r.group, category: r.category });
    } else if (type === 'crafting_shapeless') {
      const cells = (r.ingredients as any[]).map((i) => this.ingredient(i));
      if (cells.some((c) => !c)) return;
      const item = resultItem(r.result);
      if (!item) return;
      this.crafting.push({ id, type: 'shapeless', width: 0, height: 0, pattern: cells, result: { item, count: r.result.count ?? 1 }, group: r.group, category: r.category });
    } else if (type === 'crafting_transmute') {
      const input = this.ingredient(r.input), material = this.ingredient(r.material);
      const item = resultItem(r.result);
      if (!input || !material || !item) return;
      this.crafting.push({ id, type: 'shapeless', width: 0, height: 0, pattern: [input, material], result: { item, count: 1 }, group: r.group, transmute: { input, material } });
    } else if (type === 'smelting' || type === 'blasting' || type === 'smoking' || type === 'campfire_cooking') {
      const ing = this.ingredient(r.ingredient); const item = resultItem(r.result);
      if (!ing || !item) return;
      this.cooking.push({ id, type, ingredient: ing, result: item, experience: r.experience ?? 0, time: r.cookingtime ?? (type === 'smelting' ? 200 : type === 'campfire_cooking' ? 600 : 100) });
    } else if (type === 'stonecutting') {
      const ing = this.ingredient(r.ingredient); const item = resultItem(r.result);
      if (!ing || !item) return;
      this.stonecutting.push({ id, ingredient: ing, result: item, count: r.result?.count ?? r.count ?? 1 });
    } else if (type === 'smithing_transform' || type === 'smithing_trim') {
      const template = this.ingredient(r.template) ?? new Set<string>(), base = this.ingredient(r.base) ?? new Set<string>(), addition = this.ingredient(r.addition) ?? new Set<string>();
      this.smithing.push({ id, template, base, addition, result: type === 'smithing_transform' ? (resultItem(r.result) ?? null) : null, trim: type === 'smithing_trim' });
    }
  }

  /** Find matching crafting recipe for a w x h grid. */
  match(grid: (ItemStack | null)[], w: number, h: number): CraftingRecipe | null {
    const present = grid.filter((s): s is ItemStack => !!s && s.count > 0);
    if (present.length === 0) return null;
    // candidate recipes: those containing the first present item
    const cands = this.byIngredient.get(present[0].item.name);
    if (!cands) return this.matchSpecial(grid, w, h);
    for (const r of cands) {
      if (r.type === 'shapeless') { if (this.matchShapeless(r, present)) return r; }
      else if (this.matchShaped(r, grid, w, h)) return r;
    }
    return this.matchSpecial(grid, w, h);
  }

  private matchShapeless(r: CraftingRecipe, present: ItemStack[]): boolean {
    if (present.length !== r.pattern.length) return false;
    const used = new Array(present.length).fill(false);
    for (const ing of r.pattern) {
      let found = false;
      for (let i = 0; i < present.length; i++) if (!used[i] && ing!.has(present[i].item.name)) { used[i] = true; found = true; break; }
      if (!found) return false;
    }
    return true;
  }

  private matchShaped(r: CraftingRecipe, grid: (ItemStack | null)[], w: number, h: number): boolean {
    if (r.width > w || r.height > h) return false;
    for (let oy = 0; oy <= h - r.height; oy++) for (let ox = 0; ox <= w - r.width; ox++) {
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < h && ok; y++) for (let x = 0; x < w; x++) {
          const s = grid[y * w + x];
          const px = mirror ? r.width - 1 - (x - ox) : x - ox, py = y - oy;
          const inside = px >= 0 && px < r.width && py >= 0 && py < r.height;
          const ing = inside ? r.pattern[py * r.width + px] : null;
          if (!ing) { if (s && s.count > 0) { ok = false; break; } }
          else if (!s || !ing.has(s.item.name)) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }

  /** Special recipes: item repair (two damaged tools), armor dyeing (leather), firework... */
  private matchSpecial(grid: (ItemStack | null)[], w: number, h: number): CraftingRecipe | null {
    const present = grid.filter((s): s is ItemStack => !!s && s.count > 0);
    if (present.length === 2 && present[0].item === present[1].item && present[0].isDamageable) {
      const it = present[0].item;
      return { id: 'repair', type: 'shapeless', width: 0, height: 0, pattern: [new Set([it.name]), new Set([it.name])], result: { item: it, count: 1 } };
    }
    return null;
  }

  /** Compute the crafting result stack (handles repair). */
  craftResult(r: CraftingRecipe, grid: (ItemStack | null)[]): ItemStack {
    if (r.id === 'repair') {
      const present = grid.filter((s): s is ItemStack => !!s && s.count > 0);
      const max = r.result.item.maxDurability;
      const dur1 = max - present[0].damage, dur2 = max - present[1].damage;
      const dur = Math.min(max, dur1 + dur2 + Math.floor(max * 0.05));
      return new ItemStack(r.result.item, 1, max - dur);
    }
    if (r.transmute) {
      const present = grid.filter((s): s is ItemStack => !!s && s.count > 0);
      const src = present.find((s) => r.transmute!.input.has(s.item.name));
      const out = new ItemStack(r.result.item, 1);
      if (src) { out.extra = { ...src.extra }; out.customName = src.customName; }
      return out;
    }
    return new ItemStack(r.result.item, r.result.count);
  }

  /** Remaining items left in the grid after crafting (buckets, bottles, bowls). */
  remainder(stack: ItemStack): ItemStack | null {
    const n = stack.item.name;
    if (n === 'milk_bucket' || n === 'water_bucket' || n === 'lava_bucket' || n === 'powder_snow_bucket') return new ItemStack(this.items.get('bucket')!, 1);
    if (n === 'honey_bottle' || n === 'dragon_breath') return new ItemStack(this.items.get('glass_bottle')!, 1);
    if (n === 'mushroom_stew' || n === 'rabbit_stew' || n === 'beetroot_soup' || n === 'suspicious_stew') return null;
    return null;
  }

  recipesFor(itemName: string): CraftingRecipe[] { return this.byResult.get(itemName) ?? []; }

  cookingFor(stack: ItemStack, kind: 'smelting' | 'blasting' | 'smoking' | 'campfire_cooking'): CookingRecipe | null {
    for (const r of this.cooking) if (r.type === kind && r.ingredient.has(stack.item.name)) return r;
    return null;
  }

  stonecuttingFor(stack: ItemStack): StonecuttingRecipe[] { return this.stonecutting.filter((r) => r.ingredient.has(stack.item.name)); }

  smithingFor(template: ItemStack | null, base: ItemStack | null, addition: ItemStack | null): SmithingRecipe | null {
    if (!base) return null;
    for (const r of this.smithing) {
      const tOk = r.template.size === 0 ? !template : template && r.template.has(template.item.name);
      const aOk = r.addition.size === 0 ? !addition : addition && r.addition.has(addition.item.name);
      if (tOk && aOk && r.base.has(base.item.name)) return r;
    }
    return null;
  }
}
