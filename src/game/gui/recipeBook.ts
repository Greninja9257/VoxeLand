// Recipe book panel (vanilla RecipeBookComponent) for the inventory and crafting table screens: tabs, search,
// craftable-only filter, paged 5x4 recipe grid, click to fill the crafting grid (ghost recipe when missing items).
import type { ContainerScreenBase } from './containers';
import { Inventory, ItemStack } from '../../items/stack';
import type { CraftingRecipe } from '../../items/recipes';
import { TextField } from './widgets';

const TAB_ICONS = ['compass', 'bricks', 'iron_axe', 'lava_bucket'];
const TAB_FILTERS: ((name: string) => boolean)[] = [
  () => true,
  (n) => /planks|log|wood|stone|brick|slab|stairs|wall|cobble|sandstone|deepslate|granite|diorite|andesite|tuff|quartz|purpur|copper|prismarine|blackstone|basalt|nether_brick|bamboo|mud|glass|smooth|polished|chiseled|cut_|cracked|door|trapdoor|fence|hay_block|bone_block|concrete|terracotta|wool|carpet|_block$|bookshelf|iron_bars|chain$|ladder|scaffolding|lantern|torch|bed$|banner|sign|candle/.test(n),
  (n) => /_pickaxe|_axe$|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|bow$|crossbow|arrow|shield|shears|flint_and_steel|fishing_rod|bucket|compass|clock|spyglass|trident|mace|elytra|_horse_armor/.test(n),
  (n) => !TAB_FILTERS[1](n) && !TAB_FILTERS[2](n),
];

export class RecipeBookPanel {
  static open = false;
  static tab = 0;
  static craftableOnly = false;
  x = 0; y = 0;
  page = 0;
  search: TextField;
  list: CraftingRecipe[] = [];
  pages: CraftingRecipe[][] = [];
  ghost: CraftingRecipe | null = null;
  private hovered: CraftingRecipe | null = null;
  constructor(public screen: ContainerScreenBase, public grid: Inventory, public gridW: number, public gridH: number) {
    this.search = new TextField(0, 0, 80, 12, ''); this.search.bordered = false; this.search.placeholder = 'Search...';
    this.search.onChange = () => { this.page = 0; this.refresh(); };
  }
  get game() { return this.screen.gui.game; }
  get visible(): boolean { return RecipeBookPanel.open && this.screen.width >= 379; }
  /** Book's top-left; the container screen is pushed 77 px right while the book is open (vanilla 177 + (w-imageWidth-200)/2). */
  layout(): void {
    const s = this.screen;
    if (this.visible) { s.left = 177 + Math.floor((s.width - s.bgW - 200) / 2); this.x = Math.floor((s.width - 147) / 2) - 86; }
    else { s.left = Math.floor((s.width - s.bgW) / 2); }
    this.y = Math.floor((s.height - 166) / 2);
    this.search.x = this.x + 25; this.search.y = this.y + 14; this.search.w = 80; this.search.h = 14;
  }
  toggle(): void { RecipeBookPanel.open = !RecipeBookPanel.open; this.layout(); this.refresh(); this.game.sounds.play('ui.button.click', 0.25, 1); }

  refresh(): void {
    const g = this.game;
    const q = this.search.text.toLowerCase().trim();
    const tab = TAB_FILTERS[RecipeBookPanel.tab];
    const seen = new Set<string>();
    this.list = [];
    for (const r of g.recipes.crafting) {
      if (r.width > this.gridW || r.height > this.gridH) continue;
      const n = r.result.item.name;
      if (!tab(n)) continue;
      if (q && !n.includes(q.replace(/ /g, '_')) && !g.items.displayName(n).toLowerCase().includes(q)) continue;
      if (RecipeBookPanel.craftableOnly && !this.canCraft(r)) continue;
      // one entry per result item (vanilla groups variants); keep the first craftable one
      const key = n + ':' + r.result.count;
      if (seen.has(key)) continue;
      seen.add(key);
      this.list.push(r);
    }
    // craftable first like vanilla
    this.list.sort((a, b) => (this.canCraft(b) ? 1 : 0) - (this.canCraft(a) ? 1 : 0));
    this.pages = []; for (let i = 0; i < this.list.length; i += 20) this.pages.push(this.list.slice(i, i + 20));
    this.page = Math.max(0, Math.min(this.page, this.pages.length - 1));
  }

  /** Count how many times the recipe can be crafted from the player inventory + crafting grid. */
  craftCount(r: CraftingRecipe): number {
    const p = this.game.player;
    const avail = new Map<string, number>();
    for (const inv of [p.inventory, this.grid]) for (const s of inv.slots) if (s) avail.set(s.item.name, (avail.get(s.item.name) ?? 0) + s.count);
    let count = 0;
    const cells = r.pattern.filter((c) => c) as Set<string>[];
    if (!cells.length) return 0;
    for (;;) {
      const used = new Map<string, number>();
      let ok = true;
      for (const cell of cells) {
        let found = false;
        for (const n of cell) { const left = (avail.get(n) ?? 0) - (used.get(n) ?? 0); if (left > 0) { used.set(n, (used.get(n) ?? 0) + 1); found = true; break; } }
        if (!found) { ok = false; break; }
      }
      if (!ok) break;
      for (const [n, c] of used) avail.set(n, (avail.get(n) ?? 0) - c);
      count++;
      if (count >= 64) break;
    }
    return count;
  }
  canCraft(r: CraftingRecipe): boolean { return this.craftCount(r) > 0; }

  /** Move ingredients from the inventory into the crafting grid (vanilla ServerPlaceRecipe). */
  place(r: CraftingRecipe, max: boolean): void {
    const p = this.game.player, g = this.game;
    // return current grid contents first
    for (let i = 0; i < this.grid.size; i++) { const s = this.grid.slots[i]; if (s) { if (p.inventory.add(s) > 0) p.throwItem(s); this.grid.slots[i] = null; } }
    const n = max ? this.craftCount(r) : 1;
    if (n === 0) { this.ghost = r; this.grid.onChange?.(); return; }
    this.ghost = null;
    const per = Math.max(1, Math.min(n, max ? 64 : 1));
    // shaped recipes may be placed at any offset in a larger grid; vanilla puts them top-left
    for (let ry = 0; ry < r.height; ry++) for (let rx = 0; rx < r.width; rx++) {
      const cell = r.pattern[ry * r.width + rx];
      if (!cell) continue;
      const gi = ry * this.gridW + rx;
      for (let k = 0; k < per; k++) {
        let taken: ItemStack | null = null;
        for (let i = 0; i < p.inventory.size && !taken; i++) { const s = p.inventory.get(i); if (s && cell.has(s.item.name)) { taken = s.clone(); taken.count = 1; s.count--; if (s.count <= 0) p.inventory.set(i, null); } }
        if (!taken) break;
        const cur = this.grid.slots[gi];
        if (cur && cur.canStackWith(taken)) cur.count++; else this.grid.slots[gi] = taken;
      }
    }
    p.inventory.onChange?.();
    this.grid.onChange?.();
    g.sounds.play('ui.button.click', 0.25, 1);
  }

  // ---- drawing ----
  render(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
    if (!this.visible) return;
    const gui = this.screen.gui, g = this.game;
    const x = this.x, y = this.y;
    gui.drawSprite(ctx, 'gui/recipe_book', x, y, 147, 166, 0, 0, 147, 166);
    // tabs
    TAB_ICONS.forEach((icon, i) => {
      const sel = RecipeBookPanel.tab === i;
      const tx = x - 30 + (sel ? 2 : 0), ty = y + 3 + i * 27;
      gui.drawSprite(ctx, sel ? 'gui/sprites/recipe_book/tab_selected' : 'gui/sprites/recipe_book/tab', tx, ty, 35, 27);
      const it = g.items.get(icon); if (it) gui.drawItem(ctx, new ItemStack(it, 1), tx + 9 + (sel ? 0 : 0), ty + 6, false);
    });
    // search + filter
    this.search.render(ctx, mx, my, 0, this.screen);
    const fh = mx >= x + 110 && mx < x + 136 && my >= y + 12 && my < y + 28;
    gui.drawSprite(ctx, `gui/sprites/recipe_book/filter_${RecipeBookPanel.craftableOnly ? 'enabled' : 'disabled'}${fh ? '_highlighted' : ''}`, x + 110, y + 12, 26, 16);
    // recipes
    this.hovered = null;
    const page = this.pages[this.page] ?? [];
    page.forEach((r, i) => {
      const col = i % 5, row = Math.floor(i / 5);
      const bx = x + 11 + col * 25, by = y + 31 + row * 25;
      const craftable = this.canCraft(r);
      const many = g.recipes.recipesFor(r.result.item.name).length > 1;
      gui.drawSprite(ctx, `gui/sprites/recipe_book/slot_${many ? 'many_' : ''}${craftable ? 'craftable' : 'uncraftable'}`, bx, by, 25, 25);
      gui.drawItem(ctx, new ItemStack(r.result.item, r.result.count), bx + 4, by + 4);
      if (mx >= bx && mx < bx + 25 && my >= by && my < by + 25) { this.hovered = r; ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(bx + 2, by + 2, 21, 21); }
    });
    const hov = this.hovered as CraftingRecipe | null;
    if (hov) { const lines = gui.itemTooltipLines(new ItemStack(hov.result.item, hov.result.count)); if (!this.canCraft(hov)) lines.push('§cMissing ingredients'); gui.queueTooltip(lines, mx, my); }
    // page buttons
    if (this.pages.length > 1) {
      const bh = mx >= x + 38 && mx < x + 50 && my >= y + 137 && my < y + 154, fh2 = mx >= x + 93 && mx < x + 105 && my >= y + 137 && my < y + 154;
      if (this.page > 0) gui.drawSprite(ctx, `gui/sprites/recipe_book/page_backward${bh ? '_highlighted' : ''}`, x + 38, y + 137, 12, 17);
      if (this.page < this.pages.length - 1) gui.drawSprite(ctx, `gui/sprites/recipe_book/page_forward${fh2 ? '_highlighted' : ''}`, x + 93, y + 137, 12, 17);
      gui.font.drawCentered(ctx, `${this.page + 1}/${this.pages.length}`, x + 73, y + 141, 0xffffff);
    }
    if (!page.length) gui.font.drawCentered(ctx, RecipeBookPanel.craftableOnly ? 'Nothing craftable' : 'No recipes', x + 73, y + 80, 0x808080);
  }
  /** Ghost items in the crafting grid for a recipe the player cannot craft yet. */
  renderGhost(ctx: CanvasRenderingContext2D, gridX: number, gridY: number): void {
    const r = this.ghost; if (!r) return;
    for (let ry = 0; ry < r.height; ry++) for (let rx = 0; rx < r.width; rx++) {
      const cell = r.pattern[ry * r.width + rx]; if (!cell) continue;
      if (this.grid.slots[ry * this.gridW + rx]) continue;
      const name = [...cell][Math.floor(performance.now() / 1000) % cell.size];
      const it = this.game.items.get(name); if (!it) continue;
      ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#8b8b8b'; ctx.fillRect(gridX + rx * 18, gridY + ry * 18, 16, 16); ctx.globalAlpha = 0.7; this.screen.gui.drawItem(ctx, new ItemStack(it, 1), gridX + rx * 18, gridY + ry * 18, false); ctx.restore();
    }
  }

  // ---- input ----
  mouseDown(mx: number, my: number, button: number, shift: boolean): boolean {
    if (!this.visible) return false;
    const x = this.x, y = this.y;
    // tabs
    for (let i = 0; i < 4; i++) { const tx = x - 30, ty = y + 3 + i * 27; if (mx >= tx && mx < tx + 35 && my >= ty && my < ty + 27) { RecipeBookPanel.tab = i; this.page = 0; this.refresh(); this.game.sounds.play('ui.button.click', 0.25, 1); return true; } }
    if (mx >= x + 110 && mx < x + 136 && my >= y + 12 && my < y + 28) { RecipeBookPanel.craftableOnly = !RecipeBookPanel.craftableOnly; this.refresh(); this.game.sounds.play('ui.button.click', 0.25, 1); return true; }
    if (this.search.contains(mx, my)) { this.screen.focused = this.search; this.search.mouseDown(mx, my, button, this.screen); return true; }
    if (this.pages.length > 1) {
      if (mx >= x + 38 && mx < x + 50 && my >= y + 137 && my < y + 154 && this.page > 0) { this.page--; this.game.sounds.play('ui.button.click', 0.25, 1); return true; }
      if (mx >= x + 93 && mx < x + 105 && my >= y + 137 && my < y + 154 && this.page < this.pages.length - 1) { this.page++; this.game.sounds.play('ui.button.click', 0.25, 1); return true; }
    }
    const page = this.pages[this.page] ?? [];
    for (let i = 0; i < page.length; i++) {
      const col = i % 5, row = Math.floor(i / 5);
      const bx = x + 11 + col * 25, by = y + 31 + row * 25;
      if (mx >= bx && mx < bx + 25 && my >= by && my < by + 25) {
        // right click cycles alternative recipes for the same result
        let r = page[i];
        if (button === 2) { const alts = this.game.recipes.recipesFor(r.result.item.name).filter((a) => a.width <= this.gridW && a.height <= this.gridH); const idx = alts.indexOf(r); if (alts.length > 1) { r = alts[(idx + 1) % alts.length]; page[i] = r; } }
        this.place(r, shift);
        return true;
      }
    }
    // clicks inside the book panel are consumed
    if (mx >= x - 30 && mx < x + 147 && my >= y && my < y + 166) { this.screen.focused = null; return true; }
    return false;
  }
  keyDown(code: string, key: string, mods: any): boolean {
    if (!this.visible || this.screen.focused !== this.search) return false;
    if (code === 'Escape') return false;
    this.search.keyDown(code, key, mods);
    return true;
  }
  typed(ch: string): boolean { if (!this.visible || this.screen.focused !== this.search) return false; this.search.typed(ch); return true; }
  wheel(dy: number, mx: number, my: number): boolean {
    if (!this.visible || mx < this.x || mx >= this.x + 147 || my < this.y || my >= this.y + 166) return false;
    this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + Math.sign(dy)));
    return true;
  }
}
