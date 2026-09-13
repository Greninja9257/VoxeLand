// Menus: title, world select/create, options, controls, pause, death, chat, confirm.
import { Screen, Button, Slider, TextField, Checkbox, CycleButton, ListWidget } from './widgets';
import { storage, type WorldMeta } from '../../save/storage';
import { DEFAULT_BINDINGS } from '../input';
import type { GameMode } from '../../entity/player';

export class TitleScreen extends Screen {
  pausesGame = false; closeOnEsc = false; hidesHud = true; darkBackground = false;
  splash = '';
  build(): void {
    const g = this.gui.game;
    if (!this.splash) { const s = g.assets.splashes; this.splash = s.length ? s[Math.floor(Math.random() * s.length)] : 'VoxeLand!'; }
    const cx = this.width / 2, y = this.height / 4 + 48;
    this.add(new Button(cx - 100, y, 200, 20, g.assets.lang['menu.singleplayer'] ?? 'Singleplayer', () => this.gui.open(new WorldSelectScreen())));
    this.add(new Button(cx - 100, y + 24, 200, 20, g.assets.lang['menu.options'] ?? 'Options…', () => this.gui.open(new OptionsScreen(this))));
    this.add(new Button(cx - 100, y + 48, 200, 20, 'Credits', () => this.gui.open(new CreditsScreen(this))));
    this.add(new Button(cx - 100, y + 72, 200, 20, g.assets.lang['menu.quit'] ?? 'Quit Game', () => location.reload()));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    // logo
    ctx.save(); ctx.translate(cx, this.height / 4 - 20); ctx.scale(4, 4);
    this.gui.font.drawCentered(ctx, 'VoxeLand', 0, -8, 0xffffff, true);
    ctx.restore();
    // splash
    const t = performance.now() / 1000;
    const s = 1.8 - Math.abs(Math.sin(t * Math.PI * 2 / 1) * 0.1);
    ctx.save(); ctx.translate(cx + 90, this.height / 4 + 6); ctx.rotate(-20 * Math.PI / 180); ctx.scale(s, s);
    const sw = Math.min(1, 100 / Math.max(1, this.gui.font.width(this.splash) * 1.8));
    ctx.scale(sw, sw);
    this.gui.font.drawCentered(ctx, this.splash, 0, -4, 0xffff00, true);
    ctx.restore();
    super.render(ctx, mx, my, partial);
    this.gui.font.draw(ctx, `VoxeLand ${g.version} — assets: Minecraft ${g.assets.manifest?.mcVersion ?? ''}`, 2, this.height - 10, 0xffffff);
    this.gui.font.drawRight(ctx, 'Not affiliated with Mojang Studios', this.width - 2, this.height - 10, 0xffffff);
  }
}

export class WorldSelectScreen extends Screen {
  pausesGame = false; hidesHud = true;
  worlds: WorldMeta[] = [];
  list!: ListWidget;
  playBtn!: Button; deleteBtn!: Button;
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    storage.listWorlds().then((w) => { this.worlds = w; });
    this.list = this.add(new ListWidget(cx - 150, 32, 300, this.height - 100, 36, () => this.worlds.length, (ctx, i, x, y, w, sel, hov) => {
      const wm = this.worlds[i];
      if (sel) { ctx.fillStyle = '#808080'; ctx.fillRect(x - 2, y, w + 4, 36); ctx.fillStyle = '#000'; ctx.fillRect(x - 1, y + 1, w + 2, 34); }
      else if (hov) { ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x - 2, y, w + 4, 36); }
      this.gui.font.draw(ctx, wm.name, x + 4, y + 3, 0xffffff);
      this.gui.font.draw(ctx, `${wm.id} (${new Date(wm.lastPlayed).toLocaleString()})`, x + 4, y + 13, 0x808080);
      this.gui.font.draw(ctx, `${g.assets.lang['gameMode.' + wm.gameMode] ?? wm.gameMode} Mode, ${wm.cheats ? 'Cheats' : 'No cheats'}, Version: ${wm.version}`, x + 4, y + 23, 0x808080);
    }, (_i, dbl) => { this.playBtn.active = true; this.deleteBtn.active = true; if (dbl) this.play(); }));
    this.playBtn = this.add(new Button(cx - 154, this.height - 52, 150, 20, g.assets.lang['selectWorld.select'] ?? 'Play Selected World', () => this.play()));
    this.playBtn.active = false;
    this.add(new Button(cx + 4, this.height - 52, 150, 20, g.assets.lang['selectWorld.create'] ?? 'Create New World', () => this.gui.open(new CreateWorldScreen())));
    this.deleteBtn = this.add(new Button(cx - 154, this.height - 28, 150, 20, g.assets.lang['selectWorld.delete'] ?? 'Delete', () => { const w = this.worlds[this.list.selected]; if (w) this.gui.open(new ConfirmScreen(`Are you sure you want to delete '${w.name}'?`, 'This world will be lost forever! (A long time!)', async (ok) => { if (ok) { await storage.deleteWorld(w.id); } this.gui.open(new WorldSelectScreen()); })); }));
    this.deleteBtn.active = false;
    this.add(new Button(cx + 4, this.height - 28, 150, 20, g.assets.lang['gui.cancel'] ?? 'Cancel', () => this.gui.open(new TitleScreen())));
  }
  private play(): void { const w = this.worlds[this.list.selected]; if (w) this.gui.game.loadWorld(w); }
  wheel(dy: number, x: number, y: number): void { if (this.list.contains(x, y)) this.list.wheel(dy); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['selectWorld.title'] ?? 'Select World', this.width / 2, 12, 0xffffff);
    super.render(ctx, mx, my, partial);
    if (!this.worlds.length) this.gui.font.drawCentered(ctx, 'No worlds yet — create one!', this.width / 2, this.height / 2, 0x808080);
  }
  keyDown(code: string, key: string, mods: { shift: boolean; ctrl: boolean }): boolean { if (code === 'Escape') { this.gui.open(new TitleScreen()); return true; } return super.keyDown(code, key, mods); }
}

export class CreateWorldScreen extends Screen {
  pausesGame = false; hidesHud = true;
  name!: TextField; seed!: TextField;
  mode: GameMode = 'survival'; difficulty = 2; cheats = false;
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    this.name = this.add(new TextField(cx - 100, 50, 200, 20, this.name?.text ?? 'New World'));
    this.name.placeholder = 'World name';
    this.seed = this.add(new TextField(cx - 100, 90, 200, 20, this.seed?.text ?? ''));
    this.seed.placeholder = 'Leave blank for a random seed';
    this.add(new CycleButton(cx - 155, 120, 150, 20, (g.assets.lang['selectWorld.gameMode'] ?? 'Game Mode') + ': ', [{ value: 'survival' as GameMode, label: 'Survival' }, { value: 'creative' as GameMode, label: 'Creative' }, { value: 'adventure' as GameMode, label: 'Adventure' }], this.mode, (v) => { this.mode = v; }));
    this.add(new CycleButton(cx + 5, 120, 150, 20, (g.assets.lang['options.difficulty'] ?? 'Difficulty') + ': ', [{ value: 0, label: 'Peaceful' }, { value: 1, label: 'Easy' }, { value: 2, label: 'Normal' }, { value: 3, label: 'Hard' }], this.difficulty, (v) => { this.difficulty = v; }));
    this.add(new CycleButton(cx - 155, 144, 150, 20, (g.assets.lang['selectWorld.allowCommands'] ?? 'Allow Cheats') + ': ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], this.cheats, (v) => { this.cheats = v; }));
    this.add(new Button(cx - 155, this.height - 28, 150, 20, g.assets.lang['selectWorld.create'] ?? 'Create New World', () => {
      const seedStr = this.seed.text.trim();
      let seed: number;
      if (!seedStr) seed = (Math.random() * 0xffffffff) | 0;
      else if (/^-?\d+$/.test(seedStr)) seed = Number(BigInt.asIntN(32, BigInt(seedStr)));
      else { let h = 0; for (const ch of seedStr) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0; seed = h; }
      const meta: WorldMeta = { id: 'w' + Date.now().toString(36), name: this.name.text.trim() || 'New World', seed, created: Date.now(), lastPlayed: Date.now(), gameMode: this.mode, difficulty: this.difficulty, cheats: this.cheats || this.mode === 'creative', version: g.version };
      storage.saveWorldMeta(meta).then(() => g.loadWorld(meta));
    }));
    this.add(new Button(cx + 5, this.height - 28, 150, 20, g.assets.lang['gui.cancel'] ?? 'Cancel', () => this.gui.open(new WorldSelectScreen())));
    this.focused = this.name;
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const cx = this.width / 2;
    this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['selectWorld.create'] ?? 'Create New World', cx, 12, 0xffffff);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['selectWorld.enterName'] ?? 'World Name', cx - 100, 38, 0xa0a0a0);
    this.gui.font.draw(ctx, this.gui.game.assets.lang['selectWorld.enterSeed'] ?? 'Seed for the world generator', cx - 100, 78, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
}

export class ConfirmScreen extends Screen {
  pausesGame = false; hidesHud = true;
  constructor(public title: string, public message: string, public cb: (ok: boolean) => void) { super(); }
  build(): void {
    const cx = this.width / 2;
    this.add(new Button(cx - 155, this.height / 2 + 20, 150, 20, 'Yes', () => this.cb(true)));
    this.add(new Button(cx + 5, this.height / 2 + 20, 150, 20, 'No', () => this.cb(false)));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, this.title, this.width / 2, this.height / 2 - 30, 0xffffff);
    this.gui.font.drawCentered(ctx, this.message, this.width / 2, this.height / 2 - 10, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
}

export class CreditsScreen extends Screen {
  pausesGame = false; hidesHud = true;
  text: string[] = [];
  scroll = 0;
  constructor(private parent: Screen) { super(); }
  build(): void {
    fetch('./assets/CREDITS.txt').then((r) => r.text()).then((t) => { this.text = t.split('\n'); });
    this.add(new Button(this.width / 2 - 100, this.height - 28, 200, 20, 'Done', () => this.gui.open(this.parent)));
  }
  wheel(dy: number): void { this.scroll = Math.max(0, this.scroll + dy * 20); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, 'Credits', this.width / 2, 12, 0xffffff);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 28, this.width, this.height - 64); ctx.clip();
    let y = 32 - this.scroll;
    for (const l of this.text) { for (const w of this.gui.font.wrap(l, this.width - 40)) { this.gui.font.draw(ctx, w, 20, y, 0xdddddd); y += 10; } }
    ctx.restore();
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

export class OptionsScreen extends Screen {
  hidesHud = true;
  constructor(private parent: Screen | null) { super(); this.pausesGame = true; }
  build(): void {
    const g = this.gui.game, o = g.options;
    const cx = this.width / 2;
    let y = 30;
    const L = cx - 155, R = cx + 5;
    this.add(new Slider(L, y, 150, 20, (o.fov - 30) / 80, (v) => `FOV: ${Math.round(30 + v * 80) === 70 ? 'Normal' : Math.round(30 + v * 80) === 110 ? 'Quake Pro' : Math.round(30 + v * 80)}`, (v) => { o.fov = Math.round(30 + v * 80); }, 1 / 80));
    this.add(new Slider(R, y, 150, 20, (o.renderDistance - 2) / 30, (v) => `Render Distance: ${Math.round(2 + v * 30)} chunks`, (v) => { o.renderDistance = Math.round(2 + v * 30); g.applyOptions(); }, 1 / 30));
    y += 24;
    this.add(new Slider(L, y, 150, 20, o.gamma, (v) => `Brightness: ${v <= 0 ? 'Moody' : v >= 1 ? 'Bright' : Math.round(v * 100) + '%'}`, (v) => { o.gamma = v; }));
    this.add(new Slider(R, y, 150, 20, o.sensitivity, (v) => `Sensitivity: ${Math.round(v * 200)}%`, (v) => { o.sensitivity = v; }));
    y += 24;
    this.add(new CycleButton(L, y, 150, 20, 'GUI Scale: ', [{ value: 0, label: 'Auto' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], o.guiScale, (v) => { o.guiScale = v; }));
    this.add(new CycleButton(R, y, 150, 20, 'Clouds: ', [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }], o.clouds, (v) => { o.clouds = v; g.applyOptions(); }));
    y += 24;
    this.add(new CycleButton(L, y, 150, 20, 'View Bobbing: ', [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }], o.viewBobbing, (v) => { o.viewBobbing = v; }));
    this.add(new CycleButton(R, y, 150, 20, 'Attack Indicator: ', [{ value: true, label: 'Crosshair' }, { value: false, label: 'OFF' }], o.attackIndicator, (v) => { o.attackIndicator = v; }));
    y += 24;
    this.add(new CycleButton(L, y, 150, 20, 'Subtitles: ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], o.subtitles, (v) => { o.subtitles = v; this.gui.showSubtitles = v; }));
    this.add(new CycleButton(R, y, 150, 20, 'Auto-Jump: ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], o.autoJump, (v) => { o.autoJump = v; }));
    y += 24;
    if (g.inWorld) {
      this.add(new CycleButton(L, y, 150, 20, 'Difficulty: ', [{ value: 0, label: 'Peaceful' }, { value: 1, label: 'Easy' }, { value: 2, label: 'Normal' }, { value: 3, label: 'Hard' }], g.difficulty, (v) => { g.setDifficulty(v); }));
      y += 24;
    }
    // volumes
    const vols: [string, keyof typeof o.volumes][] = [['Master Volume', 'master'], ['Music', 'music'], ['Jukebox/Note Blocks', 'record'], ['Weather', 'weather'], ['Blocks', 'block'], ['Hostile Creatures', 'hostile'], ['Friendly Creatures', 'neutral'], ['Players', 'player'], ['Ambient/Environment', 'ambient']];
    vols.forEach(([label, key], i) => {
      this.add(new Slider(i % 2 === 0 ? L : R, y + Math.floor(i / 2) * 24, 150, 20, o.volumes[key], (v) => `${label}: ${v <= 0 ? 'OFF' : Math.round(v * 100) + '%'}`, (v) => { o.volumes[key] = v; (g.sounds.volumes as any)[key] = v; g.sounds.applyVolumes(); }));
    });
    y += Math.ceil(vols.length / 2) * 24;
    this.add(new Button(L, y, 150, 20, 'Controls…', () => this.gui.open(new ControlsScreen(this))));
    this.add(new Button(R, y, 150, 20, 'Done', () => this.done()));
  }
  private done(): void { this.gui.game.saveOptions(); if (this.parent) this.gui.open(this.parent); else this.gui.close(); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['options.title'] ?? 'Options', this.width / 2, 12, 0xffffff);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.done(); return true; } return super.keyDown(code, key, mods); }
}

export class ControlsScreen extends Screen {
  hidesHud = true;
  waiting: string | null = null;
  list!: ListWidget;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game;
    const binds = DEFAULT_BINDINGS;
    this.list = this.add(new ListWidget(this.width / 2 - 155, 30, 310, this.height - 70, 24, () => binds.length, (ctx, i, x, y, w) => {
      const b = binds[i];
      this.gui.font.draw(ctx, b.label, x + 4, y + 8, 0xffffff);
      const key = g.input.bindings.get(b.name) ?? '';
      const label = this.waiting === b.name ? '> ??? <' : keyLabel(key);
      const conflict = [...g.input.bindings.values()].filter((k) => k === key).length > 1;
      this.gui.drawNineSlice(ctx, 'gui/sprites/widget/button', x + w - 130, y + 2, 75, 20, 3);
      this.gui.font.drawCentered(ctx, label, x + w - 130 + 37, y + 8, conflict ? 0xff5555 : this.waiting === b.name ? 0xffff55 : 0xffffff);
      this.gui.drawNineSlice(ctx, 'gui/sprites/widget/button', x + w - 52, y + 2, 50, 20, 3);
      this.gui.font.drawCentered(ctx, 'Reset', x + w - 27, y + 8, 0xffffff);
    }, () => {}));
    this.add(new Button(this.width / 2 - 100, this.height - 32, 200, 20, 'Done', () => { g.saveOptions(); this.gui.open(this.parent); }));
  }
  mouseDown(x: number, y: number, button: number): boolean {
    if (this.list.contains(x, y)) {
      const i = Math.floor((y - this.list.y + this.list.scroll) / this.list.rowH);
      const b = DEFAULT_BINDINGS[i];
      if (b) {
        const rx = x - this.list.x - 4, w = this.list.w - 12;
        if (rx > w - 130 && rx < w - 55) { if (this.waiting === b.name) { this.gui.game.input.bindings.set(b.name, 'Mouse' + button); this.waiting = null; } else this.waiting = b.name; return true; }
        if (rx > w - 52) { this.gui.game.input.bindings.set(b.name, b.key); this.waiting = null; return true; }
      }
    }
    if (this.waiting) { this.gui.game.input.bindings.set(this.waiting, 'Mouse' + button); this.waiting = null; return true; }
    return super.mouseDown(x, y, button);
  }
  keyDown(code: string, key: string, mods: any): boolean {
    if (this.waiting) { if (code !== 'Escape') this.gui.game.input.bindings.set(this.waiting, code); this.waiting = null; return true; }
    if (code === 'Escape') { this.gui.game.saveOptions(); this.gui.open(this.parent); return true; }
    return super.keyDown(code, key, mods);
  }
  wheel(dy: number): void { this.list.wheel(dy); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void { this.gui.font.drawCentered(ctx, 'Controls', this.width / 2, 12, 0xffffff); super.render(ctx, mx, my, partial); }
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return ['Left Button', 'Middle Button', 'Right Button', 'Button 4', 'Button 5'][+code.slice(5)] ?? code;
  return { ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Control', ControlRight: 'Right Control', AltLeft: 'Left Alt', Space: 'Space', Tab: 'Tab', Slash: '/', Escape: 'Escape', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] ?? code;
}

export class PauseScreen extends Screen {
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2, y = this.height / 4 + 8;
    this.add(new Button(cx - 102, y, 204, 20, g.assets.lang['menu.returnToGame'] ?? 'Back to Game', () => this.gui.close()));
    this.add(new Button(cx - 102, y + 24, 98, 20, g.assets.lang['menu.options'] ?? 'Options…', () => this.gui.open(new OptionsScreen(this))));
    this.add(new Button(cx + 4, y + 24, 98, 20, 'Controls…', () => this.gui.open(new ControlsScreen(this))));
    this.add(new Button(cx - 102, y + 48, 204, 20, g.assets.lang['menu.returnToMenu'] ?? 'Save and Quit to Title', () => g.quitToTitle()));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void { this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['menu.game'] ?? 'Game Menu', this.width / 2, this.height / 4 - 16, 0xffffff); super.render(ctx, mx, my, partial); }
}

export class DeathScreen extends Screen {
  closeOnEsc = false; pausesGame = false;
  timer = 0;
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    const r = this.add(new Button(cx - 100, this.height / 4 + 72, 200, 20, g.assets.lang['deathScreen.respawn'] ?? 'Respawn', () => { this.gui.close(); g.respawnPlayer(); }));
    const t = this.add(new Button(cx - 100, this.height / 4 + 96, 200, 20, g.assets.lang['deathScreen.titleScreen'] ?? 'Title Screen', () => g.quitToTitle()));
    r.active = false; t.active = false;
  }
  tick(): void { this.timer++; if (this.timer === 20) for (const w of this.widgets) w.active = true; }
  drawBackground(ctx: CanvasRenderingContext2D): void { const grad = ctx.createLinearGradient(0, 0, 0, this.height); grad.addColorStop(0, 'rgba(96,0,0,0.5)'); grad.addColorStop(1, 'rgba(160,0,0,0.6)'); ctx.fillStyle = grad; ctx.fillRect(0, 0, this.width, this.height); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const g = this.gui.game;
    ctx.save(); ctx.translate(this.width / 2, this.height / 4); ctx.scale(2, 2); this.gui.font.drawCentered(ctx, g.assets.lang['deathScreen.title'] ?? 'You Died!', 0, 0, 0xffffff); ctx.restore();
    this.gui.font.drawCentered(ctx, g.player.deathMessage, this.width / 2, this.height / 4 + 30, 0xffffff);
    this.gui.font.drawCentered(ctx, (g.assets.lang['deathScreen.score'] ?? 'Score: %s').replace('%s', '§e' + g.player.score), this.width / 2, this.height / 4 + 50, 0xffffff);
    super.render(ctx, mx, my, partial);
  }
}

export class ChatScreen extends Screen {
  pausesGame = false; darkBackground = false;
  field!: TextField;
  histIndex = -1;
  constructor(private initial = '') { super(); }
  build(): void {
    this.field = this.add(new TextField(2, this.height - 14, this.width - 4, 12, this.initial));
    this.field.maxLength = 256;
    this.field.onEnter = (t) => { if (t.trim()) { this.gui.chatHistory.push(t); this.gui.game.handleChat(t); } this.gui.close(); };
    this.focused = this.field;
    this.histIndex = this.gui.chatHistory.length;
  }
  keyDown(code: string, key: string, mods: any): boolean {
    if (code === 'ArrowUp') { if (this.histIndex > 0) { this.histIndex--; this.field.text = this.gui.chatHistory[this.histIndex]; this.field.cursor = this.field.text.length; } return true; }
    if (code === 'ArrowDown') { if (this.histIndex < this.gui.chatHistory.length) { this.histIndex++; this.field.text = this.gui.chatHistory[this.histIndex] ?? ''; this.field.cursor = this.field.text.length; } return true; }
    if (code === 'Tab' && this.field.text.startsWith('/')) { const c = this.gui.game.completeCommand(this.field.text); if (c) { this.field.text = c; this.field.cursor = c.length; } return true; }
    return super.keyDown(code, key, mods);
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.drawChat(ctx, true);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(2, this.height - 14, this.width - 4, 12);
    super.render(ctx, mx, my, partial);
  }
}

export { Checkbox };
