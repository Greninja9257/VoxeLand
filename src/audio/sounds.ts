// Sound manager: vanilla sounds.json events, positional audio, music, records, ambience.
import type { Assets } from '../assets';

export type SoundCategory = 'master' | 'music' | 'record' | 'weather' | 'block' | 'hostile' | 'neutral' | 'player' | 'ambient' | 'voice' | 'ui';

interface SoundEntry { name: string; volume: number; pitch: number; weight: number; stream: boolean; isEvent: boolean }

const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'phantom', 'drowned', 'husk', 'stray', 'bogged', 'wither_skeleton', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex', 'evoker', 'vindicator', 'pillager', 'ravager', 'warden', 'wither', 'ender_dragon', 'cave_spider', 'zombie_villager', 'illusioner', 'piglin_brute', 'breeze', 'creaking']);

export class SoundManager {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private gains = new Map<SoundCategory, GainNode>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  events: Record<string, SoundEntry[]> = {};
  volumes: Record<SoundCategory, number> = { master: 1, music: 1, record: 1, weather: 1, block: 1, hostile: 1, neutral: 1, player: 1, ambient: 1, voice: 1, ui: 1 };
  listener = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private music: HTMLAudioElement | null = null;
  private musicTimer = 0;
  private musicKind = '';
  private record: { el: HTMLAudioElement; x: number; y: number; z: number } | null = null;
  private underwaterLoop: AudioBufferSourceNode | null = null;
  private rainLoop: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private activeCount = 0;
  enabled = true;
  subtitles: { text: string; time: number; x: number; y: number; z: number }[] = [];
  private playing: { src: AudioBufferSourceNode; gain: GainNode; panner: PannerNode | null; x: number; y: number; z: number; attenuate: boolean }[] = [];
  /** Multiplayer hooks. Network playback uses the *Remote methods to avoid echoing events. */
  onSound: ((event: string, x: number, y: number, z: number, volume: number, pitch: number, attenuate: boolean) => void) | null = null;
  onMusic: ((name: string, kind: string, volume: number) => void) | null = null;
  onRecord: ((disc: string | null, x?: number, y?: number, z?: number) => void) | null = null;
  musicControlled = false;

  constructor(private assets: Assets) {
    for (const [event, def] of Object.entries(assets.data.sounds)) {
      this.events[event] = (def.sounds ?? []).map((s: any) => typeof s === 'string' ? { name: s, volume: 1, pitch: 1, weight: 1, stream: false, isEvent: false } : { name: s.name, volume: s.volume ?? 1, pitch: s.pitch ?? 1, weight: s.weight ?? 1, stream: !!s.stream, isEvent: s.type === 'event' });
    }
  }

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      for (const c of ['music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'] as SoundCategory[]) { const g = this.ctx.createGain(); g.connect(this.master); this.gains.set(c, g); }
      this.applyVolumes();
    } catch (e) { console.warn('audio unavailable', e); }
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    for (const [c, g] of this.gains) g.gain.value = this.volumes[c];
    if (this.music) this.music.volume = Math.min(1, this.volumes.master * this.volumes.music * (this.musicVolumeScale));
    if (this.record) this.record.el.volume = Math.min(1, this.volumes.master * this.volumes.record);
  }
  private musicVolumeScale = 1;
  private musicName = '';
  currentMusic(): { name: string; kind: string; volume: number } | null {
    if (!this.music || this.music.paused || this.music.ended) return null;
    return this.musicName ? { name: this.musicName, kind: this.musicKind, volume: this.musicVolumeScale } : null;
  }

  private category(event: string): SoundCategory {
    if (event.startsWith('music.') ) return 'music';
    if (event.startsWith('music_disc.')) return 'record';
    if (event.startsWith('block.')) return 'block';
    if (event.startsWith('weather.')) return 'weather';
    if (event.startsWith('ambient.')) return 'ambient';
    if (event.startsWith('ui.')) return 'ui';
    if (event.startsWith('entity.')) { const m = event.split('.')[1]; if (m === 'player') return 'player'; return HOSTILE.has(m) ? 'hostile' : 'neutral'; }
    if (event.startsWith('item.')) return 'player';
    return 'master';
  }

  private pick(event: string, depth = 0): SoundEntry | null {
    const list = this.events[event.replace(/^minecraft:/, '')];
    if (!list || !list.length || depth > 4) return null;
    let total = 0; for (const e of list) total += e.weight;
    let r = Math.random() * total;
    let chosen = list[list.length - 1];
    for (const e of list) { r -= e.weight; if (r < 0) { chosen = e; break; } }
    if (chosen.isEvent) { const sub = this.pick(chosen.name, depth + 1); if (!sub) return null; return { ...sub, volume: sub.volume * chosen.volume, pitch: sub.pitch * chosen.pitch }; }
    return chosen;
  }

  private buffer(name: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(name);
    if (p) return p;
    p = fetch(`./assets/sounds/${name.replace(/^minecraft:/, '')}.ogg`).then(async (r) => {
      if (!r.ok || !this.ctx) return null;
      const data = await r.arrayBuffer();
      try { return await this.ctx.decodeAudioData(data); } catch { return null; }
    }).catch(() => null);
    this.buffers.set(name, p);
    return p;
  }

  /** Non-positional sound (UI, player). */
  play(event: string, volume = 1, pitch = 1): void { this.playAt(event, this.listener.x, this.listener.y, this.listener.z, volume, pitch, false); }

  /** Positional sound. */
  playAt(event: string, x: number, y: number, z: number, volume = 1, pitch = 1, attenuate = true): void {
    // UI feedback belongs only to the player interacting with their local screen.
    // Never forward it to multiplayer, even if a caller accidentally uses playAt.
    if (this.category(event) !== 'ui') this.onSound?.(event, x, y, z, volume, pitch, attenuate);
    this.playAtRemote(event, x, y, z, volume, pitch, attenuate);
  }

  /** Play a sound received from the network without sending it back. */
  playAtRemote(event: string, x: number, y: number, z: number, volume = 1, pitch = 1, attenuate = true): void {
    if (!this.ctx || !this.enabled) return;
    const entry = this.pick(event);
    if (!entry) return;
    if (entry.stream) { return; }
    const vol = volume * entry.volume, pit = pitch * entry.pitch;
    const dx = x - this.listener.x, dy = y - this.listener.y, dz = z - this.listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const range = 16 * Math.max(1, vol);
    if (attenuate && dist > range) return;
    if (this.activeCount > 64) return;
    const cat = this.category(event);
    const sub = this.assets.data.sounds[event.replace(/^minecraft:/, '')]?.subtitle;
    if (sub) this.addSubtitle(sub, x, y, z);
    this.buffer(entry.name).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.max(0.5, Math.min(2, pit));
      const gain = this.ctx.createGain();
      gain.gain.value = Math.min(1, vol);
      let panner: PannerNode | null = null;
      if (attenuate && dist > 0.5) {
        panner = this.ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'linear';
        panner.refDistance = 1; panner.maxDistance = range; panner.rolloffFactor = 1;
        panner.positionX.value = dx; panner.positionY.value = dy; panner.positionZ.value = dz;
        src.connect(gain); gain.connect(panner); panner.connect(this.gains.get(cat) ?? this.master);
      } else { src.connect(gain); gain.connect(this.gains.get(cat) ?? this.master); }
      const rec = { src, gain, panner, x, y, z, attenuate };
      this.playing.push(rec);
      this.activeCount++;
      src.onended = () => { this.activeCount--; const i = this.playing.indexOf(rec); if (i >= 0) this.playing.splice(i, 1); };
      src.start();
    });
  }

  private addSubtitle(key: string, x: number, y: number, z: number): void {
    const text = this.assets.lang[key] ?? key;
    const ex = this.subtitles.find((s) => s.text === text);
    if (ex) { ex.time = 60; ex.x = x; ex.y = y; ex.z = z; } else this.subtitles.push({ text, time: 60, x, y, z });
    if (this.subtitles.length > 6) this.subtitles.shift();
  }

  /** Update listener position; positional sources are relative so we move them. */
  updateListener(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.listener = { x, y, z, yaw, pitch };
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fy = yaw * Math.PI / 180;
    const fx = -Math.sin(fy), fz = Math.cos(fy);
    if (l.forwardX) { l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = fz; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0; }
    else (l as any).setOrientation?.(fx, 0, fz, 0, 1, 0);
    for (const p of this.playing) if (p.panner) { p.panner.positionX.value = p.x - x; p.panner.positionY.value = p.y - y; p.panner.positionZ.value = p.z - z; }
    for (const s of this.subtitles) s.time--;
    this.subtitles = this.subtitles.filter((s) => s.time > 0);
  }

  // ---------- music ----------
  /** kind: 'menu' | 'game' | 'creative' | 'nether.<biome>' | 'end' | 'under_water' */
  tickMusic(kind: string, dtTicks: number): void {
    if (this.musicControlled) return;
    if (!this.assets.manifest?.music && !this.events['music.' + kind]) return;
    if (this.record) return;
    if (this.music && !this.music.paused && !this.music.ended) { if (this.musicKind !== kind && (kind === 'menu' || this.musicKind === 'menu')) { this.stopMusic(); } else return; }
    if (this.music && this.music.ended) { this.music = null; this.musicTimer = kind === 'menu' ? 20 : 6000 + Math.random() * 18000; }
    this.musicTimer -= dtTicks;
    if (this.musicTimer > 0) return;
    const entry = this.pick('music.' + kind);
    if (!entry) { this.musicTimer = 1200; return; }
    this.musicKind = kind;
    this.onMusic?.(entry.name, kind, entry.volume);
    this.playMusicRemote(entry.name, kind, entry.volume);
  }

  /** Start the exact soundtrack selected by the multiplayer host. */
  playMusicRemote(name: string, kind: string, volume = 1): void {
    if (this.music) this.music.pause();
    const el = new Audio(`./assets/sounds/${name}.ogg`);
    this.musicName = name;
    this.musicKind = kind;
    this.musicVolumeScale = volume;
    el.volume = Math.min(1, this.volumes.master * this.volumes.music * volume);
    el.play().catch(() => { this.musicTimer = 200; });
    this.music = el;
    this.musicTimer = 1e9;
  }
  stopMusic(): void { if (this.music) { this.music.pause(); this.music = null; } this.musicTimer = 100; }
  fadeMusicForRecord(): void { this.stopMusic(); }

  playRecord(disc: string, x: number, y: number, z: number): void {
    this.onRecord?.(disc, x, y, z);
    this.playRecordRemote(disc, x, y, z);
  }
  playRecordRemote(disc: string, x: number, y: number, z: number): void {
    this.stopRecordRemote();
    const entry = this.pick('music_disc.' + disc.replace('music_disc_', ''));
    if (!entry) return;
    this.stopMusic();
    const el = new Audio(`./assets/sounds/${entry.name}.ogg`);
    el.volume = Math.min(1, this.volumes.master * this.volumes.record);
    el.play().catch(() => {});
    this.record = { el, x, y, z };
  }
  stopRecord(x?: number, y?: number, z?: number): void { this.onRecord?.(null, x, y, z); this.stopRecordRemote(x, y, z); }
  stopRecordRemote(x?: number, y?: number, z?: number): void { void x; void y; void z; if (this.record) { this.record.el.pause(); this.record = null; } }
  updateRecord(): void {
    if (!this.record) return;
    const r = this.record;
    const d = Math.hypot(r.x - this.listener.x, r.y - this.listener.y, r.z - this.listener.z);
    r.el.volume = Math.max(0, Math.min(1, (1 - d / 64) * this.volumes.master * this.volumes.record));
    if (r.el.ended) this.record = null;
  }

  // ---------- loops ----------
  setUnderwater(on: boolean): void {
    if (!this.ctx) return;
    if (on && !this.underwaterLoop) {
      const entry = this.pick('ambient.underwater.loop');
      if (!entry) return;
      this.buffer(entry.name).then((buf) => {
        if (!buf || !this.ctx || this.underwaterLoop) return;
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain(); g.gain.value = 0.6; src.connect(g); g.connect(this.gains.get('ambient') ?? this.master); src.start();
        this.underwaterLoop = src;
      });
    } else if (!on && this.underwaterLoop) { try { this.underwaterLoop.stop(); } catch { /* */ } this.underwaterLoop = null; }
  }
  setRain(strength: number): void {
    if (!this.ctx) return;
    if (strength > 0 && !this.rainLoop) {
      const entry = this.pick('weather.rain');
      if (!entry) return;
      this.buffer(entry.name).then((buf) => {
        if (!buf || !this.ctx || this.rainLoop) return;
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain(); g.gain.value = strength; src.connect(g); g.connect(this.gains.get('weather') ?? this.master); src.start();
        this.rainLoop = { src, gain: g };
      });
    } else if (this.rainLoop) { if (strength <= 0) { try { this.rainLoop.src.stop(); } catch { /* */ } this.rainLoop = null; } else this.rainLoop.gain.gain.value = strength; }
  }
}
