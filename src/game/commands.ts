// Chat commands with vanilla syntax: target selectors (@s @p @a @e @r, names, [type=,distance=,limit=,sort=]),
// relative coordinates (~), the usual argument order and vanilla-style feedback.
import type { Game } from './game';
import { ItemStack } from '../items/stack';
import { MOB_DEFS, Mob } from '../entity/mobs';
import { BIOMES } from '../world/gen/biomes';
import { Entity, LivingEntity, ItemEntity } from '../entity/entity';
import { Player, type GameMode } from '../entity/player';
import type { Dimension } from '../world/world';

const EFFECTS = ['speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health', 'instant_damage', 'jump_boost', 'nausea', 'regeneration', 'resistance', 'fire_resistance', 'water_breathing', 'invisibility', 'blindness', 'night_vision', 'hunger', 'weakness', 'poison', 'wither', 'health_boost', 'absorption', 'saturation', 'glowing', 'levitation', 'luck', 'unluck', 'slow_falling', 'conduit_power', 'dolphins_grace', 'bad_omen', 'hero_of_the_village', 'darkness'];
const GAMEMODES: Record<string, GameMode> = { survival: 'survival', creative: 'creative', adventure: 'adventure', spectator: 'spectator', s: 'survival', c: 'creative', a: 'adventure', sp: 'spectator', '0': 'survival', '1': 'creative', '2': 'adventure', '3': 'spectator' };
const DIFF = ['peaceful', 'easy', 'normal', 'hard'];

/** Command signatures for /help and tab completion. */
export const COMMAND_USAGE: Record<string, string> = {
  help: '/help [command]',
  gamemode: '/gamemode <survival|creative|adventure|spectator> [targets]',
  defaultgamemode: '/defaultgamemode <mode>',
  time: '/time <set|add|query> <day|noon|night|midnight|ticks|daytime|gametime|day>',
  tp: '/tp <x> <y> <z> | /tp <targets> <x> <y> <z> | /tp <targets> <destination>',
  teleport: '/teleport (alias of /tp)',
  give: '/give <targets> <item> [count]',
  clear: '/clear [targets] [item] [maxCount]',
  weather: '/weather <clear|rain|thunder> [duration]',
  difficulty: '/difficulty [peaceful|easy|normal|hard]',
  kill: '/kill [targets]',
  damage: '/damage <target> <amount>',
  seed: '/seed',
  effect: '/effect give <targets> <effect> [seconds] [amplifier] [hideParticles] | /effect clear [targets] [effect]',
  xp: '/xp <add|set|query> <targets> <amount> [points|levels]',
  experience: '/experience (alias of /xp)',
  summon: '/summon <entity> [x y z]',
  setblock: '/setblock <x> <y> <z> <block> [destroy|keep|replace]',
  fill: '/fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [replace [filter]|keep|hollow|outline|destroy]',
  clone: '/clone <x1> <y1> <z1> <x2> <y2> <z2> <x> <y> <z>',
  gamerule: '/gamerule <rule> [value]',
  spawnpoint: '/spawnpoint [targets] [x y z]',
  setworldspawn: '/setworldspawn [x y z]',
  say: '/say <message>',
  me: '/me <action>',
  tell: '/tell <targets> <message>',
  msg: '/msg (alias of /tell)',
  w: '/w (alias of /tell)',
  teammsg: '/teammsg <message>',
  tellraw: '/tellraw <targets> <text>',
  title: '/title <targets> <title|subtitle|actionbar|clear> [text]',
  locate: '/locate structure <village|stronghold|fortress> | /locate biome <biome>',
  enchant: '/enchant <targets> <enchantment> [level]',
  playsound: '/playsound <sound> [source] [targets] [x y z] [volume] [pitch]',
  particle: '/particle <name> [x y z] [count]',
  list: '/list',
  kick: '/kick <player> [reason]',
  'save-all': '/save-all',
  toggledownfall: '/toggledownfall (legacy)',
  daylock: '/daylock [true|false]',
  spectate: '/spectate [target]',
  ride: '/ride <target> mount <vehicle> | /ride <target> dismount',
  execute: '/execute ... run <command>  (as/at/positioned subset)',
};

/** All candidates for the last word of a partially typed command (vanilla CommandSuggestions). */
export function suggestCommand(g: Game, text: string): string[] {
  const parts = text.slice(1).split(' ');
  const names = Object.keys(COMMAND_USAGE);
  const last = parts[parts.length - 1];
  const pick = (opts: string[]) => opts.filter((o) => o.startsWith(last) && o !== last).slice(0, 50);
  if (parts.length === 1) return pick(names);
  const cmd = parts[0];
  const players = g.allPlayersEverywhere().map((x) => x.name);
  const targets = ['@s', '@p', '@a', '@e', '@r', ...players];
  const itemNames = () => g.items.items.filter((i) => i).map((i) => i.name);
  const blockNames = () => g.registry.blocks.map((b) => b.name);
  switch (cmd) {
    case 'gamemode': return parts.length === 2 ? pick(['survival', 'creative', 'adventure', 'spectator']) : pick(targets);
    case 'defaultgamemode': return pick(['survival', 'creative', 'adventure', 'spectator']);
    case 'time': return parts.length === 2 ? pick(['set', 'add', 'query']) : parts[1] === 'set' ? pick(['day', 'noon', 'night', 'midnight']) : parts[1] === 'query' ? pick(['daytime', 'gametime', 'day']) : [];
    case 'weather': return parts.length === 2 ? pick(['clear', 'rain', 'thunder']) : [];
    case 'difficulty': return pick(DIFF);
    case 'give': return parts.length === 2 ? pick(targets) : parts.length === 3 ? pick(itemNames()) : [];
    case 'clear': return parts.length === 2 ? pick(targets) : parts.length === 3 ? pick(itemNames()) : [];
    case 'summon': return parts.length === 2 ? pick([...Object.keys(MOB_DEFS), 'lightning_bolt', 'tnt']) : pick(['~', '~ ~ ~']);
    case 'effect': return parts.length === 2 ? pick(['give', 'clear']) : parts.length === 3 ? pick(targets) : parts.length === 4 ? pick(EFFECTS) : parts.length === 5 ? pick(['infinite']) : [];
    case 'setblock': return parts.length <= 4 ? pick(['~']) : parts.length === 5 ? pick(blockNames()) : pick(['destroy', 'keep', 'replace']);
    case 'fill': return parts.length <= 7 ? pick(['~']) : parts.length === 8 ? pick(blockNames()) : pick(['replace', 'keep', 'hollow', 'outline', 'destroy']);
    case 'clone': return pick(['~']);
    case 'gamerule': return parts.length === 2 ? pick(Object.keys(g.rules)) : pick(['true', 'false']);
    case 'locate': return parts.length === 2 ? pick(['biome', 'structure']) : parts.length === 3 ? pick(parts[1] === 'structure' ? ['village', 'stronghold', 'fortress'] : BIOMES.map((b) => b.name)) : [];
    case 'xp': case 'experience': return parts.length === 2 ? pick(['add', 'set', 'query']) : parts.length === 3 ? pick(targets) : parts.length === 5 ? pick(['points', 'levels']) : [];
    case 'title': return parts.length === 2 ? pick(targets) : parts.length === 3 ? pick(['title', 'subtitle', 'actionbar', 'clear']) : [];
    case 'enchant': return parts.length === 2 ? pick(targets) : parts.length === 3 ? pick((g.assets.mcdata.enchantments ?? []).map((e: any) => e.name)) : [];
    case 'help': return pick(names);
    case 'kill': case 'tp': case 'teleport': case 'spawnpoint': case 'tell': case 'msg': case 'w': case 'tellraw': case 'damage': case 'spectate': case 'ride': case 'kick': return parts.length === 2 ? pick(targets) : cmd === 'ride' && parts.length === 3 ? pick(['mount', 'dismount']) : cmd === 'tp' || cmd === 'teleport' ? pick([...targets, '~']) : [];
    case 'playsound': return parts.length === 2 ? pick(Object.keys(g.sounds.events ?? {})) : parts.length === 3 ? pick(['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice']) : parts.length === 4 ? pick(targets) : [];
    case 'particle': return parts.length === 2 ? pick(['flame', 'smoke', 'heart', 'happy_villager', 'portal', 'explosion', 'splash', 'bubble', 'enchant', 'totem_of_undying']) : [];
    case 'execute': return pick(['as', 'at', 'positioned', 'run', 'in', 'if', 'unless']);
  }
  return [];
}

export function completeCommand(g: Game, text: string): string | null {
  const parts = text.slice(1).split(' ');
  const names = Object.keys(COMMAND_USAGE);
  if (parts.length === 1) { const m = names.find((c) => c.startsWith(parts[0])); return m ? '/' + m + ' ' : null; }
  const cmd = parts[0], last = parts[parts.length - 1];
  const complete = (opts: string[]) => { const m = opts.find((o) => o.startsWith(last)); return m ? '/' + [...parts.slice(0, -1), m].join(' ') + ' ' : null; };
  if (last.startsWith('@')) return complete(['@s', '@p', '@a', '@e', '@r']);
  switch (cmd) {
    case 'gamemode': case 'defaultgamemode': if (parts.length === 2) return complete(['survival', 'creative', 'adventure', 'spectator']); break;
    case 'time': if (parts.length === 2) return complete(['set', 'add', 'query']); if (parts.length === 3) return complete(['day', 'noon', 'night', 'midnight', 'daytime', 'gametime']); break;
    case 'weather': if (parts.length === 2) return complete(['clear', 'rain', 'thunder']); break;
    case 'difficulty': if (parts.length === 2) return complete(DIFF); break;
    case 'give': if (parts.length === 3) return complete(g.items.items.filter((i) => i).map((i) => i.name)); break;
    case 'summon': if (parts.length === 2) return complete(Object.keys(MOB_DEFS)); break;
    case 'effect': if (parts.length === 2) return complete(['give', 'clear']); if (parts.length === 4) return complete(EFFECTS); break;
    case 'setblock': if (parts.length === 5) return complete(g.registry.blocks.map((b) => b.name)); break;
    case 'fill': if (parts.length === 8) return complete(g.registry.blocks.map((b) => b.name)); break;
    case 'gamerule': if (parts.length === 2) return complete(Object.keys(g.rules)); break;
    case 'locate': if (parts.length === 2) return complete(['biome', 'structure']); if (parts.length === 3) return complete(parts[1] === 'structure' ? ['village', 'stronghold', 'fortress'] : BIOMES.map((b) => b.name)); break;
    case 'xp': case 'experience': if (parts.length === 2) return complete(['add', 'set', 'query']); break;
    case 'title': if (parts.length === 3) return complete(['title', 'subtitle', 'actionbar', 'clear']); break;
    case 'enchant': if (parts.length === 3) return complete(g.assets.mcdata.enchantments?.map((e: any) => e.name) ?? []); break;
    case 'help': if (parts.length === 2) return complete(names); break;
  }
  return null;
}

class CommandError extends Error {}

/** Parse a target selector or player name into entities. */
function selectTargets(g: Game, sel: string, self: Player, playersOnly = false): Entity[] {
  // players are found in every dimension; other entities only in the executor's
  const all = (): Entity[] => [...g.allPlayersEverywhere(), ...g.entities.filter((e) => !e.removed && !(e instanceof Player))];
  const players = (): Player[] => g.allPlayersEverywhere();
  if (!sel.startsWith('@')) {
    const p = players().find((x) => x.name.toLowerCase() === sel.toLowerCase());
    if (!p) throw new CommandError(`No player was found`);
    return [p];
  }
  const m = /^@([spaer])(?:\[(.*)\])?$/.exec(sel);
  if (!m) throw new CommandError(`Invalid selector '${sel}'`);
  const kind = m[1];
  const args: Record<string, string> = {};
  if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = (v ?? '').trim(); }
  let list: Entity[] = kind === 's' ? [self] : kind === 'e' ? all() : players();
  if (playersOnly) list = list.filter((e) => e instanceof Player);
  const ox = args.x !== undefined ? +args.x : self.x, oy = args.y !== undefined ? +args.y : self.y, oz = args.z !== undefined ? +args.z : self.z;
  if (args.type) { const neg = args.type.startsWith('!'); const t = args.type.replace('!', '').replace('minecraft:', ''); list = list.filter((e) => ((e instanceof Player ? 'player' : e.type) === t) !== neg); }
  if (args.name) { const neg = args.name.startsWith('!'); const n = args.name.replace('!', '').replace(/"/g, ''); list = list.filter((e) => (((e as any).name ?? (e as any).customName ?? '') === n) !== neg); }
  if (args.distance) { const r = parseRange(args.distance); list = list.filter((e) => { const d = Math.sqrt(e.distSq(ox, oy, oz)); return d >= r[0] && d <= r[1]; }); }
  if (args.gamemode) { const neg = args.gamemode.startsWith('!'); const gm = args.gamemode.replace('!', ''); list = list.filter((e) => (e instanceof Player && e.gameMode === gm) !== neg); }
  if (args.dx !== undefined || args.dy !== undefined || args.dz !== undefined) { const dx = +(args.dx ?? 0), dy = +(args.dy ?? 0), dz = +(args.dz ?? 0); list = list.filter((e) => e.x >= Math.min(ox, ox + dx) && e.x <= Math.max(ox, ox + dx) + 1 && e.y >= Math.min(oy, oy + dy) && e.y <= Math.max(oy, oy + dy) + 1 && e.z >= Math.min(oz, oz + dz) && e.z <= Math.max(oz, oz + dz) + 1); }
  const sort = args.sort ?? (kind === 'p' ? 'nearest' : kind === 'r' ? 'random' : 'arbitrary');
  if (sort === 'nearest') list.sort((a, b) => a.distSq(ox, oy, oz) - b.distSq(ox, oy, oz));
  else if (sort === 'furthest') list.sort((a, b) => b.distSq(ox, oy, oz) - a.distSq(ox, oy, oz));
  else if (sort === 'random') list.sort(() => Math.random() - 0.5);
  let limit = args.limit !== undefined ? parseInt(args.limit) : kind === 'p' || kind === 'r' ? 1 : Infinity;
  if (kind === 'p' || kind === 'r') limit = Math.max(1, limit);
  if (limit !== Infinity) list = list.slice(0, limit);
  if (!list.length) throw new CommandError(kind === 'e' ? 'No entity was found' : 'No player was found');
  return list;
}
function parseRange(s: string): [number, number] {
  if (s.includes('..')) { const [a, b] = s.split('..'); return [a === '' ? 0 : +a, b === '' ? Infinity : +b]; }
  return [+s, +s];
}

/** Execute a command as the given player (host player by default). Feedback goes to the executor: the host's
 *  chat, or `feedback` for a guest running it through the host. Announcements (/say, /me) reach everyone. */
export function runCommand(g: Game, text: string, executor?: Player, feedback?: (text: string) => void, operator = g.cheats): void {
  const say = feedback ?? ((t: string) => g.gui.addChat(t));
  const err = (t: string) => say('§c' + t);
  const announce = (t: string) => { g.gui.addChat(t); g.host?.broadcast({ t: 'chat', text: t }); };
  const syncRemote = (pl: Player) => { if (pl !== g.player) g.host?.syncInventory(pl); };
  const raw = text.startsWith('/') ? text.slice(1) : text;
  const parts = raw.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const self = executor ?? g.player;
  const p = self;
  if (!cmd) return;
  const usage = (name: string) => { throw new CommandError(`Unknown or incomplete command, see below for error\n§7${COMMAND_USAGE[name] ?? ''}`); };
  if (!(cmd in COMMAND_USAGE)) { err(`Unknown or incomplete command, see below for error\n§7${raw}§r§c<--[HERE]`); return; }
  if (!operator && !['help', 'seed', 'say', 'me', 'tell', 'msg', 'w', 'teammsg', 'list', 'trigger'].includes(cmd)) { err(`Unknown or incomplete command, see below for error\n§7${raw}§r§c<--[HERE]`); return; }
  const rel = (s: string | undefined, base: number, name = 'coordinate'): number => {
    if (s === undefined) throw new CommandError(`Expected ${name}`);
    if (s.startsWith('~')) return base + (s.length > 1 ? parseFloat(s.slice(1)) : 0);
    if (s.startsWith('^')) return base + (s.length > 1 ? parseFloat(s.slice(1)) : 0); // local coords approximated as relative
    const v = parseFloat(s); if (Number.isNaN(v)) throw new CommandError(`Expected ${name}, got '${s}'`); return v;
  };
  const blockCoord = (s: string | undefined, base: number): number => Math.floor(rel(s, Math.floor(base)));
  const targets = (sel: string | undefined, fallback: Entity[] = [self], playersOnly = false): Entity[] => sel === undefined ? fallback : selectTargets(g, sel, self, playersOnly);
  const nameOf = (e: Entity): string => e instanceof Player ? e.name : (e as any).customName ?? (g.assets.lang['entity.minecraft.' + e.type] ?? e.type);
  const isSelector = (s?: string) => !!s && (s.startsWith('@') || g.allPlayersEverywhere().some((x) => x.name.toLowerCase() === s.toLowerCase()));
  try {
    switch (cmd) {
      case 'help': {
        if (parts[1]) { const u = COMMAND_USAGE[parts[1].replace('/', '')]; if (!u) throw new CommandError(`Unknown command: ${parts[1]}`); say(u); break; }
        say('§e--- Showing help (commands) ---');
        for (const u of Object.values(COMMAND_USAGE)) if (!u.includes('alias')) say(`§7${u}`);
        break;
      }
      case 'gamemode': case 'defaultgamemode': {
        const m = GAMEMODES[parts[1] ?? '']; if (!m) usage(cmd);
        if (cmd === 'defaultgamemode') { if (g.worldMeta) g.worldMeta.gameMode = m; say(`The default game mode is now ${g.assets.lang['gameMode.' + m] ?? m}`); break; }
        for (const e of targets(parts[2], [self], true)) { const pl = e as Player; pl.setGameMode(m); say(pl === self ? `Set own game mode to ${g.assets.lang['gameMode.' + m] ?? m}` : `Set ${pl.name}'s game mode to ${g.assets.lang['gameMode.' + m] ?? m}`); }
        break;
      }
      case 'time': {
        const sub = parts[1];
        if (sub === 'set') { const named: Record<string, number> = { day: 1000, noon: 6000, night: 13000, midnight: 18000 }; const v = named[parts[2]] ?? parseInt(parts[2]); if (Number.isNaN(v)) usage(cmd); g.world.dayTime = Math.floor(g.world.dayTime / 24000) * 24000 + ((v % 24000) + 24000) % 24000; say(`Set the time to ${v}`); }
        else if (sub === 'add') { const v = parseInt(parts[2]); if (Number.isNaN(v)) usage(cmd); g.world.dayTime += v; say(`Set the time to ${g.world.dayTime % 24000}`); }
        else if (sub === 'query') { const q = parts[2] ?? 'daytime'; say(`The time is ${q === 'gametime' ? g.world.time : q === 'day' ? Math.floor(g.world.dayTime / 24000) : g.world.dayTime % 24000}`); }
        else usage(cmd);
        break;
      }
      case 'tp': case 'teleport': {
        // /tp <x y z> | /tp <target> | /tp <targets> <x y z> | /tp <targets> <destination>
        const move = (e: Entity, x: number, y: number, z: number, dim: Dimension = e.world.dimension) => { if (e instanceof Player) g.teleportPlayer(e, dim, x, y, z); else { e.setPos(x, y, z); e.fallDistance = 0; e.portalCooldown = Math.max(e.portalCooldown, 40); } };
        if (parts.length === 4 && !isSelector(parts[1])) { const x = rel(parts[1], p.x), y = rel(parts[2], p.y), z = rel(parts[3], p.z); move(p, x, y, z); say(`Teleported ${p.name} to ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`); }
        else if (parts.length === 2) { const d = targets(parts[1])[0]; move(p, d.x, d.y, d.z, d.world.dimension); say(`Teleported ${p.name} to ${nameOf(d)}`); }
        else if (parts.length === 3) { const d = targets(parts[2])[0]; for (const e of targets(parts[1])) { move(e, d.x, d.y, d.z, d.world.dimension); say(`Teleported ${nameOf(e)} to ${nameOf(d)}`); } }
        else if (parts.length >= 5) { for (const e of targets(parts[1])) { const x = rel(parts[2], e.x), y = rel(parts[3], e.y), z = rel(parts[4], e.z); move(e, x, y, z); if (parts[5] !== undefined && parts[6] !== undefined) { e.yaw = rel(parts[5], e.yaw); e.pitch = rel(parts[6], e.pitch); } say(`Teleported ${nameOf(e)} to ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`); } }
        else usage(cmd);
        break;
      }
      case 'give': {
        if (parts.length < 3) usage(cmd);
        const name = parts[2].replace('minecraft:', '').split('[')[0]; const count = parseInt(parts[3] ?? '1') || 1;
        const it = g.items.get(name);
        if (!it) throw new CommandError(`Unknown item '${parts[2]}'`);
        for (const e of targets(parts[1], [self], true)) {
          const pl = e as Player; let left = count;
          while (left > 0) { const s = new ItemStack(it, Math.min(left, it.stackSize)); left -= s.count; pl.give(s); }
          syncRemote(pl);
          say(`Gave ${count} [${g.items.displayName(it.name)}] to ${pl.name}`);
        }
        break;
      }
      case 'clear': {
        const item = parts[2] ? parts[2].replace('minecraft:', '') : null; const max = parts[3] !== undefined ? parseInt(parts[3]) : -1;
        for (const e of targets(parts[1], [self], true)) {
          const pl = e as Player; let n = 0;
          const invs = [pl.inventory, pl.armor, pl.offhand];
          for (const inv of invs) for (let i = 0; i < inv.size; i++) { const s = inv.get(i); if (!s || (item && s.item.name !== item)) continue; const take = max < 0 ? s.count : Math.min(s.count, max - n); if (take <= 0) continue; s.count -= take; n += take; if (s.count <= 0) inv.set(i, null); }
          pl.inventory.onChange?.(); syncRemote(pl);
          if (max === 0) say(`${pl.name} has ${n} matching items`); else say(n ? `Removed ${n} item(s) from player ${pl.name}` : `No items were found on player ${pl.name}`);
        }
        break;
      }
      case 'weather': {
        const w = parts[1]; const dur = parts[2] ? parseInt(parts[2]) * 20 : 0;
        if (w === 'clear') { g.weather.raining = false; g.weather.thundering = false; g.weather.rainTime = dur || 12000 + Math.floor(Math.random() * 168000); }
        else if (w === 'rain') { g.weather.raining = true; g.weather.thundering = false; g.weather.rainTime = dur || 6000; }
        else if (w === 'thunder') { g.weather.raining = true; g.weather.thundering = true; g.weather.thunderTime = dur || 6000; g.weather.rainTime = dur || 6000; }
        else usage(cmd);
        say(`Set the weather to ${w}`); break;
      }
      case 'toggledownfall': g.weather.raining = !g.weather.raining; say('Toggled downfall'); break;
      case 'difficulty': { if (!parts[1]) { say(`The difficulty is ${cap(DIFF[g.difficulty])}`); break; } const d = DIFF.indexOf(parts[1].toLowerCase()); const dn = d >= 0 ? d : parseInt(parts[1]); if (!(dn >= 0 && dn <= 3)) usage(cmd); g.setDifficulty(dn); say(`The difficulty has been set to ${cap(DIFF[dn])}`); break; }
      case 'kill': { const list = targets(parts[1]); for (const e of list) { if (e instanceof LivingEntity) e.hurt({ amount: 1e9, source: 'void', bypassArmor: true }); else e.remove(); } say(list.length === 1 ? `Killed ${nameOf(list[0])}` : `Killed ${list.length} entities`); break; }
      case 'damage': { const amount = parseFloat(parts[2]); if (Number.isNaN(amount)) usage(cmd); for (const e of targets(parts[1])) { if (e instanceof LivingEntity) { e.hurt({ amount, source: 'generic' as any }); say(`Applied ${amount} damage to ${nameOf(e)}`); } } break; }
      case 'seed': say(`Seed: [${g.world.seed}]`); break;
      case 'effect': {
        const sub = parts[1];
        if (sub === 'clear') { const id = parts[3]?.replace('minecraft:', ''); for (const e of targets(parts[2])) { if (!(e instanceof LivingEntity)) continue; if (id) e.effects = e.effects.filter((x) => x.id !== id); else { e.effects = []; e.absorption = 0; } say(id ? `Removed effect ${id} from ${nameOf(e)}` : `Removed every effect from ${nameOf(e)}`); } break; }
        if (sub === 'give') {
          const id = (parts[3] ?? '').replace('minecraft:', ''); if (!EFFECTS.includes(id)) throw new CommandError(`Unknown effect '${parts[3]}'`);
          const secs = parts[4] === 'infinite' ? 1e7 : parseInt(parts[4] ?? '30') || 30; const amp = parseInt(parts[5] ?? '0') || 0; const hide = parts[6] === 'true';
          for (const e of targets(parts[2])) { if (e instanceof LivingEntity) { e.addEffect({ id, amplifier: amp, duration: secs * 20, hideParticles: hide } as any); say(`Applied effect ${g.assets.lang['effect.minecraft.' + id] ?? id} to ${nameOf(e)}`); } }
          break;
        }
        usage(cmd); break;
      }
      case 'xp': case 'experience': {
        const sub = parts[1];
        if (sub === 'query') { const pl = targets(parts[2], [self], true)[0] as Player; say(`${pl.name} has ${parts[3] === 'levels' ? pl.xpLevel + ' experience levels' : Math.floor(pl.totalXp) + ' experience points'}`); break; }
        if (sub !== 'add' && sub !== 'set') usage(cmd);
        const n = parseInt(parts[3]); if (Number.isNaN(n)) usage(cmd);
        const levels = (parts[4] ?? 'points').startsWith('level');
        for (const e of targets(parts[2], [self], true)) { const pl = e as Player; if (levels) { if (sub === 'set') { pl.xpLevel = 0; pl.xpProgress = 0; } pl.addXpLevels(n); } else { if (sub === 'set') { pl.xpProgress = 0; } pl.addXp(n); } say(`${sub === 'add' ? 'Gave' : 'Set'} ${n} experience ${levels ? 'levels' : 'points'} ${sub === 'add' ? 'to' : 'for'} ${pl.name}`); }
        break;
      }
      case 'summon': {
        const name = (parts[1] ?? '').replace('minecraft:', ''); if (!name) usage(cmd);
        const x = parts[2] ? rel(parts[2], p.x) : p.x, y = parts[3] ? rel(parts[3], p.y) : p.y, z = parts[4] ? rel(parts[4], p.z) : p.z;
        if (MOB_DEFS[name]) { g.spawnMob(name, x, y, z); }
        else if (name === 'lightning_bolt') g.weather.strikeLightning(Math.floor(x), Math.floor(y), Math.floor(z));
        else if (name === 'tnt') g.igniteTnt(Math.floor(x), Math.floor(y), Math.floor(z));
        else if (name === 'item') { const it = g.items.get('stone'); if (it) g.dropItem(x, y, z, new ItemStack(it, 1)); }
        else throw new CommandError(`Unknown entity type '${parts[1]}'`);
        say(`Summoned new ${g.assets.lang['entity.minecraft.' + name] ?? name}`); break;
      }
      case 'setblock': {
        if (parts.length < 5) usage(cmd);
        const x = blockCoord(parts[1], p.x), y = blockCoord(parts[2], p.y), z = blockCoord(parts[3], p.z);
        const mode = ['destroy', 'keep', 'replace'].includes(parts[parts.length - 1]) ? parts.pop()! : 'replace';
        const st = g.registry.parseState(parts.slice(4).join(' '));
        if (!st && !/^(minecraft:)?air$/.test(parts[4])) throw new CommandError(`Unknown block '${parts[4]}'`);
        const old = g.world.getBlock(x, y, z);
        if (mode === 'keep' && old !== 0) throw new CommandError('Could not set the block');
        if (mode === 'destroy' && old !== 0) g.breakBlock(x, y, z, null, true, true);
        g.world.setBlock(x, y, z, st, 1);
        say(`Changed the block at ${x}, ${y}, ${z}`); break;
      }
      case 'fill': {
        if (parts.length < 8) usage(cmd);
        const c = parts.slice(1, 7).map((s, i) => blockCoord(s, [p.x, p.y, p.z][i % 3]));
        const [x0, x1] = [Math.min(c[0], c[3]), Math.max(c[0], c[3])], [y0, y1] = [Math.min(c[1], c[4]), Math.max(c[1], c[4])], [z0, z1] = [Math.min(c[2], c[5]), Math.max(c[2], c[5])];
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 32768) throw new CommandError(`Too many blocks in the specified area (maximum 32768, specified ${(x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1)})`);
        const modeIdx = parts.findIndex((s, i) => i >= 8 && ['replace', 'keep', 'hollow', 'outline', 'destroy'].includes(s));
        const mode = modeIdx >= 0 ? parts[modeIdx] : 'replace';
        const st = g.registry.parseState(parts.slice(7, modeIdx >= 0 ? modeIdx : undefined).join(' '));
        const filter = mode === 'replace' && modeIdx >= 0 && parts[modeIdx + 1] ? g.registry.blockByName(parts[modeIdx + 1].replace('minecraft:', ''))?.id ?? -1 : -1;
        let n = 0;
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          const edge = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
          const old = g.world.getBlock(x, y, z);
          let put = st;
          if (mode === 'keep' && old !== 0) continue;
          if (mode === 'hollow' && !edge) put = 0;
          if (mode === 'outline' && !edge) continue;
          if (filter >= 0 && g.registry.stateBlock[old] !== filter) continue;
          if (mode === 'destroy' && old !== 0) g.breakBlock(x, y, z, null, true, true);
          if (g.world.setBlock(x, y, z, put, 0)) n++;
        }
        if (!n) throw new CommandError('No blocks were filled');
        say(`Successfully filled ${n} block(s)`); break;
      }
      case 'clone': {
        if (parts.length < 10) usage(cmd);
        const c = parts.slice(1, 10).map((s, i) => blockCoord(s, [p.x, p.y, p.z][i % 3]));
        const [x0, x1] = [Math.min(c[0], c[3]), Math.max(c[0], c[3])], [y0, y1] = [Math.min(c[1], c[4]), Math.max(c[1], c[4])], [z0, z1] = [Math.min(c[2], c[5]), Math.max(c[2], c[5])];
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 32768) throw new CommandError('Too many blocks in the specified area');
        const buf: number[] = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) buf.push(g.world.getBlock(x, y, z));
        let i = 0, n = 0;
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { if (g.world.setBlock(c[6] + x - x0, c[7] + y - y0, c[8] + z - z0, buf[i++], 0)) n++; }
        say(`Successfully cloned ${n} block(s)`); break;
      }
      case 'gamerule': {
        const rule = parts[1], val = parts[2];
        if (!rule) { say('Rules: ' + Object.entries(g.rules).map(([k, v]) => `${k}=${v}`).join(', ')); break; }
        if (!(rule in g.rules)) throw new CommandError(`Unknown game rule '${rule}'`);
        if (val === undefined) { say(`Gamerule ${rule} is currently set to: ${(g.rules as any)[rule]}`); break; }
        (g.rules as any)[rule] = val === 'true' ? true : val === 'false' ? false : (Number.isNaN(parseInt(val)) ? val : parseInt(val));
        say(`Gamerule ${rule} is now set to: ${val}`); break;
      }
      case 'spawnpoint': {
        const list = targets(parts[1], [self], true);
        for (const e of list) { const pl = e as Player; const x = parts[2] ? blockCoord(parts[2], pl.x) : Math.floor(pl.x), y = parts[3] ? blockCoord(parts[3], pl.y) : Math.floor(pl.y), z = parts[4] ? blockCoord(parts[4], pl.z) : Math.floor(pl.z); pl.setSpawn(x, y, z, true); say(`Set spawn point to ${x}, ${y}, ${z} [0.0] in minecraft:${g.world.dimension} for ${pl.name}`); }
        break;
      }
      case 'setworldspawn': { const x = parts[1] ? blockCoord(parts[1], p.x) : Math.floor(p.x), y = parts[2] ? blockCoord(parts[2], p.y) : Math.floor(p.y), z = parts[3] ? blockCoord(parts[3], p.z) : Math.floor(p.z); g.worldSpawn = [x, y, z]; say(`Set the world spawn point to ${x}, ${y}, ${z} [0.0]`); break; }
      case 'say': announce(`[${p.name}] ${parts.slice(1).join(' ')}`); break;
      case 'me': announce(`* ${p.name} ${parts.slice(1).join(' ')}`); break;
      case 'teammsg': announce(`[Team] <${p.name}> ${parts.slice(1).join(' ')}`); break;
      case 'tell': case 'msg': case 'w': {
        if (parts.length < 3) usage(cmd);
        const msg = parts.slice(2).join(' ');
        for (const e of targets(parts[1], undefined, true)) { const pl = e as Player; say(`§7§oYou whisper to ${pl.name}: ${msg}`); if (pl === g.player) g.gui.addChat(`§7§o${p.name} whispers to you: ${msg}`); else g.host?.send((pl as any).clientId, { t: 'chat', text: `§7§o${p.name} whispers to you: ${msg}` }); }
        break;
      }
      case 'tellraw': { if (parts.length < 3) usage(cmd); let txt = parts.slice(2).join(' '); try { const j = JSON.parse(txt); txt = typeof j === 'string' ? j : Array.isArray(j) ? j.map((x) => x.text ?? x).join('') : j.text ?? txt; } catch { /* plain */ } for (const e of targets(parts[1], undefined, true)) { const pl = e as Player; if (pl === g.player) g.gui.addChat(txt); else g.host?.send((pl as any).clientId, { t: 'chat', text: txt }); } break; }
      case 'title': {
        if (parts.length < 3) usage(cmd);
        const kind = parts[2], txt = parts.slice(3).join(' ').replace(/^"(.*)"$/, '$1');
        for (const e of targets(parts[1], undefined, true)) {
          const pl = e as Player;
          if (pl === g.player) { if (kind === 'title') g.gui.showTitle(txt); else if (kind === 'subtitle') g.gui.showTitle(g.gui.titleText?.title ?? '', txt); else if (kind === 'actionbar') g.gui.showActionBar(txt); else if (kind === 'clear' || kind === 'reset') g.gui.titleText = null; else usage(cmd); }
          else g.host?.send((pl as any).clientId, { t: kind === 'actionbar' ? 'actionbar' : 'chat', text: txt });
        }
        say(`Showing new ${kind} for ${parts[1]}`); break;
      }
      case 'locate': {
        const name = (parts[2] ?? parts[1] ?? '').replace('minecraft:', '');
        if (parts[1] === 'structure') {
          const kind = name.replace(/^village_.*/, 'village').replace(/^nether_fortress$|^fortress$/, 'fortress');
          if (!['village', 'stronghold', 'fortress'].includes(kind)) throw new CommandError((g.assets.lang['commands.locate.structure.invalid'] ?? 'There is no structure with type "%s"').replace('%s', name));
          const label = g.assets.lang[`structure.minecraft.${kind === 'fortress' ? 'fortress' : kind}`] ?? kind;
          g.chunks.locate(kind, p.x, p.z).then((pos) => {
            if (!pos) { say((g.assets.lang['commands.locate.structure.not_found'] ?? 'Could not find a structure of type "%s" nearby').replace('%s', name)); return; }
            const d = Math.round(Math.hypot(pos[0] - p.x, pos[1] - p.z));
            say((g.assets.lang['commands.locate.structure.success'] ?? 'The nearest %s is at %s (%s blocks away)').replace('%s', label).replace('%s', `[${pos[0]}, ~, ${pos[1]}]`).replace('%s', String(d)));
          });
          break;
        }
        const bi = BIOMES.findIndex((b) => b.name === name);
        if (bi < 0) throw new CommandError(`Unknown biome '${name}'`);
        let found: [number, number] | null = null;
        for (let r = 0; r <= 1024 && !found; r += 16) for (let a = 0; a < 24 && !found; a++) { const x = Math.floor(p.x + Math.cos(a / 12 * Math.PI) * r), z = Math.floor(p.z + Math.sin(a / 12 * Math.PI) * r); if (g.world.isLoaded(x, z) ? g.world.getBiome(x, z) === bi : false) found = [x, z]; }
        if (found) say(`The nearest minecraft:${name} is at [${found[0]}, ~, ${found[1]}] (${Math.round(Math.hypot(found[0] - p.x, found[1] - p.z))} blocks away)`); else throw new CommandError(`Could not find a biome of type "minecraft:${name}" within reasonable distance`);
        break;
      }
      case 'enchant': {
        if (parts.length < 3) usage(cmd);
        const id = parts[2].replace('minecraft:', ''); const lvl = parseInt(parts[3] ?? '1') || 1;
        for (const e of targets(parts[1], [self], true)) { const pl = e as Player; const held = pl.heldItem(); if (!held) throw new CommandError(`${pl.name} is not holding any item`); const ex = held.enchantments.find((x) => x.id === id); if (ex) ex.level = lvl; else held.enchantments.push({ id, level: lvl }); pl.inventory.onChange?.(); syncRemote(pl); say(`Applied enchantment ${g.assets.lang['enchantment.minecraft.' + id] ?? id} to ${pl.name}'s item`); }
        break;
      }
      case 'playsound': { if (!parts[1]) usage(cmd); const snd = parts[1].replace('minecraft:', ''); const x = parts[4] ? rel(parts[4], p.x) : p.x, y = parts[5] ? rel(parts[5], p.y) : p.y, z = parts[6] ? rel(parts[6], p.z) : p.z; g.sounds.playAt(snd, x, y, z, parseFloat(parts[7] ?? '1') || 1, parseFloat(parts[8] ?? '1') || 1); say(`Played sound ${snd} to ${parts[3] ?? p.name}`); break; }
      case 'particle': { if (!parts[1]) usage(cmd); const name = parts[1].replace('minecraft:', ''); const x = parts[2] ? rel(parts[2], p.x) : p.x, y = parts[3] ? rel(parts[3], p.y) : p.y, z = parts[4] ? rel(parts[4], p.z) : p.z; const count = parseInt(parts[8] ?? parts[5] ?? '1') || 1; const pa: any = g.particles; const fn = { flame: 'spawnFlame', smoke: 'spawnSmoke', heart: 'spawnHeart', happy_villager: 'spawnHappyVillager', portal: 'spawnPortal', explosion: 'spawnExplosion', splash: 'spawnSplash', bubble: 'spawnBubble', enchant: 'spawnEnchant', totem_of_undying: 'spawnTotem' }[name]; if (!fn || !pa[fn]) throw new CommandError(`Unknown particle '${name}'`); for (let i = 0; i < count; i++) pa[fn](x, y, z, name === 'splash' ? 0x3f76e4 : count); say(`Displaying particle minecraft:${name}`); break; }
      case 'list': { const names = g.allPlayersEverywhere().map((x) => x.name); say(`There are ${names.length} of a max of ${g.host ? g.host.opts.maxPlayers : 1} players online: ${names.join(', ')}`); break; }
      case 'kick': { if (!g.host) throw new CommandError('No player was found'); const name = parts[1]; const gu = [...g.host.guests.values()].find((x) => x.name.toLowerCase() === (name ?? '').toLowerCase()); if (!gu) throw new CommandError('No player was found'); g.host.kick(gu.id, parts.slice(2).join(' ') || 'Kicked by an operator'); say(`Kicked ${gu.name}: ${parts.slice(2).join(' ') || 'Kicked by an operator'}`); break; }
      case 'save-all': g.saveAll(); say('Saved the game'); break;
      case 'daylock': g.rules.doDaylightCycle = parts[1] === 'false'; say(`Daylight cycle ${g.rules.doDaylightCycle ? 'enabled' : 'locked'}`); break;
      case 'spectate': { if (!p.isSpectator) throw new CommandError('Spectator mode is required'); if (!parts[1]) { say('Stopped spectating'); break; } const t = targets(parts[1])[0]; p.setPos(t.x, t.y, t.z); say(`Now spectating ${nameOf(t)}`); break; }
      case 'ride': {
        const rider = targets(parts[1])[0];
        // vanilla RideCommand: dismount / mount <vehicle>, with the vanilla refusals
        if (parts[2] === 'dismount') { if (rider.vehicle) { const v = rider.vehicle; if ((v as any).ejectPassenger) (v as any).ejectPassenger(rider); else rider.stopRiding(); say(`${nameOf(rider)} stopped riding ${nameOf(v)}`); } else throw new CommandError(`${nameOf(rider)} is not riding any vehicle`); break; }
        if (parts[2] === 'mount') {
          if (!parts[3]) usage(cmd);
          const v = targets(parts[3])[0];
          if (v === rider) throw new CommandError(`${nameOf(rider)} cannot ride itself`);
          if (rider.vehicle === v) throw new CommandError(`${nameOf(rider)} is already riding ${nameOf(v)}`);
          for (let c: Entity | null = v; c; c = c.vehicle) if (c === rider) throw new CommandError(`Mounting ${nameOf(v)} would result in a loop`);
          if (v.world !== rider.world) throw new CommandError(`${nameOf(rider)} and ${nameOf(v)} are not in the same dimension`);
          if (rider instanceof Player && rider.sleeping) throw new CommandError(`${nameOf(rider)} is sleeping and cannot ride anything`);
          const ok = (v as any).addPassenger ? (v as any).addPassenger(rider) : rider.startRiding(v);
          if (!ok) throw new CommandError(`${nameOf(rider)} could not start riding ${nameOf(v)}`);
          g.host?.onRideChanged(rider);
          say(`${nameOf(rider)} started riding ${nameOf(v)}`); break;
        }
        usage(cmd); break;
      }
      case 'execute': {
        // /execute [as <t>] [at <t>] [positioned <x y z>] run <command>
        let i = 1; let who: Player = p;
        while (i < parts.length && parts[i] !== 'run') {
          if (parts[i] === 'as' || parts[i] === 'at') { const t = targets(parts[i + 1])[0]; if (t instanceof Player) who = t; i += 2; }
          else if (parts[i] === 'positioned') i += 4;
          else if (parts[i] === 'in' || parts[i] === 'rotated' || parts[i] === 'anchored' || parts[i] === 'align' || parts[i] === 'facing') i += 2;
          else if (parts[i] === 'if' || parts[i] === 'unless') i += 3;
          else usage(cmd);
        }
        if (parts[i] !== 'run') usage(cmd);
        runCommand(g, '/' + parts.slice(i + 1).join(' '), who, feedback, operator); break;
      }
      default: err(`Unknown or incomplete command, see below for error\n§7${raw}§r§c<--[HERE]`);
    }
  } catch (e: any) {
    if (e instanceof CommandError) { for (const line of String(e.message).split('\n')) err(line); }
    else { err('An unexpected error occurred trying to execute that command'); console.error(e); }
  }
  void ItemEntity; void Mob;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
