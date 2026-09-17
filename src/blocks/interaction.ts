// Right-click block interactions.
import type { Game } from '../game/game';
import type { Player } from '../entity/player';
import { ItemStack } from '../items/stack';
import { facingOffset, oppositeFacing, rotateY, rotateYCCW } from './placement';
import { SET_UPDATE_NEIGHBORS } from '../world/world';

const NOTE_INSTRUMENTS: Record<string, string> = { harp: 'harp', bass: 'bass', snare: 'snare', hat: 'hat', basedrum: 'basedrum', bell: 'bell', flute: 'flute', chime: 'chime', guitar: 'guitar', xylophone: 'xylophone', iron_xylophone: 'iron_xylophone', cow_bell: 'cow_bell', didgeridoo: 'didgeridoo', bit: 'bit', banjo: 'banjo', pling: 'pling' };

export function useBlock(game: Game, x: number, y: number, z: number, state: number, face: number, hit: [number, number, number], player: Player): boolean {
  const reg = game.registry, world = game.world;
  const b = reg.block(state);
  const n = b.name;
  const props = reg.getProps(state);
  const held = player.heldItem();
  const sounds = game.sounds;

  // doors
  if (n.endsWith('_door') && n !== 'iron_door') {
    const open = props.open !== 'true';
    const other = props.half === 'lower' ? y + 1 : y - 1;
    world.setBlock(x, y, z, reg.withProp(state, 'open', String(open)));
    const os = world.getBlock(x, other, z);
    if (os !== 0 && reg.block(os) === b) world.setBlock(x, other, z, reg.withProp(os, 'open', String(open)));
    sounds.playAt(doorSound(n, open), x + 0.5, y + 0.5, z + 0.5, 1, 0.9 + Math.random() * 0.1);
    return true;
  }
  if (n.endsWith('_trapdoor') && n !== 'iron_trapdoor') {
    const open = props.open !== 'true';
    world.setBlock(x, y, z, reg.withProp(state, 'open', String(open)));
    sounds.playAt(doorSound(n, open, true), x + 0.5, y + 0.5, z + 0.5, 1, 0.9 + Math.random() * 0.1);
    return true;
  }
  if (n.endsWith('_fence_gate')) {
    const open = props.open !== 'true';
    let s = reg.withProp(state, 'open', String(open));
    if (open) {
      // gate opens away from the player
      const pf = player.horizontalFacing();
      if (props.facing === oppositeFacing(pf)) s = reg.withProp(s, 'facing', pf);
    }
    world.setBlock(x, y, z, s);
    sounds.playAt(open ? 'block.fence_gate.open' : 'block.fence_gate.close', x + 0.5, y + 0.5, z + 0.5, 1, 0.9 + Math.random() * 0.1);
    return true;
  }
  if (n === 'lever') {
    const powered = props.powered !== 'true';
    world.setBlock(x, y, z, reg.withProp(state, 'powered', String(powered)));
    sounds.playAt('block.lever.click', x + 0.5, y + 0.5, z + 0.5, 0.3, powered ? 0.6 : 0.5);
    game.redstone.sourceChanged(x, y, z);
    return true;
  }
  if (n.endsWith('_button')) {
    if (props.powered === 'true') return true;
    world.setBlock(x, y, z, reg.withProp(state, 'powered', 'true'));
    sounds.playAt(n.includes('stone') || n.includes('polished') ? 'block.stone_button.click_on' : 'block.wooden_button.click_on', x + 0.5, y + 0.5, z + 0.5, 0.3, 0.6);
    world.scheduleTick(x, y, z, n.includes('stone') || n.includes('polished') || n.includes('blackstone') ? 20 : 30);
    game.redstone.sourceChanged(x, y, z);
    return true;
  }
  if (n === 'repeater') {
    const d = (+props.delay % 4) + 1;
    world.setBlock(x, y, z, reg.withProp(state, 'delay', String(d)));
    sounds.playAt('block.lever.click', x + 0.5, y + 0.5, z + 0.5, 0.3, 0.5);
    return true;
  }
  if (n === 'comparator') {
    const mode = props.mode === 'compare' ? 'subtract' : 'compare';
    world.setBlock(x, y, z, reg.withProp(state, 'mode', mode));
    sounds.playAt('block.comparator.click', x + 0.5, y + 0.5, z + 0.5, 0.3, mode === 'subtract' ? 0.55 : 0.5);
    game.redstone.sourceChanged(x, y, z);
    return true;
  }
  if (n === 'daylight_detector') {
    world.setBlock(x, y, z, reg.withProp(state, 'inverted', String(props.inverted !== 'true')));
    game.redstone.sourceChanged(x, y, z);
    return true;
  }
  if (n === 'note_block') {
    const note = (+props.note + 1) % 25;
    world.setBlock(x, y, z, reg.withProp(state, 'note', String(note)));
    playNote(game, x, y, z, reg.withProp(state, 'note', String(note)));
    return true;
  }
  // containers / workstations
  if (n === 'crafting_table') { game.gui.openCrafting(); return true; }
  if (n === 'chest' || n === 'trapped_chest' || n.endsWith('copper_chest')) { openChest(game, x, y, z, state, player); return true; }
  if (n === 'ender_chest') { game.gui.openContainer(player.enderChest, 'container.enderchest', 3); sounds.playAt('block.ender_chest.open', x + 0.5, y + 0.5, z + 0.5, 0.5, 1); return true; }
  if (n === 'barrel') { const be = game.blockEntities.getOrCreate(x, y, z, 'barrel', () => ({ items: 27 })); game.gui.openContainer(be.inventory, 'container.barrel', 3, () => { world.setBlock(x, y, z, reg.withProp(world.getBlock(x, y, z), 'open', 'false')); sounds.playAt('block.barrel.close', x + 0.5, y + 0.5, z + 0.5, 0.5, 1); }); world.setBlock(x, y, z, reg.withProp(state, 'open', 'true')); sounds.playAt('block.barrel.open', x + 0.5, y + 0.5, z + 0.5, 0.5, 1); return true; }
  if (n.endsWith('shulker_box')) { const be = game.blockEntities.getOrCreate(x, y, z, 'shulker_box', () => ({ items: 27 })); game.gui.openContainer(be.inventory, 'container.shulkerBox', 3, () => sounds.playAt('block.shulker_box.close', x + 0.5, y + 0.5, z + 0.5, 0.5, 1)); sounds.playAt('block.shulker_box.open', x + 0.5, y + 0.5, z + 0.5, 0.5, 1); return true; }
  if (n === 'furnace' || n === 'blast_furnace' || n === 'smoker') { const be = game.blockEntities.getOrCreate(x, y, z, n, () => ({ items: 3 })); game.gui.openFurnace(be, n); return true; }
  if (n === 'dispenser' || n === 'dropper') { const be = game.blockEntities.getOrCreate(x, y, z, n, () => ({ items: 9 })); game.gui.openContainer(be.inventory, 'container.' + n, 3, undefined, 3); return true; }
  if (n === 'hopper') { const be = game.blockEntities.getOrCreate(x, y, z, 'hopper', () => ({ items: 5 })); game.gui.openContainer(be.inventory, 'container.hopper', 1, undefined, 5); return true; }
  if (n === 'stonecutter') { game.gui.openStonecutter(); return true; }
  if (n === 'smithing_table') { game.gui.openSmithing(); return true; }
  if (n === 'anvil' || n === 'chipped_anvil' || n === 'damaged_anvil') { game.gui.openAnvil(); return true; }
  if (n === 'enchanting_table') { game.gui.openEnchanting(x, y, z); return true; }
  if (n === 'grindstone') { game.gui.openGrindstone(); return true; }
  if (n === 'brewing_stand') { const be = game.blockEntities.getOrCreate(x, y, z, 'brewing_stand', () => ({ items: 5 })); game.gui.openBrewing(be); return true; }
  if (n === 'loom' || n === 'cartography_table' || n === 'fletching_table') { game.gui.openCrafting(); return true; }
  // beds
  if (n.endsWith('_bed')) { player.trySleep(x, y, z, state); return true; }
  // jukebox
  if (n === 'jukebox') {
    const be = game.blockEntities.get(x, y, z);
    if (be && be.record) {
      game.dropItem(x + 0.5, y + 1, z + 0.5, ItemStack.deserialize(be.record, game.items)!);
      be.record = null; world.setBlock(x, y, z, reg.withProp(state, 'has_record', 'false'));
      game.sounds.stopRecord(x, y, z);
      return true;
    }
    if (held && held.item.name.startsWith('music_disc_')) {
      const b2 = game.blockEntities.getOrCreate(x, y, z, 'jukebox', () => ({}));
      b2.record = held.serialize();
      world.setBlock(x, y, z, reg.withProp(state, 'has_record', 'true'));
      game.sounds.playRecord(held.item.name, x, y, z);
      game.gui.showActionBar(game.assets.lang['record.nowPlaying']?.replace('%s', game.assets.lang['jukebox_song.minecraft.' + held.item.name.replace('music_disc_', '')] ?? held.item.name) ?? 'Now playing');
      if (!player.isCreative) held.count--;
      player.inventory.onChange?.();
      return true;
    }
    return false;
  }
  // cake
  if (n === 'cake') {
    if (!player.canEat(false)) return false;
    player.eatFood(2, 0.4);
    const bites = +props.bites + 1;
    if (bites >= 7) world.setBlock(x, y, z, 0); else world.setBlock(x, y, z, reg.withProp(state, 'bites', String(bites)));
    return true;
  }
  // flower pot
  if (n === 'flower_pot' && held) {
    const potted = reg.blockByName('potted_' + held.item.name);
    if (potted) { world.setBlock(x, y, z, potted.defaultState); if (!player.isCreative) held.count--; player.inventory.onChange?.(); return true; }
    return false;
  }
  if (n.startsWith('potted_')) {
    const plant = game.items.get(n.slice(7));
    if (plant) player.give(new ItemStack(plant, 1));
    world.setBlock(x, y, z, reg.defaultState('flower_pot'));
    return true;
  }
  // composter
  if (n === 'composter') {
    const level = +props.level;
    if (level === 8) { player.give(new ItemStack(game.items.get('bone_meal')!, 1)); world.setBlock(x, y, z, reg.withProp(state, 'level', '0')); sounds.playAt('block.composter.empty', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
    if (held && level < 7) {
      const chance = COMPOST[held.item.name];
      if (chance) {
        if (!player.isCreative) held.count--; player.inventory.onChange?.();
        if (Math.random() < chance) { world.setBlock(x, y, z, reg.withProp(state, 'level', String(level + 1))); sounds.playAt('block.composter.fill_success', x + 0.5, y + 0.5, z + 0.5, 1, 1); if (level + 1 === 7) world.scheduleTick(x, y, z, 20); }
        else sounds.playAt('block.composter.fill', x + 0.5, y + 0.5, z + 0.5, 1, 1);
        return true;
      }
    }
    return false;
  }
  // cauldron
  if (n === 'cauldron' && held?.item.name === 'water_bucket') { world.setBlock(x, y, z, reg.stateWith(reg.blockByName('water_cauldron')!, { level: '3' })); player.replaceHeld(new ItemStack(game.items.get('bucket')!, 1)); sounds.playAt('item.bucket.empty', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
  if (n === 'cauldron' && held?.item.name === 'lava_bucket') { world.setBlock(x, y, z, reg.defaultState('lava_cauldron')); player.replaceHeld(new ItemStack(game.items.get('bucket')!, 1)); sounds.playAt('item.bucket.empty_lava', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
  if (n === 'water_cauldron' && held) {
    if (held.item.name === 'bucket' && props.level === '3') { world.setBlock(x, y, z, reg.defaultState('cauldron')); player.replaceHeld(new ItemStack(game.items.get('water_bucket')!, 1)); sounds.playAt('item.bucket.fill', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
    if (held.item.name === 'glass_bottle') { const lv = +props.level; world.setBlock(x, y, z, lv > 1 ? reg.withProp(state, 'level', String(lv - 1)) : reg.defaultState('cauldron')); if (!player.isCreative) held.count--; player.give(new ItemStack(game.items.get('potion')!, 1, 0, [], null, { potion: 'water' })); sounds.playAt('item.bottle.fill', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
    if (held.item.name === 'potion' && held.extra.potion === 'water' && props.level !== '3') { world.setBlock(x, y, z, reg.withProp(state, 'level', String(+props.level + 1))); player.replaceHeld(new ItemStack(game.items.get('glass_bottle')!, 1)); sounds.playAt('item.bottle.empty', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
  }
  if (n === 'lava_cauldron' && held?.item.name === 'bucket') { world.setBlock(x, y, z, reg.defaultState('cauldron')); player.replaceHeld(new ItemStack(game.items.get('lava_bucket')!, 1)); sounds.playAt('item.bucket.fill_lava', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
  // bell
  if (n === 'bell') { sounds.playAt('block.bell.use', x + 0.5, y + 0.5, z + 0.5, 2, 1); game.blockEntities.getOrCreate(x, y, z, 'bell', () => ({})).ringTicks = 50; return true; }
  // berries
  if (n === 'sweet_berry_bush') {
    const age = +props.age;
    if (age > 1) {
      const count = 1 + Math.floor(Math.random() * 2) + (age === 3 ? 1 : 0);
      game.dropItem(x + 0.5, y + 0.5, z + 0.5, new ItemStack(game.items.get('sweet_berries')!, count));
      world.setBlock(x, y, z, reg.withProp(state, 'age', '1'));
      sounds.playAt('block.sweet_berry_bush.pick_berries', x + 0.5, y + 0.5, z + 0.5, 1, 0.8 + Math.random() * 0.4);
      return true;
    }
    return false;
  }
  if ((n === 'cave_vines' || n === 'cave_vines_plant') && props.berries === 'true') {
    game.dropItem(x + 0.5, y + 0.5, z + 0.5, new ItemStack(game.items.get('glow_berries')!, 1));
    world.setBlock(x, y, z, reg.withProp(state, 'berries', 'false'));
    sounds.playAt('block.cave_vines.pick_berries', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    return true;
  }
  if (n === 'dragon_egg') {
    for (let i = 0; i < 16; i++) {
      const tx = x + Math.floor(Math.random() * 16) - 8, ty = Math.min(319, Math.max(-64, y + Math.floor(Math.random() * 8) - 4)), tz = z + Math.floor(Math.random() * 16) - 8;
      if (world.getBlock(tx, ty, tz) === 0) { world.setBlock(x, y, z, 0); world.setBlock(tx, ty, tz, state); return true; }
    }
    return true;
  }
  if (n === 'campfire' || n === 'soul_campfire') {
    if (props.lit === 'true' && held && game.recipes.cookingFor(held, 'campfire_cooking')) {
      const be = game.blockEntities.getOrCreate(x, y, z, 'campfire', () => ({ items: 4 }));
      for (let i = 0; i < 4; i++) if (!be.inventory.get(i)) { be.inventory.set(i, held.split(1)); be.cookTimes = be.cookTimes ?? [0, 0, 0, 0]; be.cookTimes[i] = 0; player.inventory.onChange?.(); sounds.playAt('block.campfire.crackle', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
    }
    return false;
  }
  if (n === 'lectern' || n.endsWith('_sign') || n.endsWith('_hanging_sign') || n === 'chiseled_bookshelf' || n === 'beehive' || n === 'bee_nest' || n === 'respawn_anchor' || n === 'end_portal_frame' || n === 'lodestone' || n === 'decorated_pot' || n === 'crafter' || n === 'vault') {
    if (n === 'respawn_anchor') { if (held?.item.name === 'glowstone' && +props.charges < 4) { world.setBlock(x, y, z, reg.withProp(state, 'charges', String(+props.charges + 1))); if (!player.isCreative) held.count--; sounds.playAt('block.respawn_anchor.charge', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; } if (+props.charges > 0) { if (world.dimension === 'the_nether') { player.setSpawn(x, y + 1, z, true); game.gui.showActionBar('Respawn point set'); sounds.playAt('block.respawn_anchor.set_spawn', x + 0.5, y + 0.5, z + 0.5, 1, 1); } else { game.explode(x + 0.5, y + 0.5, z + 0.5, 5, true); } return true; } }
    if (n === 'end_portal_frame' && held?.item.name === 'ender_eye' && props.eye === 'false') { world.setBlock(x, y, z, reg.withProp(state, 'eye', 'true')); if (!player.isCreative) held.count--; sounds.playAt('block.end_portal_frame.fill', x + 0.5, y + 0.5, z + 0.5, 1, 1); game.blocks.checkEndPortal(x, y, z); return true; }
    if (n === 'decorated_pot') { sounds.playAt('block.decorated_pot.insert_fail', x + 0.5, y + 0.5, z + 0.5, 1, 1); return true; }
    return false;
  }
  if (n === 'tnt' && held?.item.name === 'flint_and_steel') return false; // handled by item use
  return false;
}

function doorSound(name: string, open: boolean, trapdoor = false): string {
  const wood = !(name.includes('iron') || name.includes('copper'));
  const kind = name.includes('bamboo') ? 'bamboo_wood' : name.includes('cherry') ? 'cherry_wood' : name.includes('crimson') || name.includes('warped') ? 'nether_wood' : wood ? 'wooden' : name.includes('copper') ? 'copper' : 'iron';
  if (trapdoor) return `block.${kind === 'wooden' ? 'wooden' : kind}_trapdoor.${open ? 'open' : 'close'}`;
  return `block.${kind === 'wooden' ? 'wooden' : kind}_door.${open ? 'open' : 'close'}`;
}

export function openChest(game: Game, x: number, y: number, z: number, state: number, _player: Player): void {
  const reg = game.registry, world = game.world;
  const props = reg.getProps(state);
  const n = reg.nameOf(state);
  const be = game.blockEntities.getOrCreate(x, y, z, 'chest', () => ({ items: 27 }));
  const openSound = n === 'ender_chest' ? 'block.ender_chest.open' : n.includes('copper') ? 'block.copper_chest.open' : 'block.chest.open';
  const closeSound = openSound.replace('open', 'close');
  if (props.type === 'single') {
    game.gui.openContainer(be.inventory, n === 'trapped_chest' ? 'container.chest' : 'container.chest', 3, () => { game.sounds.playAt(closeSound, x + 0.5, y + 0.5, z + 0.5, 0.5, 0.9 + Math.random() * 0.1); game.blockEntities.setOpen(x, y, z, false); });
  } else {
    const f = props.facing;
    const dir = props.type === 'left' ? rotateY(f) : rotateYCCW(f);
    const [dx, , dz] = facingOffset(dir);
    const other = game.blockEntities.getOrCreate(x + dx, y, z + dz, 'chest', () => ({ items: 27 }));
    const first = props.type === 'right' ? be : other, second = props.type === 'right' ? other : be;
    const combined = game.blockEntities.combined(first, second);
    game.gui.openContainer(combined, 'container.chestDouble', 6, () => { game.sounds.playAt(closeSound, x + 0.5, y + 0.5, z + 0.5, 0.5, 0.9 + Math.random() * 0.1); game.blockEntities.setOpen(x, y, z, false); game.blockEntities.setOpen(x + dx, y, z + dz, false); });
    game.blockEntities.setOpen(x + dx, y, z + dz, true);
  }
  game.blockEntities.setOpen(x, y, z, true);
  game.sounds.playAt(openSound, x + 0.5, y + 0.5, z + 0.5, 0.5, 0.9 + Math.random() * 0.1);
  if (n === 'trapped_chest') { game.redstone.sourceChanged(x, y, z); }
  void world; void SET_UPDATE_NEIGHBORS;
}

export function playNote(game: Game, x: number, y: number, z: number, state: number): void {
  const reg = game.registry;
  const props = reg.getProps(state);
  const inst = NOTE_INSTRUMENTS[props.instrument] ?? 'harp';
  const note = +props.note;
  const pitch = Math.pow(2, (note - 12) / 12);
  game.sounds.playAt('block.note_block.' + inst, x + 0.5, y + 0.5, z + 0.5, 3, pitch);
  game.particles.spawnNote(x + 0.5, y + 1.2, z + 0.5, note / 24);
}

const COMPOST: Record<string, number> = {
  beetroot_seeds: 0.3, dried_kelp: 0.3, short_grass: 0.3, glow_berries: 0.3, kelp: 0.3, melon_seeds: 0.3, pumpkin_seeds: 0.3, seagrass: 0.3, sweet_berries: 0.3, wheat_seeds: 0.3, moss_carpet: 0.3, pink_petals: 0.3, small_dripleaf: 0.3, hanging_roots: 0.3, mangrove_roots: 0.3, torchflower_seeds: 0.3, pitcher_pod: 0.3, leaf_litter: 0.3, bush: 0.3,
  dried_kelp_block: 0.5, tall_grass: 0.5, flowering_azalea_leaves: 0.5, cactus: 0.5, sugar_cane: 0.5, vine: 0.5, nether_sprouts: 0.5, weeping_vines: 0.5, twisting_vines: 0.5, melon_slice: 0.5, glow_lichen: 0.5, wildflowers: 0.5, firefly_bush: 0.5,
  apple: 0.65, beetroot: 0.65, carrot: 0.65, cocoa_beans: 0.65, potato: 0.65, wheat: 0.65, brown_mushroom: 0.65, red_mushroom: 0.65, mushroom_stem: 0.65, crimson_fungus: 0.65, warped_fungus: 0.65, nether_wart: 0.65, crimson_roots: 0.65, warped_roots: 0.65, shroomlight: 0.65, dandelion: 0.65, poppy: 0.65, blue_orchid: 0.65, allium: 0.65, azure_bluet: 0.65, red_tulip: 0.65, orange_tulip: 0.65, white_tulip: 0.65, pink_tulip: 0.65, oxeye_daisy: 0.65, cornflower: 0.65, lily_of_the_valley: 0.65, wither_rose: 0.65, fern: 0.65, sunflower: 0.65, lilac: 0.65, rose_bush: 0.65, peony: 0.65, large_fern: 0.65, spore_blossom: 0.65, moss_block: 0.65, big_dripleaf: 0.65, sea_pickle: 0.65, lily_pad: 0.65, pumpkin: 0.65, carved_pumpkin: 0.65, melon: 0.65, torchflower: 0.65, pitcher_plant: 0.65,
  baked_potato: 0.85, bread: 0.85, cookie: 0.85, hay_block: 0.85, brown_mushroom_block: 0.85, red_mushroom_block: 0.85, nether_wart_block: 0.85, warped_wart_block: 0.85, flowering_azalea: 0.85, azalea: 0.85, cake: 1, pumpkin_pie: 1,
};
for (const n of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'azalea']) { COMPOST[n + '_leaves'] = 0.3; COMPOST[n + '_sapling'] = 0.3; }
