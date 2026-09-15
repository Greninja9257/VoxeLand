// Vanilla-style option definitions: one declarative spec drives defaults, persistence and the settings screens.

export type OptionKind = 'slider' | 'cycle' | 'bool';
export interface OptionSpec {
  key: string;
  label: string;
  kind: OptionKind;
  /** slider: numeric range and step */
  min?: number; max?: number; step?: number;
  /** cycle: value/label pairs */
  values?: { value: any; label: string }[];
  /** custom slider label */
  format?: (v: number) => string;
  tooltip?: string;
  /** setting a value needs the game to react (chunk reload, volume change, ...) */
  apply?: boolean;
}

export interface Options {
  // video
  fov: number; renderDistance: number; simulationDistance: number; gamma: number; guiScale: number; fullscreen: boolean;
  graphics: 'fast' | 'fancy' | 'fabulous'; clouds: 'off' | 'fast' | 'fancy'; smoothLighting: boolean; particles: 0 | 1 | 2; mipmapLevels: number;
  entityDistance: number; entityShadows: boolean; fovEffects: number; screenEffects: number; viewBobbing: boolean; biomeBlend: number;
  maxFps: number; vsync: boolean; attackIndicator: 'off' | 'crosshair' | 'hotbar'; autosaveIndicator: boolean; glintSpeed: number; glintStrength: number;
  damageTilt: number; darknessPulsing: boolean; menuBlur: number; showChunkBorders?: boolean;
  // sound
  volumes: Record<string, number>; subtitles: boolean; directionalAudio: boolean; musicToast: boolean;
  // controls
  sensitivity: number; invertMouse: boolean; wheelSensitivity: number; discreteScroll: boolean; rawInput: boolean; autoJump: boolean; toggleSneak: boolean; toggleSprint: boolean; operatorItemsTab: boolean;
  // chat
  chatVisibility: 'full' | 'system' | 'hidden'; chatColors: boolean; webLinks: boolean; chatOpacity: number; textBackgroundOpacity: number; chatScale: number; chatLineSpacing: number; chatWidth: number; chatFocusedHeight: number; chatUnfocusedHeight: number; chatDelay: number; commandSuggestions: boolean; narrator: 'off' | 'all' | 'chat' | 'system';
  // skin
  modelParts: Record<string, boolean>; mainHand: 'left' | 'right'; skin: 'steve' | 'alex';
  // accessibility
  highContrast: boolean; hideLightningFlashes: boolean; hideSplashTexts: boolean; textBackground: boolean; panoramaSpeed: number; reducedDebugInfo: boolean;
  language: string;
  /** multiplayer identity/display name, saved server addresses and the last one used */
  playerId: string; playerName: string; relayUrl: string; serverAddresses: string[]; lastServerAddress: string; lastJavaServerAddress: string;
  bindings?: Record<string, string>;
}

export const DEFAULT_OPTIONS: Options = {
  fov: 70, renderDistance: 10, simulationDistance: 8, gamma: 0.5, guiScale: 0, fullscreen: false,
  graphics: 'fancy', clouds: 'fancy', smoothLighting: true, particles: 0, mipmapLevels: 4,
  entityDistance: 1, entityShadows: true, fovEffects: 1, screenEffects: 1, viewBobbing: true, biomeBlend: 2,
  maxFps: 120, vsync: true, attackIndicator: 'crosshair', autosaveIndicator: true, glintSpeed: 0.5, glintStrength: 0.75,
  damageTilt: 1, darknessPulsing: true, menuBlur: 5,
  volumes: { master: 0.7, music: 0.5, record: 1, weather: 1, block: 1, hostile: 1, neutral: 1, player: 1, ambient: 1, voice: 1 }, subtitles: false, directionalAudio: false, musicToast: true,
  sensitivity: 0.5, invertMouse: false, wheelSensitivity: 1, discreteScroll: false, rawInput: true, autoJump: false, toggleSneak: false, toggleSprint: false, operatorItemsTab: false,
  chatVisibility: 'full', chatColors: true, webLinks: true, chatOpacity: 1, textBackgroundOpacity: 0.5, chatScale: 1, chatLineSpacing: 0, chatWidth: 1, chatFocusedHeight: 1, chatUnfocusedHeight: 0.44, chatDelay: 0, commandSuggestions: true, narrator: 'off',
  modelParts: { cape: true, jacket: true, left_sleeve: true, right_sleeve: true, left_pants_leg: true, right_pants_leg: true, hat: true }, mainHand: 'right', skin: 'steve',
  highContrast: false, hideLightningFlashes: false, hideSplashTexts: false, textBackground: true, panoramaSpeed: 1, reducedDebugInfo: false,
  language: 'en_us',
  playerId: '', playerName: 'Player' + Math.floor(Math.random() * 1000), relayUrl: '', serverAddresses: [], lastServerAddress: '', lastJavaServerAddress: '',
};

const onOff = [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }];
const offOn = [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }];
const pct = (v: number) => `${Math.round(v * 100)}%`;

export const VIDEO_OPTIONS: OptionSpec[] = [
  { key: 'graphics', label: 'Graphics', kind: 'cycle', values: [{ value: 'fast', label: 'Fast' }, { value: 'fancy', label: 'Fancy' }, { value: 'fabulous', label: 'Fabulous!' }], apply: true, tooltip: 'Fast: leaves are opaque and translucency is simplified.\nFancy: full leaf transparency and translucent water.' },
  { key: 'renderDistance', label: 'Render Distance', kind: 'slider', min: 2, max: 32, step: 1, format: (v) => `${v} chunks`, apply: true },
  { key: 'simulationDistance', label: 'Simulation Distance', kind: 'slider', min: 5, max: 32, step: 1, format: (v) => `${v} chunks`, apply: true, tooltip: 'Chunks within this distance tick (crops grow, mobs act, redstone runs).' },
  { key: 'smoothLighting', label: 'Smooth Lighting', kind: 'cycle', values: onOff, apply: true },
  { key: 'maxFps', label: 'Max Framerate', kind: 'slider', min: 10, max: 260, step: 10, format: (v) => (v >= 260 || v <= 0 ? 'Unlimited' : `${v} fps`) },
  { key: 'vsync', label: 'VSync', kind: 'cycle', values: onOff },
  { key: 'viewBobbing', label: 'View Bobbing', kind: 'cycle', values: onOff },
  { key: 'guiScale', label: 'GUI Scale', kind: 'cycle', values: [{ value: 0, label: 'Auto' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], apply: true },
  { key: 'attackIndicator', label: 'Attack Indicator', kind: 'cycle', values: [{ value: 'crosshair', label: 'Crosshair' }, { value: 'hotbar', label: 'Hotbar' }, { value: 'off', label: 'OFF' }] },
  { key: 'gamma', label: 'Brightness', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'Moody' : v >= 1 ? 'Bright' : pct(v)) },
  { key: 'clouds', label: 'Clouds', kind: 'cycle', values: [{ value: 'fancy', label: 'Fancy' }, { value: 'fast', label: 'Fast' }, { value: 'off', label: 'OFF' }], apply: true },
  { key: 'fullscreen', label: 'Fullscreen', kind: 'cycle', values: offOn, apply: true },
  { key: 'particles', label: 'Particles', kind: 'cycle', values: [{ value: 0, label: 'All' }, { value: 1, label: 'Decreased' }, { value: 2, label: 'Minimal' }] },
  { key: 'mipmapLevels', label: 'Mipmap Levels', kind: 'slider', min: 0, max: 4, step: 1, format: (v) => (v === 0 ? 'OFF' : String(v)), apply: true, tooltip: 'Smooths distant textures (no effect on lighting).' },
  { key: 'entityShadows', label: 'Entity Shadows', kind: 'cycle', values: onOff },
  { key: 'entityDistance', label: 'Entity Distance', kind: 'slider', min: 0.5, max: 5, step: 0.25, format: pct },
  { key: 'biomeBlend', label: 'Biome Blend', kind: 'slider', min: 0, max: 7, step: 1, format: (v) => (v === 0 ? 'OFF' : `${v * 2 + 1}x${v * 2 + 1}`), apply: true },
  { key: 'fovEffects', label: 'FOV Effects', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'screenEffects', label: 'Distortion Effects', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'glintSpeed', label: 'Glint Speed', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'glintStrength', label: 'Glint Strength', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'autosaveIndicator', label: 'Autosave Indicator', kind: 'cycle', values: onOff },
  { key: 'menuBlur', label: 'Menu Background Blur', kind: 'slider', min: 0, max: 10, step: 1, format: (v) => (v === 0 ? 'OFF' : String(v)) },
];

export const SOUND_OPTIONS: OptionSpec[] = [
  { key: 'volumes.master', label: 'Master Volume', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.music', label: 'Music', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.record', label: 'Jukebox/Note Blocks', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.weather', label: 'Weather', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.block', label: 'Blocks', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.hostile', label: 'Hostile Creatures', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.neutral', label: 'Friendly Creatures', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.player', label: 'Players', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.ambient', label: 'Ambient/Environment', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'volumes.voice', label: 'Voice/Speech', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? 'OFF' : pct(v)), apply: true },
  { key: 'subtitles', label: 'Show Subtitles', kind: 'cycle', values: offOn, apply: true },
  { key: 'directionalAudio', label: 'Directional Audio', kind: 'cycle', values: offOn, tooltip: 'Uses HRTF-based panning for better spatial audio.', apply: true },
  { key: 'musicToast', label: 'Music Toast', kind: 'cycle', values: onOff },
];

export const MOUSE_OPTIONS: OptionSpec[] = [
  { key: 'sensitivity', label: 'Sensitivity', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => (v <= 0 ? '*yawn*' : v >= 1 ? 'HYPERSPEED!!!' : `${Math.round(v * 200)}%`) },
  { key: 'invertMouse', label: 'Invert Mouse', kind: 'cycle', values: offOn },
  { key: 'wheelSensitivity', label: 'Scroll Sensitivity', kind: 'slider', min: 0.01, max: 10, step: 0.01, format: (v) => v.toFixed(2) },
  { key: 'discreteScroll', label: 'Discrete Scrolling', kind: 'cycle', values: offOn },
  { key: 'rawInput', label: 'Raw Input', kind: 'cycle', values: onOff, apply: true },
];

export const CONTROL_OPTIONS: OptionSpec[] = [
  { key: 'toggleSneak', label: 'Sneak', kind: 'cycle', values: [{ value: false, label: 'Hold' }, { value: true, label: 'Toggle' }] },
  { key: 'toggleSprint', label: 'Sprint', kind: 'cycle', values: [{ value: false, label: 'Hold' }, { value: true, label: 'Toggle' }] },
  { key: 'autoJump', label: 'Auto-Jump', kind: 'cycle', values: offOn },
  { key: 'operatorItemsTab', label: 'Operator Items Tab', kind: 'cycle', values: offOn },
];

export const CHAT_OPTIONS: OptionSpec[] = [
  { key: 'chatVisibility', label: 'Chat', kind: 'cycle', values: [{ value: 'full', label: 'Shown' }, { value: 'system', label: 'Commands Only' }, { value: 'hidden', label: 'Hidden' }] },
  { key: 'chatColors', label: 'Colors', kind: 'cycle', values: onOff },
  { key: 'webLinks', label: 'Web Links', kind: 'cycle', values: onOff },
  { key: 'chatOpacity', label: 'Chat Text Opacity', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => pct(v * 0.9 + 0.1) },
  { key: 'textBackgroundOpacity', label: 'Text Background Opacity', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'chatScale', label: 'Chat Text Size', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'chatLineSpacing', label: 'Line Spacing', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'chatDelay', label: 'Chat Delay', kind: 'slider', min: 0, max: 6, step: 0.1, format: (v) => (v <= 0 ? 'No delay' : `${v.toFixed(1)} seconds`) },
  { key: 'chatWidth', label: 'Width', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => `${Math.round(40 + v * 280)}px` },
  { key: 'chatFocusedHeight', label: 'Focused Height', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => `${Math.round(20 + v * 160)}px` },
  { key: 'chatUnfocusedHeight', label: 'Unfocused Height', kind: 'slider', min: 0, max: 1, step: 0, format: (v) => `${Math.round(20 + v * 160)}px` },
  { key: 'commandSuggestions', label: 'Command Suggestions', kind: 'cycle', values: onOff },
  { key: 'narrator', label: 'Narrator', kind: 'cycle', values: [{ value: 'off', label: 'OFF' }, { value: 'all', label: 'Narrates All' }, { value: 'chat', label: 'Narrates Chat' }, { value: 'system', label: 'Narrates System' }] },
];

export const ACCESSIBILITY_OPTIONS: OptionSpec[] = [
  { key: 'narrator', label: 'Narrator', kind: 'cycle', values: [{ value: 'off', label: 'OFF' }, { value: 'all', label: 'Narrates All' }, { value: 'chat', label: 'Narrates Chat' }, { value: 'system', label: 'Narrates System' }] },
  { key: 'subtitles', label: 'Show Subtitles', kind: 'cycle', values: offOn, apply: true },
  { key: 'highContrast', label: 'High Contrast', kind: 'cycle', values: offOn },
  { key: 'textBackground', label: 'Text Background', kind: 'cycle', values: [{ value: true, label: 'Chat' }, { value: false, label: 'Everywhere' }] },
  { key: 'textBackgroundOpacity', label: 'Text Background Opacity', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'chatLineSpacing', label: 'Line Spacing', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'chatDelay', label: 'Chat Delay', kind: 'slider', min: 0, max: 6, step: 0.1, format: (v) => (v <= 0 ? 'No delay' : `${v.toFixed(1)} seconds`) },
  { key: 'autoJump', label: 'Auto-Jump', kind: 'cycle', values: offOn },
  { key: 'toggleSneak', label: 'Sneak', kind: 'cycle', values: [{ value: false, label: 'Hold' }, { value: true, label: 'Toggle' }] },
  { key: 'toggleSprint', label: 'Sprint', kind: 'cycle', values: [{ value: false, label: 'Hold' }, { value: true, label: 'Toggle' }] },
  { key: 'screenEffects', label: 'Distortion Effects', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'fovEffects', label: 'FOV Effects', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'darknessPulsing', label: 'Darkness Pulsing', kind: 'cycle', values: onOff },
  { key: 'damageTilt', label: 'Damage Tilt', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'glintSpeed', label: 'Glint Speed', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'glintStrength', label: 'Glint Strength', kind: 'slider', min: 0, max: 1, step: 0, format: pct },
  { key: 'hideLightningFlashes', label: 'Hide Lightning Flashes', kind: 'cycle', values: offOn },
  { key: 'hideSplashTexts', label: 'Hide Splash Texts', kind: 'cycle', values: offOn },
  { key: 'panoramaSpeed', label: 'Panorama Scroll Speed', kind: 'slider', min: 0, max: 2, step: 0, format: pct },
  { key: 'menuBlur', label: 'Menu Background Blur', kind: 'slider', min: 0, max: 10, step: 1, format: (v) => (v === 0 ? 'OFF' : String(v)) },
  { key: 'reducedDebugInfo', label: 'Reduced Debug Info', kind: 'cycle', values: offOn },
];

export const SKIN_PARTS: { key: string; label: string }[] = [
  { key: 'cape', label: 'Cape' }, { key: 'jacket', label: 'Jacket' }, { key: 'left_sleeve', label: 'Left Sleeve' }, { key: 'right_sleeve', label: 'Right Sleeve' },
  { key: 'left_pants_leg', label: 'Left Pants Leg' }, { key: 'right_pants_leg', label: 'Right Pants Leg' }, { key: 'hat', label: 'Hat' },
];

export function getOption(o: Options, key: string): any { const [a, b] = key.split('.'); return b ? (o as any)[a][b] : (o as any)[a]; }
export function setOption(o: Options, key: string, v: any): void { const [a, b] = key.split('.'); if (b) (o as any)[a][b] = v; else (o as any)[a] = v; }

/** Merge a saved options object over the defaults (unknown keys ignored, nested maps merged). */
export function mergeOptions(saved: any): Options {
  const out: any = JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  if (!saved || typeof saved !== 'object') return out;
  for (const [k, v] of Object.entries(saved)) {
    if (!(k in out) && k !== 'bindings') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) Object.assign(out[k], v);
    else out[k] = v;
  }
  // migrate old boolean-valued options
  if (typeof out.clouds === 'boolean') out.clouds = out.clouds ? 'fancy' : 'off';
  if (typeof out.attackIndicator === 'boolean') out.attackIndicator = out.attackIndicator ? 'crosshair' : 'off';
  return out;
}
