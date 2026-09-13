// Container screens with vanilla slot interaction (click, shift-click, drag, number keys, drop).
import { Screen, TextField } from './widgets';
import { Inventory, ItemStack } from '../../items/stack';
import type { BlockEntity } from '../blockEntities';
import type { CraftingRecipe } from '../../items/recipes';
import { potionColor } from '../blockEntities';

export interface Slot {
  inv: Inventory; index: number; x: number; y: number;
  accepts?: (s: ItemStack) => boolean;
  output?: boolean;         // take-only (crafting result)
  onTake?: (s: ItemStack, all: boolean) => void;
  bg?: string;              // empty-slot sprite
  max?: number;
  craftAll?: boolean;       // shift-click crafts repeatedly (all handled by onTake)
}

export abstract class ContainerScreenBase extends Screen {
  isInventoryLike = true;
  pausesGame = false;
  slots: Slot[] = [];
  carried: ItemStack | null = null;
  bgW = 176; bgH = 166;
  left = 0; top = 0;
  texture = 'gui/container/inventory';
  title = '';
  private dragSlots: Slot[] = []; private dragButton = -1; private dragging = false;
  private lastClickTime = 0; private lastClickSlot: Slot | null = null;
  quickCraftable = true;
  onCloseCb: (() => void) | null = null;

  get player() { return this.gui.game.player; }

  build(): void {
    this.left = Math.floor((this.width - this.bgW) / 2); this.top = Math.floor((this.height - this.bgH) / 2);
    this.slots = [];
    this.buildSlots();
  }
  abstract buildSlots(): void;

  /** Standard player inventory + hotbar slots at (8, y). */
  addPlayerSlots(y: number): void {
    const p = this.player;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) this.slots.push({ inv: p.inventory, index: 9 + r * 9 + c, x: 8 + c * 18, y: y + r * 18 });
    for (let c = 0; c < 9; c++) this.slots.push({ inv: p.inventory, index: c, x: 8 + c * 18, y: y + 58 });
  }

  slotAt(mx: number, my: number): Slot | null {
    const x = mx - this.left, y = my - this.top;
    for (const s of this.slots) if (x >= s.x && x < s.x + 16 && y >= s.y && y < s.y + 16) return s;
    return null;
  }

  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const gui = this.gui;
    this.drawBg(ctx, mx, my, partial);
    ctx.save(); ctx.translate(this.left, this.top);
    this.drawForeground(ctx, mx - this.left, my - this.top);
    const hov = this.slotAt(mx, my);
    for (const s of this.slots) {
      const st = s.inv.get(s.index);
      if (!st && s.bg) gui.drawSprite(ctx, s.bg, s.x, s.y, 16, 16);
      const inDrag = this.dragging && this.dragSlots.includes(s) && this.carried;
      if (inDrag) { const per = this.dragAmount(); const ghost = this.carried!.clone(); ghost.count = Math.min(ghost.maxStack, (st?.count ?? 0) + per); gui.drawItem(ctx, ghost, s.x, s.y); }
      else gui.drawItem(ctx, st, s.x, s.y);
      if (s === hov) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(s.x, s.y, 16, 16); }
    }
    ctx.restore();
    super.render(ctx, mx, my, partial);
    if (this.carried) gui.drawItem(ctx, this.carried, mx - 8, my - 8);
    else if (hov) { const st = hov.inv.get(hov.index); if (st) gui.queueTooltip(gui.itemTooltipLines(st), mx, my); }
  }
  drawBg(ctx: CanvasRenderingContext2D, _mx: number, _my: number, _p: number): void {
    this.gui.drawSprite(ctx, this.texture, this.left, this.top, this.bgW, this.bgH, 0, 0, this.bgW, this.bgH);
  }
  drawForeground(ctx: CanvasRenderingContext2D, _mx: number, _my: number): void {
    if (this.title) this.gui.font.draw(ctx, this.title, 8, 6, 0x404040, false);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['container.inventory'] ?? 'Inventory', 8, this.bgH - 94, 0x404040, false);
  }

  private dragAmount(): number { if (!this.carried) return 0; if (this.dragButton === 1) return 1; return Math.floor(this.carried.count / Math.max(1, this.dragSlots.length)); }

  mouseDown(x: number, y: number, button: number): boolean {
    if (super.mouseDown(x, y, button)) return true;
    const slot = this.slotAt(x, y);
    const g = this.gui.game;
    const shift = g.input.keys.has('ShiftLeft') || g.input.keys.has('ShiftRight');
    if (!slot) {
      if (this.carried && (x < this.left || x >= this.left + this.bgW || y < this.top || y >= this.top + this.bgH)) {
        // drop carried
        if (button === 0) { this.player.throwItem(this.carried); this.carried = null; }
        else if (button === 1 || button === 2) { this.player.throwItem(this.carried.split(1)); if (this.carried.count <= 0) this.carried = null; }
      }
      return true;
    }
    if (button === 0 || button === 2) {
      const now = performance.now();
      if (button === 0 && this.lastClickSlot === slot && now - this.lastClickTime < 300 && this.carried) { this.collectAll(); this.lastClickTime = 0; return true; }
      this.lastClickTime = now; this.lastClickSlot = slot;
    }
    if (this.carried && !slot.output && (button === 0 || button === 2) && (!slot.accepts || slot.accepts(this.carried))) {
      // start drag
      this.dragging = true; this.dragButton = button === 2 ? 1 : 0; this.dragSlots = [slot];
      return true;
    }
    this.clickSlot(slot, button, shift);
    return true;
  }
  mouseMove(x: number, y: number): void {
    super.mouseMove(x, y);
    if (this.dragging && this.carried) { const s = this.slotAt(x, y); if (s && !this.dragSlots.includes(s) && !s.output && (!s.accepts || s.accepts(this.carried))) { const st = s.inv.get(s.index); if (!st || st.canStackWith(this.carried)) this.dragSlots.push(s); } }
  }
  mouseUp(x: number, y: number, button: number): void {
    super.mouseUp(x, y, button);
    if (!this.dragging) return;
    this.dragging = false;
    if (!this.carried) return;
    const shift = this.gui.game.input.keys.has('ShiftLeft');
    if (this.dragSlots.length <= 1) { const s = this.dragSlots[0]; if (s) this.clickSlot(s, button === 2 ? 2 : 0, shift); this.dragSlots = []; return; }
    const per = this.dragAmount();
    for (const s of this.dragSlots) {
      if (this.carried.count <= 0) break;
      const st = s.inv.get(s.index);
      const can = Math.min(per, this.carried.count, (s.max ?? this.carried.maxStack) - (st?.count ?? 0));
      if (can <= 0) continue;
      if (st) { st.count += can; } else { const n = this.carried.clone(); n.count = can; s.inv.set(s.index, n); }
      this.carried.count -= can;
      s.inv.onChange?.();
    }
    if (this.carried.count <= 0) this.carried = null;
    this.dragSlots = [];
    this.onSlotsChanged();
  }

  clickSlot(slot: Slot, button: number, shift: boolean): void {
    const inv = slot.inv, i = slot.index;
    const st = inv.get(i);
    if (shift && button === 0) {
      if (!st) return;
      // crafting outputs craft repeatedly straight into the inventory (the first result is not moved separately)
      if (slot.output && slot.craftAll) { slot.onTake!(st.clone(), true); this.onSlotsChanged(); return; }
      const all = st.clone(); this.quickMove(slot, st); if (slot.output) slot.onTake?.(all, true); this.onSlotsChanged();
      return;
    }
    if (slot.output) {
      if (!st) return;
      if (!this.carried) { this.carried = st.clone(); inv.set(i, null); slot.onTake?.(this.carried, false); }
      else if (this.carried.canStackWith(st) && this.carried.count + st.count <= this.carried.maxStack) { this.carried.count += st.count; inv.set(i, null); slot.onTake?.(st, false); }
      this.onSlotsChanged();
      return;
    }
    if (button === 0) {
      if (!this.carried) { if (st) { this.carried = st; inv.set(i, null); } }
      else if (!st) { if (!slot.accepts || slot.accepts(this.carried)) { const max = slot.max ?? this.carried.maxStack; if (this.carried.count <= max) { inv.set(i, this.carried); this.carried = null; } else { inv.set(i, this.carried.split(max)); } } }
      else if (st.canStackWith(this.carried)) { const max = slot.max ?? st.maxStack; const n = Math.min(this.carried.count, max - st.count); st.count += n; this.carried.count -= n; if (this.carried.count <= 0) this.carried = null; inv.onChange?.(); }
      else if (!slot.accepts || slot.accepts(this.carried)) { inv.set(i, this.carried); this.carried = st; }
    } else if (button === 2 || button === 1) {
      if (!this.carried) { if (st) { const half = Math.ceil(st.count / 2); this.carried = st.split(half); if (st.count <= 0) inv.set(i, null); else inv.onChange?.(); } }
      else if (!st) { if (!slot.accepts || slot.accepts(this.carried)) { inv.set(i, this.carried.split(1)); if (this.carried.count <= 0) this.carried = null; } }
      else if (st.canStackWith(this.carried) && st.count < (slot.max ?? st.maxStack)) { st.count++; this.carried.count--; if (this.carried.count <= 0) this.carried = null; inv.onChange?.(); }
    }
    this.onSlotsChanged();
  }

  /** Shift-click: move between player inventory and container. */
  quickMove(slot: Slot, st: ItemStack): void {
    const p = this.player;
    const isPlayerSlot = slot.inv === p.inventory;
    if (isPlayerSlot) {
      // try container slots first (non-output), then hotbar<->main
      const targets = this.slots.filter((s) => s.inv !== p.inventory && !s.output && (!s.accepts || s.accepts(st)));
      if (targets.length) this.moveInto(st, targets);
      if (st.count > 0) { const hot = slot.index < 9; const range: [number, number] = hot ? [9, 36] : [0, 9]; p.inventory.add(st, range); }
    } else {
      // armour auto-equip
      if (st.item.armorSlot && this.slots.some((s) => s.inv === p.armor)) { const idx = st.item.armorSlot === 'head' ? 0 : st.item.armorSlot === 'chest' ? 1 : st.item.armorSlot === 'legs' ? 2 : 3; if (!p.armor.get(idx)) { p.armor.set(idx, st.split(1)); } }
      if (st.count > 0) { p.inventory.add(st, [9, 36]); if (st.count > 0) p.inventory.add(st, [0, 9]); }
    }
    if (st.count <= 0) slot.inv.set(slot.index, null); else slot.inv.onChange?.();
  }
  private moveInto(st: ItemStack, targets: Slot[]): void {
    for (const t of targets) { if (st.count <= 0) break; const ts = t.inv.get(t.index); if (ts && ts.canStackWith(st)) { const n = Math.min(st.count, (t.max ?? ts.maxStack) - ts.count); ts.count += n; st.count -= n; t.inv.onChange?.(); } }
    for (const t of targets) { if (st.count <= 0) break; if (!t.inv.get(t.index)) { const n = Math.min(st.count, t.max ?? st.maxStack); const c = st.clone(); c.count = n; t.inv.set(t.index, c); st.count -= n; } }
  }
  private collectAll(): void {
    if (!this.carried) return;
    for (const s of this.slots) { if (s.output) continue; const st = s.inv.get(s.index); if (st && st.canStackWith(this.carried) && this.carried.count < this.carried.maxStack) { const n = Math.min(st.count, this.carried.maxStack - this.carried.count); this.carried.count += n; st.count -= n; if (st.count <= 0) s.inv.set(s.index, null); else s.inv.onChange?.(); } }
    this.onSlotsChanged();
  }

  keyDown(code: string, key: string, mods: { shift: boolean; ctrl: boolean }): boolean {
    if (super.keyDown(code, key, mods)) return true;
    const g = this.gui.game;
    const hov = this.slotAt(this.gui.mouseX, this.gui.mouseY);
    if (code === g.input.key('inventory')) { this.gui.close(); return true; }
    if (code === g.input.key('drop') && hov) { const st = hov.inv.get(hov.index); if (st && !hov.output) { const d = mods.ctrl ? st.split(st.count) : st.split(1); if (st.count <= 0) hov.inv.set(hov.index, null); else hov.inv.onChange?.(); this.player.throwItem(d); this.onSlotsChanged(); } return true; }
    if (code.startsWith('Digit') && hov && !hov.output) {
      const n = +code.slice(5) - 1;
      if (n >= 0 && n < 9) { const p = this.player; const a = hov.inv.get(hov.index), b = p.inventory.get(n); if (hov.inv === p.inventory && hov.index === n) return true; if ((!a || !hov.accepts || hov.accepts(b ?? a)) && (!b || !hov.accepts || hov.accepts(b))) { hov.inv.set(hov.index, b); p.inventory.set(n, a); this.onSlotsChanged(); } }
      return true;
    }
    return false;
  }
  onSlotsChanged(): void {}
  onClose(): void {
    if (this.carried) { this.player.inventory.add(this.carried); if (this.carried.count > 0) this.player.throwItem(this.carried); this.carried = null; }
    this.onCloseCb?.();
  }
}

// ---------- crafting helpers ----------
class CraftingMixin {
  static setup(screen: ContainerScreenBase, grid: Inventory, w: number, h: number, gx: number, gy: number, rx: number, ry: number, result: Inventory): void {
    const g = screen.gui.game;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) screen.slots.push({ inv: grid, index: r * w + c, x: gx + c * 18, y: gy + r * 18 });
    const update = () => { const recipe = g.recipes.match(grid.slots.slice(0, w * h), w, h); result.slots[0] = recipe ? g.recipes.craftResult(recipe, grid.slots) : null; (screen as any).currentRecipe = recipe; };
    grid.onChange = update;
    update();
    screen.slots.push({ inv: result, index: 0, x: rx, y: ry, output: true, craftAll: true, onTake: (_s, all) => {
      const recipe = (screen as any).currentRecipe as CraftingRecipe | null;
      if (!recipe) return;
      const consume = () => { for (let i = 0; i < w * h; i++) { const st = grid.slots[i]; if (!st) continue; const rem = g.recipes.remainder(st); st.count--; if (st.count <= 0) grid.slots[i] = rem; else if (rem) { if (g.player.inventory.add(rem) > 0) g.player.throwItem(rem); } } };
      if (all) {
        // craft as many as possible into the player inventory
        let guard = 0;
        while (guard++ < 64) {
          const r2 = g.recipes.match(grid.slots.slice(0, w * h), w, h);
          if (!r2 || r2.id !== recipe.id) break;
          const out = g.recipes.craftResult(r2, grid.slots);
          consume();
          if (g.player.inventory.add(out) > 0) { g.player.throwItem(out); break; }
        }
        result.slots[0] = null;
      } else consume();
      g.sounds.play('ui.button.click', 0, 1);
      update();
    } });
  }
}

export class InventoryScreen extends ContainerScreenBase {
  grid = new Inventory(4); result = new Inventory(1);
  buildSlots(): void {
    const p = this.player;
    this.texture = 'gui/container/inventory'; this.bgW = 176; this.bgH = 166;
    this.grid = p.craftingGrid;
    CraftingMixin.setup(this, this.grid, 2, 2, 98, 18, 154, 28, this.result);
    const armorSlot = (i: number, y: number, slot: string, bg: string) => this.slots.push({ inv: p.armor, index: i, x: 8, y, accepts: (s) => s.item.armorSlot === slot, max: 1, bg: 'gui/sprites/container/slot/' + bg });
    armorSlot(0, 8, 'head', 'helmet'); armorSlot(1, 26, 'chest', 'chestplate'); armorSlot(2, 44, 'legs', 'leggings'); armorSlot(3, 62, 'feet', 'boots');
    this.slots.push({ inv: p.offhand, index: 0, x: 77, y: 62, bg: 'gui/sprites/container/slot/shield' });
    this.addPlayerSlots(84);
  }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    this.gui.font.draw(ctx, this.gui.game.assets.lang['container.crafting'] ?? 'Crafting', 97, 8, 0x404040, false);
    // player preview
    const c = this.gui.game.entityRenderer.playerPreview(mx - 51, my - 45);
    if (c) ctx.drawImage(c, 26, 8, 49, 70);
  }
  onClose(): void {
    super.onClose();
    for (let i = 0; i < 4; i++) { const s = this.grid.slots[i]; if (s) { if (this.player.inventory.add(s) > 0) this.player.throwItem(s); this.grid.slots[i] = null; } }
  }
}

export class CraftingScreen extends ContainerScreenBase {
  grid = new Inventory(9); result = new Inventory(1);
  buildSlots(): void {
    this.texture = 'gui/container/crafting_table'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.crafting'] ?? 'Crafting';
    CraftingMixin.setup(this, this.grid, 3, 3, 30, 17, 124, 35, this.result);
    this.addPlayerSlots(84);
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 9; i++) { const s = this.grid.slots[i]; if (s) { if (this.player.inventory.add(s) > 0) this.player.throwItem(s); this.grid.slots[i] = null; } } }
}

export class ContainerScreen extends ContainerScreenBase {
  constructor(public inv: Inventory, public name: string, public rows: number, public cols = 9, onClose?: () => void) { super(); this.onCloseCb = onClose ?? null; }
  buildSlots(): void {
    this.title = this.name;
    if (this.cols === 3) { this.texture = 'gui/container/dispenser'; this.bgW = 176; this.bgH = 166; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) this.slots.push({ inv: this.inv, index: r * 3 + c, x: 62 + c * 18, y: 17 + r * 18 }); this.addPlayerSlots(84); return; }
    if (this.cols === 5) { this.texture = 'gui/container/hopper'; this.bgW = 176; this.bgH = 133; for (let c = 0; c < 5; c++) this.slots.push({ inv: this.inv, index: c, x: 44 + c * 18, y: 20 }); this.addPlayerSlots(51); return; }
    this.texture = this.name.includes('shulker') ? 'gui/container/shulker_box' : 'gui/container/generic_54';
    this.bgW = 176; this.bgH = 114 + this.rows * 18;
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < 9; c++) this.slots.push({ inv: this.inv, index: r * 9 + c, x: 8 + c * 18, y: 18 + r * 18, accepts: this.name.includes('shulker') ? (s) => !s.item.name.endsWith('shulker_box') : undefined });
    this.addPlayerSlots(this.rows * 18 + 32);
  }
  drawBg(ctx: CanvasRenderingContext2D): void {
    if (this.cols !== 9) { super.drawBg(ctx, 0, 0, 0); return; }
    const gui = this.gui;
    gui.drawSprite(ctx, this.texture, this.left, this.top, 176, 17 + this.rows * 18, 0, 0, 176, 17 + this.rows * 18);
    gui.drawSprite(ctx, this.texture, this.left, this.top + 17 + this.rows * 18, 176, 96, 0, 126, 176, 96);
  }
  drawForeground(ctx: CanvasRenderingContext2D): void {
    this.gui.font.draw(ctx, this.title, 8, 6, 0x404040, false);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['container.inventory'] ?? 'Inventory', 8, this.bgH - 94, 0x404040, false);
  }
}

export class FurnaceScreen extends ContainerScreenBase {
  constructor(public be: BlockEntity, public kind: string) { super(); }
  buildSlots(): void {
    const g = this.gui.game;
    this.texture = 'gui/container/' + this.kind; this.bgW = 176; this.bgH = 166;
    this.title = g.assets.lang['container.' + (this.kind === 'furnace' ? 'furnace' : this.kind === 'blast_furnace' ? 'blast_furnace' : 'smoker')] ?? this.kind;
    this.slots.push({ inv: this.be.inventory, index: 0, x: 56, y: 17 });
    this.slots.push({ inv: this.be.inventory, index: 1, x: 56, y: 53, accepts: (s) => (g.items.fuel.get(s.item.name) ?? 0) > 0 || s.item.name === 'bucket' });
    this.slots.push({ inv: this.be.inventory, index: 2, x: 116, y: 35, output: true, onTake: (s) => { if (this.be.xp) { g.spawnXp(g.player.x, g.player.y, g.player.z, Math.floor(this.be.xp)); this.be.xp = 0; } void s; } });
    this.addPlayerSlots(84);
  }
  drawForeground(ctx: CanvasRenderingContext2D): void {
    super.drawForeground(ctx, 0, 0);
    const be = this.be;
    if (be.burnTime > 0 && be.burnDuration) { const h = Math.ceil(14 * be.burnTime / be.burnDuration); this.gui.drawSprite(ctx, 'gui/sprites/container/furnace/lit_progress', 56, 36 + 14 - h, 14, h, 0, 14 - h, 14, h); }
    if (be.cookTime > 0 && be.cookDuration) { const w = Math.ceil(24 * be.cookTime / be.cookDuration); this.gui.drawSprite(ctx, 'gui/sprites/container/furnace/burn_progress', 79, 34, w, 16, 0, 0, w, 16); }
  }
  quickMove(slot: Slot, st: ItemStack): void {
    const g = this.gui.game;
    if (slot.inv === this.player.inventory) {
      const targets = g.recipes.cookingFor(st, this.kind === 'furnace' ? 'smelting' : this.kind === 'blast_furnace' ? 'blasting' : 'smoking') ? this.slots.filter((s) => s.inv === this.be.inventory && s.index === 0) : (g.items.fuel.get(st.item.name) ?? 0) > 0 ? this.slots.filter((s) => s.inv === this.be.inventory && s.index === 1) : [];
      if (targets.length) { (this as any).moveInto(st, targets); if (st.count <= 0) slot.inv.set(slot.index, null); else slot.inv.onChange?.(); if (st.count <= 0) return; }
    }
    super.quickMove(slot, st);
  }
}

// ---------- creative ----------
const TABS: { id: string; icon: string; label: string; filter: (name: string, g: any) => boolean }[] = [
  { id: 'building_blocks', icon: 'bricks', label: 'Building Blocks', filter: (n, g) => !!g.items.get(n)?.blockName && /planks|log|wood|stone|brick|slab|stairs|wall|cobble|sandstone|deepslate|granite|diorite|andesite|tuff|calcite|quartz|purpur|copper|prismarine|blackstone|basalt|end_stone|nether_brick|bamboo|mud_brick|resin|iron_block|gold_block|diamond_block|netherite_block|emerald_block|lapis_block|redstone_block|coal_block|raw_|amethyst_block|obsidian|glass|smooth|polished|chiseled|cut_|cracked|mosaic|mangrove|cherry|oak|spruce|birch|jungle|acacia|crimson|warped|door|trapdoor|fence|hay_block|bone_block|dripstone_block|packed_mud|glazed|concrete|terracotta/.test(n) && !/ore|leaves|sapling|button|pressure_plate|sign|boat|bed|carpet|wool|banner|stained|dye|candle/.test(n) },
  { id: 'colored_blocks', icon: 'cyan_wool', label: 'Colored Blocks', filter: (n) => /wool|carpet|terracotta|concrete|stained_glass|candle|bed$|banner$|shulker_box|glazed/.test(n) && !/dye|powder$/.test(n) || /_concrete_powder/.test(n) },
  { id: 'natural_blocks', icon: 'grass_block', label: 'Natural Blocks', filter: (n, g) => !!g.items.get(n)?.blockName && /grass_block|dirt|podzol|mycelium|mud$|clay|gravel|sand$|ore$|leaves|sapling|log$|stem$|flower|grass$|fern|bush|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily|rose|sunflower|lilac|peony|mushroom|cactus|sugar_cane|pumpkin|melon|kelp|seagrass|coral|ice$|snow|moss|azalea|vine|spore|dripleaf|roots|nylium|wart|fungus|sprouts|glowstone|magma|soul_sand|soul_soil|netherrack|end_stone|chorus|bedrock|deepslate$|stone$|cobblestone$|infested|sculk|amethyst|pointed|budding|ancient_debris|bamboo$|lichen|petals|litter|wildflowers|torchflower|pitcher|honeycomb_block|bee_nest|obsidian|crying|frogspawn|dripstone|calcite|tuff$|basalt$|blackstone$|shroomlight|sea_pickle|cobweb|water_bucket|lava_bucket|powder_snow|hanging_roots|mangrove_propagule|cherry_leaves|egg$|slime_block|honey_block|spawner|resin_clump|creaking_heart|eyeblossom/.test(n) },
  { id: 'functional_blocks', icon: 'oak_sign', label: 'Functional Blocks', filter: (n) => /torch$|lantern|campfire|crafting_table|stonecutter|cartography|fletching|smithing_table|grindstone|loom|furnace|smoker|anvil|composter|barrel|chest$|ender_chest|shulker|jukebox|note_block|lectern|enchanting|brewing|cauldron|bell$|beacon|conduit|lodestone|ladder|scaffolding|bookshelf|sign$|hanging_sign|bed$|banner$|painting|item_frame|armor_stand|flower_pot|candle|decorated_pot|respawn_anchor|end_portal_frame|infested|spawner|lightning_rod|chain$|iron_bars|glass_pane|soul_lantern|end_rod|end_crystal|trial_spawner|vault|shelf|copper_golem/.test(n) && !/redstone_torch|chest_minecart|bed(rock)/.test(n) },
  { id: 'redstone_blocks', icon: 'redstone', label: 'Redstone Blocks', filter: (n) => /redstone|repeater|comparator|lever|button|pressure_plate|piston|observer|dispenser|dropper|hopper|daylight_detector|tripwire|target$|note_block|tnt$|rail$|minecart|lectern|sculk_sensor|calibrated|bulb|crafter|trapped_chest|iron_door|iron_trapdoor|oak_door|oak_trapdoor|oak_fence_gate|lightning_rod|slime_block|honey_block|copper_door|copper_trapdoor|armadillo/.test(n) && !/ore|_powder/.test(n) },
  { id: 'tools', icon: 'diamond_pickaxe', label: 'Tools & Utilities', filter: (n) => /_pickaxe|_axe$|_shovel|_hoe|shears|flint_and_steel|fishing_rod|bucket|compass|clock|map$|lead|name_tag|spyglass|saddle|carrot_on_a_stick|fungus_on_a_stick|boat|raft|minecart|elytra|firework_rocket|music_disc|goat_horn|brush|bundle|recovery_compass|book$|writable_book|ender_pearl|ender_eye|totem|_horse_armor|wolf_armor|bone$|_spawn_egg/.test(n) && !/spawn_egg/.test(n) },
  { id: 'combat', icon: 'netherite_sword', label: 'Combat', filter: (n) => /_sword|_helmet|_chestplate|_leggings|_boots|bow$|crossbow|arrow|trident|shield|mace|tnt$|snowball|egg$|end_crystal|wind_charge|totem|turtle_helmet|elytra|golden_apple|wolf_armor/.test(n) && !/spawn_egg|turtle_egg|sniffer_egg|dragon_egg|frog/.test(n) },
  { id: 'food_and_drinks', icon: 'golden_apple', label: 'Food & Drinks', filter: (n, g) => !!g.items.get(n)?.food || /potion|milk_bucket|honey_bottle|cake$|cookie|bread|stew|soup/.test(n) },
  { id: 'ingredients', icon: 'iron_ingot', label: 'Ingredients', filter: (n) => /ingot|nugget|coal$|charcoal|diamond$|emerald$|lapis_lazuli|quartz$|amethyst_shard|redstone$|glowstone_dust|gunpowder|string$|feather|flint$|leather$|stick$|bowl$|brick$|paper|sugar$|slime_ball|magma_cream|blaze|ghast_tear|nether_wart$|spider_eye|rabbit_hide|rabbit_foot|scute|shell|bone_meal|_dye|prismarine_shard|prismarine_crystals|heart_of_the_sea|nautilus|phantom_membrane|honeycomb$|echo_shard|disc_fragment|template|pottery_sherd|netherite_scrap|raw_|dragon_breath|fermented|glass_bottle|glistering|golden_carrot|wheat$|seeds|bamboo$|book$|ink_sac|glow_ink|firework_star|resin_brick|copper_ingot|breeze_rod|heavy_core|turtle_scute|armadillo_scute|frog|tadpole/.test(n) },
  { id: 'spawn_eggs', icon: 'pig_spawn_egg', label: 'Spawn Eggs', filter: (n) => n.endsWith('_spawn_egg') },
];

export class CreativeScreen extends ContainerScreenBase {
  tab = 0;
  items: ItemStack[] = [];
  scroll = 0;
  gridInv = new Inventory(45);
  search!: TextField;
  static lastTab = 0;
  buildSlots(): void {
    this.texture = 'gui/container/creative_inventory/tab_items'; this.bgW = 195; this.bgH = 136;
    this.tab = CreativeScreen.lastTab;
    this.search = new TextField(this.left + 82, this.top + 6, 80, 9, ''); // vanilla EditBox(82, 6, 80, 9), unbordered
    this.search.bordered = false; // the tab texture already draws the field
    this.search.onChange = () => { this.scroll = 0; this.refresh(); this.rebuildSlots(); };
    this.widgets = [this.search];
    this.refresh();
    this.rebuildSlots();
    if (this.isSearch()) this.focused = this.search;
  }
  private isSearch(): boolean { return this.tab === 10; }
  private isInventory(): boolean { return this.tab === 11; }
  refresh(): void {
    const g = this.gui.game;
    const all = g.items.items.filter((i) => i && i.name !== 'air' && !/^(bundle|debug_stick|knowledge_book|command_block|barrier|structure|jigsaw|light$|petrified|spawner|reinforced|bedrock|end_portal_frame|written_book|filled_map|potion$|splash_potion$|lingering_potion$|tipped_arrow$|ominous|enchanted_book|firework_star|player_head|test_|air$)/.test(i.name));
    let list: ItemStack[];
    if (this.isSearch()) { const q = this.search.text.toLowerCase().trim(); list = all.filter((i) => !q || i.name.includes(q.replace(/ /g, '_')) || g.items.displayName(i.name).toLowerCase().includes(q)).map((i) => new ItemStack(i, 1)); }
    else if (this.isInventory()) list = [];
    else { const t = TABS[this.tab]; const used = new Set<string>(); list = []; for (const i of all) { let tabOf = TABS.findIndex((tt) => tt.filter(i.name, g)); if (tabOf === -1 && i.blockName) tabOf = 0; if (tabOf === -1) tabOf = 8; if (tabOf === this.tab && !used.has(i.name)) { used.add(i.name); list.push(new ItemStack(i, 1)); } } void t; }
    // potions variants in search/food tab
    if (this.isSearch() || this.tab === 7) for (const kind of ['water', 'speed', 'slowness', 'strength', 'healing', 'harming', 'leaping', 'regeneration', 'fire_resistance', 'water_breathing', 'invisibility', 'night_vision', 'weakness', 'poison', 'slow_falling']) { const eff = kind === 'water' ? null : { id: { speed: 'speed', slowness: 'slowness', strength: 'strength', healing: 'instant_health', harming: 'instant_damage', leaping: 'jump_boost', regeneration: 'regeneration', fire_resistance: 'fire_resistance', water_breathing: 'water_breathing', invisibility: 'invisibility', night_vision: 'night_vision', weakness: 'weakness', poison: 'poison', slow_falling: 'slow_falling' }[kind], amplifier: 0, duration: kind === 'healing' || kind === 'harming' ? 1 : 3600 }; for (const it of ['potion', 'splash_potion', 'lingering_potion']) { const s = new ItemStack(g.items.get(it)!, 1, 0, [], null, { potion: kind, effect: eff, color: potionColor(kind) }); if (!this.isSearch() || !this.search.text || kind.includes(this.search.text.toLowerCase())) list.push(s); } }
    this.items = list;
  }
  private rebuildSlots(): void {
    this.slots = [];
    const p = this.player;
    if (this.isInventory()) {
      this.texture = 'gui/container/creative_inventory/tab_inventory';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) this.slots.push({ inv: p.inventory, index: 9 + r * 9 + c, x: 9 + c * 18, y: 54 + r * 18 });
      for (let c = 0; c < 9; c++) this.slots.push({ inv: p.inventory, index: c, x: 9 + c * 18, y: 112 });
      const armorSlot = (i: number, x: number, slot: string) => this.slots.push({ inv: p.armor, index: i, x, y: 20, accepts: (s) => s.item.armorSlot === slot, max: 1 });
      armorSlot(0, 9, 'head'); armorSlot(1, 27, 'chest'); armorSlot(2, 45, 'legs'); armorSlot(3, 63, 'feet');
      this.slots.push({ inv: p.offhand, index: 0, x: 81, y: 20 });
      const trash = new Inventory(1); trash.onChange = () => { trash.slots[0] = null; };
      this.slots.push({ inv: trash, index: 0, x: 173, y: 112, accepts: () => true });
      return;
    }
    this.texture = this.isSearch() ? 'gui/container/creative_inventory/tab_item_search' : 'gui/container/creative_inventory/tab_items';
    const rows = Math.max(0, Math.ceil(this.items.length / 9) - 5);
    this.scroll = Math.min(this.scroll, rows);
    for (let i = 0; i < 45; i++) { const it = this.items[this.scroll * 9 + i] ?? null; this.gridInv.slots[i] = it ? it.clone() : null; }
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) this.slots.push({ inv: this.gridInv, index: r * 9 + c, x: 9 + c * 18, y: 18 + r * 18, output: true, onTake: () => {} });
    for (let c = 0; c < 9; c++) this.slots.push({ inv: p.inventory, index: c, x: 9 + c * 18, y: 112 });
  }
  clickSlot(slot: Slot, button: number, shift: boolean): void {
    if (slot.inv === this.gridInv) {
      const st = slot.inv.get(slot.index);
      if (!st) { if (this.carried) { this.carried = null; } return; }
      if (shift) { const c = st.clone(); c.count = 1; this.player.inventory.add(c); return; }
      if (!this.carried) { this.carried = st.clone(); this.carried.count = button === 2 ? 1 : 1; return; }
      if (this.carried.canStackWith(st)) { this.carried.count = Math.min(this.carried.maxStack, this.carried.count + (button === 2 ? 1 : 1)); return; }
      this.carried = null; return;
    }
    if (this.isInventory() && this.carried && button === 0 && slot.inv.size === 1 && slot.accepts && slot.x === 173) { this.carried = null; return; }
    super.clickSlot(slot, button, shift);
    if (!this.isInventory()) this.gridInv.slots.forEach((s, i) => { const it = this.items[this.scroll * 9 + i]; this.gridInv.slots[i] = it ? it.clone() : null; });
  }
  mouseDown(x: number, y: number, button: number): boolean {
    // tabs
    const lx = x - this.left, ly = y - this.top;
    const tabIdx = this.tabAt(lx, ly);
    if (tabIdx >= 0) { this.tab = tabIdx; CreativeScreen.lastTab = tabIdx; this.scroll = 0; this.search.text = ''; this.refresh(); this.rebuildSlots(); this.focused = this.isSearch() ? this.search : null; this.gui.game.sounds.play('ui.button.click', 0.25, 1); return true; }
    // delete all with trash
    return super.mouseDown(x, y, button);
  }
  private tabAt(lx: number, ly: number): number {
    // top row tabs 0-5 + search(10) at index 6; bottom row: 6-9 + inventory(11)
    for (let i = 0; i < 7; i++) { const tx = i * 27 - 1 + (i === 6 ? 1 : 0), ty = -28; if (lx >= tx && lx < tx + 26 && ly >= ty && ly < ty + 32) return i === 6 ? 10 : i; }
    for (let i = 0; i < 5; i++) { const tx = i * 27 - 1 + (i === 4 ? 2 * 27 : 0), ty = this.bgH - 4; if (lx >= tx && lx < tx + 26 && ly >= ty && ly < ty + 32) return i === 4 ? 11 : 6 + i; }
    return -1;
  }
  wheel(dy: number, x: number, y: number): void {
    if (this.isInventory()) return;
    const rows = Math.max(0, Math.ceil(this.items.length / 9) - 5);
    this.scroll = Math.max(0, Math.min(rows, this.scroll + dy));
    this.rebuildSlots();
    void x; void y;
  }
  keyDown(code: string, key: string, mods: any): boolean {
    if (this.isSearch() && code !== 'Escape') { this.focused = this.search; this.search.keyDown(code, key, mods); return true; }
    return super.keyDown(code, key, mods);
  }
  typed(ch: string): void { if (this.isSearch()) this.search.typed(ch); }
  drawBg(ctx: CanvasRenderingContext2D): void {
    const gui = this.gui;
    // tabs behind
    const drawTab = (i: number, top: boolean, selected: boolean, icon: string) => {
      const col = top ? (i === 6 ? 6 : i) : (i === 4 ? 6 : i);
      const tx = this.left + col * 27 - 1 + (col === 6 ? 1 : 0) + (top ? 0 : 0);
      const ty = top ? this.top - 28 : this.top + this.bgH - 4;
      const sprite = `gui/sprites/container/creative_inventory/tab_${top ? 'top' : 'bottom'}_${selected ? 'selected' : 'unselected'}_${Math.min(7, col + 1)}`;
      gui.drawSprite(ctx, sprite, tx, ty, 26, 32);
      const it = gui.game.items.get(icon);
      if (it) gui.drawItem(ctx, new ItemStack(it, 1), tx + 5, ty + (top ? 9 : 7) + (selected ? 0 : (top ? 2 : -2)), false);
    };
    for (let i = 0; i < 6; i++) if (this.tab !== i) drawTab(i, true, false, TABS[i].icon);
    if (this.tab !== 10) drawTab(6, true, false, 'compass');
    for (let i = 0; i < 4; i++) if (this.tab !== 6 + i) drawTab(i, false, false, TABS[6 + i].icon);
    if (this.tab !== 11) drawTab(4, false, false, 'chest');
    gui.drawSprite(ctx, this.texture, this.left, this.top, this.bgW, this.bgH, 0, 0, this.bgW, this.bgH);
    if (this.tab < 6) drawTab(this.tab, true, true, TABS[this.tab].icon); else if (this.tab === 10) drawTab(6, true, true, 'compass'); else if (this.tab === 11) drawTab(4, false, true, 'chest'); else drawTab(this.tab - 6, false, true, TABS[this.tab].icon);
    // scrollbar
    if (!this.isInventory()) { const rows = Math.max(0, Math.ceil(this.items.length / 9) - 5); const sy = this.top + 18 + (rows > 0 ? Math.floor((this.scroll / rows) * (112 - 15)) : 0); gui.drawSprite(ctx, rows > 0 ? 'gui/sprites/container/creative_inventory/scroller' : 'gui/sprites/container/creative_inventory/scroller_disabled', this.left + 175, sy, 12, 15); }
  }
  drawForeground(ctx: CanvasRenderingContext2D): void {
    const label = this.isSearch() ? '' : this.isInventory() ? 'Survival Inventory' : TABS[this.tab].label;
    if (label) this.gui.font.draw(ctx, label, 8, 6, 0x404040, false);
    if (this.isInventory()) { const c = this.gui.game.entityRenderer.playerPreview(0, 0); if (c) ctx.drawImage(c, 122, 8, 49, 70); }
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    if (this.isSearch()) { this.search.x = this.left + 82; this.search.y = this.top + 6; this.search.visible = true; } else this.search.visible = false;
    super.render(ctx, mx, my, partial);
    // tab tooltips
    const t = this.tabAt(mx - this.left, my - this.top);
    if (t >= 0 && !this.carried) this.gui.queueTooltip([t === 10 ? 'Search Items' : t === 11 ? 'Survival Inventory' : TABS[t].label], mx, my);
  }
}

// ---------- stonecutter ----------
export class StonecutterScreen extends ContainerScreenBase {
  input = new Inventory(1); output = new Inventory(1);
  results: { item: any; count: number }[] = []; selected = -1; scroll = 0;
  buildSlots(): void {
    this.texture = 'gui/container/stonecutter'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.stonecutter'] ?? 'Stonecutter';
    this.slots.push({ inv: this.input, index: 0, x: 20, y: 33 });
    this.slots.push({ inv: this.output, index: 0, x: 143, y: 33, output: true, onTake: () => { const s = this.input.get(0); if (s) { s.count--; if (s.count <= 0) this.input.set(0, null); } this.update(); } });
    this.input.onChange = () => { this.selected = -1; this.update(); };
    this.addPlayerSlots(84);
  }
  update(): void {
    const s = this.input.get(0);
    this.results = s ? this.gui.game.recipes.stonecuttingFor(s).map((r) => ({ item: r.result, count: r.count })) : [];
    this.output.slots[0] = this.selected >= 0 && this.results[this.selected] && s ? new ItemStack(this.results[this.selected].item, this.results[this.selected].count) : null;
  }
  mouseDown(x: number, y: number, b: number): boolean {
    const lx = x - this.left - 52, ly = y - this.top - 14;
    if (lx >= 0 && lx < 64 && ly >= 0 && ly < 54) { const i = Math.floor(ly / 18) * 4 + Math.floor(lx / 16) + this.scroll * 4; if (this.results[i]) { this.selected = i; this.update(); this.gui.game.sounds.play('block.stonecutter.select_recipe', 0.5, 1); } return true; }
    return super.mouseDown(x, y, b);
  }
  wheel(dy: number): void { const rows = Math.max(0, Math.ceil(this.results.length / 4) - 3); this.scroll = Math.max(0, Math.min(rows, this.scroll + dy)); }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    super.drawForeground(ctx, mx, my);
    for (let i = 0; i < 12; i++) {
      const idx = i + this.scroll * 4; const r = this.results[idx]; if (!r) break;
      const x = 52 + (i % 4) * 16, y = 14 + Math.floor(i / 4) * 18;
      const hov = mx >= x && mx < x + 16 && my >= y && my < y + 18;
      this.gui.drawSprite(ctx, idx === this.selected ? 'gui/sprites/container/stonecutter/recipe_selected' : hov ? 'gui/sprites/container/stonecutter/recipe_highlighted' : 'gui/sprites/container/stonecutter/recipe', x, y, 16, 18);
      this.gui.drawItem(ctx, new ItemStack(r.item, r.count), x, y + 1);
      if (hov && !this.carried) this.gui.queueTooltip([this.gui.game.items.displayName(r.item.name)], mx + this.left, my + this.top);
    }
    const rows = Math.max(0, Math.ceil(this.results.length / 4) - 3);
    this.gui.drawSprite(ctx, rows > 0 ? 'gui/sprites/container/stonecutter/scroller' : 'gui/sprites/container/stonecutter/scroller_disabled', 119, 15 + (rows > 0 ? Math.floor(this.scroll / rows * 39) : 0), 12, 15);
  }
  onClose(): void { super.onClose(); const s = this.input.get(0); if (s) { if (this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}

// ---------- anvil ----------
export class AnvilScreen extends ContainerScreenBase {
  inputs = new Inventory(2); output = new Inventory(1); name!: TextField; cost = 0;
  buildSlots(): void {
    this.texture = 'gui/container/anvil'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.repair'] ?? 'Repair & Name';
    this.name = new TextField(this.left + 62, this.top + 24, 103, 12, '');
    this.name.maxLength = 50; this.name.onChange = () => this.update();
    this.widgets = [this.name];
    this.slots.push({ inv: this.inputs, index: 0, x: 27, y: 47 }, { inv: this.inputs, index: 1, x: 76, y: 47 });
    this.slots.push({ inv: this.output, index: 0, x: 134, y: 47, output: true, onTake: () => { const p = this.player; if (!p.isCreative) p.addXpLevels(-this.cost); const a = this.inputs.get(0), b = this.inputs.get(1); if (b && a && b.item === a.item && b.isDamageable) this.inputs.set(1, null); else if (b && (b.item.name === 'enchanted_book' || a?.item.repairWith.includes(b.item.name))) { const need = a?.item.repairWith.includes(b.item.name) ? Math.min(b.count, Math.ceil(a!.damage / (a!.maxDurability / 4))) : 1; b.count -= need; if (b.count <= 0) this.inputs.set(1, null); } else this.inputs.set(1, null); this.inputs.set(0, null); this.gui.game.sounds.play('block.anvil.use', 1, 1); this.update(); } });
    this.inputs.onChange = () => this.update();
    this.addPlayerSlots(84);
  }
  update(): void {
    const a = this.inputs.get(0), b = this.inputs.get(1);
    this.cost = 0; this.output.slots[0] = null;
    if (!a) return;
    const out = a.clone();
    let cost = 0;
    const rename = this.name.text.trim();
    if (rename && rename !== (a.customName ?? '')) { out.customName = rename; cost += 1; }
    else if (!rename && a.customName) { out.customName = null; cost += 1; }
    if (b) {
      if (b.item === a.item && a.isDamageable) { const dur = Math.min(a.maxDurability, (a.maxDurability - a.damage) + (b.maxDurability - b.damage) + Math.floor(a.maxDurability * 0.12)); out.damage = a.maxDurability - dur; cost += 2; for (const e of b.enchantments) { const ex = out.enchantments.find((x) => x.id === e.id); if (ex) ex.level = ex.level === e.level ? Math.min(e.level + 1, maxLevel(e.id)) : Math.max(ex.level, e.level); else out.enchantments.push({ ...e }); cost += e.level; } }
      else if (b.item.name === 'enchanted_book' && b.extra?.enchantments) { for (const e of b.extra.enchantments as { id: string; level: number }[]) { if (!a.item.enchantCategories.length && a.item.name !== 'book') continue; const ex = out.enchantments.find((x) => x.id === e.id); if (ex) ex.level = ex.level === e.level ? Math.min(e.level + 1, maxLevel(e.id)) : Math.max(ex.level, e.level); else out.enchantments.push({ ...e }); cost += e.level; } }
      else if (a.item.repairWith.includes(b.item.name) && a.isDamageable && a.damage > 0) { const n = Math.min(b.count, Math.ceil(a.damage / (a.maxDurability / 4))); out.damage = Math.max(0, a.damage - n * Math.floor(a.maxDurability / 4)); cost += n; }
      else return;
    }
    if (cost === 0) return;
    cost += a.extra?.repairCost ?? 0;
    out.extra = { ...out.extra, repairCost: (a.extra?.repairCost ?? 0) * 2 + 1 };
    this.cost = cost;
    if (cost >= 40 && !this.player.isCreative) { this.cost = 40; return; }
    this.output.slots[0] = out;
  }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    super.drawForeground(ctx, mx, my);
    if (this.cost > 0) { const ok = this.player.xpLevel >= this.cost || this.player.isCreative; const text = this.cost >= 40 && !this.player.isCreative ? 'Too Expensive!' : `Enchantment Cost: ${this.cost}`; ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(168 - this.gui.font.width(text) - 2, 66, this.gui.font.width(text) + 4, 12); this.gui.font.drawRight(ctx, text, 168, 68, ok && this.cost < 40 ? 0x80ff20 : 0xff6060); }
    if (!this.output.get(0) && this.cost > 0 && this.inputs.get(0)) this.gui.drawSprite(ctx, 'gui/sprites/container/anvil/error', 99, 45, 28, 21);
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 2; i++) { const s = this.inputs.get(i); if (s && this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}
function maxLevel(id: string): number { return { sharpness: 5, smite: 5, bane_of_arthropods: 5, efficiency: 5, power: 5, protection: 4, fire_protection: 4, blast_protection: 4, projectile_protection: 4, unbreaking: 3, fortune: 3, looting: 3, respiration: 3, depth_strider: 3, thorns: 3, knockback: 2, fire_aspect: 2, punch: 2, sweeping_edge: 3, feather_falling: 4, aqua_affinity: 1, silk_touch: 1, infinity: 1, mending: 1, flame: 1, loyalty: 3, riptide: 3, impaling: 5, channeling: 1, quick_charge: 3, multishot: 1, piercing: 4, soul_speed: 3, swift_sneak: 3, lure: 3, luck_of_the_sea: 3, frost_walker: 2, wind_burst: 3, density: 5, breach: 4 }[id] ?? 1; }

// ---------- enchanting ----------
const ENCH_POOL: Record<string, string[]> = { mining: ['efficiency', 'unbreaking', 'fortune', 'silk_touch', 'mending'], weapon: ['sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping_edge', 'unbreaking', 'mending'], armor: ['protection', 'fire_protection', 'blast_protection', 'projectile_protection', 'thorns', 'unbreaking', 'mending'], armor_feet: ['feather_falling', 'depth_strider', 'frost_walker', 'soul_speed'], armor_head: ['respiration', 'aqua_affinity'], bow: ['power', 'punch', 'flame', 'infinity', 'unbreaking', 'mending'], crossbow: ['quick_charge', 'multishot', 'piercing', 'unbreaking', 'mending'], trident: ['loyalty', 'impaling', 'riptide', 'channeling', 'unbreaking', 'mending'], fishing: ['lure', 'luck_of_the_sea', 'unbreaking', 'mending'], durability: ['unbreaking', 'mending'], book: ['sharpness', 'efficiency', 'protection', 'unbreaking', 'fortune', 'power', 'looting', 'silk_touch', 'mending', 'feather_falling', 'thorns', 'respiration', 'depth_strider', 'infinity', 'fire_aspect', 'knockback'] };

export class EnchantingScreen extends ContainerScreenBase {
  item = new Inventory(2);
  options: { level: number; ench: { id: string; level: number }[]; seed: number }[] = [];
  shelves = 0;
  constructor(public bx: number, public by: number, public bz: number) { super(); }
  buildSlots(): void {
    this.texture = 'gui/container/enchanting_table'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.enchant'] ?? 'Enchant';
    this.slots.push({ inv: this.item, index: 0, x: 15, y: 47, max: 1 });
    this.slots.push({ inv: this.item, index: 1, x: 35, y: 47, accepts: (s) => s.item.name === 'lapis_lazuli', bg: 'gui/sprites/container/enchanting_table/lapis_lazuli' });
    this.item.onChange = () => this.roll();
    this.addPlayerSlots(84);
    // count bookshelves
    const w = this.gui.game.world, reg = this.gui.game.registry;
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy <= 1; dy++) { if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue; const s = w.getBlock(this.bx + dx, this.by + dy, this.bz + dz); if (s && reg.nameOf(s) === 'bookshelf') { const ix = this.bx + Math.sign(dx) * (Math.abs(dx) === 2 ? 1 : 0), iz = this.bz + Math.sign(dz) * (Math.abs(dz) === 2 ? 1 : 0); const gap = w.getBlock(ix, this.by + dy, iz); if (gap === 0 || reg.isAir(gap)) n++; } }
    this.shelves = Math.min(15, n);
  }
  roll(): void {
    const s = this.item.get(0);
    this.options = [];
    if (!s || s.enchantments.length || (!s.item.enchantCategories.length && s.item.name !== 'book')) return;
    const b = this.shelves;
    for (let i = 0; i < 3; i++) {
      const base = Math.floor(Math.random() * 8) + 1 + (b >> 1) + Math.floor(Math.random() * (b + 1));
      let level = i === 0 ? Math.max(base / 3, 1) : i === 1 ? Math.floor(base * 2 / 3 + 1) : Math.max(base, b * 2);
      level = Math.floor(level);
      if (level < i + 1) level = 0;
      this.options.push({ level, ench: level > 0 ? this.pickEnchants(s, level) : [], seed: Math.random() });
    }
  }
  private pickEnchants(s: ItemStack, level: number): { id: string; level: number }[] {
    const cats = s.item.name === 'book' ? ['book'] : s.item.enchantCategories.concat(s.item.armorSlot === 'feet' ? ['armor_feet'] : [], s.item.armorSlot === 'head' ? ['armor_head'] : []);
    const pool = new Set<string>();
    for (const c of cats) for (const e of ENCH_POOL[c] ?? []) pool.add(e);
    const list = [...pool];
    if (!list.length) return [];
    const out: { id: string; level: number }[] = [];
    let l = level;
    const conflicts: Record<string, string[]> = { sharpness: ['smite', 'bane_of_arthropods'], smite: ['sharpness', 'bane_of_arthropods'], bane_of_arthropods: ['sharpness', 'smite'], protection: ['fire_protection', 'blast_protection', 'projectile_protection'], fire_protection: ['protection', 'blast_protection', 'projectile_protection'], blast_protection: ['protection', 'fire_protection', 'projectile_protection'], projectile_protection: ['protection', 'fire_protection', 'blast_protection'], fortune: ['silk_touch'], silk_touch: ['fortune'], infinity: ['mending'], mending: ['infinity'], depth_strider: ['frost_walker'], frost_walker: ['depth_strider'], riptide: ['loyalty', 'channeling'], loyalty: ['riptide'], channeling: ['riptide'], multishot: ['piercing'], piercing: ['multishot'] };
    while (list.length && (out.length === 0 || Math.random() < (l + 1) / 50)) {
      const id = list[Math.floor(Math.random() * list.length)];
      if (out.some((o) => o.id === id || conflicts[o.id]?.includes(id))) { list.splice(list.indexOf(id), 1); continue; }
      const max = maxLevel(id);
      const lvl = Math.max(1, Math.min(max, Math.round(l / (50 / max))));
      out.push({ id, level: lvl });
      list.splice(list.indexOf(id), 1);
      l = Math.floor(l / 2);
    }
    return out;
  }
  mouseDown(x: number, y: number, b: number): boolean {
    const lx = x - this.left, ly = y - this.top;
    for (let i = 0; i < 3; i++) {
      if (lx >= 60 && lx < 168 && ly >= 14 + i * 19 && ly < 33 + i * 19) {
        const o = this.options[i]; const s = this.item.get(0), lapis = this.item.get(1);
        const p = this.player;
        if (!o || o.level <= 0 || !s) return true;
        const lapisNeeded = i + 1;
        if (!p.isCreative && (p.xpLevel < o.level || !lapis || lapis.count < lapisNeeded)) return true;
        if (s.item.name === 'book') { s.item = this.gui.game.items.get('enchanted_book')!; s.extra = { enchantments: o.ench }; } else s.enchantments = o.ench;
        if (!p.isCreative) { p.addXpLevels(-(i + 1)); lapis!.count -= lapisNeeded; if (lapis!.count <= 0) this.item.set(1, null); }
        this.gui.game.sounds.play('block.enchantment_table.use', 1, 1);
        this.options = [];
        this.item.onChange = null as any; this.item.onChange = () => this.roll();
        return true;
      }
    }
    return super.mouseDown(x, y, b);
  }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    super.drawForeground(ctx, mx, my);
    const p = this.player, lapis = this.item.get(1);
    for (let i = 0; i < 3; i++) {
      const o = this.options[i];
      const y = 14 + i * 19;
      const enabled = o && o.level > 0 && (p.isCreative || (p.xpLevel >= o.level && lapis && lapis.count >= i + 1));
      const hov = mx >= 60 && mx < 168 && my >= y && my < y + 19;
      this.gui.drawSprite(ctx, o && o.level > 0 ? (enabled ? (hov ? 'gui/sprites/container/enchanting_table/enchantment_slot_highlighted' : 'gui/sprites/container/enchanting_table/enchantment_slot') : 'gui/sprites/container/enchanting_table/enchantment_slot_disabled') : 'gui/sprites/container/enchanting_table/enchantment_slot_disabled', 60, y, 108, 19);
      if (o && o.level > 0) {
        this.gui.drawSprite(ctx, enabled ? `gui/sprites/container/enchanting_table/level_${i + 1}` : `gui/sprites/container/enchanting_table/level_${i + 1}_disabled`, 60, y + 2, 16, 16);
        const glyph = '§k' + 'abcdefghij'.slice(0, 6 + i * 2);
        this.gui.font.draw(ctx, glyph, 78, y + 4, enabled ? 0x555555 : 0x404040, false);
        this.gui.font.drawRight(ctx, String(o.level), 166, y + 9, enabled ? 0x80ff20 : 0x404040);
        if (hov && o.ench.length) this.gui.queueTooltip([`§7${this.gui.game.assets.lang['enchantment.minecraft.' + o.ench[0].id] ?? o.ench[0].id} ${['I', 'II', 'III', 'IV', 'V'][o.ench[0].level - 1] ?? o.ench[0].level}§r…?`, enabled ? `§7${i + 1} Lapis Lazuli, ${i + 1} Enchantment Level${i > 0 ? 's' : ''}` : `§cLevel Requirement: ${o.level}`], mx + this.left, my + this.top);
      }
    }
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 2; i++) { const s = this.item.get(i); if (s && this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}

// ---------- smithing ----------
export class SmithingScreen extends ContainerScreenBase {
  inputs = new Inventory(3); output = new Inventory(1);
  buildSlots(): void {
    this.texture = 'gui/container/smithing'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.upgrade'] ?? 'Upgrade Gear';
    this.slots.push({ inv: this.inputs, index: 0, x: 8, y: 48, bg: 'gui/sprites/container/smithing/empty_slot_smithing_template_netherite_upgrade' }, { inv: this.inputs, index: 1, x: 26, y: 48 }, { inv: this.inputs, index: 2, x: 44, y: 48, bg: 'gui/sprites/container/smithing/empty_slot_ingot' });
    this.slots.push({ inv: this.output, index: 0, x: 98, y: 48, output: true, onTake: () => { for (let i = 0; i < 3; i++) { const s = this.inputs.get(i); if (s) { s.count--; if (s.count <= 0) this.inputs.set(i, null); } } this.gui.game.sounds.play('block.smithing_table.use', 1, 1); this.update(); } });
    this.inputs.onChange = () => this.update();
    this.addPlayerSlots(84);
  }
  update(): void {
    const g = this.gui.game;
    const r = g.recipes.smithingFor(this.inputs.get(0), this.inputs.get(1), this.inputs.get(2));
    const base = this.inputs.get(1);
    if (r && base && r.result) { const out = base.clone(); out.item = r.result; out.count = 1; this.output.slots[0] = out; }
    else if (r && base && r.trim) { const out = base.clone(); out.extra = { ...out.extra, trim: { pattern: this.inputs.get(0)?.item.name, material: this.inputs.get(2)?.item.name } }; this.output.slots[0] = out; }
    else this.output.slots[0] = null;
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 3; i++) { const s = this.inputs.get(i); if (s && this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}

// ---------- grindstone ----------
export class GrindstoneScreen extends ContainerScreenBase {
  inputs = new Inventory(2); output = new Inventory(1);
  buildSlots(): void {
    this.texture = 'gui/container/grindstone'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.grindstone_title'] ?? 'Repair & Disenchant';
    this.slots.push({ inv: this.inputs, index: 0, x: 49, y: 19 }, { inv: this.inputs, index: 1, x: 49, y: 40 });
    this.slots.push({ inv: this.output, index: 0, x: 129, y: 34, output: true, onTake: () => { let xp = 0; for (let i = 0; i < 2; i++) { const s = this.inputs.get(i); if (s) for (const e of s.enchantments) xp += e.level * 3 + Math.floor(Math.random() * (e.level * 3)); this.inputs.set(i, null); } if (xp) this.gui.game.spawnXp(this.player.x, this.player.y, this.player.z, xp); this.gui.game.sounds.play('block.grindstone.use', 1, 1); this.update(); } });
    this.inputs.onChange = () => this.update();
    this.addPlayerSlots(84);
  }
  update(): void {
    const a = this.inputs.get(0), b = this.inputs.get(1);
    const src = a ?? b;
    if (!src) { this.output.slots[0] = null; return; }
    if (a && b && a.item !== b.item) { this.output.slots[0] = null; return; }
    const out = src.clone(); out.count = 1;
    out.enchantments = src.enchantments.filter((e) => e.id.startsWith('curse') || e.id === 'binding_curse' || e.id === 'vanishing_curse');
    if (out.item.name === 'enchanted_book') { out.item = this.gui.game.items.get('book')!; out.extra = {}; }
    if (a && b && a.isDamageable) { const dur = Math.min(a.maxDurability, (a.maxDurability - a.damage) + (b.maxDurability - b.damage) + Math.floor(a.maxDurability * 0.05)); out.damage = a.maxDurability - dur; }
    delete out.extra.repairCost;
    this.output.slots[0] = out;
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 2; i++) { const s = this.inputs.get(i); if (s && this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}

// ---------- brewing ----------
export class BrewingScreen extends ContainerScreenBase {
  constructor(public be: BlockEntity) { super(); }
  buildSlots(): void {
    this.texture = 'gui/container/brewing_stand'; this.bgW = 176; this.bgH = 166;
    this.title = this.gui.game.assets.lang['container.brewing'] ?? 'Brewing Stand';
    const bottle = (s: ItemStack) => s.item.name === 'potion' || s.item.name === 'splash_potion' || s.item.name === 'lingering_potion' || s.item.name === 'glass_bottle';
    this.slots.push({ inv: this.be.inventory, index: 0, x: 56, y: 51, accepts: bottle, max: 1 }, { inv: this.be.inventory, index: 1, x: 79, y: 58, accepts: bottle, max: 1 }, { inv: this.be.inventory, index: 2, x: 102, y: 51, accepts: bottle, max: 1 });
    this.slots.push({ inv: this.be.inventory, index: 3, x: 79, y: 17 });
    this.slots.push({ inv: this.be.inventory, index: 4, x: 17, y: 17, accepts: (s) => s.item.name === 'blaze_powder', bg: 'gui/sprites/container/brewing_stand/fuel_length' });
    this.addPlayerSlots(84);
  }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    super.drawForeground(ctx, mx, my);
    const be = this.be;
    if (be.fuel > 0) { const w = Math.round(18 * be.fuel / 20); this.gui.drawSprite(ctx, 'gui/sprites/container/brewing_stand/fuel_length', 60, 44, w, 4, 0, 0, w, 4); }
    if (be.brewTime > 0) { const h = Math.round(28 * (1 - be.brewTime / 400)); this.gui.drawSprite(ctx, 'gui/sprites/container/brewing_stand/brew_progress', 97, 16, 9, h, 0, 0, 9, h); const bw = Math.round(24 * be.brewTime / 400); this.gui.drawSprite(ctx, 'gui/sprites/container/brewing_stand/bubbles', 63, 14 + 29 - bw, 12, bw, 0, 29 - bw, 12, bw); }
  }
}

// ---------- trading ----------
export class TradingScreen extends ContainerScreenBase {
  inputs = new Inventory(2); output = new Inventory(1);
  trades: { a: string; ac: number; b?: string; bc?: number; r: string; rc: number }[] = [];
  selected = -1;
  constructor(public mob: any) { super(); }
  buildSlots(): void {
    this.texture = 'gui/container/villager'; this.bgW = 276; this.bgH = 166;
    this.title = this.gui.game.assets.lang['entity.minecraft.villager'] ?? 'Villager';
    if (!this.mob.trades) this.mob.trades = this.generateTrades();
    this.trades = this.mob.trades;
    this.slots.push({ inv: this.inputs, index: 0, x: 136, y: 37 }, { inv: this.inputs, index: 1, x: 162, y: 37 });
    this.slots.push({ inv: this.output, index: 0, x: 220, y: 37, output: true, onTake: () => { const t = this.trades[this.selected]; if (!t) return; this.inputs.remove(t.a, t.ac); if (t.b) this.inputs.remove(t.b, t.bc!); this.gui.game.sounds.play('entity.villager.yes', 1, 1); this.gui.game.player.addXp(3); this.update(); } });
    this.inputs.onChange = () => this.update();
    this.addPlayerSlots(84 + 0);
    for (const s of this.slots) if (s.inv === this.player.inventory) s.x += 100;
  }
  private generateTrades() {
    const pools = [
      { a: 'wheat', ac: 20, r: 'emerald', rc: 1 }, { a: 'emerald', ac: 1, r: 'bread', rc: 6 }, { a: 'potato', ac: 26, r: 'emerald', rc: 1 }, { a: 'emerald', ac: 3, r: 'apple', rc: 4 },
      { a: 'emerald', ac: 1, r: 'arrow', rc: 16 }, { a: 'stick', ac: 32, r: 'emerald', rc: 1 }, { a: 'emerald', ac: 2, r: 'bow', rc: 1 }, { a: 'paper', ac: 24, r: 'emerald', rc: 1 },
      { a: 'emerald', ac: 5, r: 'iron_pickaxe', rc: 1 }, { a: 'coal', ac: 15, r: 'emerald', rc: 1 }, { a: 'emerald', ac: 4, r: 'iron_helmet', rc: 1 }, { a: 'emerald', ac: 7, r: 'iron_chestplate', rc: 1 }, { a: 'emerald', ac: 1, r: 'cooked_beef', rc: 5 }, { a: 'string', ac: 20, r: 'emerald', rc: 1 }, { a: 'emerald', ac: 6, r: 'enchanted_book', rc: 1 },
    ];
    const n = 3 + Math.floor(Math.random() * 4);
    const out = [] as typeof pools;
    while (out.length < n) { const t = pools[Math.floor(Math.random() * pools.length)]; if (!out.includes(t)) out.push(t); }
    return out;
  }
  update(): void {
    const t = this.trades[this.selected];
    if (!t) { this.output.slots[0] = null; return; }
    const ok = this.inputs.count(t.a) >= t.ac && (!t.b || this.inputs.count(t.b) >= t.bc!);
    const r = this.gui.game.items.get(t.r);
    this.output.slots[0] = ok && r ? new ItemStack(r, t.rc, 0, t.r === 'enchanted_book' ? [] : [], null, t.r === 'enchanted_book' ? { enchantments: [{ id: 'unbreaking', level: 2 }] } : {}) : null;
  }
  mouseDown(x: number, y: number, b: number): boolean {
    const lx = x - this.left, ly = y - this.top;
    if (lx >= 5 && lx < 93 && ly >= 18) { const i = Math.floor((ly - 18) / 20); if (this.trades[i]) { this.selected = i; this.update(); return true; } }
    return super.mouseDown(x, y, b);
  }
  drawForeground(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    this.gui.font.draw(ctx, this.title, 100, 6, 0x404040, false);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['container.inventory'] ?? 'Inventory', 108, 72, 0x404040, false);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['merchant.trades'] ?? 'Trades', 5, 6, 0x404040, false);
    const g = this.gui.game;
    this.trades.forEach((t, i) => {
      const y = 18 + i * 20;
      if (i === this.selected) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(5, y, 88, 20); }
      this.gui.drawItem(ctx, new ItemStack(g.items.get(t.a)!, t.ac), 7, y + 1);
      if (t.b) this.gui.drawItem(ctx, new ItemStack(g.items.get(t.b)!, t.bc), 25, y + 1);
      this.gui.drawSprite(ctx, 'gui/sprites/container/villager/trade_arrow', 45, y + 5, 10, 9);
      this.gui.drawItem(ctx, new ItemStack(g.items.get(t.r)!, t.rc), 65, y + 1);
      const hov = mx >= 5 && mx < 93 && my >= y && my < y + 20;
      if (hov && !this.carried) this.gui.queueTooltip([`${t.ac} ${g.items.displayName(t.a)}${t.b ? ' + ' + t.bc + ' ' + g.items.displayName(t.b) : ''} → ${t.rc} ${g.items.displayName(t.r)}`], mx + this.left, my + this.top);
    });
  }
  onClose(): void { super.onClose(); for (let i = 0; i < 2; i++) { const s = this.inputs.get(i); if (s && this.player.inventory.add(s) > 0) this.player.throwItem(s); } }
}
