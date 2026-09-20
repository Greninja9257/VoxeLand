// Screen base class + widgets (button, slider, text field, checkbox, toggle switch, list).
import type { Gui } from './gui';

export abstract class Screen {
  gui!: Gui;
  widgets: Widget[] = [];
  width = 0; height = 0;
  pausesGame = true;
  closeOnEsc = true;
  hidesHud = false;
  darkBackground = true;
  initialized = false;
  focused: Widget | null = null;

  init(): void { this.widgets = []; this.build(); this.initialized = true; }
  abstract build(): void;
  resize(): void { this.init(); }
  tick(): void {}
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    for (const w of this.widgets) if (w.visible) w.render(ctx, mx, my, partial, this);
  }
  mouseDown(x: number, y: number, button: number): boolean {
    for (const w of this.widgets) if (w.visible && w.active && w.contains(x, y)) { this.focused = w; w.mouseDown(x, y, button, this); return true; }
    this.focused = null;
    return false;
  }
  mouseUp(x: number, y: number, button: number): void { for (const w of this.widgets) w.mouseUp(x, y, button, this); }
  mouseMove(x: number, y: number): void { for (const w of this.widgets) w.mouseMove(x, y, this); }
  wheel(_dy: number, _x: number, _y: number): void {}
  keyDown(code: string, key: string, mods: { shift: boolean; ctrl: boolean }): boolean {
    if (this.focused && this.focused.keyDown(code, key, mods, this)) return true;
    if (code === 'Escape' && this.closeOnEsc) { this.onClose(); this.gui.close(); return true; }
    if (code === 'Tab') { const active = this.widgets.filter((w) => w.visible && w.active && w.focusable); if (active.length) { const i = active.indexOf(this.focused as Widget); this.focused = active[(i + 1) % active.length]; } return true; }
    return false;
  }
  typed(ch: string): void { this.focused?.typed(ch, this); }
  onClose(): void {}
  add<T extends Widget>(w: T): T { this.widgets.push(w); return w; }
  drawBackground(ctx: CanvasRenderingContext2D): void { if (this.darkBackground) this.gui.drawScreenBackground(ctx); }
}

export abstract class Widget {
  visible = true; active = true; focusable = true;
  hovered = false;
  tooltip: string | null = null;
  constructor(public x: number, public y: number, public w: number, public h: number) {}
  contains(px: number, py: number): boolean { return px >= this.x && py >= this.y && px < this.x + this.w && py < this.y + this.h; }
  abstract render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number, screen: Screen): void;
  mouseDown(_x: number, _y: number, _b: number, _s: Screen): void {}
  mouseUp(_x: number, _y: number, _b: number, _s: Screen): void {}
  mouseMove(x: number, y: number, _s: Screen): void { this.hovered = this.contains(x, y); }
  keyDown(_code: string, _key: string, _mods: { shift: boolean; ctrl: boolean }, _s: Screen): boolean { return false; }
  typed(_ch: string, _s: Screen): void {}
}

export class Button extends Widget {
  constructor(x: number, y: number, w: number, h: number, public label: string, public onClick: (b: Button) => void) { super(x, y, w, h); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    const hov = this.active && this.contains(mx, my);
    gui.drawNineSlice(ctx, !this.active ? 'gui/sprites/widget/button_disabled' : hov ? 'gui/sprites/widget/button_highlighted' : 'gui/sprites/widget/button', this.x, this.y, this.w, this.h, 3);
    const color = !this.active ? 0xa0a0a0 : hov ? 0xffffa0 : 0xffffff;
    gui.font.drawCentered(ctx, this.label, this.x + this.w / 2, this.y + (this.h - 8) / 2, color);
    if (hov && this.tooltip) gui.queueTooltip([this.tooltip], mx, my);
  }
  mouseDown(_x: number, _y: number, b: number, s: Screen): void { if (b === 0 && this.active) { s.gui.game.sounds.play('ui.button.click', 0.25, 1); this.onClick(this); } }
}

export class Slider extends Widget {
  dragging = false;
  constructor(x: number, y: number, w: number, h: number, public value: number, public label: (v: number) => string, public onChange: (v: number) => void, public step = 0) { super(x, y, w, h); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    const hov = this.contains(mx, my) || this.dragging;
    gui.drawNineSlice(ctx, hov ? 'gui/sprites/widget/slider_highlighted' : 'gui/sprites/widget/slider', this.x, this.y, this.w, this.h, 3);
    const hx = this.x + Math.round(this.value * (this.w - 8));
    gui.drawNineSlice(ctx, hov ? 'gui/sprites/widget/slider_handle_highlighted' : 'gui/sprites/widget/slider_handle', hx, this.y, 8, this.h, 3);
    gui.font.drawCentered(ctx, this.label(this.value), this.x + this.w / 2, this.y + (this.h - 8) / 2, hov ? 0xffffa0 : 0xffffff);
  }
  private setFromMouse(x: number): void {
    let v = Math.max(0, Math.min(1, (x - this.x - 4) / (this.w - 8)));
    if (this.step > 0) v = Math.round(v / this.step) * this.step;
    if (v !== this.value) { this.value = v; this.onChange(v); }
  }
  mouseDown(x: number, _y: number, b: number): void { if (b === 0) { this.dragging = true; this.setFromMouse(x); } }
  mouseMove(x: number, y: number, s: Screen): void { super.mouseMove(x, y, s); if (this.dragging) this.setFromMouse(x); }
  mouseUp(_x: number, _y: number, _b: number, s: Screen): void { if (this.dragging) { this.dragging = false; s.gui.game.sounds.play('ui.button.click', 0.25, 1); } }
  keyDown(code: string): boolean { if (code === 'ArrowLeft') { this.value = Math.max(0, this.value - (this.step || 0.05)); this.onChange(this.value); return true; } if (code === 'ArrowRight') { this.value = Math.min(1, this.value + (this.step || 0.05)); this.onChange(this.value); return true; } return false; }
}

export class TextField extends Widget {
  text = '';
  cursor = 0;
  maxLength = 64;
  placeholder = '';
  onEnter: ((t: string) => void) | null = null;
  onChange: ((t: string) => void) | null = null;
  filter: ((ch: string) => boolean) | null = null;
  bordered = true;
  /** render the text as dots (passwords) */
  password = false;
  constructor(x: number, y: number, w: number, h: number, text = '') { super(x, y, w, h); this.text = text; this.cursor = text.length; }
  render(ctx: CanvasRenderingContext2D, _mx: number, _my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    const focused = s.focused === this;
    if (this.bordered) gui.drawNineSlice(ctx, focused ? 'gui/sprites/widget/text_field_highlighted' : 'gui/sprites/widget/text_field', this.x, this.y, this.w, this.h, 1);
    // vanilla EditBox: bordered text at (x+4, y+(h-8)/2), unbordered at (x, y)
    const tx = this.bordered ? this.x + 4 : this.x, ty = this.bordered ? this.y + (this.h - 8) / 2 : this.y;
    const inner = this.bordered ? this.w - 8 : this.w;
    ctx.save(); ctx.beginPath(); ctx.rect(tx - 1, this.y, inner + 2, this.h); ctx.clip();
    if (!this.text && this.placeholder && !focused) gui.font.draw(ctx, this.placeholder, tx, ty, 0x808080);
    // scroll so cursor visible
    const shown = this.password ? '•'.repeat(this.text.length) : this.text;
    const before = (this.password ? '•'.repeat(this.cursor) : this.text.slice(0, this.cursor));
    let off = 0;
    const bw = gui.font.width(before);
    if (bw > inner - 2) off = bw - (inner - 2);
    this.scrollOff = off;
    gui.font.draw(ctx, shown, tx - off, ty, 0xe0e0e0);
    if (focused && Math.floor(performance.now() / 500) % 2 === 0) { const cx = tx - off + bw; if (this.cursor === this.text.length) gui.font.draw(ctx, '_', cx, ty, 0xe0e0e0, false); else { ctx.fillStyle = '#e0e0e0'; ctx.fillRect(cx, ty - 1, 1, 10); } }
    ctx.restore();
  }
  private scrollOff = 0;
  mouseDown(x: number, _y: number, _b: number, s: Screen): void {
    const tx = (this.bordered ? this.x + 4 : this.x) - this.scrollOff;
    const font = s.gui.font;
    let best = this.text.length;
    for (let i = 0; i <= this.text.length; i++) { const wx = tx + font.width(this.text.slice(0, i)); if (wx + font.width(this.text.charAt(i) || ' ') / 2 > x) { best = i; break; } }
    this.cursor = best;
  }
  keyDown(code: string, _key: string, mods: { shift: boolean; ctrl: boolean }): boolean {
    if (code === 'ArrowLeft') { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (code === 'ArrowRight') { this.cursor = Math.min(this.text.length, this.cursor + 1); return true; }
    if (code === 'Home') { this.cursor = 0; return true; }
    if (code === 'End') { this.cursor = this.text.length; return true; }
    if (code === 'Delete') { this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1); this.onChange?.(this.text); return true; }
    if (code === 'Enter' || code === 'NumpadEnter') { this.onEnter?.(this.text); return true; }
    if (code === 'Backspace') { if (mods.ctrl) { this.text = ''; this.cursor = 0; } else if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } this.onChange?.(this.text); return true; }
    if (code === 'Escape') return false;
    return code.startsWith('Key') || code.startsWith('Digit') || code === 'Space' || code === 'Minus' || code === 'Period' || code === 'Comma' || code === 'Slash' || code === 'Quote' || code === 'Semicolon' || code.startsWith('Numpad') || code === 'Equal' || code === 'BracketLeft' || code === 'BracketRight' || code === 'Backslash' || code === 'Backquote';
  }
  typed(ch: string): void {
    if (ch === '\b' || ch === '\n') return;
    if (this.filter && !this.filter(ch)) return;
    if (this.text.length >= this.maxLength) return;
    this.text = this.text.slice(0, this.cursor) + ch + this.text.slice(this.cursor);
    this.cursor += ch.length;
    this.onChange?.(this.text);
  }
}

export class Checkbox extends Widget {
  constructor(x: number, y: number, public label: string, public checked: boolean, public onChange: (v: boolean) => void) { super(x, y, 20 + 6 + 0, 20); this.w = 20 + 6 + 100; }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    const hov = this.contains(mx, my);
    gui.drawSprite(ctx, this.checked ? (hov ? 'gui/sprites/widget/checkbox_selected_highlighted' : 'gui/sprites/widget/checkbox_selected') : (hov ? 'gui/sprites/widget/checkbox_highlighted' : 'gui/sprites/widget/checkbox'), this.x, this.y, 20, 20);
    gui.font.draw(ctx, this.label, this.x + 24, this.y + 6, 0xffffff);
  }
  mouseDown(_x: number, _y: number, b: number, s: Screen): void { if (b === 0) { this.checked = !this.checked; this.onChange(this.checked); s.gui.game.sounds.play('ui.button.click', 0.25, 1); } }
}

/** An on/off toggle switch (Bedrock-style): a pill track that turns green with a knob sliding across. */
export class ToggleSwitch extends Widget {
  private knob: number; // 0..1, animated
  constructor(x: number, y: number, public value: boolean, public onChange: (v: boolean) => void, public label = '') { super(x, y, 40 + (label ? 60 : 30), 20); this.knob = value ? 1 : 0; }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    const hov = this.active && this.contains(mx, my);
    const target = this.value ? 1 : 0;
    this.knob += (target - this.knob) * 0.35; if (Math.abs(target - this.knob) < 0.02) this.knob = target;
    const tx = this.x, ty = this.y + 3, tw = 36, th = 14;
    const on = this.knob;
    // track: dark rim, grey→green fill blending with the knob position
    const mix = (a: number, b: number) => Math.round(a + (b - a) * on);
    const fill = `rgb(${mix(0x58, 0x2f)},${mix(0x58, 0xb0)},${mix(0x58, 0x38)})`;
    const rim = this.active ? '#0a0a0a' : '#2a2a2a';
    ctx.fillStyle = rim; ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = this.active ? fill : '#3a3a3a'; ctx.fillRect(tx + 1, ty + 1, tw - 2, th - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(tx + 1, ty + 1, tw - 2, 2); // inner shadow
    // knob: 14×14 square with a light face and bevel, slides from the left to the right end
    const kx = Math.round(tx + 1 + on * (tw - 2 - 12));
    ctx.fillStyle = rim; ctx.fillRect(kx - 1, ty, 14, th);
    ctx.fillStyle = hov ? '#ffffff' : '#e0e0e0'; ctx.fillRect(kx, ty + 1, 12, th - 2);
    ctx.fillStyle = hov ? '#c8c8c8' : '#a8a8a8'; ctx.fillRect(kx, ty + th - 4, 12, 3); ctx.fillRect(kx + 9, ty + 1, 3, th - 2);
    const text = (this.label ? this.label + ': ' : '') + (this.value ? 'ON' : 'OFF');
    gui.font.draw(ctx, text, tx + tw + 6, this.y + 6, !this.active ? 0xa0a0a0 : this.value ? (hov ? 0x9cff9c : 0x55ff55) : hov ? 0xffffa0 : 0xa0a0a0);
  }
  mouseDown(_x: number, _y: number, b: number, s: Screen): void {
    if (b !== 0 || !this.active) return;
    this.value = !this.value;
    s.gui.game.sounds.play('ui.button.click', 0.25, 1);
    this.onChange(this.value);
  }
}

export class CycleButton<T> extends Button {
  index: number;
  constructor(x: number, y: number, w: number, h: number, public prefix: string, public options: { value: T; label: string }[], initial: T, public onCycle: (v: T) => void) {
    super(x, y, w, h, '', () => {});
    this.index = Math.max(0, options.findIndex((o) => o.value === initial));
    this.label = this.prefix + this.options[this.index].label;
    this.onClick = () => { this.index = (this.index + 1) % this.options.length; this.label = this.prefix + this.options[this.index].label; this.onCycle(this.options[this.index].value); };
  }
  get value(): T { return this.options[this.index].value; }
}

/** Scrollable list of rows (each row height rowH). */
export class ListWidget extends Widget {
  scroll = 0;
  selected = -1;
  constructor(x: number, y: number, w: number, h: number, public rowH: number, public count: () => number, public renderRow: (ctx: CanvasRenderingContext2D, i: number, x: number, y: number, w: number, selected: boolean, hovered: boolean) => void, public onSelect: (i: number, double: boolean) => void) { super(x, y, w, h); }
  private lastClick = 0; private lastIndex = -1;
  get maxScroll(): number { return Math.max(0, this.count() * this.rowH - this.h); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, _p: number, s: Screen): void {
    const gui = s.gui;
    ctx.save(); ctx.beginPath(); ctx.rect(this.x, this.y, this.w, this.h); ctx.clip();
    gui.drawListBackground(ctx, this.x, this.y, this.w, this.h);
    const n = this.count();
    for (let i = 0; i < n; i++) {
      const ry = this.y + i * this.rowH - this.scroll;
      if (ry + this.rowH < this.y || ry > this.y + this.h) continue;
      const hov = this.contains(mx, my) && my >= ry && my < ry + this.rowH;
      this.renderRow(ctx, i, this.x + 4, ry, this.w - 12, i === this.selected, hov);
    }
    ctx.restore();
    if (this.maxScroll > 0) {
      const barH = Math.max(10, this.h * this.h / (n * this.rowH));
      const by = this.y + (this.scroll / this.maxScroll) * (this.h - barH);
      ctx.fillStyle = '#000'; ctx.fillRect(this.x + this.w - 6, this.y, 6, this.h);
      ctx.fillStyle = '#808080'; ctx.fillRect(this.x + this.w - 6, by, 6, barH);
      ctx.fillStyle = '#c0c0c0'; ctx.fillRect(this.x + this.w - 6, by, 5, barH - 1);
    }
  }
  mouseDown(x: number, y: number, b: number): void {
    if (b !== 0) return;
    const i = Math.floor((y - this.y + this.scroll) / this.rowH);
    if (i >= 0 && i < this.count()) { const now = performance.now(); const dbl = i === this.lastIndex && now - this.lastClick < 400; this.selected = i; this.lastClick = now; this.lastIndex = i; this.onSelect(i, dbl); }
    void x;
  }
  wheel(dy: number): void { this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + dy * this.rowH)); }
}
