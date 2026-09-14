// Multiplayer screens: server list (LAN + public relay), direct connect, "Open to LAN" and disconnect notice.
import { Screen, Button, ListWidget, TextField, CycleButton } from './widgets';
import { TitleScreen } from './screens';
import { listServers } from '../../net/client';
import { defaultRelayUrl, type ServerInfo } from '../../net/protocol';

export class MultiplayerScreen extends Screen {
  pausesGame = false; hidesHud = true;
  servers: (ServerInfo & { relay: string })[] = [];
  list!: ListWidget;
  joinBtn!: Button;
  status = 'Scanning for games on your local network…';
  private nameField!: TextField;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    this.nameField = new TextField(cx - 150, 14, 120, 14, g.options.playerName);
    this.nameField.maxLength = 16; this.nameField.placeholder = 'Player name';
    this.nameField.onChange = (t) => { g.options.playerName = t.replace(/[^\w]/g, '').slice(0, 16); };
    this.add(this.nameField);
    this.list = this.add(new ListWidget(cx - 150, 32, 300, this.height - 100, 36, () => this.servers.length, (ctx, i, x, y, w, sel, hov) => {
      const s = this.servers[i];
      if (sel) { ctx.fillStyle = '#808080'; ctx.fillRect(x - 2, y, w + 4, 36); ctx.fillStyle = '#000'; ctx.fillRect(x - 1, y + 1, w + 2, 34); }
      else if (hov) { ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x - 2, y, w + 4, 36); }
      this.gui.font.draw(ctx, s.name, x + 4, y + 3, 0xffffff);
      this.gui.font.draw(ctx, `${s.motd || (s.lan ? 'LAN world' : 'Public world')} — hosted by ${s.host}`, x + 4, y + 13, 0x808080);
      this.gui.font.draw(ctx, `${s.gameMode} · ${s.public ? 'Public' : 'LAN'} · ${s.relay.replace(/^wss?:\/\//, '')}`, x + 4, y + 23, 0x808080);
      this.gui.font.drawRight(ctx, `${s.players}/${s.maxPlayers}`, x + w - 6, y + 3, 0xa0a0a0);
    }, (_i, dbl) => { this.joinBtn.active = true; if (dbl) this.join(); }));
    this.joinBtn = this.add(new Button(cx - 154, this.height - 52, 100, 20, 'Join Server', () => this.join()));
    this.joinBtn.active = false;
    this.add(new Button(cx - 50, this.height - 52, 100, 20, 'Direct Connection', () => this.gui.open(new DirectConnectScreen(this))));
    this.add(new Button(cx + 54, this.height - 52, 100, 20, 'Refresh', () => this.refresh()));
    this.add(new Button(cx - 154, this.height - 28, 150, 20, 'Public Server Address…', () => this.gui.open(new RelayAddressScreen(this))));
    this.add(new Button(cx + 4, this.height - 28, 150, 20, 'Cancel', () => this.gui.open(this.parent)));
    this.refresh();
  }
  async refresh(): Promise<void> {
    const g = this.gui.game;
    this.servers = []; this.list.selected = -1; this.joinBtn.active = false;
    const relays = [defaultRelayUrl()];
    if (g.options.relayUrl && !relays.includes(g.options.relayUrl)) relays.push(g.options.relayUrl);
    this.status = 'Scanning…';
    await Promise.all(relays.map(async (r) => { try { const list = await listServers(r); for (const s of list) this.servers.push({ ...s, relay: r }); } catch { /* unavailable relays appear as an empty list */ } }));
    this.status = this.servers.length ? '' : 'No Games Found.';
  }
  private join(): void {
    const s = this.servers[this.list.selected];
    if (!s) return;
    const g = this.gui.game;
    g.saveOptions();
    g.joinServer(s.relay, s.id).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e))));
  }
  wheel(dy: number, x: number, y: number): void { if (this.list.contains(x, y)) this.list.wheel(dy); }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Play Multiplayer', this.width / 2, 4, 0xffffff);
    super.render(ctx, mx, my, partial);
    f.draw(ctx, 'Name:', this.width / 2 - 150, 4, 0xa0a0a0);
    if (this.status) f.drawCentered(ctx, this.status, this.width / 2, this.height / 2, 0x808080);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

export class DirectConnectScreen extends Screen {
  pausesGame = false; hidesHud = true;
  field!: TextField;
  constructor(private parent: Screen) { super(); }
  build(): void {
    const cx = this.width / 2;
    this.field = this.add(new TextField(cx - 100, this.height / 2 - 20, 200, 20, this.gui.game.options.relayUrl || ''));
    this.field.maxLength = 128; this.field.placeholder = 'ws://host:8080/ws#serverId';
    this.field.onEnter = () => this.connect();
    this.focused = this.field;
    this.add(new Button(cx - 100, this.height / 2 + 12, 200, 20, 'Join Server', () => this.connect()));
    this.add(new Button(cx - 100, this.height / 2 + 36, 200, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  private connect(): void {
    const t = this.field.text.trim();
    let url = t, id = '';
    const hash = t.indexOf('#');
    if (hash >= 0) { url = t.slice(0, hash); id = t.slice(hash + 1); }
    if (!/^wss?:\/\//.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
    if (!url.endsWith('/ws')) url = url.replace(/\/$/, '') + '/ws';
    const g = this.gui.game;
    g.options.relayUrl = url; g.saveOptions();
    if (!id) { // no id: list that relay and pick the first server
      listServers(url).then((list) => { if (!list.length) this.gui.open(new DisconnectedScreen('No games are hosted on that server.')); else g.joinServer(url, list[0].id).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e)))); }).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e))));
      return;
    }
    g.joinServer(url, id).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e))));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    this.gui.font.drawCentered(ctx, 'Direct Connection', this.width / 2, this.height / 2 - 60, 0xffffff);
    this.gui.font.drawCentered(ctx, 'Server Address (relay URL, optionally #serverId)', this.width / 2, this.height / 2 - 34, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

export class RelayAddressScreen extends Screen {
  pausesGame = false; hidesHud = true;
  field!: TextField;
  constructor(private parent: MultiplayerScreen) { super(); }
  build(): void {
    const cx = this.width / 2;
    this.field = this.add(new TextField(cx - 100, this.height / 2 - 20, 200, 20, this.gui.game.options.relayUrl || ''));
    this.field.maxLength = 128; this.field.placeholder = 'wss://your-app.up.railway.app/ws';
    this.focused = this.field;
    this.add(new Button(cx - 100, this.height / 2 + 12, 200, 20, 'Done', () => { let u = this.field.text.trim(); if (u && !/^wss?:\/\//.test(u)) u = 'wss://' + u; if (u && !u.endsWith('/ws')) u = u.replace(/\/$/, '') + '/ws'; this.gui.game.options.relayUrl = u; this.gui.game.saveOptions(); this.gui.open(this.parent); }));
    this.add(new Button(cx - 100, this.height / 2 + 36, 200, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Public Server Address', this.width / 2, this.height / 2 - 70, 0xffffff);
    f.drawCentered(ctx, 'A VoxeLand relay hosted on the internet (e.g. Railway) lists public worlds.', this.width / 2, this.height / 2 - 48, 0xa0a0a0);
    f.drawCentered(ctx, 'Leave empty to only use the local network relay.', this.width / 2, this.height / 2 - 36, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
  keyDown(code: string, key: string, mods: any): boolean { if (code === 'Escape') { this.gui.open(this.parent); return true; } return super.keyDown(code, key, mods); }
}

/** Pause-menu "Open to LAN" (vanilla ShareToLanScreen) with an extra public toggle. */
export class OpenToLanScreen extends Screen {
  hidesHud = true;
  gameMode = 'survival'; cheats = false; isPublic = false;
  status = '';
  constructor(private parent: Screen) { super(); }
  build(): void {
    const g = this.gui.game;
    const cx = this.width / 2;
    this.gameMode = g.worldMeta?.gameMode ?? 'survival'; this.cheats = g.cheats;
    this.add(new CycleButton(cx - 155, 100, 150, 20, 'Game Mode: ', [{ value: 'survival', label: 'Survival' }, { value: 'creative', label: 'Creative' }, { value: 'adventure', label: 'Adventure' }, { value: 'spectator', label: 'Spectator' }], this.gameMode, (v) => { this.gameMode = v; }));
    this.add(new CycleButton(cx + 5, 100, 150, 20, 'Allow Cheats: ', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], this.cheats, (v) => { this.cheats = v; }));
    this.add(new CycleButton(cx - 155, 124, 150, 20, 'Visibility: ', [{ value: false, label: 'LAN only' }, { value: true, label: 'Public' }], this.isPublic, (v) => { this.isPublic = v; }));
    const relay = this.add(new TextField(cx + 5, 124, 150, 20, g.options.relayUrl || defaultRelayUrl()));
    relay.maxLength = 128; relay.placeholder = 'relay ws:// address';
    this.add(new Button(cx - 155, this.height - 28, 150, 20, 'Start LAN World', async () => {
      this.status = 'Connecting to the relay…';
      try {
        let url = relay.text.trim(); if (!/^wss?:\/\//.test(url)) url = 'ws://' + url; if (!url.endsWith('/ws')) url = url.replace(/\/$/, '') + '/ws';
        const h = await g.openToLan({ name: g.worldMeta?.name ?? 'VoxeLand world', motd: '', gameMode: this.gameMode, cheats: this.cheats, isPublic: this.isPublic, maxPlayers: 8, relayUrl: url });
        g.gui.addChat(`§eLocal game hosted (${h.isPublic ? 'public' : 'LAN'}). Others can join from Multiplayer at ${url.replace('/ws', '')}`);
        if (this.isPublic && !h.isPublic) g.gui.addChat('§cThe relay is not a public host, so the world is only visible on the local network');
        this.gui.close();
      } catch (e: any) { this.status = '§c' + (e?.message ?? String(e)); }
    }));
    this.add(new Button(cx + 5, this.height - 28, 150, 20, 'Cancel', () => this.gui.open(this.parent)));
  }
  render(ctx: CanvasRenderingContext2D, mx: number, my: number, partial: number): void {
    const f = this.gui.font;
    f.drawCentered(ctx, 'Open to LAN', this.width / 2, 50, 0xffffff);
    f.drawCentered(ctx, 'Settings for other players', this.width / 2, 82, 0xa0a0a0);
    f.drawCentered(ctx, 'Other players on your network open this game\'s address in a browser and pick the world from Multiplayer.', this.width / 2, 160, 0x808080);
    f.drawCentered(ctx, 'Public: the relay must be an internet-hosted VoxeLand server (e.g. on Railway) to be listed for everyone.', this.width / 2, 172, 0x808080);
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
    this.gui.font.drawCentered(ctx, 'Connection Lost', this.width / 2, this.height / 2 - 40, 0xffffff);
    this.gui.font.drawCentered(ctx, this.reason, this.width / 2, this.height / 2 - 20, 0xa0a0a0);
    super.render(ctx, mx, my, partial);
  }
}
