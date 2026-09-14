// Keyboard / mouse input with rebindable keys.
export interface KeyBinding { name: string; label: string; key: string }

export const DEFAULT_BINDINGS: KeyBinding[] = [
  { name: 'forward', label: 'Walk Forwards', key: 'KeyW' }, { name: 'back', label: 'Walk Backwards', key: 'KeyS' },
  { name: 'left', label: 'Strafe Left', key: 'KeyA' }, { name: 'right', label: 'Strafe Right', key: 'KeyD' },
  { name: 'jump', label: 'Jump', key: 'Space' }, { name: 'sneak', label: 'Sneak', key: 'ShiftLeft' }, { name: 'sprint', label: 'Sprint', key: 'ControlLeft' },
  { name: 'inventory', label: 'Open/Close Inventory', key: 'KeyE' }, { name: 'drop', label: 'Drop Selected Item', key: 'KeyQ' }, { name: 'swapHands', label: 'Swap Item With Offhand', key: 'KeyF' },
  { name: 'chat', label: 'Open Chat', key: 'KeyT' }, { name: 'command', label: 'Open Command', key: 'Slash' }, { name: 'playerList', label: 'List Players', key: 'Tab' },
  { name: 'togglePerspective', label: 'Toggle Perspective', key: 'F5' }, { name: 'debug', label: 'Debug Screen', key: 'F3' }, { name: 'hideGui', label: 'Hide GUI', key: 'F1' }, { name: 'fullscreen', label: 'Toggle Fullscreen', key: 'F11' }, { name: 'screenshot', label: 'Take Screenshot', key: 'F2' },
  { name: 'pickBlock', label: 'Pick Block', key: 'Mouse1' }, { name: 'attack', label: 'Attack/Destroy', key: 'Mouse0' }, { name: 'use', label: 'Use Item/Place Block', key: 'Mouse2' },
  { name: 'hotbar1', label: 'Hotbar Slot 1', key: 'Digit1' }, { name: 'hotbar2', label: 'Hotbar Slot 2', key: 'Digit2' }, { name: 'hotbar3', label: 'Hotbar Slot 3', key: 'Digit3' }, { name: 'hotbar4', label: 'Hotbar Slot 4', key: 'Digit4' }, { name: 'hotbar5', label: 'Hotbar Slot 5', key: 'Digit5' }, { name: 'hotbar6', label: 'Hotbar Slot 6', key: 'Digit6' }, { name: 'hotbar7', label: 'Hotbar Slot 7', key: 'Digit7' }, { name: 'hotbar8', label: 'Hotbar Slot 8', key: 'Digit8' }, { name: 'hotbar9', label: 'Hotbar Slot 9', key: 'Digit9' },
];

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();   // pressed this frame (GUI)
  released = new Set<string>();
  buttons = new Set<number>();
  buttonsPressed = new Set<number>();
  buttonsReleased = new Set<number>();
  // accumulated since the last game tick (gameplay)
  tickPressed = new Set<string>();
  tickButtonsPressed = new Set<number>();
  tickDoubleTapped = new Set<string>();
  tickWheel = 0;
  mouseDx = 0; mouseDy = 0;
  wheel = 0;
  mouseX = 0; mouseY = 0;
  typed: string[] = [];  // text input characters this frame
  bindings = new Map<string, string>();
  pointerLocked = false;
  lastKeyTime = new Map<string, number>();
  doubleTapped = new Set<string>();

  constructor(public canvas: HTMLCanvasElement) {
    for (const b of DEFAULT_BINDINGS) this.bindings.set(b.name, b.key);
    window.addEventListener('keydown', (e) => {
      if (this.wantLock && !this.pointerLocked && e.code !== 'Escape') this.lockPointer();
      if (e.code === 'Tab' || e.code === 'F1' || e.code === 'F3' || e.code === 'F5' || e.code === 'F11' || e.code === 'Slash' || e.code === 'F2' || e.code === 'Space' || ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.code === 'KeyW' || e.code === 'KeyD' || e.code === 'KeyA' || e.code === 'KeyQ' || e.code === 'KeyE' || e.code === 'KeyR' || e.code === 'KeyF' || e.code === 'KeyP'))) e.preventDefault();
      if (!this.keys.has(e.code)) {
        this.pressed.add(e.code); this.tickPressed.add(e.code);
        const now = performance.now();
        const last = this.lastKeyTime.get(e.code) ?? 0;
        if (now - last < 300) { this.doubleTapped.add(e.code); this.tickDoubleTapped.add(e.code); }
        this.lastKeyTime.set(e.code, now);
      }
      this.keys.add(e.code);
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.typed.push(e.key);
      else if (e.key === 'Backspace') this.typed.push('\b');
      else if (e.key === 'Enter') this.typed.push('\n');
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { navigator.clipboard?.readText().then((t) => { for (const ch of t) this.typed.push(ch); }).catch(() => {}); }
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.released.add(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    // macOS: Ctrl+click is the right button (vanilla treats it the same way)
    const mapButton = (e: MouseEvent) => (e.button === 0 && e.ctrlKey && /Mac/.test(navigator.platform) ? 2 : e.button);
    window.addEventListener('mousedown', (e) => { if (this.wantLock && !this.pointerLocked) this.lockPointer(); const b = mapButton(e); this.buttons.add(b); this.buttonsPressed.add(b); this.tickButtonsPressed.add(b); if (b === 1) e.preventDefault(); });
    window.addEventListener('mouseup', (e) => { const b = mapButton(e); this.buttons.delete(b); this.buttons.delete(e.button); this.buttonsReleased.add(b); });
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        // while a screen is open the lock is kept and a software cursor is moved instead of the camera
        if (this.softCursor) { this.mouseX = Math.max(0, Math.min(window.innerWidth - 1, this.mouseX + e.movementX)); this.mouseY = Math.max(0, Math.min(window.innerHeight - 1, this.mouseY + e.movementY)); }
        else { this.mouseDx += e.movementX; this.mouseDy += e.movementY; }
      } else { this.mouseX = e.clientX; this.mouseY = e.clientY; }
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); this.tickWheel += Math.sign(e.deltaY); if (this.pointerLocked) e.preventDefault(); }, { passive: false });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.pointerLocked = document.pointerLockElement === canvas; });
    // Ctrl/Cmd+W closes the tab in every browser (the page cannot cancel it); the confirmation dialog at least
    // stops an accidental sprint+W from throwing away an unsaved world. Fullscreen + Keyboard Lock captures it fully.
    window.addEventListener('beforeunload', (e) => { if (this.wantLock || this.softCursor) { e.preventDefault(); (e as any).returnValue = ''; } });
    // In fullscreen, Keyboard Lock lets the page receive Esc without the browser dropping the pointer lock.
    document.addEventListener('fullscreenchange', () => {
      const kb: any = (navigator as any).keyboard;
      if (!kb?.lock) return;
      if (document.fullscreenElement) kb.lock(['Escape', 'KeyW', 'KeyT', 'KeyN', 'Tab', 'F5']).then(() => { this.keyboardLocked = !!document.fullscreenElement; }).catch(() => {});
      else { kb.unlock?.(); this.keyboardLocked = false; }
    });
  }

  key(name: string): string { return this.bindings.get(name) ?? ''; }
  isDown(name: string): boolean { const k = this.key(name); return k.startsWith('Mouse') ? this.buttons.has(+k.slice(5)) : this.keys.has(k); }
  /** Pressed since the last game tick (use from tick code). */
  wasPressed(name: string): boolean { const k = this.key(name); return k.startsWith('Mouse') ? this.tickButtonsPressed.has(+k.slice(5)) : this.tickPressed.has(k); }
  wasReleased(name: string): boolean { const k = this.key(name); return k.startsWith('Mouse') ? this.buttonsReleased.has(+k.slice(5)) : this.released.has(k); }
  wasDoubleTapped(name: string): boolean { return this.tickDoubleTapped.has(this.key(name)); }
  /** Pressed this frame (use from per-frame code). */
  keyPressed(code: string): boolean { return this.pressed.has(code); }
  framePressed(name: string): boolean { const k = this.key(name); return k.startsWith('Mouse') ? this.buttonsPressed.has(+k.slice(5)) : this.pressed.has(k); }
  /** Clear the per-tick buffers after a game tick consumed them. */
  consumeTick(): void { this.tickPressed.clear(); this.tickButtonsPressed.clear(); this.tickDoubleTapped.clear(); this.tickWheel = 0; }
  /** Drop buffered gameplay input (e.g. while a screen is open). */
  discardTick(): void { this.consumeTick(); }

  lastLockRequest = 0;
  /** Set by the game: the pointer should be locked (in world, no screen). Re-acquired on the next gesture if a request was rejected. */
  wantLock = false;
  /** A GUI screen is open: mouse movement drives the software cursor instead of the camera. */
  softCursor = false;
  /** Fullscreen Keyboard Lock is active: Esc reaches the page and does not drop the pointer lock. */
  keyboardLocked = false;
  /** Raw Input option: request unaccelerated mouse movement. */
  rawInput = true;
  lockPointer(): void { this.lastLockRequest = performance.now(); if (!this.pointerLocked) { try { const r: any = this.canvas.requestPointerLock?.({ unadjustedMovement: this.rawInput } as any); if (r && r.catch) r.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* */ } }); } catch { try { this.canvas.requestPointerLock(); } catch { /* */ } } } }
  unlockPointer(): void { this.lastLockRequest = performance.now(); if (this.pointerLocked) document.exitPointerLock(); }

  /** Call at end of frame. */
  endFrame(): void {
    this.pressed.clear(); this.released.clear(); this.buttonsPressed.clear(); this.buttonsReleased.clear();
    this.mouseDx = 0; this.mouseDy = 0; this.wheel = 0; this.typed.length = 0; this.doubleTapped.clear();
  }
}
