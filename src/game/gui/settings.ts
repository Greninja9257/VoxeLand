// Vanilla-structured settings screens: Options -> Video / Music & Sounds / Controls (Mouse, Key Binds) / Chat /
// Skin Customization / Accessibility / Language / Credits. Sub-screens are generated from the option specs.
import { Screen, Button, Slider, CycleButton, TextField, Widget } from './widgets';
import { ACCESSIBILITY_OPTIONS, CHAT_OPTIONS, CONTROL_OPTIONS, MOUSE_OPTIONS, SKIN_PARTS, SOUND_OPTIONS, VIDEO_OPTIONS, getOption, setOption, type OptionSpec } from '../options';
import { ControlsScreen, CreditsScreen } from './screens';

/** A widget bound to an option spec. */
function optionWidget(screen: Screen, spec: OptionSpec, x: number, y: number, w: number): Widget {
  const g = screen.gui.game, o = g.options;
  const changed = () => { if (spec.apply) g.applyOptions(); };
  if (spec.kind === 'slider') {
    const min = spec.min ?? 0, max = spec.max ?? 1, range = max - min;
    const step = spec.step && spec.step > 0 ? spec.step / range : 0;
    const cur = (Number(getOption(o, spec.key)) - min) / range;
    const fmt = (v: number) => `${spec.label}: ${spec.format ? spec.format(min + v * range) : Math.round(min + v * range)}`;
    const sl = new Slider(x, y, w, 20, Math.max(0, Math.min(1, cur)), fmt, (v) => { let val = min + v * range; if (spec.step && spec.step > 0) val = Math.round(val / spec.step) * spec.step; setOption(o, spec.key, +val.toFixed(4)); changed(); }, step);
    sl.tooltip = spec.tooltip ?? null;
    return sl;
  }
  const values = spec.values ?? [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }];
  const cb = new CycleButton(x, y, w, 20, spec.label + ': ', values, getOption(o, spec.key), (v) => { setOption(o, spec.key, v); changed(); });
  cb.tooltip = spec.tooltip ?? null;
  return cb;
}

/** Generic two-column scrolling option list (vanilla OptionsList). */
export class OptionsListScreen extends Screen {
  hidesHud = true;
  scroll = 0;
  private rows = 0;
  private listTop = 32;
  private listBottom = 0;
  private rowWidgets: Widget[] = [];
  private baseY = new Map<Widget, number>();
  constructor(public title: string, protected specs: OptionSpec[], protected parent: Screen | null, protected extra: ((s: OptionsListScreen, x: number, y: number, w: number) => Widget | null)[] = [], protected extraFirst = false) { super(); }
  build(): void {
    const cx = this.width / 2;
    this.listBottom = this.height - 36;
    this.rowWidgets = []; this.baseY.clear();
    const L = cx - 155, R = cx + 5;
    let i = 0;
    const place = (make: (x: number, y: number, w: number) => Widget | null) => {
      const col = i % 2, y = this.listTop + 4 + Math.floor(i / 2) * 25;
      const wdg = make(col === 0 ? L : R, y, 150);
      if (!wdg) return;
      this.add(wdg); this.rowWidgets.push(wdg); this.baseY.set(wdg, y); i++;
    };
    if (this.extraFirst) for (const ex of this.extra) place((x, y, w) => ex(this, x, y, w));
    for (const spec of this.specs) place((x, y, w) => optionWidget(this, spec, x, y, w));
    if (!this.extraFirst) for (const ex of this.extra) place((x, y, w) => ex(this, x, y, w));
    this.rows = Math.ceil(i / 2);
    this.add(new Button(cx - 100, this.height - 27, 200, 20, 'Done', () => this.done()));
    this.applyScroll();
  }
  get maxScroll(): number { return Math.max(0, this.rows * 25 + 8 - (this.listBottom - this.listTop)); }
  private applyScroll(): void {
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
    for (const w of this.rowWidgets) { const by = this.baseY.get(w)!; w.y = by - this.scroll; w.visible = w.y + 20 > this.listTop && w.y < this.listBottom; }
  }
  wheel(dy: number): void { this.scroll += dy * 25; this.applyScroll(); }
  done(): void { this.gui.game.saveOptions(); if (this.parent) this.gui.open(this.parent); else this.gui.close(); }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.done(); return true; } return super.keyDown(code, key, mods); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const gui = this.gui;
    gui.drawListBackground(ctx, 0, this.listTop, this.width, this.listBottom - this.listTop);
    ctx.save(); ctx.beginPath(); ctx.rect(0, this.listTop, this.width, this.listBottom - this.listTop); ctx.clip();
    for (const w of this.rowWidgets) if (w.visible) w.render(ctx, mx, my, partial, this);
    ctx.restore();
    for (const w of this.widgets) if (w.visible && !this.rowWidgets.includes(w)) w.render(ctx, mx, my, partial, this);
    if (this.maxScroll > 0) {
      const h = this.listBottom - this.listTop, barH = Math.max(10, h * h / (this.rows * 25 + 8));
      const by = this.listTop + (this.scroll / this.maxScroll) * (h - barH);
      ctx.fillStyle = '#000'; ctx.fillRect(this.width / 2 + 156, this.listTop, 6, h);
      ctx.fillStyle = '#808080'; ctx.fillRect(this.width / 2 + 156, by, 6, barH);
      ctx.fillStyle = '#c0c0c0'; ctx.fillRect(this.width / 2 + 156, by, 5, barH - 1);
    }
    gui.font.drawCentered(ctx, this.title, this.width / 2, 12, 0xffffff);
  }
  mouseDown(x: number, y: number, button: number): boolean {
    if (y >= this.listTop && y < this.listBottom) {
      for (const w of this.rowWidgets) if (w.visible && w.active && w.contains(x, y)) { this.focused = w; w.mouseDown(x, y, button, this); return true; }
    }
    for (const w of this.widgets) if (!this.rowWidgets.includes(w) && w.visible && w.active && w.contains(x, y)) { this.focused = w; w.mouseDown(x, y, button, this); return true; }
    this.focused = null;
    return false;
  }
}

/** Main options screen (vanilla layout: FOV + buttons into the sub-menus). */
export class OptionsScreen extends Screen {
  hidesHud = true;
  constructor(private parent: Screen | null) { super(); this.pausesGame = true; }
  build(): void {
    const g = this.gui.game, o = g.options;
    const cx = this.width / 2;
    const L = cx - 155, R = cx + 5;
    let y = this.height / 6 - 12;
    this.add(new Slider(L, y, 150, 20, (o.fov - 30) / 80, (v) => { const f = Math.round(30 + v * 80); return `FOV: ${f === 70 ? 'Normal' : f === 110 ? 'Quake Pro' : f}`; }, (v) => { o.fov = Math.round(30 + v * 80); g.applyOptions(); }, 1 / 80));
    if (g.inWorld) this.add(new CycleButton(R, y, 150, 20, 'Difficulty: ', [{ value: 0, label: 'Peaceful' }, { value: 1, label: 'Easy' }, { value: 2, label: 'Normal' }, { value: 3, label: 'Hard' }], g.difficulty, (v) => g.setDifficulty(v)));
    else this.add(new CycleButton(R, y, 150, 20, 'Realms Notifications: ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], false, () => {}));
    y += 48;
    const sub = (x: number, yy: number, label: string, make: () => Screen) => this.add(new Button(x, yy, 150, 20, label, () => this.gui.open(make())));
    sub(L, y, 'Skin Customization...', () => new SkinScreen(this));
    sub(R, y, 'Music & Sounds...', () => new OptionsListScreen('Music & Sound Options', SOUND_OPTIONS, this));
    y += 24;
    sub(L, y, 'Video Settings...', () => new OptionsListScreen('Video Settings', VIDEO_OPTIONS, this));
    sub(R, y, 'Controls...', () => new ControlsMenuScreen(this));
    y += 24;
    sub(L, y, 'Language...', () => new LanguageScreen(this));
    sub(R, y, 'Chat Settings...', () => new OptionsListScreen('Chat Settings', CHAT_OPTIONS, this));
    y += 24;
    sub(L, y, 'Resource Packs...', () => new ResourcePackScreen(this));
    sub(R, y, 'Accessibility Settings...', () => new OptionsListScreen('Accessibility Settings', ACCESSIBILITY_OPTIONS, this));
    y += 24;
    sub(L, y, 'Telemetry Data...', () => new TelemetryScreen(this));
    sub(R, y, 'Credits & Attribution...', () => new CreditsScreen(this));
    y += 24;
    this.add(new Button(cx - 100, this.height - 27, 200, 20, 'Done', () => this.done()));
  }
  private done(): void { this.gui.game.saveOptions(); if (this.parent) this.gui.open(this.parent); else this.gui.close(); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['options.title'] ?? 'Options', this.width / 2, 15, 0xffffff);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.done(); return true; } return super.keyDown(code, key, mods); }
}

/** Controls: Mouse Settings, Key Binds and the toggle options. */
export class ControlsMenuScreen extends OptionsListScreen {
  constructor(parent: Screen) {
    super('Controls', CONTROL_OPTIONS, parent, [
      (s, x, y, w) => new Button(x, y, w, 20, 'Mouse Settings...', () => s.gui.open(new OptionsListScreen('Mouse Settings', MOUSE_OPTIONS, s))),
      (s, x, y, w) => new Button(x, y, w, 20, 'Key Binds...', () => s.gui.open(new ControlsScreen(s))),
    ], true);
  }
}

/** Vanilla has no name field; VoxeLand needs one, so it lives with the rest of the appearance settings. */
export class PlayerNameScreen extends Screen {
  hidesHud = true;
  field!: TextField;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game, cx = this.width / 2;
    this.field = this.add(new TextField(cx - 100, this.height / 2 - 10, 200, 20, g.options.playerName));
    this.field.maxLength = 16; this.field.placeholder = 'Player';
    this.field.filter = (ch) => /[\w]/.test(ch);
    this.field.onEnter = () => this.done();
    this.focused = this.field;
    this.add(new Button(cx - 100, this.height / 2 + 20, 200, 20, 'Done', () => this.done()));
  }
  private done(): void {
    const g = this.gui.game;
    g.options.playerName = this.field.text.trim() || 'Player';
    if (g.player && !g.isRemote && !g.host) g.player.name = g.options.playerName;
    g.saveOptions();
    this.gui.open(this.parent);
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, 'Player Name', this.width / 2, this.height / 2 - 44, 0xffffff);
    this.gui.font.drawCentered(ctx, 'Shown in chat, the player list and death messages', this.width / 2, this.height / 2 - 30, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.done(); return true; } return super.keyDown(code, key, mods); }
}

export class SkinScreen extends OptionsListScreen {
  constructor(parent: Screen) {
    super('Skin Customization', [], parent, [
      (s: OptionsListScreen, x: number, y: number, w: number) => new Button(x, y, w, 20, `Player Name: ${s.gui.game.options.playerName}`, () => s.gui.open(new PlayerNameScreen(s))),
      ...SKIN_PARTS.map((p) => (s: OptionsListScreen, x: number, y: number, w: number) => new CycleButton(x, y, w, 20, p.label + ': ', [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }], s.gui.game.options.modelParts[p.key] !== false, (v) => { s.gui.game.options.modelParts[p.key] = v; })),
      (s, x, y, w) => new CycleButton(x, y, w, 20, 'Main Hand: ', [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], s.gui.game.options.mainHand, (v) => { s.gui.game.options.mainHand = v as any; }),
      (s, x, y, w) => new CycleButton(x, y, w, 20, 'Skin: ', [{ value: 'steve', label: 'Steve (Classic)' }, { value: 'alex', label: 'Alex (Slim)' }], s.gui.game.options.skin, (v) => { s.gui.game.options.skin = v as any; }),
    ]);
  }
}

export class LanguageScreen extends OptionsListScreen {
  constructor(parent: Screen) {
    super('Language', [], parent, [
      (s, x, y, w) => new CycleButton(x, y, w, 20, 'Language: ', [{ value: 'en_us', label: 'English (US)' }], s.gui.game.options.language, (v) => { s.gui.game.options.language = v; }),
    ]);
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    super.render(ctx, mx, my, partial);
    this.gui.font.drawCentered(ctx, '(Only the bundled en_us language file is available)', this.width / 2, this.height - 45, 0x808080);
  }
}

export class ResourcePackScreen extends Screen {
  hidesHud = true;
  constructor(private parent: Screen) { super(); }
  build(): void { this.add(new Button(this.width / 2 - 100, this.height - 27, 200, 20, 'Done', () => this.gui.open(this.parent))); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Select Resource Packs', this.width / 2, 16, 0xffffff);
    const lines = ['Available Packs: (none)', '', 'Selected Packs:', '  Default Template Resource Pack (vanilla textures)', '  Vanilla sounds (Mojang asset index)', '', 'Packs are bundled at build time by scripts/fetch-assets.mjs;', 'drop-in pack loading is not supported in the browser build.'];
    lines.forEach((l, i) => f.drawCentered(ctx, l, this.width / 2, 40 + i * 12, i === 0 || i === 2 ? 0xffffff : 0xa0a0a0));
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

export class TelemetryScreen extends Screen {
  hidesHud = true;
  constructor(private parent: Screen) { super(); }
  build(): void { this.add(new Button(this.width / 2 - 100, this.height - 27, 200, 20, 'Done', () => this.gui.open(this.parent))); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Telemetry Data Collection', this.width / 2, 16, 0xffffff);
    ['VoxeLand collects no telemetry.', 'Nothing leaves your browser except multiplayer traffic', 'to the server you explicitly connect to.'].forEach((l, i) => f.drawCentered(ctx, l, this.width / 2, 50 + i * 12, 0xa0a0a0));
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}
