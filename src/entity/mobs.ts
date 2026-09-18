// Mobs: config-driven stats + AI behaviours.
import { LivingEntity, type EntityDamage } from './entity';
import { ArrowEntity, ThrownProjectile } from './misc';
import { ItemStack } from '../items/stack';
import { lookDir, wrapDegrees, clamp } from '../math';
import type { Player } from './player';
import { JOB_SITES, LEVEL_XP, MAX_LEVEL, offersForLevel, wanderingTraderOffers, type Trade } from './villagerTrades';

export interface MobDef {
  name: string;
  health: number;
  speed: number;
  damage: number;
  width: number; height: number;
  eye: number;
  category: 'hostile' | 'passive' | 'neutral' | 'water' | 'ambient';
  model: string;
  texture: string;
  sounds: { ambient?: string; hurt?: string; death?: string; step?: string };
  ai: Partial<{ melee: boolean; ranged: 'arrow' | 'fireball' | 'fire_charge' | 'snowball' | 'potion'; rangedInterval: number; creeper: boolean; enderman: boolean; flee: boolean; tempt: string[]; breed: string[]; water: boolean; fly: boolean; burnsInDay: boolean; undead: boolean; arthropod: boolean; climb: boolean; slime: boolean; chicken: boolean; sheep: boolean; teleport: boolean; noAI: boolean; wander: boolean; followRange: number; attackRange: number; neutral: boolean; spider: boolean; lightSensitive: boolean; lavaWalk: boolean; tameable: string[]; explodeOnDeath: boolean; ghast: boolean; phantom: boolean; golem: boolean; pack: boolean;
    /** vanilla goal speed modifiers (RandomStroll / Panic / Tempt / MeleeAttack), applied on top of the movement attribute */
    speeds: Partial<{ stroll: number; panic: number; tempt: number; attack: number }> }>;
  xp: number;
  loot?: string;
  fireImmune?: boolean;
  babyScale?: number;
}

const D = (name: string, health: number, speed: number, damage: number, w: number, h: number, category: MobDef['category'], model: string, texture: string, ai: MobDef['ai'], xp = 5, extra: Partial<MobDef> = {}): MobDef => ({
  name, health, speed, damage, width: w, height: h, eye: h * 0.85, category, model, texture,
  sounds: { ambient: `entity.${name}.ambient`, hurt: `entity.${name}.hurt`, death: `entity.${name}.death`, step: `entity.${name}.step` },
  ai: { wander: true, followRange: 16, attackRange: 2, ...ai }, xp, ...extra,
});

export const MOB_DEFS: Record<string, MobDef> = {
  zombie: D('zombie', 20, 0.23, 3, 0.6, 1.95, 'hostile', 'zombie', 'entity/zombie/zombie', { melee: true, burnsInDay: true, undead: true, followRange: 35 }, 5),
  husk: D('husk', 20, 0.23, 3, 0.6, 1.95, 'hostile', 'zombie', 'entity/zombie/husk', { melee: true, undead: true, followRange: 35 }, 5),
  drowned: D('drowned', 20, 0.23, 3, 0.6, 1.95, 'hostile', 'zombie', 'entity/zombie/drowned', { melee: true, undead: true, water: true, burnsInDay: true }, 5),
  zombie_villager: D('zombie_villager', 20, 0.23, 3, 0.6, 1.95, 'hostile', 'zombie', 'entity/zombie_villager/zombie_villager', { melee: true, burnsInDay: true, undead: true }, 5),
  skeleton: D('skeleton', 20, 0.25, 2, 0.6, 1.99, 'hostile', 'skeleton', 'entity/skeleton/skeleton', { ranged: 'arrow', rangedInterval: 40, burnsInDay: true, undead: true }, 5),
  stray: D('stray', 20, 0.25, 2, 0.6, 1.99, 'hostile', 'skeleton', 'entity/skeleton/stray', { ranged: 'arrow', rangedInterval: 40, burnsInDay: true, undead: true }, 5),
  bogged: D('bogged', 16, 0.25, 2, 0.6, 1.99, 'hostile', 'skeleton', 'entity/skeleton/bogged', { ranged: 'arrow', rangedInterval: 70, burnsInDay: true, undead: true }, 5),
  wither_skeleton: D('wither_skeleton', 20, 0.25, 8, 0.7, 2.4, 'hostile', 'skeleton', 'entity/skeleton/wither_skeleton', { melee: true, undead: true }, 5, { fireImmune: true }),
  creeper: D('creeper', 20, 0.25, 0, 0.6, 1.7, 'hostile', 'creeper', 'entity/creeper/creeper', { creeper: true, speeds: { stroll: 0.8 } }, 5),
  spider: D('spider', 16, 0.3, 2, 1.4, 0.9, 'hostile', 'spider', 'entity/spider/spider', { melee: true, arthropod: true, climb: true, spider: true, lightSensitive: true, speeds: { stroll: 0.8 } }, 5),
  cave_spider: D('cave_spider', 12, 0.3, 2, 0.7, 0.5, 'hostile', 'spider', 'entity/spider/cave_spider', { melee: true, arthropod: true, climb: true, spider: true, speeds: { stroll: 0.8 } }, 5),
  enderman: D('enderman', 40, 0.3, 7, 0.6, 2.9, 'neutral', 'enderman', 'entity/enderman/enderman', { melee: true, enderman: true, teleport: true, neutral: true, followRange: 64 }, 5),
  witch: D('witch', 26, 0.25, 0, 0.6, 1.95, 'hostile', 'villager', 'entity/witch/witch', { ranged: 'potion', rangedInterval: 60 }, 5),
  slime: D('slime', 16, 0.3, 4, 2.04, 2.04, 'hostile', 'slime', 'entity/slime/slime', { melee: true, slime: true }, 4),
  magma_cube: D('magma_cube', 16, 0.3, 6, 2.04, 2.04, 'hostile', 'magma_cube', 'entity/slime/magmacube', { melee: true, slime: true }, 4, { fireImmune: true }),
  phantom: D('phantom', 20, 0.3, 6, 0.9, 0.5, 'hostile', 'phantom', 'entity/phantom/phantom', { fly: true, phantom: true, burnsInDay: true, undead: true, melee: true }, 5),
  zombified_piglin: D('zombified_piglin', 20, 0.23, 5, 0.6, 1.95, 'neutral', 'piglin', 'entity/piglin/zombified_piglin', { melee: true, undead: true, neutral: true, pack: true }, 5, { fireImmune: true }),
  piglin: D('piglin', 16, 0.35, 5, 0.6, 1.95, 'hostile', 'piglin', 'entity/piglin/piglin', { melee: true }, 5, { fireImmune: true }),
  piglin_brute: D('piglin_brute', 50, 0.35, 7, 0.6, 1.95, 'hostile', 'piglin', 'entity/piglin/piglin_brute', { melee: true }, 20, { fireImmune: true }),
  hoglin: D('hoglin', 40, 0.3, 6, 1.4, 1.4, 'hostile', 'hoglin', 'entity/hoglin/hoglin', { melee: true }, 5),
  zoglin: D('zoglin', 40, 0.3, 6, 1.4, 1.4, 'hostile', 'hoglin', 'entity/hoglin/zoglin', { melee: true, undead: true }, 5),
  ghast: D('ghast', 10, 0.02, 0, 4, 4, 'hostile', 'ghast', 'entity/ghast/ghast', { fly: true, ghast: true, ranged: 'fireball', rangedInterval: 60, followRange: 64, attackRange: 64 }, 5, { fireImmune: true }),
  blaze: D('blaze', 20, 0.23, 6, 0.6, 1.8, 'hostile', 'blaze', 'entity/blaze/blaze', { fly: true, ranged: 'fire_charge', rangedInterval: 40, melee: true, followRange: 48, attackRange: 3 }, 10, { fireImmune: true }),
  strider: D('strider', 20, 0.175, 0, 0.9, 1.7, 'passive', 'strider', 'entity/strider/strider', { lavaWalk: true, tempt: ['warped_fungus'], breed: ['warped_fungus'] }, 2, { fireImmune: true }),
  pig: D('pig', 10, 0.25, 0, 0.9, 0.9, 'passive', 'pig', 'entity/pig/pig_temperate', { flee: true, tempt: ['carrot', 'potato', 'beetroot'], breed: ['carrot', 'potato', 'beetroot'], speeds: { panic: 1.25, tempt: 1.2 } }, 2),
  cow: D('cow', 10, 0.2, 0, 0.9, 1.4, 'passive', 'cow', 'entity/cow/cow_temperate', { flee: true, tempt: ['wheat'], breed: ['wheat'], speeds: { panic: 2, tempt: 1.25 } }, 2),
  mooshroom: D('mooshroom', 10, 0.2, 0, 0.9, 1.4, 'passive', 'cow', 'entity/cow/mooshroom_red', { flee: true, tempt: ['wheat'], breed: ['wheat'], speeds: { panic: 2, tempt: 1.25 } }, 2),
  sheep: D('sheep', 8, 0.23, 0, 0.9, 1.3, 'passive', 'sheep', 'entity/sheep/sheep', { flee: true, sheep: true, tempt: ['wheat'], breed: ['wheat'], speeds: { panic: 1.25, tempt: 1.1 } }, 2),
  chicken: D('chicken', 4, 0.25, 0, 0.4, 0.7, 'passive', 'chicken', 'entity/chicken/chicken_temperate', { flee: true, chicken: true, tempt: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'], breed: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'], speeds: { panic: 1.4 } }, 2),
  rabbit: D('rabbit', 3, 0.3, 0, 0.4, 0.5, 'passive', 'rabbit', 'entity/rabbit/rabbit_brown', { flee: true, tempt: ['carrot', 'golden_carrot', 'dandelion'], breed: ['carrot', 'golden_carrot', 'dandelion'], speeds: { stroll: 0.6, panic: 2.2 } }, 2),
  wolf: D('wolf', 8, 0.3, 4, 0.6, 0.85, 'neutral', 'wolf', 'entity/wolf/wolf', { melee: true, neutral: true, tameable: ['bone'], breed: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh'] }, 3),
  cat: D('cat', 10, 0.3, 3, 0.6, 0.7, 'passive', 'cat', 'entity/cat/cat_tabby', { flee: true, tameable: ['cod', 'salmon'], breed: ['cod', 'salmon'], speeds: { stroll: 0.8, tempt: 0.6, panic: 1.5 } }, 3),
  ocelot: D('ocelot', 10, 0.3, 3, 0.6, 0.7, 'passive', 'cat', 'entity/cat/ocelot', { flee: true, speeds: { stroll: 0.8, tempt: 0.6 } }, 3),
  fox: D('fox', 10, 0.3, 2, 0.6, 0.7, 'passive', 'fox', 'entity/fox/fox', { flee: true, breed: ['sweet_berries', 'glow_berries'], speeds: { panic: 2.2 } }, 3),
  horse: D('horse', 22, 0.225, 0, 1.4, 1.6, 'passive', 'horse', 'entity/horse/horse_brown', { flee: true, tempt: ['golden_apple', 'golden_carrot'], breed: ['golden_apple', 'golden_carrot'], speeds: { stroll: 0.7, panic: 1.2 } }, 2),
  donkey: D('donkey', 18, 0.175, 0, 1.4, 1.5, 'passive', 'horse', 'entity/horse/donkey', { flee: true, speeds: { stroll: 0.7, panic: 1.2 } }, 2),
  llama: D('llama', 22, 0.2, 1, 0.9, 1.87, 'neutral', 'llama', 'entity/llama/llama_creamy', { flee: true, tempt: ['hay_block'], breed: ['hay_block'], speeds: { stroll: 0.7, panic: 1.2 } }, 2),
  goat: D('goat', 10, 0.2, 2, 0.9, 1.3, 'neutral', 'goat', 'entity/goat/goat', { flee: true, breed: ['wheat'], speeds: { panic: 1.25, tempt: 1.25 } }, 2),
  panda: D('panda', 20, 0.15, 6, 1.3, 1.25, 'neutral', 'panda', 'entity/panda/panda', { flee: true, tempt: ['bamboo'], breed: ['bamboo'], speeds: { panic: 2 } }, 3),
  polar_bear: D('polar_bear', 30, 0.25, 6, 1.4, 1.4, 'neutral', 'polar_bear', 'entity/bear/polarbear', { melee: true, neutral: true, speeds: { attack: 1.25, panic: 2 } }, 5),
  parrot: D('parrot', 6, 0.2, 0, 0.5, 0.9, 'passive', 'parrot', 'entity/parrot/parrot_red_blue', { flee: true, fly: true, tameable: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'] }, 2),
  bee: D('bee', 10, 0.3, 2, 0.7, 0.6, 'neutral', 'bee', 'entity/bee/bee', { fly: true, neutral: true, melee: true, breed: ['dandelion', 'poppy'] }, 2),
  turtle: D('turtle', 30, 0.1, 0, 1.2, 0.4, 'passive', 'turtle', 'entity/turtle/turtle', { flee: true, water: true, breed: ['seagrass'], speeds: { panic: 1.2, tempt: 1.1 } }, 2),
  frog: D('frog', 10, 0.2, 0, 0.5, 0.5, 'passive', 'frog', 'entity/frog/frog_temperate', { flee: true, speeds: { panic: 2 } }, 2),
  armadillo: D('armadillo', 12, 0.14, 0, 0.7, 0.65, 'passive', 'armadillo', 'entity/armadillo/armadillo', { flee: true, tempt: ['spider_eye'], breed: ['spider_eye'], speeds: { panic: 2 } }, 2),
  camel: D('camel', 32, 0.09, 0, 1.7, 2.375, 'passive', 'camel', 'entity/camel/camel', { flee: true, tempt: ['cactus'], breed: ['cactus'], speeds: { stroll: 2, panic: 4, tempt: 3 } }, 2),
  sniffer: D('sniffer', 14, 0.1, 0, 1.9, 1.75, 'passive', 'sniffer', 'entity/sniffer/sniffer', { flee: true, breed: ['torchflower_seeds'], speeds: { panic: 2 } }, 2),
  axolotl: D('axolotl', 14, 0.2, 2, 0.75, 0.42, 'passive', 'axolotl', 'entity/axolotl/axolotl_lucy', { water: true }, 2),
  squid: D('squid', 10, 0.2, 0, 0.8, 0.8, 'water', 'squid', 'entity/squid/squid', { water: true, flee: true }, 2),
  glow_squid: D('glow_squid', 10, 0.2, 0, 0.8, 0.8, 'water', 'squid', 'entity/squid/glow_squid', { water: true, flee: true }, 2),
  cod: D('cod', 3, 0.7, 0, 0.5, 0.3, 'water', 'cod', 'entity/fish/cod', { water: true, flee: true }, 1),
  salmon: D('salmon', 3, 0.7, 0, 0.7, 0.4, 'water', 'salmon', 'entity/fish/salmon', { water: true, flee: true }, 1),
  tropical_fish: D('tropical_fish', 3, 0.7, 0, 0.5, 0.4, 'water', 'cod', 'entity/fish/tropical_a', { water: true, flee: true }, 1),
  pufferfish: D('pufferfish', 3, 0.7, 2, 0.7, 0.7, 'water', 'pufferfish', 'entity/fish/pufferfish', { water: true }, 1),
  dolphin: D('dolphin', 10, 1.2, 3, 0.9, 0.6, 'water', 'dolphin', 'entity/dolphin/dolphin', { water: true, neutral: true }, 1),
  guardian: D('guardian', 30, 0.5, 6, 0.85, 0.85, 'hostile', 'guardian', 'entity/guardian/guardian', { water: true, melee: true }, 10),
  bat: D('bat', 6, 0.3, 0, 0.5, 0.9, 'ambient', 'bat', 'entity/bat/bat', { fly: true }, 0),
  villager: D('villager', 20, 0.5, 0, 0.6, 1.95, 'passive', 'villager', 'entity/villager/villager', { flee: true, speeds: { stroll: 0.6, panic: 0.5 } }, 0),
  wandering_trader: D('wandering_trader', 20, 0.5, 0, 0.6, 1.95, 'passive', 'villager', 'entity/wandering_trader/wandering_trader', { flee: true, speeds: { stroll: 0.6, panic: 0.5 } }, 0),
  iron_golem: D('iron_golem', 100, 0.25, 15, 1.4, 2.7, 'neutral', 'iron_golem', 'entity/iron_golem/iron_golem', { melee: true, golem: true, followRange: 16, speeds: { stroll: 0.6 } }, 0),
  snow_golem: D('snow_golem', 4, 0.2, 0, 0.7, 1.9, 'neutral', 'snow_golem', 'entity/snow_golem/snow_golem', { ranged: 'snowball', rangedInterval: 20, golem: true, speeds: { attack: 1.25 } }, 0),
  pillager: D('pillager', 24, 0.35, 5, 0.6, 1.95, 'hostile', 'villager', 'entity/illager/pillager', { ranged: 'arrow', rangedInterval: 30, speeds: { stroll: 0.6 } }, 5),
  vindicator: D('vindicator', 24, 0.35, 5, 0.6, 1.95, 'hostile', 'villager', 'entity/illager/vindicator', { melee: true, speeds: { stroll: 0.6 } }, 5),
  evoker: D('evoker', 24, 0.5, 6, 0.6, 1.95, 'hostile', 'villager', 'entity/illager/evoker', { melee: true, speeds: { stroll: 0.6 } }, 10),
  silverfish: D('silverfish', 8, 0.25, 1, 0.4, 0.3, 'hostile', 'silverfish', 'entity/silverfish/silverfish', { melee: true, arthropod: true }, 5),
  endermite: D('endermite', 8, 0.25, 2, 0.4, 0.3, 'hostile', 'silverfish', 'entity/endermite/endermite', { melee: true, arthropod: true }, 3),
  shulker: D('shulker', 30, 0, 4, 1, 1, 'hostile', 'shulker', 'entity/shulker/shulker', { noAI: true }, 5),
  vex: D('vex', 14, 0.7, 9, 0.4, 0.8, 'hostile', 'vex', 'entity/illager/vex', { fly: true, melee: true }, 3),
  ravager: D('ravager', 100, 0.3, 12, 1.95, 2.2, 'hostile', 'ravager', 'entity/illager/ravager', { melee: true, speeds: { stroll: 0.4 } }, 20),
  warden: D('warden', 500, 0.3, 30, 0.9, 2.9, 'hostile', 'warden', 'entity/warden/warden', { melee: true, followRange: 24, speeds: { attack: 1.2 } }, 5),
  breeze: D('breeze', 30, 0.6, 0, 0.6, 1.77, 'hostile', 'breeze', 'entity/breeze/breeze', { ranged: 'snowball', rangedInterval: 40 }, 10),
  creaking: D('creaking', 1, 0.4, 3, 0.9, 2.7, 'hostile', 'creaking', 'entity/creaking/creaking', { melee: true }, 0),
  wither: D('wither', 300, 0.6, 8, 0.9, 3.5, 'hostile', 'wither', 'entity/wither/wither', { fly: true, ranged: 'fireball', rangedInterval: 30, followRange: 64, attackRange: 64 }, 50, { fireImmune: true }),
  ender_dragon: D('ender_dragon', 200, 0.5, 10, 16, 8, 'hostile', 'dragon', 'entity/enderdragon/dragon', { fly: true, melee: true, followRange: 128 }, 500, { fireImmune: true }),
};

const WOOL_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

export class Mob extends LivingEntity {
  type: string;
  isMob = true;
  def: MobDef;
  hostile: boolean;
  undead: boolean; arthropod: boolean;
  // ai state
  target: LivingEntity | null = null;
  wanderTarget: [number, number, number] | null = null;
  wanderTimer = 0;
  lookTimer = 0;
  panicTicks = 0;
  angerTicks = 0;
  attackTicks = 0;
  rangedTicks = 0;
  fuse = -1; // creeper
  ignited = false;
  loveTicks = 0;
  growAge = 0;      // negative = baby (ticks until adult)
  breedCooldown = 0;
  eggTimer = 6000 + Math.floor(Math.random() * 6000);
  sheared = false; woolColor = 'white';
  eatTimer = 0;
  slimeSize = 1;
  jumpDelay = 0;
  tamed = false; ownerUuid: string | null = null; sitting = false;
  swellDir = 0; swell = 0; prevSwell = 0;
  ambientTimer = 0;
  despawnCheck = 0;
  persistent = false;
  variant = 0;
  saddled = false;
  leashed = false;
  teleportCooldown = 0;
  stareTicks = 0;
  screaming = false;
  private flyTarget: [number, number, number] | null = null;
  carriedBlock = 0;
  charged = false;
  attackAnim = 0;
  head = { yaw: 0, pitch: 0 };
  // villagers / zombie villagers (vanilla VillagerData)
  profession = 'none'; villagerType = 'plains'; villagerLevel = 1; villagerXp = 0;
  trades: Trade[] | null = null;
  jobSite: [number, number, number] | null = null;
  lastRestockDay = -1;
  /** vanilla "unhappy" head shake ticks */
  headShake = 0;
  /** zombie villager being cured: ticks left */
  conversionTime = -1;

  constructor(def: MobDef) {
    super();
    this.def = def; this.type = def.name;
    this.width = def.width; this.height = def.height; this.eyeHeight = def.eye;
    this.maxHealth = def.health; this.health = def.health;
    this.speed = def.speed;
    this.hostile = def.category === 'hostile';
    this.undead = !!def.ai.undead; this.arthropod = !!def.ai.arthropod;
    if (def.name === 'rabbit') this.variant = Math.floor(Math.random() * 6);
    if (def.ai.sheep) this.woolColor = Math.random() < 0.82 ? 'white' : Math.random() < 0.6 ? 'black' : Math.random() < 0.5 ? 'gray' : Math.random() < 0.5 ? 'light_gray' : Math.random() < 0.5 ? 'brown' : 'pink';
    if (def.ai.slime) this.setSlimeSize([1, 2, 4][Math.floor(Math.random() * 3)]);
    this.noGravity = !!def.ai.fly && !def.ai.phantom;
  }

  setSlimeSize(size: number): void {
    this.slimeSize = size;
    this.width = 0.51 * size; this.height = 0.51 * size; this.eyeHeight = this.height * 0.6;
    this.maxHealth = size * size; this.health = this.maxHealth;
    this.speed = 0.2 + 0.1 * size;
    this.updateBB();
  }
  /** 0..1 through the current hop (vanilla Rabbit.getJumpCompletion). */
  jumpProgress(partial: number): number { return this.onGround ? 0 : Math.min(1, (this.jumpTicksTotal - (this.jumpTicks - partial)) / Math.max(1, this.jumpTicksTotal)); }
  jumpTicksTotal = 10;

  setBaby(baby: boolean): void {
    this.isBaby = baby; this.growAge = baby ? -24000 : 0;
    const sc = baby ? 0.5 : 1; this.width = this.def.width * sc; this.height = this.def.height * sc; this.eyeHeight = this.def.eye * sc; this.updateBB();
    // vanilla Zombie.SPEED_MODIFIER_BABY: +50% movement speed for baby zombies only
    this.speed = this.def.speed * (baby && this.def.model === 'zombie' ? 1.5 : 1);
  }

  isFireImmune(): boolean { return !!this.def.fireImmune; }
  canBreatheUnderwater(): boolean { return !!this.def.ai.water || this.undead; }
  knockbackResistance(): number { return this.def.ai.golem || this.type === 'ravager' || this.type === 'warden' ? 1 : this.type === 'hoglin' || this.type === 'zoglin' ? 0.6 : 0; }
  armorValue(): number { return this.type === 'zombie' && this.isBaby ? 0 : this.type === 'zombie' || this.type === 'husk' || this.type === 'drowned' ? 2 : this.type === 'skeleton' ? 0 : this.type === 'hoglin' ? 0 : 0; }

  /** Nearest player (host or remote) — mobs target and follow whoever is closest. */
  private get player(): Player | null { return this.game.nearestPlayer(this.x, this.y, this.z); }

  get isVillager(): boolean { return this.type === 'villager'; }
  get isZombieVillager(): boolean { return this.type === 'zombie_villager'; }
  setVillagerData(profession: string, villagerType: string, level = 1): void {
    if (this.profession !== profession || this.villagerLevel !== level) this.trades = null;
    this.profession = profession; this.villagerType = villagerType; this.villagerLevel = Math.max(1, Math.min(MAX_LEVEL, level));
  }
  /** Offers, generated on first use (two per level, vanilla VillagerTrades). */
  ensureTrades(): Trade[] {
    if (this.trades) return this.trades;
    const g = this.game, items = g.items;
    const rnd = Math.random;
    if (this.type === 'wandering_trader') return (this.trades = wanderingTraderOffers(rnd, items));
    const out: Trade[] = [];
    if (this.profession !== 'none' && this.profession !== 'nitwit') for (let lv = 1; lv <= this.villagerLevel; lv++) out.push(...offersForLevel(this.profession, lv, rnd, items, g.tradeContext(this.villagerType)));
    return (this.trades = out);
  }
  /** Called by the trading screen after a successful trade. */
  onTraded(t: Trade): void {
    t.uses++;
    this.villagerXp += t.xp;
    const g = this.game;
    if (this.isVillager && this.villagerLevel < MAX_LEVEL && this.villagerXp >= LEVEL_XP[this.villagerLevel]) {
      this.villagerLevel++;
      this.trades!.push(...offersForLevel(this.profession, this.villagerLevel, Math.random, g.items, g.tradeContext(this.villagerType)));
      g.sounds.playAt('entity.villager.yes', this.x, this.y, this.z, 1, 1);
      g.particles.spawnHappyVillager(this.x, this.y + this.height, this.z, 5);
    }
  }
  /** Villager job hunting (claims a free job-site block nearby), losing a job whose block is gone, and daily restocks. */
  private villagerTick(): void {
    const g = this.game, world = this.world, reg = world.registry;
    if (this.age % 100 !== 0 || this.isBaby) return;
    const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z);
    if (this.jobSite) {
      const [jx, jy, jz] = this.jobSite;
      const st = world.getBlock(jx, jy, jz);
      const prof = st ? JOB_SITES[reg.nameOf(st)] : undefined;
      if (prof !== this.profession) { this.jobSite = null; if (this.villagerXp === 0) { this.profession = 'none'; this.trades = null; } }
    }
    if (!this.jobSite && this.profession !== 'nitwit') {
      // vanilla AcquirePoi: the nearest unclaimed job site; an employed villager only re-claims its own kind of block
      let best: [number, number, number] | null = null, bd = Infinity;
      for (let dy = -2; dy <= 2; dy++) for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
        const st = world.getBlock(bx + dx, by + dy, bz + dz);
        if (!st) continue;
        const prof = JOB_SITES[reg.nameOf(st)];
        if (!prof || (this.profession !== 'none' && prof !== this.profession)) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (d >= bd) continue;
        const x = bx + dx, y = by + dy, z = bz + dz;
        if (g.entities.some((e) => e !== this && e instanceof Mob && e.jobSite && e.jobSite[0] === x && e.jobSite[1] === y && e.jobSite[2] === z)) continue;
        best = [x, y, z]; bd = d;
      }
      if (best) {
        this.jobSite = best;
        const prof = JOB_SITES[reg.nameOf(world.getBlock(best[0], best[1], best[2]))];
        if (this.profession === 'none') { this.profession = prof; this.trades = null; g.sounds.playAt(`entity.villager.work_${prof}`, this.x, this.y, this.z, 1, 1); }
      }
    }
    // restock (vanilla: up to twice a day while at the job site; once a day here)
    const day = Math.floor(world.dayTime / 24000);
    if (this.jobSite && this.trades && day !== this.lastRestockDay && this.distSq(this.jobSite[0] + 0.5, this.jobSite[1], this.jobSite[2] + 0.5) < 16 * 16) {
      this.lastRestockDay = day;
      if (this.trades.some((t) => t.uses > 0)) { for (const t of this.trades) t.uses = 0; g.sounds.playAt(`entity.villager.work_${this.profession}`, this.x, this.y, this.z, 1, 1); }
    }
  }
  /** Zombie villager → villager once the curing timer runs out (vanilla ZombieVillager.finishConversion). */
  private tickConversion(): void {
    if (this.conversionTime < 0) return;
    const g = this.game;
    if (this.age % 10 === 0) for (let i = 0; i < 2; i++) g.particles.spawnPoof(this.x + (Math.random() - 0.5) * this.width, this.y + Math.random() * this.height, this.z + (Math.random() - 0.5) * this.width, 1);
    if (--this.conversionTime > 0) return;
    const v = g.spawnMob('villager', this.x, this.y, this.z, this.isBaby);
    if (v) { v.setVillagerData(this.profession, this.villagerType, this.villagerLevel); v.villagerXp = this.villagerXp; v.trades = this.trades; v.persistent = this.persistent; if ((this as any).customName) (v as any).customName = (this as any).customName; v.addEffect({ id: 'nausea', amplifier: 0, duration: 200 }); }
    g.sounds.playAt('entity.zombie_villager.converted', this.x, this.y, this.z, 1, 1);
    this.remove();
  }
  private isZombieLike(): boolean { return this.hostile && this.def.model === 'zombie' && this.type !== 'zombified_piglin'; }
  private isIllager(): boolean { return this.type === 'pillager' || this.type === 'vindicator' || this.type === 'evoker' || this.type === 'illusioner' || this.type === 'ravager' || this.type === 'vex'; }

  applySnapshot(s: any): void {
    super.applySnapshot(s);
    const ex = s.ex; if (!ex) return;
    if (ex.prof !== undefined) { this.profession = ex.prof; this.villagerType = ex.vtype ?? this.villagerType; this.villagerLevel = ex.vlevel ?? this.villagerLevel; }
    this.conversionTime = ex.curing ? 1 : -1;
    if (ex.baby !== undefined && ex.baby !== this.isBaby) this.setBaby(!!ex.baby);
    this.sheared = !!ex.sheared; if (ex.wool) this.woolColor = ex.wool; this.tamed = !!ex.tamed; this.sitting = !!ex.sit;
    this.prevSwell = this.swell; this.swell = ex.swell ?? 0; this.angerTicks = ex.anger ? 100 : 0; if (ex.size) this.slimeSize = ex.size; this.variant = ex.variant ?? this.variant;
    this.charged = !!ex.charged; (this as any).customName = ex.name; this.eatTimer = ex.eat ?? 0; this.screaming = !!ex.scream; this.carriedBlock = ex.carried ?? 0; this.attackAnim = ex.attack ?? 0; this.saddled = !!ex.saddled;
  }
  private sound(kind: 'ambient' | 'hurt' | 'death' | 'step', vol = 1, pitch?: number): void {
    const s = this.def.sounds[kind];
    if (!s) return;
    const p = pitch ?? ((Math.random() - Math.random()) * 0.2 + 1) * (this.isBaby ? 1.5 : 1);
    this.game.sounds.playAt(s, this.x, this.eyeY, this.z, vol, p, true);
  }

  hurt(d: EntityDamage): boolean {
    const r = super.hurt(d);
    if (r) {
      this.sound(this.health <= 0 ? 'death' : 'hurt');
      if (this.def.ai.flee) this.panicTicks = 100;
      if (d.attacker instanceof LivingEntity && d.attacker !== this && (this.def.ai.neutral || this.hostile || this.def.ai.melee || this.def.ai.ranged)) { this.target = d.attacker; this.angerTicks = 600; }
      if (d.attacker && this.def.ai.pack && this.def.ai.neutral) for (const e of this.game.entities) if (e instanceof Mob && e.type === this.type && e.distSq(this.x, this.y, this.z) < 32 * 32) { e.target = d.attacker as LivingEntity; e.angerTicks = 600; }
      if (this.def.ai.teleport && Math.random() < 0.5 && d.source !== 'attack') this.teleportRandom();
      this.persistent = true;
    }
    return r;
  }

  die(d: EntityDamage): void {
    const g = this.game;
    if (this.isVillager && d.attacker instanceof Mob && d.attacker.isZombieLike() && g.difficulty >= 2 && (g.difficulty === 3 || Math.random() < 0.5)) {
      const z = g.spawnMob('zombie_villager', this.x, this.y, this.z, this.isBaby);
      if (z) { z.setVillagerData(this.profession, this.villagerType, this.villagerLevel); z.villagerXp = this.villagerXp; z.trades = this.trades; z.persistent = true; if ((this as any).customName) (z as any).customName = (this as any).customName; }
      g.sounds.playAt('entity.zombie.infect', this.x, this.y, this.z, 1, 1);
      this.remove();
      return;
    }
    super.die(d);
    const killer = d.attacker && (d.attacker as any).isPlayer ? (d.attacker as Player) : null;
    const killedByPlayer = !!killer;
    const looting = killer ? (killer.heldItem()?.enchantLevel('looting') ?? 0) : 0;
    const lootName = this.def.ai.sheep ? `sheep/${this.woolColor}` : this.def.loot ?? this.type;
    let drops = g.loot.entityDrops(lootName, { killedByPlayer, lootingLevel: looting, onFire: this.fireTicks > 0, entityProps: { color: this.woolColor, sheared: this.sheared } });
    if (this.def.ai.sheep && !this.sheared) drops = drops.concat(drops.some((s) => s.item.name.endsWith('_wool')) ? [] : [new ItemStack(g.items.get(this.woolColor + '_wool')!, 1)]);
    if (this.isBaby) drops = drops.filter((s) => !s.item.name.endsWith('_wool'));
    if (this.def.ai.slime && this.slimeSize > 1) drops = [];
    for (const s of drops) g.dropItem(this.x, this.y + this.height / 2, this.z, s, [(Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2]);
    if (killedByPlayer || d.attacker) { const xp = this.def.ai.slime ? this.slimeSize : this.def.xp + (this.isBaby ? 7 : 0); if (xp > 0) g.spawnXp(this.x, this.y, this.z, xp); }
    if (this.def.ai.slime && this.slimeSize > 1) {
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) { const m = new Mob(this.def); m.setSlimeSize(this.slimeSize / 2); m.setPos(this.x + (Math.random() - 0.5), this.y + 0.5, this.z + (Math.random() - 0.5)); m.vx = (Math.random() - 0.5) * 0.4; m.vz = (Math.random() - 0.5) * 0.4; g.addEntity(m); }
    }
    if (this.type === 'creeper' && this.charged && false) { /* charged creeper heads */ }
    if (this.def.ai.explodeOnDeath) g.explode(this.x, this.y, this.z, 3, false);
  }

  protected onDeathFinished(): void { this.game.particles.spawnPoof(this.x, this.y + this.height / 2, this.z, 20); }

  tick(): void {
    if (this.health <= 0) { super.tick(); return; }
    const g = this.game;
    this.prevSwell = this.swell;
    if (this.growAge < 0) { this.growAge++; if (this.growAge === 0) this.setBaby(false); }
    if (this.loveTicks > 0) { this.loveTicks--; if (this.age % 10 === 0) g.particles.spawnHeart(this.x + (Math.random() - 0.5) * this.width, this.y + this.height + 0.3, this.z + (Math.random() - 0.5) * this.width); }
    if (this.breedCooldown > 0) this.breedCooldown--;
    if (this.teleportCooldown > 0) this.teleportCooldown--;
    if (this.attackTicks > 0) this.attackTicks--;
    if (this.angerTicks > 0) { this.angerTicks--; if (this.angerTicks === 0 && this.def.ai.neutral) this.target = null; }
    if (this.panicTicks > 0) this.panicTicks--;
    if (this.attackAnim > 0) this.attackAnim--;
    if (this.headShake > 0) this.headShake--;
    if (this.isVillager) this.villagerTick();
    if (this.isZombieVillager) this.tickConversion();
    // ambient sounds
    if (--this.ambientTimer <= 0) { this.ambientTimer = 80 + Math.floor(Math.random() * 200); if (Math.random() < 0.6) this.sound('ambient', 1); }
    // daylight burning
    if (this.def.ai.burnsInDay && this.game.isDay() && !this.inWater && this.world.getSky(Math.floor(this.x), Math.floor(this.eyeY), Math.floor(this.z)) >= 15 && this.world.dimension === 'overworld' && !g.weather.raining && this.fireTicks <= 0 && !this.hasHelmet()) this.fireTicks = 160;
    // chicken egg / slow fall
    if (this.def.ai.chicken) { if (!this.onGround && this.vy < 0) this.vy *= 0.6; if (!this.isBaby && --this.eggTimer <= 0) { this.eggTimer = 6000 + Math.floor(Math.random() * 6000); g.dropItem(this.x, this.y, this.z, new ItemStack(g.items.get('egg')!, 1)); g.sounds.playAt('entity.chicken.egg', this.x, this.y, this.z, 1, 1); } }
    // sheep eating grass
    if (this.def.ai.sheep) { if (this.eatTimer > 0) { this.eatTimer--; if (this.eatTimer === 4) { const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z); const s = this.world.getBlock(bx, by, bz); const reg = this.world.registry; if (s && reg.nameOf(s) === 'short_grass') { g.breakBlock(bx, by, bz, null, false, true); this.ate(); } else { const below = this.world.getBlock(bx, by - 1, bz); if (below === reg.GRASS_BLOCK) { this.world.setBlock(bx, by - 1, bz, reg.DIRT); this.ate(); } } } } else if (this.onGround && Math.random() < 1 / 1000 && (this.sheared || this.isBaby)) { const reg = this.world.registry; const below = this.world.getBlock(Math.floor(this.x), Math.floor(this.y) - 1, Math.floor(this.z)); const here = this.world.getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); if (below === reg.GRASS_BLOCK || (here && reg.nameOf(here) === 'short_grass')) { this.eatTimer = 40; g.sounds.playAt('entity.sheep.ambient', this.x, this.y, this.z, 0.5, 1); } } }
    // despawn far from player
    if (++this.despawnCheck > 40) { this.despawnCheck = 0; const p = this.player; if (p && !this.persistent && !this.tamed && this.def.category !== 'passive') { const d = this.distSq(p.x, p.y, p.z); if (d > 128 * 128 || (d > 32 * 32 && Math.random() < 1 / 30)) { this.remove(); return; } } }
    super.tick();
    g.redstone.entityStepped(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    // creeper fuse
    if (this.def.ai.creeper) {
      if (this.swellDir > 0 && this.swell === 0) g.sounds.playAt('entity.creeper.primed', this.x, this.y, this.z, 1, 0.5);
      this.swell = clamp(this.swell + this.swellDir, 0, 30);
      if (this.swell >= 30) { this.remove(); g.explode(this.x, this.y, this.z, this.charged ? 6 : 3, g.rules.mobGriefing !== false); }
    }
    // step sounds
    if (this.onGround && this.limbSwingAmount > 0.2 && this.age % 8 === 0 && this.def.sounds.step && !this.def.ai.fly) { const st = this.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z)); if (st) g.sounds.playAt(`block.${this.world.registry.block(st).soundType}.step`, this.x, this.y, this.z, 0.15, 1); }
  }

  private hasHelmet(): boolean { return false; }
  private ate(): void { this.sheared = false; if (this.isBaby) this.growAge = Math.min(0, this.growAge + 1200); }

  shear(): void {
    if (this.sheared || this.isBaby) return;
    this.sheared = true;
    const n = 1 + Math.floor(Math.random() * 3);
    this.game.dropItem(this.x, this.y + 0.5, this.z, new ItemStack(this.game.items.get(this.woolColor + '_wool')!, n));
    this.game.sounds.playAt('entity.sheep.shear', this.x, this.y, this.z, 1, 1);
  }

  /** Player right-clicks the mob. */
  interact(player: Player, held: ItemStack | null): boolean {
    const g = this.game;
    const n = held?.item.name;
    if (this.def.ai.sheep && n === 'shears' && !this.sheared && !this.isBaby) { this.shear(); player.damageHeld(held!, 1); return true; }
    if (this.def.ai.sheep && n?.endsWith('_dye')) { const c = n.replace('_dye', ''); if (c !== this.woolColor) { this.woolColor = c; if (!player.isCreative) held!.count--; player.inventory.onChange?.(); return true; } }
    if ((this.type === 'cow' || this.type === 'mooshroom') && n === 'bucket' && !this.isBaby) { player.replaceHeld(new ItemStack(g.items.get('milk_bucket')!, 1)); g.sounds.playAt('entity.cow.milk', this.x, this.y, this.z, 1, 1); return true; }
    if (this.type === 'mooshroom' && n === 'bowl' && !this.isBaby) { if (!player.isCreative) held!.count--; player.give(new ItemStack(g.items.get('mushroom_stew')!, 1)); g.sounds.playAt('entity.mooshroom.milk', this.x, this.y, this.z, 1, 1); return true; }
    if (this.type === 'mooshroom' && n === 'shears') { const cow = new Mob(MOB_DEFS.cow); cow.setPos(this.x, this.y, this.z); cow.yaw = this.yaw; this.remove(); g.addEntity(cow); for (let i = 0; i < 5; i++) g.dropItem(this.x, this.y + 1, this.z, new ItemStack(g.items.get('red_mushroom')!, 1)); g.sounds.playAt('entity.mooshroom.shear', this.x, this.y, this.z, 1, 1); player.damageHeld(held!, 1); return true; }
    if (this.def.ai.tameable && n && this.def.ai.tameable.includes(n) && !this.tamed) { if (!player.isCreative) held!.count--; player.inventory.onChange?.(); if (Math.random() < 1 / 3) { this.tamed = true; this.ownerUuid = player.uuid; this.target = null; this.angerTicks = 0; this.health = this.maxHealth = this.type === 'wolf' ? 40 : this.maxHealth; g.particles.spawnHeart(this.x, this.y + this.height, this.z, 7); } else g.particles.spawnSmoke(this.x, this.y + this.height, this.z, 7); return true; }
    if (this.tamed && this.ownerUuid === player.uuid && (!n || !this.def.ai.breed?.includes(n))) { this.sitting = !this.sitting; return true; }
    if (this.def.ai.breed && n && this.def.ai.breed.includes(n)) {
      if (this.isBaby) { this.growAge = Math.min(0, this.growAge + 2400); if (!player.isCreative) held!.count--; player.inventory.onChange?.(); return true; }
      if (this.loveTicks <= 0 && this.breedCooldown <= 0) { this.loveTicks = 600; if (!player.isCreative) held!.count--; player.inventory.onChange?.(); g.sounds.playAt(`entity.${this.type}.eat`, this.x, this.y, this.z, 1, 1); return true; }
    }
    if (this.type === 'pig' && n === 'saddle' && !this.saddled) { this.saddled = true; if (!player.isCreative) held!.count--; return true; }
    if (n === 'name_tag' && held?.customName) { (this as any).customName = held.customName; this.persistent = true; if (!player.isCreative) held.count--; return true; }
    if (this.isZombieVillager && n === 'golden_apple' && this.hasEffect('weakness') && this.conversionTime < 0) {
      // vanilla ZombieVillager.startConverting: 3600–6000 ticks
      if (!player.isCreative) held!.count--; player.inventory.onChange?.();
      this.conversionTime = 3600 + Math.floor(Math.random() * 2401); this.removeEffect('weakness'); this.addEffect({ id: 'strength', amplifier: 0, duration: this.conversionTime });
      g.sounds.playAt('entity.zombie_villager.cure', this.x, this.y, this.z, 1, 1); this.persistent = true;
      return true;
    }
    if (this.type === 'villager' || this.type === 'wandering_trader') {
      if (this.isBaby || this.health <= 0) return false;
      if (this.isVillager && (this.profession === 'none' || this.profession === 'nitwit')) { this.lookAt(player.x, player.eyeY, player.z, 30, 30); g.sounds.playAt('entity.villager.no', this.x, this.y, this.z, 1, 1); this.headShake = 40; return true; }
      if (player !== g.player) { g.host?.openTrading(player, this); return true; }
      g.gui.openTrading(this); return true;
    }
    return false;
  }

  protected aiStep(): void {
    const g = this.game;
    const ai = this.def.ai;
    const p = this.player;
    this.moveForward = 0; this.moveStrafe = 0; this.jumping = false;
    if (ai.noAI || this.sitting) return;
    // slime hopping movement
    if (ai.slime) { this.slimeAI(); return; }
    // target acquisition
    if (this.target && (this.target.removed || this.target.health <= 0 || this.distSq(this.target.x, this.target.y, this.target.z) > (ai.followRange ?? 16) ** 2 * 1.5)) this.target = null;
    if (!this.target && p && !p.removed && p.health > 0 && !p.isCreative && !p.isSpectator) {
      const d = Math.sqrt(this.distSq(p.x, p.y, p.z));
      if (this.hostile && !ai.neutral && d < (ai.followRange ?? 16) && (!ai.lightSensitive || this.world.getLightLevel(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z), g.skyDarken()) < 12 || this.angerTicks > 0) && this.canSee(p) && g.difficulty > 0) this.target = p;
      if (ai.enderman && d < 64 && this.playerLooking(p) && g.difficulty > 0) { this.target = p; this.angerTicks = 600; this.screaming = true; g.sounds.playAt('entity.enderman.stare', this.x, this.y, this.z, 2.5, 1); }
    }
    // zombies and illagers hunt villagers; iron golems defend against hostiles (vanilla NearestAttackableTargetGoal)
    if (!this.target && g.difficulty > 0 && this.age % 10 === 0 && (this.isZombieLike() || this.isIllager() || this.type === 'iron_golem' || this.type === 'snow_golem')) {
      const golem = this.def.ai.golem;
      let best: LivingEntity | null = null, bd = (ai.followRange ?? 16) ** 2;
      for (const e of g.entities) {
        if (e === this || !(e instanceof Mob) || e.removed || e.health <= 0) continue;
        if (golem ? !(e.hostile && e.type !== 'creeper') : !(e.isVillager || (this.type !== 'vex' && e.type === 'wandering_trader') || (this.isIllager() && e.type === 'iron_golem'))) continue;
        const d = this.distSq(e.x, e.y, e.z);
        if (d < bd && this.canSee(e)) { bd = d; best = e; }
      }
      if (best) this.target = best;
    }
    if (this.tamed && this.target && (this.target as any).isPlayer) this.target = null;
    if (this.tamed && this.ownerUuid === p?.uuid && p) { if (p.lastAttacker instanceof LivingEntity && p.lastAttacker !== this && p.lastAttacker.health > 0 && !p.lastAttacker.removed) this.target = p.lastAttacker; }
    // enderman: water/rain teleport
    if (ai.teleport && (this.inWater || this.isInRain()) && this.age % 5 === 0) { this.hurt({ amount: 1, source: 'drown', bypassArmor: true }); this.teleportRandom(); }
    if (ai.phantom) { this.phantomAI(p); return; }
    if (ai.ghast) { this.ghastAI(p); return; }
    if (ai.fly && (this.type === 'bat' || this.type === 'parrot' || this.type === 'bee' || this.type === 'vex' || this.type === 'blaze')) { this.flyAI(p); if (this.type !== 'blaze' && this.type !== 'vex') return; }
    // creeper
    if (ai.creeper && this.target) {
      const d = Math.sqrt(this.distSq(this.target.x, this.target.y, this.target.z));
      if (d < 3 && this.canSee(this.target)) { this.swellDir = 1; this.lookAt(this.target.x, this.target.eyeY, this.target.z, 30, 30); return; }
      if (d > 7) this.swellDir = -1; else if (this.swellDir > 0 && d >= 3) this.swellDir = -1;
    } else if (ai.creeper && !this.ignited) this.swellDir = -1;
    // vanilla PanicGoal: while recently hurt (or burning) run to a random spot within 5 blocks, then pick another;
    // the direction is random (DefaultRandomPos), not away from the attacker
    if ((this.panicTicks > 0 || (this.fireTicks > 0 && !this.isFireImmune())) && ai.flee) {
      if (!this.wanderTarget || this.wanderTimer <= 0 || this.distSq(this.wanderTarget[0], this.y, this.wanderTarget[2]) < 1) {
        this.wanderTarget = null;
        for (let i = 0; i < 10 && !this.wanderTarget; i++) {
          const tx = this.x + (Math.random() - 0.5) * 10, tz = this.z + (Math.random() - 0.5) * 10;
          const ty = this.game.groundHeightNear(Math.floor(tx), Math.floor(this.y), Math.floor(tz), 4);
          if (ty !== null && !this.isDangerous(Math.floor(tx), ty, Math.floor(tz))) { this.wanderTarget = [tx, ty, tz]; this.wanderTimer = 60; }
        }
        if (!this.wanderTarget) return;
      }
      this.wanderTimer--;
      this.moveTowards(this.wanderTarget[0], this.wanderTarget[2], ai.speeds?.panic ?? 1.25);
      return;
    }
    // villagers run from zombies and illagers (vanilla AvoidEntityGoal, 8 blocks, 0.5/0.5 speed modifiers)
    if (this.isVillager || this.type === 'wandering_trader') {
      let threat: LivingEntity | null = null, bd = 64;
      for (const e of g.entities) { if (e instanceof Mob && !e.removed && e.health > 0 && (e.isZombieLike() || e.isIllager() || e.type === 'zoglin')) { const d = this.distSq(e.x, e.y, e.z); if (d < bd) { bd = d; threat = e; } } }
      if (threat) { this.wanderTarget = null; this.moveTowards(this.x * 2 - threat.x, this.z * 2 - threat.z, 0.5); return; }
    }
    // attack target
    if (this.target && !this.tamed || (this.target && this.tamed && !(this.target as any).isPlayer)) {
      const t = this.target;
      const d = Math.sqrt(this.distSq(t.x, t.y, t.z));
      this.lookAt(t.x, t.eyeY, t.z, 30, 30);
      if (ai.ranged && (!ai.melee || d > (ai.attackRange ?? 2) + 1)) {
        // keep distance & shoot
        if (d > 10) this.moveTowards(t.x, t.z, 1); else if (d < 5 && this.type !== 'ghast') this.moveTowards(this.x - (t.x - this.x), this.z - (t.z - this.z), 1); else this.moveStrafe = Math.sin(this.age / 10) * 0.5;
        if (++this.rangedTicks >= (ai.rangedInterval ?? 40) * (g.difficulty === 3 ? 0.5 : 1) && this.canSee(t) && d < 15) { this.rangedTicks = 0; this.shoot(t); }
      } else {
        this.moveTowards(t.x, t.z, ai.speeds?.attack ?? 1);
        // vanilla Mob.isWithinMeleeAttackRange: our box grown by DEFAULT_ATTACK_REACH (~0.83) horizontally must touch the target
        const reach = ai.attackRange !== undefined && ai.attackRange !== 2 ? ai.attackRange : 0.828 + this.width / 2 + t.width / 2;
        const inReach = Math.abs(t.x - this.x) <= reach && Math.abs(t.z - this.z) <= reach && t.bb.maxY > this.bb.minY && t.bb.minY < this.bb.maxY;
        if (inReach && this.attackTicks <= 0 && this.canSee(t)) {
          this.attackTicks = 20;
          // the attribute value; Player.hurt applies the Easy/Hard difficulty scaling like vanilla
          if (t.hurt({ amount: this.def.damage, source: 'attack', attacker: this })) {
            if (this.type === 'husk') t.addEffect({ id: 'hunger', amplifier: 0, duration: 140 * 7 });
            if (this.type === 'cave_spider') t.addEffect({ id: 'poison', amplifier: 0, duration: 140 });
            if (this.type === 'stray' || this.type === 'bogged') { /* arrows only */ }
            if (this.type === 'wither_skeleton') t.addEffect({ id: 'wither', amplifier: 0, duration: 200 });
            if (this.type === 'iron_golem') t.vy += 0.4;
          }
          this.swing(); this.attackAnim = 10;
        }
      }
      return;
    }
    // tempt: follow player holding food
    if (ai.tempt && p && !p.removed) {
      const held = p.heldItem();
      if (held && ai.tempt.includes(held.item.name) && this.distSq(p.x, p.y, p.z) < 100) { this.lookAt(p.x, p.eyeY, p.z, 30, 30); if (this.distSq(p.x, p.y, p.z) > 6) this.moveTowards(p.x, p.z, ai.speeds?.tempt ?? 1); return; }
    }
    // tamed: follow owner
    if (this.tamed && p && this.ownerUuid === p.uuid && !this.sitting) { const d = this.distSq(p.x, p.y, p.z); if (d > 144) { this.setPos(p.x + (Math.random() - 0.5) * 4, p.y, p.z + (Math.random() - 0.5) * 4); } else if (d > 9) { this.moveTowards(p.x, p.z, 1); this.lookAt(p.x, p.eyeY, p.z, 20, 20); return; } }
    // breeding
    if (this.loveTicks > 0) {
      const mate = g.entities.find((e) => e !== this && e instanceof Mob && e.type === this.type && e.loveTicks > 0 && !e.removed && e.distSq(this.x, this.y, this.z) < 64) as Mob | undefined;
      if (mate) {
        this.moveTowards(mate.x, mate.z, 1);
        if (this.distSq(mate.x, mate.y, mate.z) < 4) {
          const baby = new Mob(this.def); baby.setBaby(true); baby.setPos(this.x, this.y, this.z);
          if (this.def.ai.sheep) baby.woolColor = Math.random() < 0.5 ? this.woolColor : mate.woolColor;
          g.addEntity(baby);
          this.loveTicks = 0; mate.loveTicks = 0; this.breedCooldown = 6000; mate.breedCooldown = 6000;
          g.spawnXp(this.x, this.y, this.z, 1 + Math.floor(Math.random() * 7));
          for (let i = 0; i < 7; i++) g.particles.spawnHeart(this.x + (Math.random() - 0.5), this.y + this.height + 0.5, this.z + (Math.random() - 0.5));
        }
        return;
      }
    }
    // wander
    if (ai.wander !== false) this.wander();
    // idle look at player
    if (p && this.distSq(p.x, p.y, p.z) < 64 && Math.random() < 0.02 && !this.wanderTarget) this.lookAt(p.x, p.eyeY, p.z, 10, 10);
  }

  private canSee(t: LivingEntity): boolean {
    return this.game.canSeeBetween(this.x, this.eyeY, this.z, t.x, t.eyeY, t.z);
  }

  private playerLooking(p: Player): boolean {
    if (p.armor.get(0)?.item.name === 'carved_pumpkin') return false;
    const d = lookDir(p.yaw, p.pitch);
    const dx = this.x - p.x, dy = this.eyeY - p.eyeY, dz = this.z - p.z;
    const len = Math.hypot(dx, dy, dz);
    const dot = (dx * d[0] + dy * d[1] + dz * d[2]) / len;
    return dot > 1 - 0.025 / len && this.canSee(p);
  }

  teleportRandom(): void {
    if (this.teleportCooldown > 0) return;
    for (let i = 0; i < 16; i++) {
      const tx = this.x + (Math.random() - 0.5) * 64, tz = this.z + (Math.random() - 0.5) * 64;
      let ty = Math.floor(this.y + (Math.random() - 0.5) * 16);
      // find ground
      while (ty > -60 && this.world.getBlock(Math.floor(tx), ty - 1, Math.floor(tz)) === 0) ty--;
      if (this.game.canStandAt(tx, ty, tz) && !this.world.registry.hasWater(this.world.getBlock(Math.floor(tx), ty, Math.floor(tz)))) {
        this.game.particles.spawnPortal(this.x, this.y + 1, this.z, 32);
        this.game.sounds.playAt('entity.enderman.teleport', this.x, this.y, this.z, 1, 1);
        this.setPos(tx, ty, tz); this.teleportCooldown = 20; this.game.sounds.playAt('entity.enderman.teleport', tx, ty, tz, 1, 1);
        return;
      }
    }
  }

  private shoot(t: LivingEntity): void {
    const g = this.game;
    const kind = this.def.ai.ranged!;
    const dx = t.x - this.x, dy = t.eyeY - 0.3 - this.eyeY, dz = t.z - this.z;
    const dist = Math.hypot(dx, dz);
    if (kind === 'arrow') {
      const a = new ArrowEntity(this, 2, this.type === 'stray' ? 'tipped' : this.type === 'bogged' ? 'tipped' : 'normal');
      if (this.type === 'stray') (a as any).effect = { id: 'slowness', amplifier: 0, duration: 600 };
      if (this.type === 'bogged') (a as any).effect = { id: 'poison', amplifier: 0, duration: 100 };
      a.setPos(this.x, this.eyeY - 0.1, this.z);
      const sp = 1.6, inacc = 14 - g.difficulty * 4;
      a.vx = dx / dist * sp + (Math.random() - 0.5) * 0.0172 * inacc; a.vy = (dy + dist * 0.2) / dist * sp * 0.9 + (Math.random() - 0.5) * 0.0172 * inacc; a.vz = dz / dist * sp + (Math.random() - 0.5) * 0.0172 * inacc;
      a.pickup = false;
      g.addEntity(a);
      g.sounds.playAt('entity.skeleton.shoot', this.x, this.y, this.z, 1, 1 / (Math.random() * 0.4 + 0.8));
    } else if (kind === 'snowball') {
      const p = new ThrownProjectile('snowball', this); p.setPos(this.x, this.eyeY, this.z); p.vx = dx / dist * 1.6; p.vy = (dy + dist * 0.2) / dist * 1.6; p.vz = dz / dist * 1.6; g.addEntity(p);
      g.sounds.playAt('entity.snow_golem.shoot', this.x, this.y, this.z, 1, 1);
    } else if (kind === 'fire_charge' || kind === 'fireball') {
      const p = new ThrownProjectile(kind === 'fireball' ? 'ghast_fireball' : 'fire_charge', this); p.setPos(this.x, this.eyeY, this.z); const sp = kind === 'fireball' ? 0.8 : 1.2; const l = Math.hypot(dx, dy, dz); p.vx = dx / l * sp; p.vy = dy / l * sp; p.vz = dz / l * sp; p.noGravity = true; g.addEntity(p);
      g.sounds.playAt(kind === 'fireball' ? 'entity.ghast.shoot' : 'entity.blaze.shoot', this.x, this.y, this.z, kind === 'fireball' ? 10 : 2, 1);
    } else if (kind === 'potion') {
      const eff = Math.random() < 0.5 ? { id: 'poison', amplifier: 0, duration: 400 } : { id: 'slowness', amplifier: 0, duration: 360 };
      const p = new ThrownProjectile('splash_potion', this, new ItemStack(g.items.get('splash_potion')!, 1, 0, [], null, { effect: eff, color: 0x4e9331 })); p.setPos(this.x, this.eyeY, this.z); p.vx = dx / dist * 0.75; p.vy = (dy + dist * 0.2) / dist * 0.75 + 0.1; p.vz = dz / dist * 0.75; g.addEntity(p);
      g.sounds.playAt('entity.witch.throw', this.x, this.y, this.z, 1, 1);
    }
  }

  private wander(): void {
    if (this.wanderTimer > 0) this.wanderTimer--;
    if (!this.wanderTarget) {
      if (this.wanderTimer <= 0 && Math.random() < 1 / 120) {
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 8;
        const tx = this.x + Math.cos(a) * r, tz = this.z + Math.sin(a) * r;
        if (this.def.ai.water) { this.wanderTarget = [tx, this.y + (Math.random() - 0.5) * 4, tz]; this.wanderTimer = 60 + Math.floor(Math.random() * 60); return; }
        // avoid wandering into water/lava/cliffs
        const ty = this.game.groundHeightNear(Math.floor(tx), Math.floor(this.y), Math.floor(tz), 4);
        if (ty !== null && !this.isDangerous(Math.floor(tx), ty, Math.floor(tz))) { this.wanderTarget = [tx, ty, tz]; this.wanderTimer = 60 + Math.floor(Math.random() * 60); }
      }
      if (this.lookTimer > 0) this.lookTimer--; else if (Math.random() < 0.02) { this.lookTimer = 20 + Math.floor(Math.random() * 40); this.yaw += (Math.random() - 0.5) * 60; }
      return;
    }
    const dx = this.wanderTarget[0] - this.x, dz = this.wanderTarget[2] - this.z;
    if (dx * dx + dz * dz < 1 || this.wanderTimer <= 0 || (this.horizontalCollision && this.onGround && Math.random() < 0.1)) { this.wanderTarget = null; this.wanderTimer = 20 + Math.floor(Math.random() * 40); return; }
    if (this.def.ai.water) { const dy = this.wanderTarget[1] - this.y; this.vy += clamp(dy, -0.02, 0.02); }
    this.moveTowards(this.wanderTarget[0], this.wanderTarget[2], this.def.ai.speeds?.stroll ?? 1);
  }

  private isDangerous(x: number, y: number, z: number): boolean {
    const reg = this.world.registry;
    const s = this.world.getBlock(x, y, z), below = this.world.getBlock(x, y - 1, z);
    if (s !== 0 && (reg.isLava(s) || (reg.hasWater(s) && !this.def.ai.water))) return true;
    if (below !== 0 && (reg.isLava(below) || reg.nameOf(below) === 'cactus' || reg.nameOf(below) === 'magma_block' || (reg.nameOf(below) === 'fire'))) return !this.def.fireImmune;
    return false;
  }

  /** Steer toward (tx, tz): set yaw and forward input, jump over obstacles. */
  moveTowards(tx: number, tz: number, speedMul: number): void {
    const dx = tx - this.x, dz = tz - this.z;
    const targetYaw = Math.atan2(-dx, dz) * 180 / Math.PI;
    this.yaw += clamp(wrapDegrees(targetYaw - this.yaw), -30, 30);
    this.moveForward = speedMul;
    // rabbits hop instead of walking (vanilla RabbitJumpControl): a jump every ~half second on the ground
    if (this.type === 'rabbit') { if (this.onGround && this.jumpTicks === 0) this.jumping = true; else if (!this.onGround) this.jumping = false; this.moveForward = speedMul * (this.onGround ? 0.6 : 1.4); }
    // jump if blocked or a step ahead
    const d = lookDir(this.yaw, 0);
    const fx = Math.floor(this.x + d[0] * (this.width / 2 + 0.3)), fz = Math.floor(this.z + d[2] * (this.width / 2 + 0.3));
    const fy = Math.floor(this.y);
    const reg = this.world.registry;
    const ahead = this.world.getBlock(fx, fy, fz);
    const aheadUp = this.world.getBlock(fx, fy + 1, fz);
    const solidAhead = ahead !== 0 && reg.collisionBoxes(ahead).length > 0 && !reg.isFluid(ahead);
    const solidAheadUp = aheadUp !== 0 && reg.collisionBoxes(aheadUp).length > 0;
    // vanilla mobs only jump one block up (WalkNodeEvaluator): a step needs the block above it, and the headroom
    // for the mob on top of that, to be clear; a two-block wall is simply not climbable
    const stepClear = solidAhead && !solidAheadUp && (() => { const h = Math.ceil(this.height); for (let i = 2; i <= h; i++) { const s = this.world.getBlock(fx, fy + i, fz); if (s !== 0 && reg.collisionBoxes(s).length > 0) return false; } return true; })();
    if (stepClear && this.onGround) this.jumping = true;
    if (this.inWater || this.inLava) this.jumping = true;
    if (this.def.ai.climb && this.horizontalCollision) this.vy = 0.2;
    // cliff avoidance when not chasing
    if (!this.target && this.onGround) {
      let drop = 0; while (drop < 4 && this.world.getBlock(fx, fy - 1 - drop, fz) === 0) drop++;
      if (drop >= 4 && !this.def.ai.fly) this.moveForward = 0;
    }
  }

  private slimeAI(): void {
    const p = this.player;
    if (this.jumpDelay > 0) this.jumpDelay--;
    if (p && !p.isCreative && !p.isSpectator && p.health > 0 && this.distSq(p.x, p.y, p.z) < 256 && this.hostile && this.game.difficulty > 0 && this.canSee(p)) { this.target = p; }
    if (this.target && (this.target.removed || this.target.health <= 0)) this.target = null;
    if (this.target) this.lookAt(this.target.x, this.target.eyeY, this.target.z, 10, 10);
    else if (Math.random() < 0.02) this.yaw += (Math.random() - 0.5) * 90;
    if (this.onGround && this.jumpDelay <= 0) {
      this.jumpDelay = this.target ? 20 + Math.floor(Math.random() * 20) : 40 + Math.floor(Math.random() * 80);
      this.jumping = true;
      this.moveForward = 1;
      this.game.sounds.playAt(this.type === 'magma_cube' ? (this.slimeSize > 1 ? 'entity.magma_cube.jump' : 'entity.magma_cube.jump') : this.slimeSize > 1 ? 'entity.slime.jump' : 'entity.slime.jump_small', this.x, this.y, this.z, 0.4, ((Math.random() - Math.random()) * 0.2 + 1) * 0.8);
    } else if (!this.onGround) this.moveForward = 1;
    if (this.target && this.attackTicks <= 0) {
      const t = this.target;
      if (this.bb.clone().grow(0.5, 0.5, 0.5).intersects(t.bb) && this.slimeSize > 1 || (this.slimeSize === 1 && this.type === 'magma_cube' && this.bb.clone().grow(0.5, 0.5, 0.5).intersects(t.bb))) { this.attackTicks = 20; t.hurt({ amount: this.type === 'magma_cube' ? this.slimeSize + 2 : this.slimeSize, source: 'attack', attacker: this }); this.game.sounds.playAt('entity.slime.attack', this.x, this.y, this.z, 1, 1); }
    }
  }
  getJumpPower(): number { return this.def.ai.slime ? 0.42 + this.slimeSize * 0.1 : super.getJumpPower(); }

  private flyAI(p: Player | null): void {
    // random flight; blaze hovers near the player
    if (!this.flyTarget || this.age % 60 === 0 || this.distSq(this.flyTarget[0], this.flyTarget[1], this.flyTarget[2]) < 2) {
      const base = this.target ?? (this.type === 'bee' || this.type === 'parrot' ? null : null);
      const cx = base ? base.x : this.x, cy = base ? base.eyeY + 2 : this.y, cz = base ? base.z : this.z;
      this.flyTarget = [cx + (Math.random() - 0.5) * 12, cy + (Math.random() - 0.5) * (this.type === 'bat' ? 4 : 6), cz + (Math.random() - 0.5) * 12];
    }
    const [tx, ty, tz] = this.flyTarget;
    const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const sp = this.type === 'bat' ? 0.05 : 0.03;
    this.vx += dx / l * sp; this.vy += dy / l * sp; this.vz += dz / l * sp;
    this.vx *= 0.9; this.vy *= 0.9; this.vz *= 0.9;
    this.yaw = Math.atan2(-this.vx, this.vz) * 180 / Math.PI;
    if (this.type === 'bat' && this.world.getSky(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) > 7 && this.game.isDay() && Math.random() < 0.01) this.remove();
    void p;
  }

  private phantomAI(p: Player | null): void {
    if (!p || p.removed) { this.flyAI(p); return; }
    // circle above the player, dive occasionally
    const t = this.age / 20;
    const cx = p.x + Math.cos(t) * 12, cz = p.z + Math.sin(t) * 12, cy = p.y + 15;
    let tx = cx, ty = cy, tz = cz;
    const diving = (this.age % 200) > 140;
    if (diving) { tx = p.x; ty = p.eyeY; tz = p.z; }
    const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z; const l = Math.hypot(dx, dy, dz) || 1;
    const sp = diving ? 0.08 : 0.04;
    this.vx += dx / l * sp; this.vy += dy / l * sp; this.vz += dz / l * sp;
    this.vx *= 0.92; this.vy *= 0.92; this.vz *= 0.92;
    this.yaw = Math.atan2(-this.vx, this.vz) * 180 / Math.PI;
    if (diving && this.attackTicks <= 0 && this.bb.clone().grow(0.5, 0.5, 0.5).intersects(p.bb)) { this.attackTicks = 40; p.hurt({ amount: 6, source: 'attack', attacker: this }); this.game.sounds.playAt('entity.phantom.bite', this.x, this.y, this.z, 1, 1); }
  }

  private ghastAI(p: Player | null): void {
    if (!this.flyTarget || this.age % 100 === 0) this.flyTarget = [this.x + (Math.random() - 0.5) * 32, clamp(this.y + (Math.random() - 0.5) * 16, 40, 110), this.z + (Math.random() - 0.5) * 32];
    const [tx, ty, tz] = this.flyTarget;
    const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z; const l = Math.hypot(dx, dy, dz) || 1;
    this.vx += dx / l * 0.01; this.vy += dy / l * 0.01; this.vz += dz / l * 0.01;
    this.vx *= 0.95; this.vy *= 0.95; this.vz *= 0.95;
    if (p && !p.isCreative && this.distSq(p.x, p.y, p.z) < 64 * 64 && this.canSee(p)) {
      this.target = p; this.lookAt(p.x, p.eyeY, p.z, 20, 20);
      if (++this.rangedTicks >= 60) { this.rangedTicks = 0; this.shoot(p); }
    } else { this.yaw = Math.atan2(-this.vx, this.vz) * 180 / Math.PI; this.target = null; }
  }

  protected travel(): void {
    if (this.def.ai.fly && !this.def.ai.phantom && this.type !== 'blaze') { this.move(this.vx, this.vy, this.vz); return; }
    if (this.def.ai.phantom) { this.move(this.vx, this.vy, this.vz); return; }
    if (this.def.ai.water) {
      if (this.inWater) { this.moveRelative(this.moveForward, this.moveStrafe, 0.02 * (this.type === 'dolphin' ? 4 : 1.5)); this.move(this.vx, this.vy, this.vz); this.vx *= 0.9; this.vz *= 0.9; this.vy *= 0.9; this.vy += (Math.random() - 0.5) * 0.01; return; }
      // out of water: flop
      if (this.onGround && Math.random() < 0.1) { this.vy = 0.3; this.vx = (Math.random() - 0.5) * 0.3; this.vz = (Math.random() - 0.5) * 0.3; }
      if (this.age % 20 === 0 && this.type !== 'turtle' && this.type !== 'axolotl' && this.type !== 'drowned' && this.type !== 'guardian') this.hurt({ amount: 1, source: 'drown', bypassArmor: true });
    }
    if (this.def.ai.lavaWalk && this.inLava) { this.vy = Math.max(this.vy, 0.05); this.moveRelative(this.moveForward, this.moveStrafe, 0.05); this.move(this.vx, this.vy, this.vz); this.vx *= 0.9; this.vz *= 0.9; return; }
    // vanilla MoveControl: getSpeed() = speedModifier * MOVEMENT_SPEED, and Mob.setSpeed feeds that same value back
    // in as the movement input, so land acceleration is (modifier * speed)² — a zombie (0.23) walks ~2.3 m/s while a
    // player uses input 1 with speed 0.1. Rabbits keep their own hop constants.
    const f = this.moveForward, st = this.moveStrafe, mod = Math.hypot(f, st);
    if (mod > 0 && this.type !== 'rabbit') {
      const attr = this.speed, sp = mod * attr;
      this.speed = sp; this.moveForward = f / mod * sp; this.moveStrafe = st / mod * sp;
      super.travel();
      this.speed = attr; this.moveForward = f; this.moveStrafe = st;
    } else super.travel();
  }

  serialize(): any { return { ...super.serialize(), woolColor: this.woolColor, sheared: this.sheared, slimeSize: this.slimeSize, tamed: this.tamed, owner: this.ownerUuid, sitting: this.sitting, growAge: this.growAge, persistent: this.persistent, saddled: this.saddled, variant: this.variant, customName: (this as any).customName, profession: this.profession, villagerType: this.villagerType, villagerLevel: this.villagerLevel, villagerXp: this.villagerXp, trades: this.trades, jobSite: this.jobSite, conversionTime: this.conversionTime }; }
  deserialize(d: any): void {
    super.deserialize(d);
    this.woolColor = d.woolColor ?? this.woolColor; this.sheared = !!d.sheared; if (d.slimeSize && this.def.ai.slime) this.setSlimeSize(d.slimeSize);
    this.tamed = !!d.tamed; this.ownerUuid = d.owner ?? null; this.sitting = !!d.sitting; this.persistent = !!d.persistent; this.saddled = !!d.saddled; this.variant = d.variant ?? 0;
    if (d.growAge < 0) this.setBaby(true), this.growAge = d.growAge;
    if (d.customName) (this as any).customName = d.customName;
    if (d.profession) { this.profession = d.profession; this.villagerType = d.villagerType ?? 'plains'; this.villagerLevel = d.villagerLevel ?? 1; this.villagerXp = d.villagerXp ?? 0; this.trades = d.trades ?? null; this.jobSite = d.jobSite ?? null; this.conversionTime = d.conversionTime ?? -1; }
  }
}

export { WOOL_COLORS };
