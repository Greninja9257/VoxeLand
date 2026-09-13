// Chat commands (subset of vanilla).
import type { Game } from './game';
import { ItemStack } from '../items/stack';
import { MOB_DEFS } from '../entity/mobs';
import { BIOMES } from '../world/gen/biomes';
import type { GameMode } from '../entity/player';

const COMMANDS = ['help', 'gamemode', 'time', 'tp', 'teleport', 'give', 'weather', 'difficulty', 'kill', 'seed', 'clear', 'effect', 'xp', 'experience', 'summon', 'setblock', 'fill', 'gamerule', 'spawnpoint', 'say', 'locate', 'enchant', 'kill', 'toggledownfall', 'me', 'setworldspawn', 'daylock'];

export function completeCommand(text: string): string | null {
  const parts = text.slice(1).split(' ');
  if (parts.length === 1) { const m = COMMANDS.find((c) => c.startsWith(parts[0])); return m ? '/' + m + ' ' : null; }
  return null;
}

export function runCommand(g: Game, text: string): void {
  const say = (t: string) => g.gui.addChat(t);
  const err = (t: string) => g.gui.addChat('§c' + t);
  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const p = g.player;
  if (!g.cheats && cmd !== 'help' && cmd !== 'seed' && cmd !== 'say' && cmd !== 'me') { err('Cheats are not enabled in this world'); return; }
  const rel = (s: string, base: number): number => s.startsWith('~') ? base + (s.length > 1 ? parseFloat(s.slice(1)) : 0) : parseFloat(s);
  switch (cmd) {
    case 'help': say('§eCommands: ' + COMMANDS.join(', ')); break;
    case 'gamemode': { const m = { s: 'survival', survival: 'survival', c: 'creative', creative: 'creative', a: 'adventure', adventure: 'adventure', sp: 'spectator', spectator: 'spectator', '0': 'survival', '1': 'creative', '2': 'adventure', '3': 'spectator' }[parts[1] ?? ''] as GameMode | undefined; if (!m) { err('Usage: /gamemode <survival|creative|adventure|spectator>'); break; } p.setGameMode(m); say(`Set own game mode to ${g.assets.lang['gameMode.' + m] ?? m}`); break; }
    case 'time': {
      const sub = parts[1];
      if (sub === 'set') { const v = { day: 1000, noon: 6000, night: 13000, midnight: 18000 }[parts[2]] ?? parseInt(parts[2]); if (Number.isNaN(v)) { err('Invalid time'); break; } g.world.dayTime = ((v % 24000) + 24000) % 24000 + Math.floor(g.world.dayTime / 24000) * 24000; say(`Set the time to ${v}`); }
      else if (sub === 'add') { g.world.dayTime += parseInt(parts[2]) || 0; say(`Added ${parts[2]} to the time`); }
      else if (sub === 'query') say(`The time is ${g.world.dayTime % 24000} (day ${Math.floor(g.world.dayTime / 24000)})`);
      else err('Usage: /time <set|add|query> <value>');
      break;
    }
    case 'tp': case 'teleport': {
      if (parts.length >= 4) { const x = rel(parts[1], p.x), y = rel(parts[2], p.y), z = rel(parts[3], p.z); if ([x, y, z].some(Number.isNaN)) { err('Invalid coordinates'); break; } p.setPos(x, y, z); p.fallDistance = 0; say(`Teleported to ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`); }
      else err('Usage: /tp <x> <y> <z>');
      break;
    }
    case 'give': {
      const name = (parts[1] ?? '').replace('minecraft:', ''); const count = parseInt(parts[2] ?? '1') || 1;
      const it = g.items.get(name);
      if (!it) { err(`Unknown item '${name}'`); break; }
      let left = count;
      while (left > 0) { const s = new ItemStack(it, Math.min(left, it.stackSize)); left -= s.count; g.givePlayer(s); }
      say(`Gave ${count} [${g.items.displayName(it.name)}] to ${p.name}`);
      break;
    }
    case 'weather': { const w = parts[1]; if (w === 'clear') { g.weather.raining = false; g.weather.thundering = false; g.weather.rainTime = 12000 + Math.floor(Math.random() * 168000); } else if (w === 'rain') { g.weather.raining = true; g.weather.thundering = false; g.weather.rainTime = 6000; } else if (w === 'thunder') { g.weather.raining = true; g.weather.thundering = true; g.weather.thunderTime = 6000; } else { err('Usage: /weather <clear|rain|thunder>'); break; } say(`Set the weather to ${w}`); break; }
    case 'toggledownfall': g.weather.raining = !g.weather.raining; say('Toggled downfall'); break;
    case 'difficulty': { const d = { peaceful: 0, easy: 1, normal: 2, hard: 3, '0': 0, '1': 1, '2': 2, '3': 3 }[parts[1] ?? '']; if (d === undefined) { say(`The difficulty is ${['Peaceful', 'Easy', 'Normal', 'Hard'][g.difficulty]}`); break; } g.setDifficulty(d); say(`The difficulty has been set to ${['Peaceful', 'Easy', 'Normal', 'Hard'][d]}`); break; }
    case 'kill': { if (parts[1] === '@e') { let n = 0; for (const e of g.entities) if (e.type !== 'player') { e.remove(); n++; } say(`Killed ${n} entities`); } else { p.hurt({ amount: 1e9, source: 'void', bypassArmor: true }); say('Killed Player'); } break; }
    case 'seed': say(`Seed: [${g.world.seed}]`); break;
    case 'clear': { p.inventory.clear(); p.armor.clear(); p.offhand.clear(); say('Cleared the inventory of Player'); break; }
    case 'effect': {
      if (parts[1] === 'clear') { p.effects = []; p.absorption = 0; say('Removed every effect from Player'); break; }
      if (parts[1] === 'give') { const id = (parts[3] ?? parts[2] ?? '').replace('minecraft:', ''); const dur = parseInt(parts[4] ?? '30') || 30; const amp = parseInt(parts[5] ?? '0') || 0; if (!g.assets.mcdata.effects.some((e) => e.name.toLowerCase().replace(/ /g, '_') === id || e.name === id) && !['speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health', 'instant_damage', 'jump_boost', 'nausea', 'regeneration', 'resistance', 'fire_resistance', 'water_breathing', 'invisibility', 'blindness', 'night_vision', 'hunger', 'weakness', 'poison', 'wither', 'health_boost', 'absorption', 'saturation', 'glowing', 'levitation', 'luck', 'slow_falling', 'conduit_power', 'dolphins_grace', 'bad_omen', 'darkness'].includes(id)) { err(`Unknown effect '${id}'`); break; } p.addEffect({ id, amplifier: amp, duration: dur * 20 }); say(`Applied effect ${id} to Player`); break; }
      err('Usage: /effect <give|clear> @s <effect> [seconds] [amplifier]'); break;
    }
    case 'xp': case 'experience': { const sub = parts[1]; const n = parseInt(parts[3] ?? parts[2] ?? '0') || 0; const unit = (parts[4] ?? parts[3] ?? 'points'); if (sub === 'add' || sub === 'set') { if (unit.startsWith('level') || parts[parts.length - 1].startsWith('level')) { if (sub === 'set') { p.xpLevel = 0; p.xpProgress = 0; } p.addXpLevels(n); } else p.addXp(n); say(`Gave ${n} experience to Player`); } else err('Usage: /xp <add|set> @s <amount> [levels|points]'); break; }
    case 'summon': { const name = (parts[1] ?? '').replace('minecraft:', ''); if (!MOB_DEFS[name]) { err(`Unknown entity '${name}'`); break; } const x = parts[2] ? rel(parts[2], p.x) : p.x, y = parts[3] ? rel(parts[3], p.y) : p.y, z = parts[4] ? rel(parts[4], p.z) : p.z; g.spawnMob(name, x, y, z); say(`Summoned new ${g.assets.lang['entity.minecraft.' + name] ?? name}`); break; }
    case 'setblock': { if (parts.length < 5) { err('Usage: /setblock <x> <y> <z> <block>'); break; } const x = Math.floor(rel(parts[1], p.x)), y = Math.floor(rel(parts[2], p.y)), z = Math.floor(rel(parts[3], p.z)); const st = g.registry.parseState(parts.slice(4).join(' ')); if (!st && parts[4] !== 'air' && parts[4] !== 'minecraft:air') { err(`Unknown block '${parts[4]}'`); break; } g.world.setBlock(x, y, z, st); say(`Changed the block at ${x}, ${y}, ${z}`); break; }
    case 'fill': { if (parts.length < 8) { err('Usage: /fill <x1> <y1> <z1> <x2> <y2> <z2> <block>'); break; } const c = parts.slice(1, 7).map((s, i) => Math.floor(rel(s, [p.x, p.y, p.z][i % 3]))); const st = g.registry.parseState(parts.slice(7).join(' ')); const [x0, x1] = [Math.min(c[0], c[3]), Math.max(c[0], c[3])], [y0, y1] = [Math.min(c[1], c[4]), Math.max(c[1], c[4])], [z0, z1] = [Math.min(c[2], c[5]), Math.max(c[2], c[5])]; if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 32768) { err('Too many blocks in the specified area'); break; } let n = 0; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (g.world.setBlock(x, y, z, st, 0)) n++; say(`Successfully filled ${n} blocks`); break; }
    case 'gamerule': { const rule = parts[1], val = parts[2]; if (!rule) { say('Rules: ' + Object.entries(g.rules).map(([k, v]) => `${k}=${v}`).join(', ')); break; } if (val === undefined) { say(`Gamerule ${rule} is currently set to: ${(g.rules as any)[rule]}`); break; } (g.rules as any)[rule] = val === 'true' ? true : val === 'false' ? false : (parseInt(val) || val); say(`Gamerule ${rule} is now set to: ${val}`); break; }
    case 'spawnpoint': case 'setworldspawn': { p.setSpawn(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), true); if (cmd === 'setworldspawn') g.worldSpawn = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]; say(`Set spawn point to ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`); break; }
    case 'say': say(`[${p.name}] ${parts.slice(1).join(' ')}`); break;
    case 'me': say(`* ${p.name} ${parts.slice(1).join(' ')}`); break;
    case 'locate': { const name = (parts[2] ?? parts[1] ?? '').replace('minecraft:', ''); const bi = BIOMES.findIndex((b) => b.name === name); if (bi < 0) { err(`Unknown biome '${name}'`); break; } let found: [number, number] | null = null; for (let r = 0; r <= 1024 && !found; r += 32) for (let a = 0; a < 16 && !found; a++) { const x = Math.floor(p.x + Math.cos(a / 8 * Math.PI) * r), z = Math.floor(p.z + Math.sin(a / 8 * Math.PI) * r); if (g.world.isLoaded(x, z) ? g.world.getBiome(x, z) === bi : false) found = [x, z]; } if (found) say(`The nearest ${name} is at [${found[0]}, ~, ${found[1]}] (${Math.round(Math.hypot(found[0] - p.x, found[1] - p.z))} blocks away)`); else say(`Could not find ${name} within loaded chunks`); break; }
    case 'enchant': { const id = (parts[2] ?? parts[1] ?? '').replace('minecraft:', ''); const lvl = parseInt(parts[3] ?? parts[2] ?? '1') || 1; const held = p.heldItem(); if (!held) { err('No item in hand'); break; } const ex = held.enchantments.find((e) => e.id === id); if (ex) ex.level = lvl; else held.enchantments.push({ id, level: lvl }); say(`Applied enchantment ${id} to Player's item`); break; }
    case 'daylock': g.rules.doDaylightCycle = parts[1] !== 'false' ? false : true; say(`Daylight cycle ${g.rules.doDaylightCycle ? 'enabled' : 'locked'}`); break;
    default: err(`Unknown command: ${cmd}. Type /help for a list.`);
  }
}
