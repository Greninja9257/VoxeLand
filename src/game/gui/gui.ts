// GUI manager: 2D overlay canvas, HUD, screens, sprites, tooltips, chat.
import type { Game } from '../game';
import { MinecraftFont, loadImg } from './font';
import type { Screen } from './widgets';
import type { ItemStack, Inventory } from '../../items/stack';
import { ContainerScreen, InventoryScreen, CraftingScreen, FurnaceScreen, CreativeScreen, StonecutterScreen, AnvilScreen, EnchantingScreen, SmithingScreen, GrindstoneScreen, BrewingScreen, TradingScreen } from './containers';
import { EnderDragonEntity, WitherEntity } from '../../entity/boss';
import { LivingEntity } from '../../entity/entity';
import { ChatScreen, DeathScreen, PauseScreen, TitleScreen } from './screens';
import type { BlockEntity } from '../blockEntities';
import { BIOMES } from '../../world/gen/biomes';
import { lookDir } from '../../math';

export interface ChatLine { text: string; time: number }

/** java.util.Random-compatible sequence used by vanilla's HUD after setSeed(tick * 312871). */
function vanillaHudRandom(seed: number): () => number {
  const multiplier = 0x5deece66dn, addend = 0xbn, mask = (1n << 48n) - 1n;
  let state = (BigInt(Math.trunc(seed)) ^ multiplier) & mask;
  const next = (bits: number) => { state = (state * multiplier + addend) & mask; return Number(state >> BigInt(48 - bits)); };
  return () => {
    let bits: number, value: number;
    do { bits = next(31); value = bits % 3; } while (bits - value + 2 >= 0x80000000);
    return value;
  };
}

export class Gui {
  ctx: CanvasRenderingContext2D;
  font = new MinecraftFont();
  scale = 2;
  width = 0; height = 0;
  private sprites = new Map<string, HTMLImageElement | null>();
  screen: Screen | null = null;
  chat: ChatLine[] = [];
  chatHistory: string[] = [];
  actionBar = { text: '', time: 0 };
  heldItemName = { text: '', time: 0 };
  hideHud = false;
  showDebug = false;
  showPlayerList = false;
  hurtFlash = 0;
  private tooltip: { lines: string[]; x: number; y: number } | null = null;
  private nameTags: { text: string; x: number; y: number; z: number }[] = [];
  spyglass = false;
  titleText: { title: string; subtitle: string; time: number; fadeIn: number; stay: number; fadeOut: number } | null = null;
  fps = 0; private frames = 0; private fpsTime = 0;
  mouseX = 0; mouseY = 0;
  private mouseDownState = new Set<number>();
  sleepFade = 0;
  thirdPerson = 0;
  showSubtitles = false;

  constructor(public game: Game, public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  async load(): Promise<void> { await this.font.load(); }

  // ---------- sprites ----------
  sprite(name: string): HTMLImageElement | null {
    const s = this.sprites.get(name);
    if (s !== undefined) return s;
    this.sprites.set(name, null);
    loadImg('./assets/pack/assets/minecraft/textures/' + name + '.png').then((img) => this.sprites.set(name, img)).catch(() => {});
    return null;
  }
  drawSprite(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w?: number, h?: number, sx = 0, sy = 0, sw?: number, sh?: number): void {
    const img = this.sprite(name);
    if (!img) return;
    ctx.drawImage(img, sx, sy, sw ?? img.width, sh ?? img.height, x, y, w ?? sw ?? img.width, h ?? sh ?? img.height);
  }
  drawNineSlice(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number, b: number): void {
    const img = this.sprite(name);
    if (!img) { ctx.fillStyle = '#6d6d6d'; ctx.fillRect(x, y, w, h); return; }
    const iw = img.width, ih = img.height;
    const d = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => { if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh); };
    d(0, 0, b, b, x, y, b, b); d(iw - b, 0, b, b, x + w - b, y, b, b); d(0, ih - b, b, b, x, y + h - b, b, b); d(iw - b, ih - b, b, b, x + w - b, y + h - b, b, b);
    d(b, 0, iw - 2 * b, b, x + b, y, w - 2 * b, b); d(b, ih - b, iw - 2 * b, b, x + b, y + h - b, w - 2 * b, b);
    d(0, b, b, ih - 2 * b, x, y + b, b, h - 2 * b); d(iw - b, b, b, ih - 2 * b, x + w - b, y + b, b, h - 2 * b);
    d(b, b, iw - 2 * b, ih - 2 * b, x + b, y + b, w - 2 * b, h - 2 * b);
  }
  drawTiled(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number, tile = 16, alpha = 1): void {
    const img = this.sprite(name);
    if (!img) { ctx.fillStyle = `rgba(48,48,48,${alpha})`; ctx.fillRect(x, y, w, h); return; }
    ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (let yy = y; yy < y + h; yy += tile) for (let xx = x; xx < x + w; xx += tile) ctx.drawImage(img, xx, yy, tile, tile);
    ctx.restore();
  }
  drawScreenBackground(ctx: CanvasRenderingContext2D): void {
    if (this.game.inWorld) { ctx.fillStyle = 'rgba(16,16,16,0.75)'; ctx.fillRect(0, 0, this.width, this.height); }
    else this.drawTiled(ctx, 'gui/menu_background', 0, 0, this.width, this.height, 32);
  }
  drawListBackground(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    if (this.game.inWorld) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, w, h); }
    else this.drawTiled(ctx, 'gui/menu_list_background', x, y, w, h, 32);
  }
  fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); }

  private vignetteCanvas: HTMLCanvasElement | null = null;
  private vignetteBrightness = 0;
  /** vanilla draws vignette.png with (ZERO, ONE_MINUS_SRC_COLOR): dst *= 1 - tex. The GUI canvas is alpha-composited
   *  over the world, so bake it as black with alpha = texture brightness (the centre is black = untouched). */
  private vignette(): HTMLCanvasElement | null {
    if (this.vignetteCanvas) return this.vignetteCanvas;
    const img = this.sprite('misc/vignette');
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) { const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3; d.data[i] = 0; d.data[i + 1] = 0; d.data[i + 2] = 0; d.data[i + 3] = lum; }
    ctx.putImageData(d, 0, 0);
    this.vignetteCanvas = c;
    return c;
  }

  // ---------- items ----------
  drawItem(ctx: CanvasRenderingContext2D, stack: ItemStack | null, x: number, y: number, showCount = true): void {
    if (!stack || stack.count <= 0) return;
    const icon = this.game.itemRenderer.icon(stack);
    ctx.drawImage(icon, x, y, 16, 16);
    if (stack.enchantments.length) { ctx.save(); ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = '#8040ff'; ctx.fillRect(x + 2, y + 2, 12, 12); ctx.restore(); }
    if (stack.isDamageable && stack.damage > 0) {
      const f = 1 - stack.damage / stack.maxDurability;
      const hue = Math.max(0, f) / 3;
      ctx.fillStyle = '#000'; ctx.fillRect(x + 2, y + 13, 13, 2);
      ctx.fillStyle = `hsl(${hue * 360},100%,50%)`; ctx.fillRect(x + 2, y + 13, Math.round(13 * f), 1);
    }
    if (showCount && stack.count > 1) this.font.drawRight(ctx, String(stack.count), x + 17, y + 9, 0xffffff);
    const cd = this.game.player?.itemCooldowns.get(stack.item.name);
    if (cd) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; const h = 16 * Math.min(1, cd / 20); ctx.fillRect(x, y + 16 - h, 16, h); }
  }
  itemTooltipLines(stack: ItemStack): string[] {
    const g = this.game;
    const lines: string[] = [];
    const name = stack.customName ?? g.items.displayName(stack.item.name);
    const rare = stack.enchantments.length > 0 || stack.item.name.includes('golden_apple') || stack.item.name === 'elytra' || stack.item.name === 'totem_of_undying';
    lines.push((stack.customName ? '§o' : rare ? '§b' : '') + name + (stack.customName ? '§r' : ''));
    if (stack.extra?.potion) { const e = stack.extra.effect; lines.push('§9' + (e ? `${g.assets.lang['effect.minecraft.' + e.id] ?? e.id}${e.amplifier > 0 ? ' ' + ['I', 'II', 'III', 'IV'][e.amplifier] : ''} (${Math.floor(e.duration / 1200)}:${String(Math.floor(e.duration / 20) % 60).padStart(2, '0')})` : g.assets.lang['effect.none'] ?? 'No Effects')); }
    for (const e of stack.enchantments) lines.push('§7' + (g.assets.lang['enchantment.minecraft.' + e.id] ?? e.id) + (e.level > 1 || true ? ' ' + toRoman(e.level) : ''));
    if (stack.item.food) { /* nothing in vanilla */ }
    if (stack.item.attackDamage > 1 || stack.item.tool !== 'none') { lines.push(''); lines.push('§7' + (g.assets.lang['item.modifiers.mainhand'] ?? 'When in Main Hand:')); if (stack.item.attackDamage > 1) lines.push(` §2${(stack.item.attackDamage + (stack.enchantLevel('sharpness') ? 0.5 + stack.enchantLevel('sharpness') * 0.5 : 0)).toFixed(0).replace(/\.0$/, '')} ${g.assets.lang['attribute.name.attack_damage'] ?? 'Attack Damage'}`); if (stack.item.attackSpeed !== 4) lines.push(` §2${stack.item.attackSpeed} ${g.assets.lang['attribute.name.attack_speed'] ?? 'Attack Speed'}`); }
    if (stack.item.armor > 0) { lines.push(''); lines.push('§7' + (g.assets.lang['item.modifiers.' + stack.item.armorSlot] ?? 'When on Body:')); lines.push(` §9+${stack.item.armor} ${g.assets.lang['attribute.name.armor'] ?? 'Armor'}`); if (stack.item.armorToughness) lines.push(` §9+${stack.item.armorToughness} ${g.assets.lang['attribute.name.armor_toughness'] ?? 'Armor Toughness'}`); }
    if (stack.isDamageable && stack.damage > 0) lines.push(`§7${(g.assets.lang['item.durability'] ?? 'Durability: %s / %s').replace('%s', String(stack.maxDurability - stack.damage)).replace('%s', String(stack.maxDurability))}`);
    if (this.showDebug) { lines.push('§8minecraft:' + stack.item.name); }
    return lines;
  }
  queueTooltip(lines: string[], x: number, y: number): void { this.tooltip = { lines, x, y }; }
  private drawTooltip(ctx: CanvasRenderingContext2D): void {
    if (!this.tooltip) return;
    const { lines } = this.tooltip;
    let w = 0; for (const l of lines) w = Math.max(w, this.font.width(l));
    const h = lines.length * 10 - 2 + (lines.length > 1 ? 2 : 0);
    let x = this.tooltip.x + 12, y = this.tooltip.y - 12;
    if (x + w + 8 > this.width) x = this.tooltip.x - 16 - w;
    if (y + h + 6 > this.height) y = this.height - h - 6;
    if (y < 4) y = 4;
    ctx.fillStyle = 'rgba(16,0,16,0.94)'; ctx.fillRect(x - 3, y - 4, w + 6, h + 8);
    const grad = ctx.createLinearGradient(0, y - 3, 0, y + h + 3);
    grad.addColorStop(0, 'rgba(80,0,255,0.31)'); grad.addColorStop(1, 'rgba(40,0,127,0.31)');
    ctx.strokeStyle = grad; ctx.lineWidth = 1; ctx.strokeRect(x - 2.5, y - 3.5, w + 5, h + 7);
    let ly = y;
    for (let i = 0; i < lines.length; i++) { this.font.draw(ctx, lines[i], x, ly, 0xffffff); ly += 10 + (i === 0 && lines.length > 1 ? 2 : 0); }
    this.tooltip = null;
  }

  // ---------- screens ----------
  open(screen: Screen): void {
    if (this.screen) this.screen.onClose();
    this.screen = screen;
    screen.gui = this;
    screen.width = this.width; screen.height = this.height;
    screen.init();
    // Browsers never treat Esc as a user gesture, so a pointer lock released by Esc can only be re-acquired on the
    // next click/key. In fullscreen with Keyboard Lock the browser leaves the lock alone, so keep it and draw a
    // software cursor; otherwise release it and use the OS cursor.
    const input = this.game.input;
    if (this.game.inWorld && input.keyboardLocked && input.pointerLocked) input.softCursor = true;
    else { input.softCursor = false; input.unlockPointer(); }
    this.game.onScreenChanged();
  }
  close(): void {
    if (!this.screen) return;
    const s = this.screen;
    this.screen = null;
    s.onClose();
    this.game.input.softCursor = false;
    if (this.game.inWorld) this.game.input.lockPointer();
    this.game.onScreenChanged();
  }
  get isOpen(): boolean { return this.screen !== null; }

  openContainer(inv: Inventory, titleKey: string, rows: number, onClose?: () => void, cols = 9): void { this.open(new ContainerScreen(inv, this.game.assets.lang[titleKey] ?? titleKey, rows, cols, onClose)); }
  openInventory(): void { this.open(this.game.player.isCreative ? new CreativeScreen() : new InventoryScreen()); }
  openCrafting(): void { this.open(new CraftingScreen()); }
  openFurnace(be: BlockEntity, kind: string): void { this.open(new FurnaceScreen(be, kind)); }
  openStonecutter(): void { this.open(new StonecutterScreen()); }
  openAnvil(): void { this.open(new AnvilScreen()); }
  openEnchanting(x: number, y: number, z: number): void { this.open(new EnchantingScreen(x, y, z)); }
  openSmithing(): void { this.open(new SmithingScreen()); }
  openGrindstone(): void { this.open(new GrindstoneScreen()); }
  openBrewing(be: BlockEntity): void { this.open(new BrewingScreen(be)); }
  openTrading(mob: any): void { this.open(new TradingScreen(mob)); }
  openChat(initial = ''): void { this.open(new ChatScreen(initial)); }
  openPause(): void { this.open(new PauseScreen()); }
  openDeath(): void { this.open(new DeathScreen()); }
  openTitle(): void { this.open(new TitleScreen()); }

  // ---------- messages ----------
  addChat(text: string): void { this.chat.push({ text, time: 0 }); if (this.chat.length > 100) this.chat.shift(); }
  showActionBar(text: string): void { this.actionBar = { text, time: 60 }; }
  showTitle(title: string, subtitle = '', fadeIn = 10, stay = 70, fadeOut = 20): void { this.titleText = { title, subtitle, time: 0, fadeIn, stay, fadeOut }; }
  onPlayerHurt(): void { this.hurtFlash = 10; }
  queueNameTag(text: string, x: number, y: number, z: number): void { this.nameTags.push({ text, x, y, z }); }
  onHeldItemChanged(): void { const s = this.game.player?.heldItem(); this.heldItemName = { text: s ? (s.customName ?? this.game.items.displayName(s.item.name)) : '', time: 40 }; }

  // ---------- per-frame ----------
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const pw = Math.floor(cw * dpr), ph = Math.floor(ch * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
    const opt = this.game.options.guiScale;
    let scale = opt === 0 ? Math.max(1, Math.min(Math.floor(pw / 320), Math.floor(ph / 240))) : opt * dpr;
    if (opt === 0) scale = Math.min(scale, 4 * dpr);
    scale = Math.max(1, scale);
    const w = Math.ceil(pw / scale), h = Math.ceil(ph / scale);
    if (scale !== this.scale || w !== this.width || h !== this.height) {
      this.scale = scale; this.width = w; this.height = h;
      if (this.screen) { this.screen.width = w; this.screen.height = h; this.screen.resize(); }
    }
  }

  tick(): void {
    for (const c of this.chat) c.time++;
    if (this.actionBar.time > 0) this.actionBar.time--;
    if (this.heldItemName.time > 0) this.heldItemName.time--;
    if (this.hurtFlash > 0) this.hurtFlash--;
    if (this.titleText) { this.titleText.time++; if (this.titleText.time > this.titleText.fadeIn + this.titleText.stay + this.titleText.fadeOut) this.titleText = null; }
    this.screen?.tick();
  }

  /** Software cursor shown while a screen is open with the pointer still locked. */
  private drawCursor(ctx: CanvasRenderingContext2D): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = this.game.input.mouseX, y = this.game.input.mouseY;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 16); ctx.lineTo(x + 4, y + 12); ctx.lineTo(x + 7, y + 18); ctx.lineTo(x + 9, y + 17); ctx.lineTo(x + 6, y + 11); ctx.lineTo(x + 11, y + 11); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.restore();
  }

  handleInput(): void {
    const input = this.game.input;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.mouseX = input.mouseX * dpr / this.scale; this.mouseY = input.mouseY * dpr / this.scale;
    const s = this.screen;
    if (!s) return;
    s.mouseMove(this.mouseX, this.mouseY);
    for (const b of input.buttonsPressed) { s.mouseDown(this.mouseX, this.mouseY, b); this.mouseDownState.add(b); }
    for (const b of input.buttonsReleased) { s.mouseUp(this.mouseX, this.mouseY, b); this.mouseDownState.delete(b); }
    if (input.wheel) s.wheel(input.wheel, this.mouseX, this.mouseY);
    const mods = { shift: input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'), ctrl: input.keys.has('ControlLeft') || input.keys.has('MetaLeft') };
    for (const code of input.pressed) {
      const handled = s.keyDown(code, code, mods);
      if (!handled && this.screen === s) {
        if (code === input.key('inventory') && (s as any).isInventoryLike) this.close();
      }
    }
    if (this.screen === s) for (const ch of input.typed) s.typed(ch);
  }

  render(partial: number, dt: number): void {
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.width, this.height);
    this.frames++; this.fpsTime += dt; if (this.fpsTime >= 1) { this.fps = this.frames; this.frames = 0; this.fpsTime = 0; }
    const g = this.game;
    if (g.inWorld && !this.hideHud && !(this.screen && this.screen.hidesHud)) this.drawHud(ctx, partial);
    if (g.inWorld && this.showDebug && !(this.screen && this.screen.hidesHud)) this.drawDebug(ctx);
    if (g.inWorld && (this.showPlayerList || g.input.isDown('playerList')) && !(this.screen && this.screen.hidesHud)) this.drawPlayerList(ctx);
    if (this.screen) { this.screen.drawBackground(ctx); this.screen.render(ctx, this.mouseX, this.mouseY, partial); }
    if (this.screen && this.game.input.pointerLocked && this.game.input.softCursor) this.drawCursor(ctx);
    this.drawTooltip(ctx);
    this.nameTags.length = 0;
  }

  // ---------- HUD ----------
  private drawHud(ctx: CanvasRenderingContext2D, partial: number): void {
    const g = this.game, p = g.player;
    const w = this.width, h = this.height;
    // overlays
    if (p.eyeInWater) { this.drawTiledFull(ctx, 'misc/underwater', 0.35); }
    if (p.fireTicks > 0 && !p.isFireImmune()) { const t = this.sprite('block/fire_1'); if (t) { ctx.save(); ctx.globalAlpha = 0.9; const fh = h * 0.5; ctx.drawImage(t, 0, 0, 16, 16, 0, h - fh, w, fh); ctx.restore(); } }
    if (p.armor.get(0)?.item.name === 'carved_pumpkin' && this.thirdPerson === 0) this.drawSprite(ctx, 'misc/pumpkinblur', 0, 0, w, h);
    if (this.spyglass) { const s = this.sprite('misc/spyglass_scope'); if (s) { const size = Math.min(w, h); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.drawImage(s, (w - size) / 2, (h - size) / 2, size, size); } }
    // vanilla Gui.renderPortalOverlay: the animated nether_portal sprite over the whole screen, alpha = portal time
    { const pt = p.prevPortalTime + (p.portalTime - p.prevPortalTime) * partial; if (pt > 0) { const img = this.sprite('block/nether_portal'); if (img) { const frames = Math.max(1, Math.floor(img.height / 16)), fi = Math.floor(g.world.time / 2) % frames; ctx.save(); ctx.globalAlpha = Math.min(1, pt); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, fi * 16, 16, 16, 0, 0, w, h); ctx.restore(); } } }
    if (g.weather.flash > 0 && !g.options.hideLightningFlashes) { ctx.fillStyle = `rgba(255,255,255,${g.weather.flash / 12})`; ctx.fillRect(0, 0, w, h); }
    if (p.hasEffect('blindness')) { ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, w, h); }
    if (p.hasEffect('darkness')) { ctx.fillStyle = `rgba(0,0,0,${0.5 + 0.3 * Math.sin(performance.now() / 500)})`; ctx.fillRect(0, 0, w, h); }
    // vignette
    if (!this.spyglass) {
      const v = this.vignette();
      if (v) {
        // vanilla: brightness eases towards 1 - (light-dependent brightness at the eye)
        const l = g.world.getLightLevel(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z), g.skyDarken());
        const target = 1 - Math.min(1, l / 15 * 0.95 + 0.05);
        this.vignetteBrightness += (target - this.vignetteBrightness) * 0.01;
        if (this.vignetteBrightness > 0.002) { ctx.save(); ctx.globalAlpha = this.vignetteBrightness; ctx.drawImage(v, 0, 0, w, h); ctx.restore(); }
      }
    }
    if (this.spyglass) return;
    const cx = Math.floor(w / 2);
    // boss bars (vanilla BossHealthOverlay: 182x5 bars stacked from y=12, name above)
    { let by = 12;
      for (const e of g.entities) {
        if (e.removed) continue;
        let name = '', color = '', hp = 0;
        if (e instanceof EnderDragonEntity) { name = 'Ender Dragon'; color = 'pink'; hp = e.health / e.maxHealth; }
        else if (e instanceof WitherEntity) { if (e.distSq(p.x, p.y, p.z) > 80 * 80) continue; name = 'Wither'; color = 'purple'; hp = e.health / e.maxHealth; }
        else if (e.remote && (e.type === 'ender_dragon' || e.type === 'wither') && e instanceof LivingEntity) { name = e.type === 'wither' ? 'Wither' : 'Ender Dragon'; color = e.type === 'wither' ? 'purple' : 'pink'; hp = e.health / e.maxHealth; }
        else continue;
        const bx = cx - 91;
        this.drawSprite(ctx, `gui/sprites/boss_bar/${color}_background`, bx, by, 182, 5);
        const pw = Math.floor(182 * Math.max(0, Math.min(1, hp)));
        if (pw > 0) this.drawSprite(ctx, `gui/sprites/boss_bar/${color}_progress`, bx, by, pw, 5, 0, 0, pw, 5);
        this.font.drawCentered(ctx, name, cx, by - 9, 0xffffff);
        by += 10 + 9;
        if (by > h / 3) break;
      }
    }
    // crosshair
    if (this.thirdPerson === 0 && !this.screen) {
      ctx.save(); ctx.globalCompositeOperation = 'difference';
      this.drawSprite(ctx, 'gui/sprites/hud/crosshair', cx - 7, Math.floor(h / 2) - 7, 15, 15);
      // attack indicator
      const held = p.heldItem();
      const speed = held ? held.item.attackSpeed : 4;
      const cd = Math.min(1, (p.attackCooldownTicks + partial) / (20 / speed));
      if (cd < 1 && g.options.attackIndicator === 'crosshair') { const ax = cx - 8, ay = Math.floor(h / 2) + 8; this.drawSprite(ctx, 'gui/sprites/hud/crosshair_attack_indicator_background', ax, ay, 16, 4); const pw = Math.floor(16 * cd); this.drawSprite(ctx, 'gui/sprites/hud/crosshair_attack_indicator_progress', ax, ay, pw, 4, 0, 0, pw, 4); }
      ctx.restore();
    }
    if (p.isSpectator) return;
    // hotbar
    const hx = cx - 91, hy = h - 22;
    this.drawSprite(ctx, 'gui/sprites/hud/hotbar', hx, hy, 182, 22);
    this.drawSprite(ctx, 'gui/sprites/hud/hotbar_selection', hx - 1 + p.selectedSlot * 20, hy - 1, 24, 23);
    const off = p.offhandItem();
    if (off) { this.drawSprite(ctx, 'gui/sprites/hud/hotbar_offhand_left', hx - 29, hy - 1, 29, 24); this.drawItem(ctx, off, hx - 29 + 3, hy + 3); }
    for (let i = 0; i < 9; i++) this.drawItem(ctx, p.inventory.get(i), hx + 3 + i * 20, hy + 3);
    // hotbar attack indicator (vanilla: sword icon beside the hotbar, opposite the offhand)
    if (g.options.attackIndicator === 'hotbar') {
      const held = p.heldItem(); const speed = held ? held.item.attackSpeed : 4;
      const cd = Math.min(1, (p.attackCooldownTicks + partial) / (20 / speed));
      if (cd < 1) { const ax = hx + 182 + 6, ay = hy + 2; this.drawSprite(ctx, 'gui/sprites/hud/hotbar_attack_indicator_background', ax, ay, 18, 18); const ph = Math.floor(18 * cd); this.drawSprite(ctx, 'gui/sprites/hud/hotbar_attack_indicator_progress', ax, ay + 18 - ph, 18, ph, 0, 18 - ph, 18, ph); }
    }
    if (!p.isCreative || true) {
      const survival = !p.isCreative && !p.isSpectator;
      if (survival) {
        // health
        const left = cx - 91, top = h - 39;
        const maxH = Math.ceil(p.maxHealth / 2), hpAbs = p.absorption;
        const rows = Math.ceil((maxH + Math.ceil(hpAbs / 2)) / 10);
        const rowH = Math.max(10 - (rows - 2), 3);
        const regen = p.foodLevel >= 20 && p.health < p.maxHealth ? Math.floor(g.world.time % 25) : -1;
        const blink = p.hurtTime > 0 && Math.floor(p.hurtTime / 3) % 2 === 0;
        const hardcore = g.hardcore;
        const kind = p.hasEffect('poison') ? 'poisoned_' : p.hasEffect('wither') ? 'withered_' : p.hasEffect('freezing') ? 'frozen_' : '';
        const hc = hardcore ? 'hardcore_' : '';
        const health = Math.ceil(p.health);
        for (let i = 0; i < maxH; i++) {
          const x = left + (i % 10) * 8, y = top - Math.floor(i / 10) * rowH - (regen === i ? 2 : 0);
          this.drawSprite(ctx, `gui/sprites/hud/heart/container${hardcore ? '_hardcore' : ''}${blink ? '_blinking' : ''}`, x, y, 9, 9);
          const v = i * 2;
          if (health > v + 1) this.drawSprite(ctx, `gui/sprites/hud/heart/${kind}${hc}full${blink ? '_blinking' : ''}`, x, y, 9, 9);
          else if (health === v + 1) this.drawSprite(ctx, `gui/sprites/hud/heart/${kind}${hc}half${blink ? '_blinking' : ''}`, x, y, 9, 9);
        }
        for (let i = 0; i < Math.ceil(hpAbs / 2); i++) { const idx = maxH + i; const x = left + (idx % 10) * 8, y = top - Math.floor(idx / 10) * rowH; this.drawSprite(ctx, 'gui/sprites/hud/heart/container', x, y, 9, 9); this.drawSprite(ctx, `gui/sprites/hud/heart/absorbing_${hpAbs >= (i + 1) * 2 ? 'full' : 'half'}`, x, y, 9, 9); }
        // armour
        const armor = p.armorValue();
        if (armor > 0) for (let i = 0; i < 10; i++) { const x = left + i * 8, y = top - rows * rowH + (rows > 1 ? 0 : 0) - (rows === 1 ? 10 : 10 - (rows - 1) * (10 - rowH)); this.drawSprite(ctx, `gui/sprites/hud/armor_${armor > i * 2 + 1 ? 'full' : armor === i * 2 + 1 ? 'half' : 'empty'}`, x, y, 9, 9); }
        // food
        const hunger = p.hasEffect('hunger') ? '_hunger' : '';
        const shakeFood = p.saturation <= 0 && g.world.time % (p.foodLevel * 3 + 1) === 0;
        const foodRandom = vanillaHudRandom(g.world.time * 312871);
        for (let i = 0; i < 10; i++) { const x = cx + 91 - 9 - i * 8, y = top + (shakeFood ? foodRandom() - 1 : 0); this.drawSprite(ctx, `gui/sprites/hud/food_empty${hunger}`, x, y, 9, 9); if (p.foodLevel > i * 2 + 1) this.drawSprite(ctx, `gui/sprites/hud/food_full${hunger}`, x, y, 9, 9); else if (p.foodLevel === i * 2 + 1) this.drawSprite(ctx, `gui/sprites/hud/food_half${hunger}`, x, y, 9, 9); }
        // air
        if (p.eyeInWater || p.air < p.maxAir) { const bubbles = Math.ceil((p.air - 2) * 10 / p.maxAir); const popping = Math.ceil(p.air * 10 / p.maxAir) - bubbles; for (let i = 0; i < bubbles + popping; i++) { const x = cx + 91 - 9 - i * 8, y = top - 10; this.drawSprite(ctx, i < bubbles ? 'gui/sprites/hud/air' : 'gui/sprites/hud/air_bursting', x, y, 9, 9); } }
        // xp bar
        this.drawSprite(ctx, 'gui/sprites/hud/experience_bar_background', cx - 91, h - 29, 182, 5);
        const xw = Math.floor(182 * p.xpProgress);
        if (xw > 0) this.drawSprite(ctx, 'gui/sprites/hud/experience_bar_progress', cx - 91, h - 29, xw, 5, 0, 0, xw, 5);
        if (p.xpLevel > 0) { const t = String(p.xpLevel); const tw = this.font.width(t); const tx = cx - tw / 2, ty = h - 31 - 4; for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.font.draw(ctx, t, tx + ox, ty + oy, 0x000000, false); this.font.draw(ctx, t, tx, ty, 0x80ff20, false); }
      }
    }
    // held item name
    if (this.heldItemName.time > 0 && this.heldItemName.text) { const a = Math.min(1, this.heldItemName.time / 10); this.font.drawCentered(ctx, this.heldItemName.text, cx, h - 59 - (p.isCreative ? -14 : 0), 0xffffff, true, a); }
    if (this.actionBar.time > 0) { const a = Math.min(1, this.actionBar.time / 10); this.font.drawCentered(ctx, this.actionBar.text, cx, h - 68 - (p.isCreative ? -14 : 0), 0xffffff, true, a); }
    // effects (top right)
    let ex = w - 26;
    for (const e of p.effects.slice().sort((a, b) => a.id.localeCompare(b.id))) {
      const good = !['poison', 'wither', 'slowness', 'weakness', 'hunger', 'blindness', 'nausea', 'mining_fatigue', 'darkness', 'bad_omen', 'unluck', 'levitation'].includes(e.id);
      const ey = good ? 2 : 28;
      this.drawSprite(ctx, e.ambient ? 'gui/sprites/hud/effect_background_ambient' : 'gui/sprites/hud/effect_background', ex, ey, 24, 24);
      const icon = this.sprite('mob_effect/' + e.id);
      if (icon) ctx.drawImage(icon, ex + 3, ey + 3, 18, 18);
      this.font.drawCentered(ctx, `${Math.floor(e.duration / 1200)}:${String(Math.floor(e.duration / 20) % 60).padStart(2, '0')}`, ex + 12, ey + 26, 0xffffff);
      if (good) ex -= 25;
    }
    // chat (the chat screen draws the full history itself)
    if (!(this.screen instanceof ChatScreen)) this.drawChat(ctx, false);
    // title
    if (this.titleText) {
      const t = this.titleText; const tt = t.time;
      let a = 1; if (tt < t.fadeIn) a = tt / t.fadeIn; else if (tt > t.fadeIn + t.stay) a = 1 - (tt - t.fadeIn - t.stay) / t.fadeOut;
      ctx.save(); ctx.translate(cx, h / 2 - 20); ctx.scale(4, 4); this.font.drawCentered(ctx, t.title, 0, -10, 0xffffff, true, Math.max(0, a)); ctx.restore();
      if (t.subtitle) { ctx.save(); ctx.translate(cx, h / 2 + 10); ctx.scale(2, 2); this.font.drawCentered(ctx, t.subtitle, 0, 0, 0xffffff, true, Math.max(0, a)); ctx.restore(); }
    }
    // sleeping fade
    if (p.sleeping || this.sleepFade > 0) { const a = Math.min(1, (p.sleepTimer) / 100); ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, w, h); if (p.sleeping) this.font.drawCentered(ctx, g.assets.lang['sleep.players_sleeping'] ?? 'Sleeping…', cx, h - 40, 0xffffff); }
    // subtitles
    if (this.showSubtitles && g.sounds.subtitles.length) {
      let sy = h - 30;
      for (const s of g.sounds.subtitles.slice(-6).reverse()) { const dir = this.subtitleDir(s.x, s.z); const text = `${dir[0]} ${s.text} ${dir[1]}`; const tw = this.font.width(text); ctx.fillStyle = `rgba(0,0,0,${0.7 * Math.min(1, s.time / 20)})`; ctx.fillRect(w - tw - 14, sy - 2, tw + 8, 11); this.font.draw(ctx, text, w - tw - 10, sy, 0xffffff, true, Math.min(1, s.time / 20)); sy -= 12; }
    }
    // name tags
    for (const n of this.nameTags) {
      const pr = g.project(n.x, n.y, n.z);
      if (!pr) continue;
      const sx = pr[0] / this.scale, sy = pr[1] / this.scale;
      const nameScale = this.game.canvas.height * this.game.renderer.proj[5] * 0.025 / (2 * pr[2] * this.scale);
      const tw = this.font.width(n.text);
      ctx.save(); ctx.translate(sx, sy); ctx.scale(nameScale, nameScale);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-tw / 2 - 1, -1, tw + 2, 10);
      this.font.drawCentered(ctx, n.text, 0, 0, 0xffffff, false);
      ctx.restore();
    }
  }

  private subtitleDir(x: number, z: number): [string, string] {
    const p = this.game.player;
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < 4) return ['', ''];
    const d = lookDir(p.yaw, 0);
    const right = -d[2] * dx + d[0] * dz;
    return right < -1 ? ['<', ''] : right > 1 ? ['', '>'] : ['', ''];
  }

  /** Scroll offset (lines) while the chat is open; vanilla ChatComponent.scrollChat. */
  chatScroll = 0;
  drawChat(ctx: CanvasRenderingContext2D, all: boolean): void {
    const g = this.game, o = g.options;
    if (o.chatVisibility === 'hidden') return;
    const h = this.height;
    const scale = 0.5 + o.chatScale * 0.5; // vanilla chat scale option
    const width = Math.round(40 + o.chatWidth * 280);
    const maxLines = Math.round((20 + (all ? o.chatFocusedHeight : o.chatUnfocusedHeight) * 160) / 9);
    const lines: { text: string; alpha: number }[] = [];
    for (const c of this.chat) {
      if (!all && c.time > 200) continue;
      if (o.chatVisibility === 'system' && !c.text.startsWith('§') && /^<.*>/.test(c.text)) continue;
      const alpha = (all ? 1 : c.time > 180 ? (200 - c.time) / 20 : 1) * (0.1 + o.chatOpacity * 0.9);
      for (const l of this.font.wrap(c.text, width / scale - 4)) lines.push({ text: l, alpha });
    }
    if (!all) this.chatScroll = 0;
    this.chatScroll = Math.max(0, Math.min(this.chatScroll, Math.max(0, lines.length - maxLines)));
    const end = lines.length - this.chatScroll, start = Math.max(0, end - maxLines);
    const shown = lines.slice(start, end);
    const lineH = 9 * scale;
    let y = h - 48 - (all ? 4 : 0) - lineH * shown.length + lineH;
    for (const l of shown) {
      ctx.fillStyle = `rgba(0,0,0,${o.textBackgroundOpacity * l.alpha})`; ctx.fillRect(2, y - 1, width + 4, lineH);
      ctx.save(); ctx.translate(4, y); ctx.scale(scale, scale);
      this.font.draw(ctx, l.text, 0, 0, 0xffffff, true, l.alpha);
      ctx.restore();
      y += lineH;
    }
    if (all && lines.length > maxLines) { // scrollbar like vanilla
      const barH = Math.max(4, maxLines / lines.length * (maxLines * lineH));
      const by = h - 48 - 4 - (this.chatScroll / (lines.length - maxLines)) * (maxLines * lineH - barH) - barH + lineH;
      ctx.fillStyle = 'rgba(190,190,190,0.7)'; ctx.fillRect(width + 4, by, 2, barH);
    }
  }

  private drawTiledFull(ctx: CanvasRenderingContext2D, name: string, alpha: number): void { this.drawTiled(ctx, name, 0, 0, this.width, this.height, 64, alpha); }

  /** Tab list: every player in the world (vanilla PlayerTabOverlay). */
  private drawPlayerList(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    let names: string[];
    if (g.client) names = g.client.players.map((p) => p.name);
    else if (g.host) names = g.host.playerList().map((p) => p.name);
    else names = [g.player.name];
    const title = g.client ? `${g.client.welcome?.hostName ?? 'Host'}'s world · ping ${g.client.ping} ms`
      : g.host ? (g.host.official ? g.worldMeta?.name ?? 'Public world' : `${g.worldMeta?.name ?? 'World'} (${g.host.isPublic ? 'public' : 'private'})`)
      : g.worldMeta?.name ?? 'Singleplayer';
    const cols = Math.max(1, Math.ceil(names.length / 20)), rows = Math.ceil(names.length / cols);
    // the panel grows to fit its contents: the longest name and the header both have to fit (vanilla PlayerTabOverlay)
    let cw = 60; for (const n of names) cw = Math.max(cw, this.font.width(n) + 6);
    const gridW = cols * (cw + 5) + 5;
    const w = Math.max(gridW, this.font.width(title) + 8), h = rows * 9 + 12;
    const x0 = Math.floor((this.width - w) / 2), y0 = 10;
    const gx = x0 + Math.floor((w - gridW) / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x0, y0, w, h);
    this.font.drawCentered(ctx, title, x0 + w / 2, y0 + 2, 0xffffff);
    names.forEach((n, i) => {
      const c = Math.floor(i / rows), r = i % rows;
      const x = gx + 5 + c * (cw + 5), y = y0 + 12 + r * 9;
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x, y - 1, cw, 9);
      this.font.draw(ctx, n, x + 2, y, n === g.player.name ? 0xffff55 : 0xffffff);
    });
  }

  private drawDebug(ctx: CanvasRenderingContext2D): void {
    const g = this.game, p = g.player;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const biome = BIOMES[g.world.getBiome(bx, bz)];
    const facing = p.horizontalFacing();
    const hit = g.targetBlock;
    const light = g.world.getLight(bx, by, bz);
    const rs = g.renderer.stats, cs = g.chunks.stats;
    const lines = [
      `VoxeLand ${g.version} (Minecraft ${g.assets.manifest?.mcVersion ?? '?'} assets) ${this.fps} fps`,
      `C: ${rs.sections} sections, ${rs.quads} quads, ${rs.drawCalls} draws | E: ${g.entities.length} | P: ${g.particles.list.length}`,
      `Chunks: ${cs.loaded} loaded, gen ${(cs.genTime / Math.max(1, cs.genCount)).toFixed(1)}ms mesh ${(cs.meshTime / Math.max(1, cs.meshCount)).toFixed(1)}ms, pending ${g.chunks.pendingGenCount}/${g.chunks.pendingMeshCount}`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(5)} / ${p.z.toFixed(3)}`,
      `Block: ${bx} ${by} ${bz} [${bx & 15} ${by & 15} ${bz & 15}]`,
      `Chunk: ${bx >> 4} ${by >> 4} ${bz >> 4}`,
      `Facing: ${facing} (Towards ${facing === 'north' ? 'negative Z' : facing === 'south' ? 'positive Z' : facing === 'west' ? 'negative X' : 'positive X'}) (${(((p.yaw + 180) % 360 + 360) % 360 - 180).toFixed(1)} / ${p.pitch.toFixed(1)})`,
      `Light: ${Math.max(light >> 4, light & 15)} (${light >> 4} sky, ${light & 15} block)`,
      `Biome: minecraft:${biome.name}`,
      `Local Difficulty: ${g.difficulty} // Day ${Math.floor(g.world.dayTime / 24000)} time ${g.world.dayTime % 24000}`,
      `Weather: ${g.weather.raining ? (g.weather.thundering ? 'thunder' : 'rain') : 'clear'} (${g.weather.rainLevel.toFixed(2)})`,
      `Dimension: minecraft:${g.world.dimension}`,
      hit ? `Looking at block: ${hit.x} ${hit.y} ${hit.z}` : '',
    ];
    let y = 2;
    for (const l of lines) { if (l) { ctx.fillStyle = 'rgba(80,80,80,0.5)'; ctx.fillRect(1, y - 1, this.font.width(l) + 2, 10); this.font.draw(ctx, l, 2, y, 0xffffff, false); } y += 10; }
    const right: string[] = [`JS: ${(performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) + 'MB / ' + Math.round((performance as any).memory.jsHeapSizeLimit / 1048576) + 'MB' : 'n/a'}`, `Renderer: WebGL2 (${g.renderer.gl.getParameter(g.renderer.gl.RENDERER) as string})`.slice(0, 60), '', `Workers: gen ${g.chunks.genPool.size}, mesh ${g.chunks.meshPool.size}`];
    if (hit) {
      const s = g.world.getBlock(hit.x, hit.y, hit.z);
      const b = g.registry.block(s);
      right.push('', `Targeted Block: ${hit.x}, ${hit.y}, ${hit.z}`, `minecraft:${b.name}`);
      for (const [k, v] of Object.entries(g.registry.getProps(s))) right.push(`${k}: ${v}`);
      const be = g.blockEntities.get(hit.x, hit.y, hit.z);
      if (be) right.push(`#block entity: ${be.type}`);
    }
    if (g.targetEntity) right.push('', `Targeted Entity: minecraft:${g.targetEntity.type}`);
    y = 2;
    for (const l of right) { if (l) { const tw = this.font.width(l); ctx.fillStyle = 'rgba(80,80,80,0.5)'; ctx.fillRect(this.width - tw - 3, y - 1, tw + 2, 10); this.font.draw(ctx, l, this.width - tw - 2, y, 0xffffff, false); } y += 10; }
  }
}

export function toRoman(n: number): string { const r = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']; return r[n - 1] ?? String(n); }
