// Multiplayer screens: server list (the backend's public world + everything hosted on the relays you use),
// direct connection by IP, the password prompt, "Share World" (public / private with a password) and the
// disconnect notice.
import { Screen, Button, ListWidget, TextField, CycleButton } from './widgets';
import { TitleScreen } from './screens';
import { listServers, PasswordRequired } from '../../net/client';
import { defaultRelayUrl, normalizeRelayUrl, type ServerInfo } from '../../net/protocol';

type Row = ServerInfo & { relay: string };

export class MultiplayerScreen extends Screen {
  pausesGame = false; hidesHud = true;
  servers: Row[] = [];
  list!: ListWidget;
  joinBtn!: Button;
  status = 'Looking for servers…';
  private nameField!: TextField;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    this.nameField = new TextField(cx - 118, 6, 120, 12, g.options.playerName);
    this.nameField.maxLength = 16; this.nameField.placeholder = 'Player name'; this.nameField.bordered = false;
    this.nameField.onChange = (t) => { g.options.playerName = t.replace(/[^\w]/g, '').slice(0, 16); if (g.player && !g.isRemote && !g.host) g.player.name = g.options.playerName || 'Player'; };
    this.add(this.nameField);
    this.list = this.add(new ListWidget(cx - 150, 22, 300, this.height - 90, 36, () => this.servers.length, (ctx, i, x, y, w, sel, hov) => {
      const s = this.servers[i];
      if (sel) { ctx.fillStyle = '#808080'; ctx.fillRect(x - 2, y, w + 4, 36); ctx.fillStyle = '#000'; ctx.fillRect(x - 1, y + 1, w + 2, 34); }
      else if (hov) { ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x - 2, y, w + 4, 36); }
      const title = (s.official ? '§b' : s.private ? '§e' : '') + s.name + (s.private ? ' §7[private]' : '');
      this.gui.font.draw(ctx, title, x + 4, y + 3, 0xffffff);
      this.gui.font.draw(ctx, s.motd || (s.official ? 'Always open — hosted by the backend' : `hosted by ${s.host}`), x + 4, y + 13, 0x808080);
      if (!s.official) this.gui.font.draw(ctx, `${s.gameMode ?? 'survival'} · ${s.relay.replace(/^wss?:\/\//, '').replace(/\/ws$/, '')}`, x + 4, y + 23, 0x808080);
      this.gui.font.drawRight(ctx, `${s.players}/${s.maxPlayers}`, x + w - 6, y + 3, s.players >= s.maxPlayers ? 0xff5555 : 0xa0a0a0);
    }, (_i, dbl) => { this.joinBtn.active = true; if (dbl) this.join(); }));
    this.joinBtn = this.add(new Button(cx - 154, this.height - 52, 100, 20, 'Join Server', () => this.join()));
    this.joinBtn.active = false;
    this.add(new Button(cx - 50, this.height - 52, 100, 20, 'Direct Connection', () => this.gui.open(new DirectConnectScreen(this))));
    this.add(new Button(cx + 54, this.height - 52, 100, 20, 'Refresh', () => this.refresh()));
    this.add(new Button(cx - 154, this.height - 28, 150, 20, 'Add Server Address…', () => this.gui.open(new RelayAddressScreen(this))));
    this.add(new Button(cx + 4, this.height - 28, 150, 20, 'Cancel', () => this.gui.open(this.parent)));
    this.refresh();
  }
  /** Relays we query: the backend that served this page plus every address the player added. */
  private relays(): string[] {
    const g = this.gui.game;
    const out = [defaultRelayUrl()];
    for (const r of g.options.serverAddresses ?? []) { const u = normalizeRelayUrl(r); if (!out.includes(u)) out.push(u); }
    return out;
  }
  async refresh(): Promise<void> {
    this.servers = []; this.list.selected = -1; this.joinBtn.active = false;
    this.status = 'Looking for servers…';
    const relays = this.relays();
    let errors = 0;
    await Promise.all(relays.map(async (r) => { try { const list = await listServers(r); for (const s of list) this.servers.push({ ...s, relay: r }); } catch { errors++; } }));
    this.servers.sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || b.players - a.players);
    if (this.servers.length) this.status = '';
    else this.status = 'No servers found.';
  }
  private join(pw = ''): void {
    const s = this.servers[this.list.selected];
    if (!s) return;
    const g = this.gui.game;
    g.saveOptions();
    if (s.private && !pw) { this.gui.open(new PasswordScreen(this, s.name, (p) => this.join(p))); return; }
    g.joinServer(s.relay, s.id, pw).catch((e) => {
      if (e instanceof PasswordRequired) this.gui.open(new PasswordScreen(this, s.name, (p) => this.join(p), 'Incorrect password'));
      else this.gui.open(new DisconnectedScreen(String(e?.message ?? e)));
    });
  }
  wheel(dy: number, x: number, y: number): void { if (this.list.contains(x, y)) this.list.wheel(dy); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Play Multiplayer', this.width / 2, 4, 0xffffff);
    super.render(ctx, mx, my, partial);
    f.draw(ctx, 'Name:', this.width / 2 - 150, 6, 0xa0a0a0);
    if (this.status) f.drawCentered(ctx, this.status, this.width / 2, this.height / 2, 0x808080);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

/** Password prompt for private servers. */
export class PasswordScreen extends Screen {
  pausesGame = false; hidesHud = true;
  field!: TextField;
  constructor(private parent: Screen, private serverName: string, private onDone: (pw: string) => void, private error = '') { super(); }
  build(): void {
    const cx = this.width / 2;
    this.field = this.add(new TextField(cx - 100, this.height / 2 - 10, 200, 20, ''));
    this.field.maxLength = 64; this.field.placeholder = 'Password';
    this.field.password = true;
    this.field.onEnter = () => this.onDone(this.field.text);
    this.focused = this.field;
    this.add(new Button(cx - 100, this.height / 2 + 20, 200, 20, 'Join Server', () => this.onDone(this.field.text)));
    this.add(new Button(cx - 100, this.height / 2 + 44, 200, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, `"${this.serverName}" is private`, this.width / 2, this.height / 2 - 50, 0xffffff);
    f.drawCentered(ctx, this.error ? '§c' + this.error : 'Enter the password to join', this.width / 2, this.height / 2 - 30, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

/** Join by address: "1.2.3.4", "host:8080", "wss://…/ws", optionally "#serverId". */
export class DirectConnectScreen extends Screen {
  pausesGame = false; hidesHud = true;
  field!: TextField;
  status = '';
  private kind: 'java' | 'voxeland' = 'java';
  private auth: 'offline' | 'microsoft' = 'offline';
  private authButton!: CycleButton<'offline' | 'microsoft'>;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const cx = this.width / 2, top = this.panelTop();
    this.add(new CycleButton(cx - 130, top + 54, 260, 20, 'Server Type: ', [{ value: 'java' as const, label: 'Minecraft Java' }, { value: 'voxeland' as const, label: 'VoxeLand World' }], this.kind, (value) => {
      this.kind = value; this.authButton.visible = value === 'java';
      this.field.text = value === 'java' ? this.gui.game.options.lastJavaServerAddress : this.gui.game.options.lastServerAddress;
      this.field.cursor = this.field.text.length;
      this.field.placeholder = value === 'java' ? 'play.example.com:25565' : 'voxeland.example.com#world-id';
      this.status = '';
    }));
    this.authButton = this.add(new CycleButton(cx - 130, top + 78, 260, 20, 'Authentication: ', [{ value: 'offline' as const, label: 'Offline / local' }, { value: 'microsoft' as const, label: 'Microsoft account' }], this.auth, (value) => { this.auth = value; this.status = ''; }));
    this.field = this.add(new TextField(cx - 130, top + 116, 260, 20, this.gui.game.options.lastJavaServerAddress || ''));
    this.field.maxLength = 255; this.field.placeholder = 'play.example.com:25565';
    this.field.onEnter = () => this.connect();
    this.focused = this.field;
    this.add(new Button(cx - 130, top + 146, 127, 20, 'Join Server', () => this.connect()));
    this.add(new Button(cx + 3, top + 146, 127, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  private panelTop(): number { return Math.max(8, Math.floor((this.height - 210) / 2)); }
  /** Wrap the panel footer by rendered pixel width, including long unbroken server names/addresses. */
  private footerLines(text: string, maxWidth: number): string[] {
    const f = this.gui.font, lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (f.width(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      if (f.width(word) <= maxWidth) { line = word; continue; }
      let part = '';
      for (const ch of word) {
        if (part && f.width(part + ch) > maxWidth) { lines.push(part); part = ch; }
        else part += ch;
      }
      line = part;
    }
    if (line) lines.push(line);
    return lines;
  }
  private connect(pw = ''): void {
    const t = this.field.text.trim();
    if (!t) return;
    const g = this.gui.game;
    if (this.kind === 'java') {
      g.options.lastJavaServerAddress = t; g.saveOptions(); this.status = 'Connecting to Minecraft server…';
      g.joinJavaServer(defaultRelayUrl(), t, this.auth).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e))));
      return;
    }
    const hash = t.indexOf('#');
    const url = normalizeRelayUrl(hash >= 0 ? t.slice(0, hash) : t);
    const id = hash >= 0 ? t.slice(hash + 1) : '';
    g.options.lastServerAddress = t;
    if (!(g.options.serverAddresses ?? []).includes(t)) g.options.serverAddresses = [...(g.options.serverAddresses ?? []), t];
    g.saveOptions();
    this.status = 'Connecting…';
    const fail = (e: any) => { if (e instanceof PasswordRequired) this.gui.open(new PasswordScreen(this, t, (p) => this.connect(p), 'Incorrect password')); else this.gui.open(new DisconnectedScreen(String(e?.message ?? e))); };
    if (id) { g.joinServer(url, id, pw).catch(fail); return; }
    // no id: show what that address is hosting (the public world is always in the list)
    listServers(url).then((list) => {
      if (!list.length) { this.status = '§cThat server has no worlds open.'; return; }
      const s = list.find((x) => x.official) ?? list[0];
      if (s.private && !pw) { this.gui.open(new PasswordScreen(this, s.name, (p) => this.connect(p))); return; }
      g.joinServer(url, s.id, pw).catch(fail);
    }).catch(fail);
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font, cx = this.width / 2, top = this.panelTop();
    ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(cx - 150, top, 300, 194);
    f.drawCentered(ctx, 'Direct Connection', cx, top + 13, 0xffffff);
    f.drawCentered(ctx, this.kind === 'java' ? 'Join a Minecraft: Java Edition server' : 'Join a world hosted through a VoxeLand relay', cx, top + 29, 0xa0a0a0);
    f.draw(ctx, this.kind === 'java' ? 'Server address' : 'Relay address', cx - 130, top + 105, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
    const hint = this.kind === 'java'
      ? this.auth === 'microsoft' ? 'A Microsoft device-login code will appear after connecting.' : 'Offline mode is for local or authentication-disabled servers.'
      : 'Use relay.example.com#serverId, or omit the ID to join its first world.';
    const rawFooter = this.status || hint;
    const footerColor = rawFooter.startsWith('§c') ? 0xff5555 : this.status ? 0xffffff : 0x808080;
    const footer = rawFooter.startsWith('§c') ? rawFooter.slice(2) : rawFooter;
    const lines = this.footerLines(footer, 268).slice(0, 2);
    lines.forEach((line, i) => f.drawCentered(ctx, line, cx, top + 174 + i * 10, footerColor));
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

/** Manage the extra server addresses whose worlds appear in the list. */
export class RelayAddressScreen extends Screen {
  pausesGame = false; hidesHud = true;
  field!: TextField;
  list!: ListWidget;
  constructor(private parent: MultiplayerScreen) { super(); }
  private get addresses(): string[] { return this.gui.game.options.serverAddresses ?? []; }
  build(): void {
    const cx = this.width / 2;
    this.field = this.add(new TextField(cx - 150, 34, 220, 20, ''));
    this.field.maxLength = 128; this.field.placeholder = 'voxeland.up.railway.app';
    this.field.onEnter = () => this.addAddress();
    this.focused = this.field;
    this.add(new Button(cx + 78, 34, 72, 20, 'Add', () => this.addAddress()));
    this.list = this.add(new ListWidget(cx - 150, 62, 300, this.height - 110, 14, () => this.addresses.length, (ctx, i, x, y, w, sel, hov) => {
      if (sel || hov) { ctx.fillStyle = sel ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)'; ctx.fillRect(x - 2, y, w + 4, 14); }
      this.gui.font.draw(ctx, this.addresses[i], x + 2, y + 3, 0xffffff);
    }, () => {}));
    this.add(new Button(cx - 150, this.height - 44, 145, 20, 'Remove Selected', () => { const i = this.list.selected; if (i >= 0) { const a = [...this.addresses]; a.splice(i, 1); this.gui.game.options.serverAddresses = a; this.list.selected = -1; } }));
    this.add(new Button(cx + 5, this.height - 44, 145, 20, 'Done', () => { this.gui.game.saveOptions(); this.parent.refresh(); this.gui.open(this.parent); }));
  }
  private addAddress(): void {
    const t = this.field.text.trim();
    if (!t) return;
    const g = this.gui.game;
    if (!this.addresses.includes(t)) g.options.serverAddresses = [...this.addresses, t];
    this.field.text = ''; this.field.cursor = 0;
    g.saveOptions();
  }
  wheel(dy: number, x: number, y: number): void { if (this.list.contains(x, y)) this.list.wheel(dy); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Server Addresses', this.width / 2, 12, 0xffffff);
    f.drawCentered(ctx, 'Worlds hosted on these VoxeLand servers appear in your list', this.width / 2, 22, 0x808080);
    super.render(ctx, mx, my, partial);
    if (!this.addresses.length) f.drawCentered(ctx, 'Only this game\'s own server is used', this.width / 2, this.height / 2, 0x808080);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.game.saveOptions(); this.parent.refresh(); this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

/** Pause-menu "Open to LAN" (vanilla ShareToLanScreen): publish this world through a relay server, public or
 *  private (password). */
export class ShareWorldScreen extends Screen {
  hidesHud = true;
  gameMode = 'survival'; cheats = false; isPublic = true;
  status = '';
  private password!: TextField;
  private address!: TextField;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    this.gameMode = g.worldMeta?.gameMode ?? 'survival'; this.cheats = g.cheats;
    this.add(new CycleButton(cx - 155, 90, 150, 20, (g.assets.lang['selectWorld.gameMode'] ?? 'Game Mode') + ': ', [{ value: 'survival', label: 'Survival' }, { value: 'creative', label: 'Creative' }, { value: 'adventure', label: 'Adventure' }, { value: 'spectator', label: 'Spectator' }], this.gameMode, (v) => { this.gameMode = v; }));
    this.add(new CycleButton(cx + 5, 90, 150, 20, (g.assets.lang['selectWorld.allowCommands'] ?? 'Allow Cheats') + ': ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], this.cheats, (v) => { this.cheats = v; }));
    this.add(new CycleButton(cx - 155, 114, 150, 20, 'Visibility: ', [{ value: true, label: 'Public' }, { value: false, label: 'Private' }], this.isPublic, (v) => { this.isPublic = v; this.password.visible = !v; if (v) this.focused = null; }));
    this.password = this.add(new TextField(cx + 5, 114, 150, 20, ''));
    this.password.maxLength = 64; this.password.placeholder = 'Password'; this.password.password = true;
    this.password.visible = !this.isPublic;   // only private worlds take a password
    this.address = this.add(new TextField(cx - 155, 150, 310, 20, g.options.lastServerAddress || defaultRelayUrl()));
    this.address.maxLength = 128; this.address.placeholder = 'server address';
    this.add(new Button(cx - 155, this.height - 28, 150, 20, g.assets.lang['lanServer.start'] ?? 'Start LAN World', async () => {
      if (!this.isPublic && !this.password.text.trim()) { this.status = '§cSet a password, or switch to Public.'; return; }
      this.status = 'Connecting to the server…';
      try {
        const url = normalizeRelayUrl(this.address.text);
        g.options.lastServerAddress = this.address.text.trim(); g.saveOptions();
        const h = await g.openToLan({ name: g.worldMeta?.name ?? 'VoxeLand world', motd: '', gameMode: this.gameMode, cheats: this.cheats, maxPlayers: 8, relayUrl: url, password: this.isPublic ? '' : this.password.text.trim() });
        const addr = url.replace(/^wss?:\/\//, '').replace(/\/ws$/, '');
        g.gui.addChat((g.assets.lang['commands.publish.started'] ?? 'Local game hosted on port %s').replace('%s', addr));
        if (!h.isPublic) g.gui.addChat(`§7Private world — password: ${this.password.text.trim()}`);
        this.gui.close();
      } catch (e: any) { this.status = '§c' + (e?.message ?? String(e)); }
    }));
    this.add(new Button(cx + 5, this.height - 28, 150, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    const lang = this.gui.game.assets.lang;
    f.drawCentered(ctx, lang['lanServer.title'] ?? 'LAN World', this.width / 2, 40, 0xffffff);
    f.drawCentered(ctx, lang['lanServer.otherPlayers'] ?? 'Settings for Other Players', this.width / 2, 72, 0xa0a0a0);
    f.draw(ctx, 'Server address (leave as-is to use this game\'s server):', this.width / 2 - 155, 140, 0x808080);
    f.drawCentered(ctx, this.isPublic ? 'Public: listed for everyone using that server.' : 'Private: listed, but only players with the password can join.', this.width / 2, 180, 0x808080);
    if (this.status) f.drawCentered(ctx, this.status, this.width / 2, 196, 0xffffff);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

export class DisconnectedScreen extends Screen {
  pausesGame = false; hidesHud = true;
  constructor(public reason: string) { super(); }
  build(): void { this.add(new Button(this.width / 2 - 100, this.height / 2 + 20, 200, 20, 'Back to Server List', () => this.gui.open(new MultiplayerScreen(new TitleScreen())))); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, this.gui.game.assets.lang['disconnect.lost'] ?? 'Connection Lost', this.width / 2, this.height / 2 - 40, 0xffffff);
    this.gui.font.drawCentered(ctx, this.reason, this.width / 2, this.height / 2 - 20, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
}
