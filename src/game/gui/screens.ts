// Menus: title, world select/create, options, controls, pause, death, chat, confirm.
import { OptionsScreen } from './settings';
import { MultiplayerScreen, ShareWorldScreen, DisconnectedScreen } from './multiplayer';
export { DisconnectedScreen };
export { OptionsScreen };
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
    this.add(new Button(cx - 100, y + 24, 200, 20, g.assets.lang['menu.multiplayer'] ?? 'Multiplayer', () => this.gui.open(new MultiplayerScreen(this))));
    this.add(new Button(cx - 100, y + 48, 200, 20, 'Credits', () => this.gui.open(new CreditsScreen(this))));
    this.add(new Button(cx - 100, y + 72 + 12, 98, 20, g.assets.lang['menu.options'] ?? 'Options...', () => this.gui.open(new OptionsScreen(this))));
    this.add(new Button(cx + 2, y + 72 + 12, 98, 20, g.assets.lang['menu.quit'] ?? 'Quit Game', () => location.reload()));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    // logo (vanilla: 274x44 at y=30; ours is the name at 4x, same vertical band)
    const logoW = this.gui.font.width('VoxeLand') * 4;
    ctx.save(); ctx.translate(cx, 30 + 22); ctx.scale(4, 4);
    this.gui.font.drawCentered(ctx, 'VoxeLand', 0, -4, 0xffffff, true);
    ctx.restore();
    // splash (vanilla SplashRenderer: rotated -20deg at the logo's lower-right corner, pulsing scale)
    if (!g.options.hideSplashTexts) {
      const t = performance.now() % 1000 / 1000;
      let s = 1.8 - Math.abs(Math.sin(t * Math.PI * 2) * 0.1);
      s = s * 100 / (this.gui.font.width(this.splash) + 32);
      ctx.save(); ctx.translate(cx + logoW / 2 + 6, 30 + 39); ctx.rotate(-20 * Math.PI / 180); ctx.scale(s, s);
      this.gui.font.drawCentered(ctx, this.splash, 0, -4, 0xffff00, true);
      ctx.restore();
    }
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
    storage.listWorlds().then((w) => { this.worlds = w.filter((x) => x.id !== 'public'); }); // the server's world is joined from Multiplayer
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
    this.add(new Button(cx - 102, y + 24, 98, 20, 'Advancements', () => {}));
    this.add(new Button(cx + 4, y + 24, 98, 20, 'Statistics', () => {}));
    this.add(new Button(cx - 102, y + 48, 98, 20, g.assets.lang['menu.options'] ?? 'Options...', () => this.gui.open(new OptionsScreen(this))));
    const share = this.add(new Button(cx + 4, y + 48, 98, 20, g.isRemote ? 'Player List' : 'Share World', () => { if (g.isRemote) this.gui.showPlayerList = !this.gui.showPlayerList; else if (!g.host) this.gui.open(new ShareWorldScreen(this)); }));
    if (g.host) share.active = false;
    this.add(new Button(cx - 102, y + 72, 204, 20, g.isRemote ? 'Disconnect' : g.assets.lang['menu.returnToMenu'] ?? 'Save and Quit to Title', () => g.quitToTitle()));
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
  /** command suggestions (vanilla CommandSuggestions): list + selected index */
  suggestions: string[] = [];
  suggestIndex = 0;
  constructor(private initial = '') { super(); }
  build(): void {
    // vanilla ChatScreen: EditBox(4, height - 12, width - 4, 12) without border over a box at height - 14
    this.field = this.add(new TextField(4, this.height - 12, this.width - 8, 12, this.initial));
    this.field.bordered = false;
    this.field.maxLength = 256;
    this.field.onEnter = (t) => { if (t.trim()) { this.gui.chatHistory.push(t); this.gui.game.handleChat(t); } this.gui.close(); };
    this.field.onChange = () => this.updateSuggestions();
    this.focused = this.field;
    this.histIndex = this.gui.chatHistory.length;
    this.gui.chatScroll = 0;
    this.updateSuggestions();
  }
  onClose(): void { this.gui.chatScroll = 0; }
  private updateSuggestions(): void {
    const t = this.field.text;
    this.suggestions = t.startsWith('/') && this.gui.game.options.commandSuggestions ? this.gui.game.commandSuggestions(t) : [];
    this.suggestIndex = 0;
  }
  private applySuggestion(): void {
    const sg = this.suggestions[this.suggestIndex]; if (!sg) return;
    const t = this.field.text; const i = t.lastIndexOf(' ');
    this.field.text = t.slice(0, i + 1) + sg + ' '; this.field.cursor = this.field.text.length;
    this.updateSuggestions();
  }
  keyDown(code: string, key: string, mods: any): boolean {
    if (this.suggestions.length && (code === 'ArrowUp' || code === 'ArrowDown')) { this.suggestIndex = (this.suggestIndex + (code === 'ArrowUp' ? -1 : 1) + this.suggestions.length) % this.suggestions.length; return true; }
    if (code === 'ArrowUp') { if (this.histIndex > 0) { this.histIndex--; this.field.text = this.gui.chatHistory[this.histIndex]; this.field.cursor = this.field.text.length; } return true; }
    if (code === 'ArrowDown') { if (this.histIndex < this.gui.chatHistory.length) { this.histIndex++; this.field.text = this.gui.chatHistory[this.histIndex] ?? ''; this.field.cursor = this.field.text.length; } return true; }
    if (code === 'Tab') { if (this.suggestions.length) this.applySuggestion(); else if (this.field.text.startsWith('/')) { const c = this.gui.game.completeCommand(this.field.text); if (c) { this.field.text = c; this.field.cursor = c.length; this.updateSuggestions(); } } return true; }
    if (code === 'PageUp') { this.gui.chatScroll += 5; return true; }
    if (code === 'PageDown') { this.gui.chatScroll = Math.max(0, this.gui.chatScroll - 5); return true; }
    return super.keyDown(code, key, mods);
  }
  wheel(dy: number): void { this.gui.chatScroll = Math.max(0, this.gui.chatScroll - Math.sign(dy) * (this.gui.game.input.keys.has('ShiftLeft') ? 7 : 1)); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.drawChat(ctx, true);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(2, this.height - 14, this.width - 4, 12);
    super.render(ctx, mx, my, partial);
    // suggestion popup above the input (vanilla: up to 10 rows, highlighted selection, usage hint)
    if (this.suggestions.length) {
      const rows = this.suggestions.slice(0, 10);
      const prefix = this.field.text.slice(0, this.field.text.lastIndexOf(' ') + 1);
      const x = 4 + this.gui.font.width(prefix);
      let w = 0; for (const r of rows) w = Math.max(w, this.gui.font.width(r));
      const y0 = this.height - 14 - rows.length * 12 - 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 1, y0 - 1, w + 4, rows.length * 12 + 2);
      rows.forEach((r, i) => this.gui.font.draw(ctx, r, x + 1, y0 + 2 + i * 12, i === this.suggestIndex ? 0xffff00 : 0xa0a0a0));
    } else if (this.field.text.startsWith('/')) {
      const usage = this.gui.game.commandUsage(this.field.text);
      if (usage) { const w = this.gui.font.width(usage); ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(3, this.height - 28, w + 4, 12); this.gui.font.draw(ctx, usage, 5, this.height - 26, 0x808080); }
    }
  }
}

export { Checkbox };
