// The player: input-driven movement, hunger/XP, inventory, block interaction, item use.
import { LivingEntity, ItemEntity, type EntityDamage, type DamageSource } from './entity';
import { ArrowEntity, ThrownProjectile } from './misc';
import { Inventory, ItemStack } from '../items/stack';
import { TIER_SPEED, TIER_LEVEL, type Item } from '../items/registry';
import { getPlacement, horizontalFacing, updateConnections, isReplaceable, canSurvive, facingOffset, oppositeFacing } from '../blocks/placement';
import { BoatEntity } from './boat';
import { useBlock } from '../blocks/interaction';
import { clamp, lookDir, wrapDegrees } from '../math';
import { SET_UPDATE_NEIGHBORS } from '../world/world';
import { MIN_Y, MAX_Y } from '../world/chunk';

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export interface BlockHit { x: number; y: number; z: number; face: number; hx: number; hy: number; hz: number; t: number; state: number }

/** Blocks whose interaction only the multiplayer host may run (they open host-owned inventories or roll dice). */
const HOST_ONLY_BLOCKS = /(chest$|barrel|shulker_box|furnace|smoker|dispenser|dropper|hopper|brewing_stand|jukebox|lectern|campfire|beehive|bee_nest|composter|cauldron|_bed$|spawner|beacon|respawn_anchor|end_portal_frame|note_block|chiseled_bookshelf|decorated_pot|crafter|vault|trial_spawner)/;

export class Player extends LivingEntity {
  type = 'player';
  isPlayer = true;
  inventory = new Inventory(36);   // 0-8 hotbar
  armor = new Inventory(4);        // 0 head,1 chest,2 legs,3 feet
  offhand = new Inventory(1);
  enderChest = new Inventory(27);
  craftingGrid = new Inventory(9);
  selectedSlot = 0;
  gameMode: GameMode = 'survival';
  // hunger
  foodLevel = 20; saturation = 5; exhaustion = 0; foodTickTimer = 0;
  // xp
  xpLevel = 0; xpProgress = 0; totalXp = 0;
  // states
  flying = false;
  sleeping = false; sleepTimer = 0; bedPos: [number, number, number] | null = null;
  spawnPos: [number, number, number] | null = null; spawnForced = false;
  // block breaking
  breaking: { x: number; y: number; z: number; progress: number; state: number } | null = null;
  breakCooldown = 0;
  useCooldown = 0;
  attackCooldownTicks = 0; // ticks since last attack
  itemUseTicks = 0; usingItem: ItemStack | null = null; useDuration = 0;
  bowCharge = 0;
  score = 0;
  deathMessage = '';
  sneakEyeTarget = 1.62;
  cameraEye = 1.62;
  prevCameraEye = 1.62;
  lastSprintKey = 0;
  flyToggleTimer = 0;
  sneakToggleTimer = 0;
  hurtDir = 0;
  respawnTicks = 0;
  swimmingPose = false;
  crawling = false;
  reachDistance = 4.5;
  name = 'Player';
  private lastX = 0; private lastZ = 0;
  walkDist = 0; nextStep = 1; prevWalkDist = 0;
  bob = 0; prevBob = 0;
  cheats = true;
  ticksSinceLastSleep = 0;
  itemCooldowns = new Map<string, number>();
  hotbarPrevSlot = 0;
  private lastBoatInput = '';

  constructor() {
    super();
    this.width = 0.6; this.height = 1.8; this.eyeHeight = 1.62; this.stepHeight = 0.6;
    this.speed = 0.1;
  }

  get isCreative(): boolean { return this.gameMode === 'creative'; }
  get isSpectator(): boolean { return this.gameMode === 'spectator'; }
  get invulnerableMode(): boolean { return this.isCreative || this.isSpectator; }

  heldItem(): ItemStack | null { return this.inventory.get(this.selectedSlot); }
  offhandItem(): ItemStack | null { return this.offhand.get(0); }
  replaceHeld(s: ItemStack | null): void { if (this.isCreative && s?.item.name === 'bucket') return; this.inventory.set(this.selectedSlot, s); }
  horizontalFacing(): string { return horizontalFacing(this.yaw); }

  setGameMode(m: GameMode): void {
    this.gameMode = m;
    if (m === 'survival' || m === 'adventure') { this.flying = false; this.noClip = false; }
    if (m === 'spectator') { this.flying = true; this.noClip = true; }
    if (m === 'creative') this.noClip = false;
  }

  isFlying(): boolean { return this.flying; }
  isFireImmune(): boolean { return this.invulnerableMode || this.hasEffect('fire_resistance'); }
  canBreatheUnderwater(): boolean { return this.invulnerableMode || this.armor.get(0)?.item.name === 'turtle_helmet' && false; }
  respirationLevel(): number { return this.armor.get(0)?.enchantLevel('respiration') ?? 0; }
  depthStriderLevel(): number { return this.armor.get(3)?.enchantLevel('depth_strider') ?? 0; }
  armorValue(): number { let a = 0; for (const s of this.armor.slots) if (s) a += s.item.armor; return a; }
  armorToughness(): number { let a = 0; for (const s of this.armor.slots) if (s) a += s.item.armorToughness; return a; }
  knockbackResistance(): number { let r = 0; for (const s of this.armor.slots) if (s && s.item.name.startsWith('netherite')) r += 0.1; return r; }
  enchantProtection(source: DamageSource): number {
    let epf = 0;
    for (const s of this.armor.slots) {
      if (!s) continue;
      epf += s.enchantLevel('protection');
      if (source === 'fire' || source === 'onFire' || source === 'lava') epf += s.enchantLevel('fire_protection') * 2;
      if (source === 'fall') epf += s.enchantLevel('feather_falling') * 3;
      if (source === 'explosion') epf += s.enchantLevel('blast_protection') * 2;
      if (source === 'arrow') epf += s.enchantLevel('projectile_protection') * 2;
    }
    return epf;
  }

  hurt(d: EntityDamage): boolean {
    if (this.invulnerableMode && d.source !== 'void') return false;
    if (this.game.difficulty === 0 && (d.source === 'starve')) return false;
    if (this.sleeping) this.wakeUp();
    const prev = this.health;
    let amount = d.amount;
    if (this.game.difficulty === 0 && d.source !== 'void' && d.source !== 'fall' && d.source !== 'starve') amount = Math.min(amount / 2 + 1, amount);
    else if (this.game.difficulty === 3 && d.source !== 'void') amount = amount * 1.5;
    const r = super.hurt({ ...d, amount });
    if (r && this.health < prev) {
      this.addExhaustion(0.1);
      this.game.sounds.playAt(this.health <= 0 ? 'entity.player.death' : 'entity.player.hurt', this.x, this.y, this.z, 1, 1);
      if (d.attacker) { const dx = d.attacker.x - this.x, dz = d.attacker.z - this.z; this.hurtDir = Math.atan2(dz, dx) * 180 / Math.PI - this.yaw; } else this.hurtDir = 0;
      if (!(this as any).isRemote) this.game.gui.onPlayerHurt();
    }
    return r;
  }

  die(d: EntityDamage): void {
    super.die(d);
    this.deathMessage = this.deathText(d);
    if (!this.isCreative && this.game.rules.keepInventory !== true) {
      for (const inv of [this.inventory, this.armor, this.offhand, this.craftingGrid]) for (let i = 0; i < inv.size; i++) { const s = inv.get(i); if (s) { this.game.dropItem(this.x, this.y + 1, this.z, s, [(Math.random() - 0.5) * 0.3, 0.2, (Math.random() - 0.5) * 0.3]); inv.slots[i] = null; } }
      const xp = Math.min(100, this.xpLevel * 7);
      if (xp > 0) this.game.spawnXp(this.x, this.y, this.z, xp);
      this.xpLevel = 0; this.xpProgress = 0; this.totalXp = 0;
    }
    this.game.onPlayerDied();
  }

  private deathText(d: EntityDamage): string {
    const l = this.game.assets.lang;
    const key = { fall: 'death.fell.accident.generic', drown: 'death.attack.drown', lava: 'death.attack.lava', fire: 'death.attack.inFire', onFire: 'death.attack.onFire', cactus: 'death.attack.cactus', starve: 'death.attack.starve', void: 'death.attack.outOfWorld', explosion: 'death.attack.explosion', arrow: 'death.attack.arrow', magma: 'death.attack.hotFloor', attack: 'death.attack.mob', sweetBerryBush: 'death.attack.sweetBerryBush', lightning: 'death.attack.lightningBolt', freeze: 'death.attack.freeze', wither: 'death.attack.wither', outOfWorld: 'death.attack.outOfWorld', stalagmite: 'death.attack.stalagmite', flyIntoWall: 'death.attack.flyIntoWall', generic: 'death.attack.generic', thorns: 'death.attack.thorns', dragonBreath: 'death.attack.dragonBreath', witherRose: 'death.attack.witherRose', cramming: 'death.attack.cramming' }[d.source] ?? 'death.attack.generic';
    let t = l[key] ?? '%1$s died';
    const attacker = d.attacker ? this.game.entityDisplayName(d.attacker) : '';
    return t.replace('%1$s', this.name).replace('%2$s', attacker).replace('%s', this.name);
  }

  // ---------- hunger ----------
  addExhaustion(n: number): void { if (!this.invulnerableMode) this.exhaustion = Math.min(40, this.exhaustion + n); }
  canEat(ignoreHunger: boolean): boolean { return ignoreHunger || this.foodLevel < 20 || this.isCreative; }
  eatFood(points: number, saturation: number): void {
    this.foodLevel = Math.min(20, this.foodLevel + points);
    this.saturation = Math.min(this.foodLevel, this.saturation + points * saturation * 2);
  }
  private tickHunger(): void {
    if (this.invulnerableMode) return;
    const diff = this.game.difficulty;
    if (this.exhaustion > 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else if (diff !== 0) this.foodLevel = Math.max(0, this.foodLevel - 1);
    }
    const natural = this.game.rules.naturalRegeneration !== false;
    if (natural && this.saturation > 0 && this.health > 0 && this.health < this.maxHealth && this.foodLevel >= 20) {
      this.foodTickTimer++;
      if (this.foodTickTimer >= 10) { const heal = Math.min(this.saturation, 6); this.heal(heal / 6); this.addExhaustion(heal); this.foodTickTimer = 0; }
    } else if (natural && this.foodLevel >= 18 && this.health > 0 && this.health < this.maxHealth) {
      this.foodTickTimer++;
      if (this.foodTickTimer >= 80) { this.heal(1); this.addExhaustion(6); this.foodTickTimer = 0; }
    } else if (this.foodLevel <= 0) {
      this.foodTickTimer++;
      if (this.foodTickTimer >= 80) { if (this.health > 10 || diff === 3 || (this.health > 1 && diff === 2)) this.hurt({ amount: 1, source: 'starve', bypassArmor: true }); this.foodTickTimer = 0; }
    } else this.foodTickTimer = 0;
  }

  // ---------- xp ----------
  xpForLevel(level: number): number { return level >= 30 ? 112 + (level - 30) * 9 : level >= 15 ? 37 + (level - 15) * 5 : 7 + level * 2; }
  addXp(n: number): void {
    this.totalXp += n;
    this.xpProgress += n / this.xpForLevel(this.xpLevel);
    while (this.xpProgress >= 1) { this.xpProgress = (this.xpProgress - 1) * this.xpForLevel(this.xpLevel); this.xpLevel++; this.xpProgress /= this.xpForLevel(this.xpLevel); this.game.sounds.playAt('entity.player.levelup', this.x, this.y, this.z, 0.75, 1); }
    while (this.xpProgress < 0 && this.xpLevel > 0) { this.xpLevel--; this.xpProgress = 1 + this.xpProgress * this.xpForLevel(this.xpLevel + 1) / this.xpForLevel(this.xpLevel); }
    if (this.xpLevel === 0 && this.xpProgress < 0) this.xpProgress = 0;
  }
  addXpLevels(n: number): void { this.xpLevel = Math.max(0, this.xpLevel + n); if (this.xpLevel === 0) this.xpProgress = 0; }

  // ---------- tick ----------
  tick(): void {
    const g = this.game;
    this.prevCameraEye = this.cameraEye;
    if (this.sleeping) { this.sleepTimer++; this.moveForward = this.moveStrafe = 0; this.jumping = false; }
    else this.sleepTimer = 0;
    this.ticksSinceLastSleep++;
    for (const [k, v] of this.itemCooldowns) { if (v <= 1) this.itemCooldowns.delete(k); else this.itemCooldowns.set(k, v - 1); }
    if (this.breakCooldown > 0) this.breakCooldown--;
    if (this.useCooldown > 0) this.useCooldown--;
    this.attackCooldownTicks++;
    if (this.flyToggleTimer > 0) this.flyToggleTimer--;
    if (this.health <= 0) { super.tick(); return; }
    this.tickHunger();
    // eye height
    this.prevWalkDist = this.walkDist;
    const targetEye = this.sleeping ? 0.2 : this.swimmingPose || this.crawling ? 0.4 : this.isSneaking ? 1.27 : 1.62;
    this.eyeHeight = targetEye;
    this.cameraEye += (targetEye - this.cameraEye) * 0.35;
    // pose size
    const wantHeight = this.sleeping ? 0.2 : this.swimmingPose || this.crawling ? 0.6 : this.isSneaking ? 1.5 : 1.8;
    if (wantHeight !== this.height) { this.height = wantHeight; this.updateBB(); }
    // item use progress
    if (this.usingItem) {
      this.itemUseTicks++;
      const it = this.usingItem.item;
      if (it.food) {
        if (this.itemUseTicks % 4 === 0 && this.itemUseTicks > 4) { g.sounds.playAt('entity.generic.eat', this.x, this.y, this.z, 0.5 + 0.5 * Math.random(), 0.9 + Math.random() * 0.2); g.particles.spawnItemCrumbs(this, this.usingItem, 5); }
        if (this.itemUseTicks >= this.useDuration) this.finishUsing();
      }
    }
    // exhaustion from movement
    const dx = this.x - this.lastX, dz = this.z - this.lastZ; const dist = Math.hypot(dx, dz);
    if (this.inWater && !this.flying) this.addExhaustion(0.01 * dist); else if (this.isSprinting && this.onGround) this.addExhaustion(0.1 * dist);
    this.lastX = this.x; this.lastZ = this.z;
    super.tick();
    // vanilla Player.tick: bob amplitude follows the (post-friction) horizontal velocity while on the ground
    this.prevBob = this.bob;
    { const fb = this.onGround && !this.flying && !this.swimmingPose ? Math.min(0.1, Math.hypot(this.vx, this.vz)) : 0; this.bob += (fb - this.bob) * 0.4; }
    // vanilla Entity.move: walkDist accumulates whenever the entity moves horizontally (also mid-air)
    this.walkDist += Math.hypot(this.x - this.prevX, this.z - this.prevZ) * 0.6;
    // footsteps (vanilla: every ~1 block of walkDist) and sprinting particles
    if (this.onGround && !this.flying && !this.sleeping) {
      if (this.walkDist > this.nextStep) {
        this.nextStep = this.walkDist + 1;
        const bx = Math.floor(this.x), by = Math.floor(this.y - 0.2), bz = Math.floor(this.z);
        const s = this.world.getBlock(bx, by, bz);
        if (s !== 0 && !this.world.registry.isFluid(s) && !this.isSneaking) {
          const b = this.world.registry.block(s);
          if (this.inWater) g.sounds.playAt('entity.player.swim', this.x, this.y, this.z, 0.15, 1);
          else if (b.soundType !== 'none') g.sounds.playAt(`block.${b.soundType}.step`, this.x, this.y, this.z, 0.15, 1);
        }
      }
      if (this.isSprinting && this.age % 2 === 0) {
        const bx = Math.floor(this.x), by = Math.floor(this.y - 0.2), bz = Math.floor(this.z);
        const s = this.world.getBlock(bx, by, bz);
        if (s !== 0 && this.world.registry.collisionBoxes(s).length) g.particles.spawnBlockHit(bx, by, bz, 1, s);
      }
    }
    // step on pressure plates / tripwires
    g.redstone.entityStepped(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    g.redstone.entityStepped(Math.floor(this.x), Math.floor(this.y + 0.2), Math.floor(this.z));
    // pick up items
    if (this.health > 0 && !this.isSpectator) this.pickupItems();
    // portal
    this.checkPortal();
    // mining fatigue etc handled in speed
  }

  protected aiStep(): void {
    // input is applied by Game.updatePlayerInput each tick
  }

  protected fall(distance: number): void {
    if (this.invulnerableMode) return;
    super.fall(distance);
  }

  jump(): void {
    super.jump();
    this.addExhaustion(this.isSprinting ? 0.2 : 0.05);
  }

  getJumpPower(): number { return super.getJumpPower(); }

  /** Apply input each tick (called from Game). */
  applyInput(fwd: number, strafe: number, jump: boolean, sneak: boolean, sprintKey: boolean, sprintToggle: boolean, flyToggle: boolean): void {
    if (this.sleeping || this.health <= 0) { this.moveForward = this.moveStrafe = 0; this.jumping = false; return; }
    // riding a boat: the movement keys steer it, sneak dismounts
    if (this.vehicle instanceof BoatEntity) {
      const b = this.vehicle;
      this.isSneaking = false; this.isSprinting = false; this.moveForward = this.moveStrafe = 0; this.jumping = false;
      if (b.passengers[0] === this) { b.inputUp = fwd > 0; b.inputDown = fwd < 0; b.inputLeft = strafe > 0; b.inputRight = strafe < 0; }
      const c = this.game.client;
      if (c && !(this as any).isRemote) { const key = `${fwd}|${strafe}`; if (key !== this.lastBoatInput) { this.lastBoatInput = key; c.send({ t: 'boatInput', up: fwd > 0, down: fwd < 0, left: strafe > 0, right: strafe < 0 }); } }
      if (sneak) { if (c) c.send({ t: 'dismount' }); else b.ejectPassenger(this); }
      return;
    }
    const wasSneaking = this.isSneaking;
    this.isSneaking = sneak && !this.flying && !this.swimmingPose;
    if (this.isSneaking && !wasSneaking) { /* start */ }
    // unsneak blocked if no headroom
    if (!this.isSneaking && wasSneaking) { this.height = 1.8; this.updateBB(); if (this.collidesNow()) { this.isSneaking = true; this.height = 1.5; this.updateBB(); } }
    this.moveForward = fwd; this.moveStrafe = strafe;
    if (this.isSneaking) { this.moveForward *= 0.3; this.moveStrafe *= 0.3; }
    if (this.usingItem) { this.moveForward *= 0.2; this.moveStrafe *= 0.2; }
    this.jumping = jump;
    // sprinting
    const canSprint = fwd > 0 && (this.foodLevel > 6 || this.isCreative) && !this.isSneaking && !this.usingItem && !this.hasEffect('blindness');
    if (canSprint && (sprintKey || sprintToggle)) this.isSprinting = true;
    if (!canSprint || (this.horizontalCollision && !this.inWater && !this.jumping && this.isSprinting && this.age % 2 === 0 && Math.hypot(this.vx, this.vz) < 0.01)) this.isSprinting = false;
    if (this.horizontalCollision && this.isSprinting && !this.inWater) { /* vanilla stops sprint when hitting a wall */ this.isSprinting = false; }
    // flying toggle (double tap jump)
    if (flyToggle && (this.isCreative || this.isSpectator)) { if (!this.isSpectator) this.flying = !this.flying; }
    if (this.flying) {
      // vanilla: abilities.flyingSpeed (0.05) * 3 per tick, vertical drag 0.6
      const fs = this.isSpectator ? 0.1 : 0.05;
      if (jump) this.vy += fs * 3;
      if (sneak) this.vy -= fs * 3;
      this.isSneaking = false;
    }
    // swimming pose: starts only when sprinting with the head under water; continues while still in water
    const wantSwim = !this.flying && this.isSprinting && (this.swimmingPose ? this.inWater : (this.inWater && this.eyeInWater));
    if (wantSwim !== this.swimmingPose) { this.swimmingPose = wantSwim; this.height = wantSwim ? 0.6 : 1.8; this.updateBB(); if (!wantSwim && this.collidesNow()) { this.swimmingPose = true; this.height = 0.6; this.updateBB(); } }
    if (this.swimmingPose) this.isSneaking = false;
    // crawling: forced when stuck in 1-block gap
    if (!this.swimmingPose && !this.sleeping) { const wantCrawl = this.height === 0.6 || false; void wantCrawl; }
  }

  private eyeInWaterOrDeep(): boolean { const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.6), Math.floor(this.z)); return s !== 0 && this.world.registry.hasWater(s); }
  private collidesNow(): boolean { let hit = false; const bb = this.bb; this.world.forEachCollisionBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, (x0, y0, z0, x1, y1, z1) => { if (bb.minX < x1 && bb.maxX > x0 && bb.minY < y1 && bb.maxY > y0 && bb.minZ < z1 && bb.maxZ > z0) hit = true; }); return hit; }

  protected travel(): void {
    if (this.flying) {
      const speed = (this.isSpectator ? 0.1 : 0.05) * (this.isSprinting ? 2 : 1);
      this.moveRelative(this.moveForward, this.moveStrafe, speed);
      this.move(this.vx, this.vy, this.vz);
      this.vx *= 0.91; this.vy *= 0.6; this.vz *= 0.91;
      this.fallDistance = 0;
      if (this.onGround && !this.isSpectator && !this.jumping && this.moveForward === 0 && this.moveStrafe === 0 && this.age % 20 === 0 && this.vy <= 0) { /* vanilla keeps flying until you land deliberately */ }
      return;
    }
    if (this.swimmingPose && this.inWater) {
      // swim in look direction
      const d = lookDir(this.yaw, this.pitch);
      const sp = this.moveForward * 0.04 + (this.jumping ? 0.02 : 0);
      if (this.moveForward > 0) { this.vx += d[0] * sp; this.vy += d[1] * sp * 0.5; this.vz += d[2] * sp; }
      this.moveRelative(0, this.moveStrafe, 0.02);
      this.move(this.vx, this.vy, this.vz);
      this.vx *= 0.9; this.vz *= 0.9; this.vy *= 0.9;
      if (!this.jumping && this.moveForward === 0) this.vy -= 0.005;
      if (this.jumping) this.vy += 0.04;
      return;
    }
    super.travel();
  }

  // ---------- items ----------
  pickupItems(): void {
    const g = this.game;
    const bb = this.bb.clone().grow(1, 0.5, 1);
    for (const e of g.entities) {
      if (e.removed || !(e instanceof ItemEntity) || e.pickupDelay > 0 || !e.bb.intersects(bb)) continue;
      const before = e.stack.count;
      const left = this.inventory.add(e.stack);
      if (left < before) {
        g.sounds.playAt('entity.item.pickup', this.x, this.y, this.z, 0.2, ((Math.random() - Math.random()) * 0.7 + 1) * 2);
        g.onItemPickedUp(e, before - left);
        if (left <= 0) e.remove(); else e.stack.count = left;
      }
    }
    for (const e of g.entities) {
      if (e.removed || e.type !== 'experience_orb' || !e.bb.intersects(bb)) continue;
      this.addXp((e as any).value);
      g.sounds.playAt('entity.experience_orb.pickup', this.x, this.y, this.z, 0.1, (Math.random() - Math.random()) * 0.35 + 0.9);
      e.remove();
    }
  }

  equipArmor(stack: ItemStack): boolean {
    const slot = stack.item.armorSlot;
    if (!slot) return false;
    const idx = slot === 'head' ? 0 : slot === 'chest' ? 1 : slot === 'legs' ? 2 : 3;
    if (this.armor.get(idx)) return false;
    this.armor.set(idx, stack.split(1));
    this.game.sounds.playAt(armorSound(stack.item.name), this.x, this.y, this.z, 1, 1);
    return true;
  }

  dropHeld(all: boolean): void {
    const s = this.heldItem();
    if (!s) return;
    const drop = all ? s.split(s.count) : s.split(1);
    if (s.count <= 0) this.inventory.set(this.selectedSlot, null); else this.inventory.onChange?.();
    this.throwItem(drop);
    this.swing();
  }
  throwItem(stack: ItemStack): void {
    const d = lookDir(this.yaw, this.pitch);
    const e = new ItemEntity(stack);
    e.setPos(this.x, this.eyeY - 0.3, this.z);
    const f = 0.3;
    e.vx = d[0] * f + (Math.random() - 0.5) * 0.02; e.vy = d[1] * f + 0.1 + (Math.random() - 0.5) * 0.02; e.vz = d[2] * f + (Math.random() - 0.5) * 0.02;
    e.pickupDelay = 40; e.thrower = this.uuid;
    this.game.addEntity(e);
  }

  // ---------- targeting ----------
  raycast(): BlockHit | null {
    const d = lookDir(this.yaw, this.pitch);
    const reach = this.isCreative ? 5 : this.reachDistance;
    const held = this.heldItem();
    const fluids = !!held && (held.item.name === 'bucket' || held.item.name === 'glass_bottle' || held.item.name.endsWith('_boat') || held.item.name.endsWith('_raft'));
    return this.game.raycastBlocks(this.x, this.eyeY, this.z, d[0], d[1], d[2], reach, fluids);
  }

  // ---------- breaking ----------
  /** Damage a block per tick (survival) or instantly (creative). */
  continueBreaking(hit: BlockHit | null): void {
    const g = this.game, reg = this.world.registry;
    if (!hit || this.isSpectator) { this.stopBreaking(); return; }
    const s = this.world.getBlock(hit.x, hit.y, hit.z);
    if (s === 0 || reg.isFluid(s)) { this.stopBreaking(); return; }
    if (this.gameMode === 'adventure') { const held = this.heldItem(); if (!held?.extra?.canBreak?.includes(reg.nameOf(s))) return; }
    if (this.isCreative) {
      if (this.breakCooldown > 0) return;
      const n = reg.nameOf(s);
      if (n.endsWith('_sword') === false && this.heldItem()?.item.tool === 'sword') return;
      g.breakBlock(hit.x, hit.y, hit.z, this, false, false);
      this.breakCooldown = 5;
      this.swing();
      return;
    }
    if (!this.breaking || this.breaking.x !== hit.x || this.breaking.y !== hit.y || this.breaking.z !== hit.z || this.breaking.state !== s) {
      this.breaking = { x: hit.x, y: hit.y, z: hit.z, progress: 0, state: s };
    }
    const b = reg.block(s);
    if (b.hardness < 0) return;
    const speed = this.breakSpeed(s);
    const canHarvest = this.canHarvest(s);
    let dmg = b.hardness === 0 ? 1 : speed / b.hardness / (canHarvest ? 30 : 100);
    if (this.breakCooldown > 0 && b.hardness > 0) { return; }
    this.breaking.progress += dmg;
    if (this.age % 4 === 0) {
      g.sounds.playAt(`block.${b.soundType}.hit`, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.25, 0.5);
      g.particles.spawnBlockHit(hit.x, hit.y, hit.z, hit.face, s);
    }
    this.swing();
    if (this.breaking.progress >= 1) {
      g.breakBlock(hit.x, hit.y, hit.z, this, true, false);
      this.breaking = null;
      this.breakCooldown = 5;
      this.addExhaustion(0.005);
    }
  }
  stopBreaking(): void { this.breaking = null; }
  get breakStage(): number { return this.breaking ? Math.min(9, Math.floor(this.breaking.progress * 10)) : -1; }

  breakSpeed(state: number): number {
    const reg = this.world.registry, g = this.game;
    const b = reg.block(state);
    const held = this.heldItem();
    let speed = 1;
    if (held) {
      const mats = b.material.split(';');
      for (const m of mats) { const t = g.assets.mcdata.materials[m]; if (t && t[held.item.id] !== undefined) speed = Math.max(speed, t[held.item.id]); }
      if (speed === 1 && held.item.tool !== 'none' && held.item.tool !== 'shears') {
        const tag = held.item.tool === 'pickaxe' ? 'mineable/pickaxe' : held.item.tool === 'axe' ? 'mineable/axe' : held.item.tool === 'shovel' ? 'mineable/shovel' : held.item.tool === 'hoe' ? 'mineable/hoe' : '';
        if (tag && g.items.blockTag(tag).has(b.name)) speed = TIER_SPEED[held.item.tier];
        if (held.item.tool === 'sword' && (b.name === 'cobweb' || b.name === 'bamboo')) speed = 15;
      }
      if (speed > 1) { const eff = held.enchantLevel('efficiency'); if (eff > 0) speed += eff * eff + 1; }
    }
    if (this.hasEffect('haste')) speed *= 1 + 0.2 * this.effectLevel('haste');
    if (this.hasEffect('mining_fatigue')) speed *= Math.pow(0.3, this.effectLevel('mining_fatigue'));
    if (this.eyeInWater && (this.armor.get(0)?.enchantLevel('aqua_affinity') ?? 0) === 0) speed /= 5;
    if (!this.onGround) speed /= 5;
    return speed;
  }

  canHarvest(state: number): boolean {
    const reg = this.world.registry, g = this.game;
    const b = reg.block(state);
    const held = this.heldItem();
    if (b.harvestTools) return !!held && b.harvestTools.has(held.item.id);
    // tag-based tier requirements
    const need = g.items.blockTag('needs_diamond_tool').has(b.name) ? 3 : g.items.blockTag('needs_iron_tool').has(b.name) ? 2 : g.items.blockTag('needs_stone_tool').has(b.name) ? 1 : 0;
    if (need > 0) {
      if (!held || held.item.tool === 'none') return false;
      const tag = held.item.tool === 'pickaxe' ? 'mineable/pickaxe' : held.item.tool === 'axe' ? 'mineable/axe' : held.item.tool === 'shovel' ? 'mineable/shovel' : held.item.tool === 'hoe' ? 'mineable/hoe' : '';
      if (!tag || !g.items.blockTag(tag).has(b.name)) return false;
      return TIER_LEVEL[held.item.tier] >= need;
    }
    return true;
  }

  // ---------- interaction ----------
  /** Right click. Returns true if something happened. */
  use(hit: BlockHit | null): boolean {
    const g = this.game, reg = this.world.registry, world = this.world;
    if (this.isSpectator || this.sleeping || this.health <= 0) return false;
    if (this.useCooldown > 0) return false;
    const held = this.heldItem();
    // block interaction first (unless sneaking with an item)
    if (hit) {
      const state = world.getBlock(hit.x, hit.y, hit.z);
      if (!(this.isSneaking && held)) {
        if (g.client && !(this as any).isRemote) {
          // multiplayer guest: the host runs the interaction (and opens container GUIs for us); simple toggles are also
          // predicted locally so doors/buttons feel instant
          const n = reg.nameOf(state);
          g.client.send({ t: 'use', x: hit.x, y: hit.y, z: hit.z, face: hit.face, hit: [hit.hx, hit.hy, hit.hz], held: held?.serialize() ?? null });
          if (HOST_ONLY_BLOCKS.test(n)) { this.useCooldown = 4; this.swing(); return true; }
        }
        if (useBlock(g, hit.x, hit.y, hit.z, state, hit.face, [hit.hx, hit.hy, hit.hz], this)) { this.useCooldown = 4; this.swing(); return true; }
      }
    }
    // item use on block
    if (held) {
      const r = this.useItemOnBlock(held, hit);
      if (r) { this.useCooldown = 4; return true; }
      const r2 = this.useItem(held, this.selectedSlot);
      if (r2) { this.useCooldown = 4; return true; }
    }
    const off = this.offhandItem();
    if (off) { const r = this.useItemOnBlock(off, hit, true) || this.useItem(off, -1); if (r) { this.useCooldown = 4; return true; } }
    return false;
  }

  private useItemOnBlock(stack: ItemStack, hit: BlockHit | null, offhand = false): boolean {
    const g = this.game, reg = this.world.registry, world = this.world;
    const item = stack.item;
    const n = item.name;
    const consume = () => { if (!this.isCreative) { stack.count--; if (stack.count <= 0) (offhand ? this.offhand : this.inventory).set(offhand ? 0 : this.selectedSlot, null); } (offhand ? this.offhand : this.inventory).onChange?.(); };
    if (!hit) {
      // buckets on fluids are handled by fluid raycast (hit present)
      return false;
    }
    // boats & rafts: placed on the hit point (vanilla BoatItem, fluid-aware raycast)
    if (n.endsWith('_boat') || n.endsWith('_raft')) {
      const bx = hit.x + hit.hx, bz = hit.z + hit.hz; let by = hit.y + hit.hy;
      const ts = world.getBlock(hit.x, hit.y, hit.z);
      if (ts && reg.hasWater(ts)) by = hit.y + 1 - 0.05; else if (hit.face === 1) by = hit.y + 1;
      const m = /^(.*?)_(chest_)?(boat|raft)$/.exec(n)!;
      const boat = new BoatEntity(m[1], !!m[2]);
      boat.setPos(bx, by, bz); boat.yaw = this.yaw;
      if (this.game.entities.some((e) => !e.removed && e !== this && e.bb.intersects(boat.bb))) return false;
      this.game.addEntity(boat);
      this.game.sounds.playAt('entity.boat.paddle_land', bx, by, bz, 0, 1);
      consume(); this.swing();
      return true;
    }
    const target = world.getBlock(hit.x, hit.y, hit.z);
    const tn = target ? reg.nameOf(target) : 'air';
    if (this.gameMode === 'adventure' && !stack.extra?.canPlaceOn) return false;
    // buckets
    if (n === 'bucket') {
      if (target !== 0 && (reg.isFluid(target) && reg.fluidLevel(target) === 0 || reg.isWaterlogged(target) && !reg.implicitWater[reg.stateBlock[target]])) {
        const lava = reg.isLava(target);
        if (reg.isWaterlogged(target) && !reg.isFluid(target)) world.setBlock(hit.x, hit.y, hit.z, reg.withProp(target, 'waterlogged', 'false'));
        else world.setBlock(hit.x, hit.y, hit.z, 0);
        g.sounds.playAt(lava ? 'item.bucket.fill_lava' : 'item.bucket.fill', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1);
        const full = new ItemStack(g.items.get(lava ? 'lava_bucket' : 'water_bucket')!, 1);
        if (!this.isCreative) { stack.count--; if (stack.count <= 0) (offhand ? this.offhand : this.inventory).set(offhand ? 0 : this.selectedSlot, full); else g.givePlayer(full); this.inventory.onChange?.(); }
        return true;
      }
      if (tn === 'powder_snow') { world.setBlock(hit.x, hit.y, hit.z, 0); g.sounds.playAt('item.bucket.fill_powder_snow', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); const full = new ItemStack(g.items.get('powder_snow_bucket')!, 1); if (!this.isCreative) { stack.count--; if (stack.count <= 0) this.inventory.set(this.selectedSlot, full); else g.givePlayer(full); this.inventory.onChange?.(); } return true; }
      return false;
    }
    if (n === 'water_bucket' || n === 'lava_bucket' || n === 'powder_snow_bucket' || n.endsWith('_bucket') && ['cod', 'salmon', 'pufferfish', 'tropical_fish', 'axolotl', 'tadpole'].includes(n.replace('_bucket', ''))) {
      const isWater = n !== 'lava_bucket' && n !== 'powder_snow_bucket';
      const [dx, dy, dz] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][hit.face];
      let px = hit.x, py = hit.y, pz = hit.z;
      let cur = target;
      const waterloggable = target !== 0 && reg.hasProp(target, 'waterlogged') && !reg.isWaterlogged(target) && isWater;
      if (!waterloggable && !isReplaceable(reg, target)) { px += dx; py += dy; pz += dz; cur = world.getBlock(px, py, pz); }
      if (waterloggable) { world.setBlock(px, py, pz, reg.withProp(target, 'waterlogged', 'true')); }
      else {
        if (!isReplaceable(reg, cur) && !(cur !== 0 && reg.hasProp(cur, 'waterlogged') && isWater)) return false;
        if (cur !== 0 && reg.hasProp(cur, 'waterlogged') && isWater) world.setBlock(px, py, pz, reg.withProp(cur, 'waterlogged', 'true'));
        else if (world.dimension === 'the_nether' && isWater) { g.sounds.playAt('block.fire.extinguish', px + 0.5, py + 0.5, pz + 0.5, 0.5, 2.6); g.particles.spawnSmoke(px + 0.5, py + 1, pz + 0.5, 8); }
        else { if (cur !== 0 && !reg.isFluid(cur) && !reg.isAir(cur)) g.breakBlock(px, py, pz, null, true, true); world.setBlock(px, py, pz, reg.defaultState(n === 'lava_bucket' ? 'lava' : n === 'powder_snow_bucket' ? 'powder_snow' : 'water')); }
      }
      if (n !== 'water_bucket' && n !== 'lava_bucket' && n !== 'powder_snow_bucket') g.spawnMob(n.replace('_bucket', ''), px + 0.5, py, pz + 0.5, false);
      g.sounds.playAt(n === 'lava_bucket' ? 'item.bucket.empty_lava' : n === 'powder_snow_bucket' ? 'item.bucket.empty_powder_snow' : 'item.bucket.empty', px + 0.5, py + 0.5, pz + 0.5, 1, 1);
      if (!this.isCreative) (offhand ? this.offhand : this.inventory).set(offhand ? 0 : this.selectedSlot, new ItemStack(g.items.get('bucket')!, 1));
      return true;
    }
    if (n === 'glass_bottle' && target !== 0 && reg.hasWater(target)) { consume(); g.givePlayer(new ItemStack(g.items.get('potion')!, 1, 0, [], null, { potion: 'water' })); g.sounds.playAt('item.bottle.fill', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); return true; }
    // tools on blocks
    if (item.tool === 'hoe' && (tn === 'dirt' || tn === 'grass_block' || tn === 'dirt_path' || tn === 'coarse_dirt' || tn === 'rooted_dirt') && hit.face !== 0) {
      const above = world.getBlock(hit.x, hit.y + 1, hit.z);
      if (above === 0) { world.setBlock(hit.x, hit.y, hit.z, reg.defaultState(tn === 'coarse_dirt' ? 'dirt' : 'farmland')); if (tn === 'rooted_dirt') { world.setBlock(hit.x, hit.y, hit.z, reg.DIRT); g.dropItem(hit.x + 0.5, hit.y + 1, hit.z + 0.5, new ItemStack(g.items.get('hanging_roots')!, 1)); } g.sounds.playAt('item.hoe.till', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); this.swing(); return true; }
    }
    if (item.tool === 'shovel' && (tn === 'grass_block' || tn === 'dirt' || tn === 'coarse_dirt' || tn === 'podzol' || tn === 'mycelium' || tn === 'rooted_dirt') && hit.face !== 0 && world.getBlock(hit.x, hit.y + 1, hit.z) === 0) { world.setBlock(hit.x, hit.y, hit.z, reg.defaultState('dirt_path')); g.sounds.playAt('item.shovel.flatten', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); this.swing(); return true; }
    if (item.tool === 'shovel' && (tn === 'campfire' || tn === 'soul_campfire') && reg.getProps(target).lit === 'true') { world.setBlock(hit.x, hit.y, hit.z, reg.withProp(target, 'lit', 'false')); g.sounds.playAt('block.fire.extinguish', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); return true; }
    if (item.tool === 'axe') {
      const stripped = tn.startsWith('stripped_') ? null : (tn.endsWith('_log') || tn.endsWith('_wood') || tn.endsWith('_stem') && !tn.includes('melon') && !tn.includes('pumpkin') || tn.endsWith('_hyphae') || tn === 'bamboo_block') ? 'stripped_' + tn : null;
      if (stripped && reg.blockByName(stripped)) { world.setBlock(hit.x, hit.y, hit.z, reg.stateWith(reg.blockByName(stripped)!, { ...reg.getProps(target) })); g.sounds.playAt('item.axe.strip', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); this.swing(); return true; }
      if (tn.includes('copper') && !tn.includes('ore') && !tn.includes('raw')) {
        const next = tn.startsWith('waxed_') ? tn.slice(6) : tn.startsWith('oxidized_') ? tn.replace('oxidized_', 'weathered_') : tn.startsWith('weathered_') ? tn.replace('weathered_', 'exposed_') : tn.startsWith('exposed_') ? tn.replace('exposed_', '') : null;
        if (next && reg.blockByName(next)) { world.setBlock(hit.x, hit.y, hit.z, reg.stateWith(reg.blockByName(next)!, { ...reg.getProps(target) })); g.sounds.playAt(tn.startsWith('waxed_') ? 'item.axe.wax_off' : 'item.axe.scrape', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); this.swing(); return true; }
      }
    }
    if (n === 'honeycomb' && tn.includes('copper') && !tn.startsWith('waxed_') && !tn.includes('ore') && reg.blockByName('waxed_' + tn)) { world.setBlock(hit.x, hit.y, hit.z, reg.stateWith(reg.blockByName('waxed_' + tn)!, { ...reg.getProps(target) })); g.sounds.playAt('item.honeycomb.wax_on', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); consume(); return true; }
    if (n === 'bone_meal') { if (target !== 0 && g.blocks.boneMeal(hit.x, hit.y, hit.z, target)) { consume(); g.sounds.playAt('item.bone_meal.use', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); g.particles.spawnHappyVillager(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 15); this.swing(); return true; } return false; }
    if (n === 'flint_and_steel' || n === 'fire_charge') {
      if (tn === 'tnt') { g.igniteTnt(hit.x, hit.y, hit.z); if (n === 'flint_and_steel') this.damageHeld(stack, 1); else consume(); return true; }
      if ((tn === 'campfire' || tn === 'soul_campfire' || tn === 'candle' || tn.endsWith('_candle') || tn.endsWith('candle_cake')) && reg.getProps(target).lit === 'false') { world.setBlock(hit.x, hit.y, hit.z, reg.withProp(target, 'lit', 'true')); g.sounds.playAt('item.flintandsteel.use', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); if (n === 'flint_and_steel') this.damageHeld(stack, 1); else consume(); return true; }
      const [dx, dy, dz] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][hit.face];
      const fx = hit.x + dx, fy = hit.y + dy, fz = hit.z + dz;
      if (world.getBlock(fx, fy, fz) === 0) {
        if (tn === 'obsidian' && g.tryCreatePortal(fx, fy, fz)) { if (n === 'flint_and_steel') this.damageHeld(stack, 1); else consume(); return true; }
        world.setBlock(fx, fy, fz, g.blocks.fireStateFor(fx, fy, fz)); g.sounds.playAt(n === 'flint_and_steel' ? 'item.flintandsteel.use' : 'item.firecharge.use', fx + 0.5, fy + 0.5, fz + 0.5, 1, 0.8 + Math.random() * 0.4); if (n === 'flint_and_steel') this.damageHeld(stack, 1); else consume(); this.swing(); return true;
      }
      return false;
    }
    if (n.endsWith('_spawn_egg')) { const [dx, dy, dz] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][hit.face]; g.spawnMob(n.replace('_spawn_egg', ''), hit.x + dx + 0.5, hit.y + dy, hit.z + dz + 0.5, false); consume(); return true; }
    if (n === 'shears' && (tn === 'pumpkin')) { const carved = reg.stateWith(reg.blockByName('carved_pumpkin')!, { facing: oppositeFacing(hit.face >= 2 ? ['down', 'up', 'north', 'south', 'west', 'east'][hit.face] : this.horizontalFacing()) }); world.setBlock(hit.x, hit.y, hit.z, reg.withProp(carved, 'facing', hit.face >= 2 ? ['down', 'up', 'north', 'south', 'west', 'east'][hit.face] : this.horizontalFacing())); g.dropItem(hit.x + 0.5, hit.y + 1, hit.z + 0.5, new ItemStack(g.items.get('pumpkin_seeds')!, 4)); g.sounds.playAt('block.pumpkin.carve', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 1, 1); this.damageHeld(stack, 1); return true; }
    if (n === 'shears' && tn === 'beehive' || tn === 'bee_nest') { if (n === 'shears' && reg.getProps(target).honey_level === '5') { world.setBlock(hit.x, hit.y, hit.z, reg.withProp(target, 'honey_level', '0')); g.dropItem(hit.x + 0.5, hit.y + 1, hit.z + 0.5, new ItemStack(g.items.get('honeycomb')!, 3)); this.damageHeld(stack, 1); return true; } if (n === 'glass_bottle' && reg.getProps(target).honey_level === '5') { world.setBlock(hit.x, hit.y, hit.z, reg.withProp(target, 'honey_level', '0')); consume(); g.givePlayer(new ItemStack(g.items.get('honey_bottle')!, 1)); return true; } }
    // seeds / crops
    const cropFor: Record<string, string> = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots', melon_seeds: 'melon_stem', pumpkin_seeds: 'pumpkin_stem', torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop', nether_wart: 'nether_wart', cocoa_beans: 'cocoa', sweet_berries: 'sweet_berry_bush', glow_berries: 'cave_vines', kelp: 'kelp', bamboo: 'bamboo_sapling', redstone: 'redstone_wire', string: 'tripwire', wheat: '', flower_pot: 'flower_pot', cake: 'cake', bucket: '', sugar_cane: 'sugar_cane', seagrass: 'seagrass', sea_pickle: 'sea_pickle' };
    let blockName = item.blockName;
    if (!blockName && cropFor[n]) blockName = cropFor[n];
    if (n === 'kelp') blockName = 'kelp';
    if (!blockName && (n.endsWith('_head') || n.endsWith('_skull')) && reg.blockByName(n)) blockName = n;
    if (blockName === 'cave_vines') { const above = world.getBlock(hit.x, hit.y, hit.z); void above; blockName = null; }
    if (blockName && reg.blockByName(blockName)) {
      if (blockName === 'redstone_wire' || blockName === 'tripwire' || blockName === 'kelp' || blockName === 'bamboo_sapling' || cropFor[n] === blockName || blockName === 'sea_pickle') { /* handled by generic placement with canSurvive */ }
      return this.placeBlock(stack, blockName, hit, offhand);
    }
    return false;
  }

  placeBlock(stack: ItemStack, blockName: string, hit: BlockHit, offhand = false): boolean {
    const g = this.game, reg = this.world.registry, world = this.world;
    if (hit.y < MIN_Y || hit.y >= MAX_Y) return false;
    const targetState = world.getBlock(hit.x, hit.y, hit.z);
    const placement = getPlacement(blockName, { world, reg, cx: hit.x, cy: hit.y, cz: hit.z, face: hit.face, hx: hit.hx, hy: hit.hy, hz: hit.hz, yaw: this.yaw, pitch: this.pitch, playerX: this.x, playerY: this.y, playerZ: this.z, sneaking: this.isSneaking, inWater: targetState !== 0 && reg.isWater(targetState) });
    if (!placement) return false;
    // entity collision check
    const all = [placement, ...(placement.extra ?? [])];
    for (const p of all) {
      if (p.y < MIN_Y || p.y >= MAX_Y) return false;
      const boxes = reg.collisionBoxes(p.state);
      for (const b of boxes) {
        const x0 = p.x + b[0], y0 = p.y + b[1], z0 = p.z + b[2], x1 = p.x + b[3], y1 = p.y + b[4], z1 = p.z + b[5];
        for (const e of g.livingEntitiesIncludingPlayer()) {
          if (e.removed) continue;
          if (e.bb.minX < x1 && e.bb.maxX > x0 && e.bb.minY < y1 && e.bb.maxY > y0 && e.bb.minZ < z1 && e.bb.maxZ > z0) return false;
        }
      }
    }
    const kelp = blockName === 'kelp';
    for (const p of all) {
      const old = world.getBlock(p.x, p.y, p.z);
      if (old !== 0 && !reg.isFluid(old) && !reg.isAir(old) && !placement.replace) g.breakBlock(p.x, p.y, p.z, null, true, true);
      else if (old !== 0 && !reg.isFluid(old) && !reg.isAir(old) && reg.block(old) !== reg.block(p.state)) g.breakBlock(p.x, p.y, p.z, null, true, true);
      let st = p.state;
      if (kelp && old !== 0 && reg.isWater(old)) { /* kelp needs water */ }
      st = updateConnections(reg, world, p.x, p.y, p.z, st);
      world.setBlock(p.x, p.y, p.z, st, SET_UPDATE_NEIGHBORS);
      // neighbours' connections
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) { const ns = world.getBlock(p.x + dx, p.y + dy, p.z + dz); if (ns !== 0) { const u = updateConnections(reg, world, p.x + dx, p.y + dy, p.z + dz, ns); if (u !== ns) world.setBlock(p.x + dx, p.y + dy, p.z + dz, u, 0); } }
    }
    const b = reg.block(placement.state);
    g.sounds.playAt(`block.${b.soundType}.place`, placement.x + 0.5, placement.y + 0.5, placement.z + 0.5, 1, 0.8);
    if (b.name === 'redstone_wire' || b.name.includes('redstone') || b.name === 'lever' || b.name === 'observer' || b.name === 'repeater' || b.name === 'comparator') g.redstone.sourceChanged(placement.x, placement.y, placement.z);
    if (!this.isCreative) { stack.count--; if (stack.count <= 0) (offhand ? this.offhand : this.inventory).set(offhand ? 0 : this.selectedSlot, null); }
    (offhand ? this.offhand : this.inventory).onChange?.();
    this.swing();
    g.onBlockPlaced(placement.x, placement.y, placement.z, placement.state);
    return true;
  }

  /** Use an item in the air / start using (eat, bow, throw). */
  private useItem(stack: ItemStack, slot: number): boolean {
    const g = this.game;
    const item = stack.item;
    const n = item.name;
    if (this.itemCooldowns.has(n)) return false;
    const consume = () => { if (!this.isCreative) { stack.count--; if (stack.count <= 0) { if (slot < 0) this.offhand.set(0, null); else this.inventory.set(slot, null); } } this.inventory.onChange?.(); this.offhand.onChange?.(); };
    if (item.food) {
      if (!this.canEat(item.food.alwaysEat)) return false;
      this.startUsing(stack, item.food.fast ? 16 : 32); return true;
    }
    if (n === 'milk_bucket' || n === 'potion' || n === 'honey_bottle') { this.startUsing(stack, n === 'honey_bottle' ? 40 : 32); return true; }
    if (n === 'bow') { if (this.isCreative || this.findArrow()) { this.startUsing(stack, 72000); return true; } return false; }
    if (n === 'crossbow') { if (stack.extra.charged) { this.shootArrow(stack, 3.15, false); stack.extra.charged = false; this.inventory.onChange?.(); return true; } if (this.isCreative || this.findArrow()) { this.startUsing(stack, 25); return true; } return false; }
    if (n === 'trident') { this.startUsing(stack, 72000); return true; }
    if (n === 'shield') { this.startUsing(stack, 72000); return true; }
    if (n === 'snowball' || n === 'egg' || n === 'ender_pearl' || n === 'splash_potion' || n === 'lingering_potion' || n === 'experience_bottle' || n === 'fire_charge' || n === 'wind_charge') {
      const d = lookDir(this.yaw, this.pitch);
      const p = new ThrownProjectile(n === 'fire_charge' ? 'fire_charge' : n, this, stack.clone());
      p.setPos(this.x, this.eyeY - 0.1, this.z);
      const sp = n === 'ender_pearl' || n === 'experience_bottle' ? 1.5 : n === 'splash_potion' ? 0.5 : 1.5;
      p.vx = d[0] * sp; p.vy = d[1] * sp + 0.05 * (n === 'splash_potion' || n === 'experience_bottle' ? 1 : 0); p.vz = d[2] * sp;
      g.addEntity(p);
      g.sounds.playAt(n === 'egg' ? 'entity.egg.throw' : n === 'ender_pearl' ? 'entity.ender_pearl.throw' : n === 'experience_bottle' ? 'entity.experience_bottle.throw' : n.includes('potion') ? 'entity.splash_potion.throw' : 'entity.snowball.throw', this.x, this.y, this.z, 0.5, 0.4 / (Math.random() * 0.4 + 0.8));
      consume();
      if (n === 'ender_pearl') this.itemCooldowns.set(n, 20);
      this.swing();
      return true;
    }
    if (n === 'elytra' || n === 'totem_of_undying' || n === 'map' || n === 'compass' || n === 'clock') return false;
    if (n === 'writable_book' || n === 'written_book' || n === 'book') return false;
    if (n === 'chorus_fruit') { this.startUsing(stack, 32); return true; }
    if (n === 'firework_rocket') { if (this.fallFlying) { this.vx += lookDir(this.yaw, this.pitch)[0] * 0.5; this.vy += lookDir(this.yaw, this.pitch)[1] * 0.5; this.vz += lookDir(this.yaw, this.pitch)[2] * 0.5; consume(); return true; } return false; }
    if (n === 'goat_horn') { g.sounds.playAt('item.goat_horn.sound.0', this.x, this.y, this.z, 16, 1); this.itemCooldowns.set(n, 140); return true; }
    if (n === 'spyglass') { g.gui.spyglass = true; this.startUsing(stack, 72000); return true; }
    return false;
  }

  startUsing(stack: ItemStack, duration: number): void { this.usingItem = stack; this.itemUseTicks = 0; this.useDuration = duration; }
  stopUsing(): void {
    if (!this.usingItem) return;
    const n = this.usingItem.item.name;
    if (n === 'bow') { const charge = Math.min(1, this.itemUseTicks / 20); const power = (charge * charge + charge * 2) / 3; if (power >= 0.1) this.shootArrow(this.usingItem, power * 3, power >= 1); }
    else if (n === 'crossbow') { if (this.itemUseTicks >= 25) { this.usingItem.extra.charged = true; this.game.sounds.playAt('item.crossbow.loading_end', this.x, this.y, this.z, 1, 1); if (!this.isCreative) this.findArrow(true); this.inventory.onChange?.(); } }
    else if (n === 'trident') { if (this.itemUseTicks >= 10) { const a = new ArrowEntity(this, 8, 'normal'); (a as any).trident = this.usingItem.clone(); (a as any).type = 'trident'; const d = lookDir(this.yaw, this.pitch); a.setPos(this.x, this.eyeY - 0.1, this.z); a.vx = d[0] * 2.5; a.vy = d[1] * 2.5; a.vz = d[2] * 2.5; this.game.addEntity(a); this.game.sounds.playAt('item.trident.throw', this.x, this.y, this.z, 1, 1); if (!this.isCreative) { this.inventory.set(this.selectedSlot, null); } } }
    this.usingItem = null; this.itemUseTicks = 0; this.game.gui.spyglass = false;
  }
  private finishUsing(): void {
    const s = this.usingItem!;
    const item = s.item, n = item.name;
    const g = this.game;
    if (item.food) {
      this.eatFood(item.food.points, item.food.saturation);
      g.sounds.playAt('entity.player.burp', this.x, this.y, this.z, 0.5, Math.random() * 0.1 + 0.9);
      const effects: Record<string, [string, number, number][]> = { golden_apple: [['regeneration', 1, 100], ['absorption', 0, 2400]], enchanted_golden_apple: [['regeneration', 1, 400], ['absorption', 3, 2400], ['resistance', 0, 6000], ['fire_resistance', 0, 6000]], rotten_flesh: Math.random() < 0.8 ? [['hunger', 0, 600]] : [], spider_eye: [['poison', 0, 100]], pufferfish: [['poison', 1, 1200], ['hunger', 2, 300], ['nausea', 0, 300]], poisonous_potato: Math.random() < 0.6 ? [['poison', 0, 100]] : [], chicken: Math.random() < 0.3 ? [['hunger', 0, 600]] : [], suspicious_stew: [['regeneration', 0, 160]], chorus_fruit: [] };
      for (const [id, amp, dur] of effects[n] ?? []) this.addEffect({ id, amplifier: amp, duration: dur });
      if (n === 'chorus_fruit') { for (let i = 0; i < 16; i++) { const tx = this.x + (Math.random() - 0.5) * 16, ty = clamp(this.y + Math.floor(Math.random() * 16) - 8, MIN_Y, MAX_Y - 1), tz = this.z + (Math.random() - 0.5) * 16; if (g.canStandAt(tx, ty, tz)) { this.setPos(tx, ty, tz); g.sounds.playAt('item.chorus_fruit.teleport', tx, ty, tz, 1, 1); break; } } this.itemCooldowns.set(n, 20); }
      const container = n.endsWith('_stew') || n === 'beetroot_soup' || n === 'suspicious_stew' ? 'bowl' : null;
      if (!this.isCreative) { s.count--; if (s.count <= 0) this.inventory.set(this.selectedSlot, null); if (container) g.givePlayer(new ItemStack(g.items.get(container)!, 1)); }
    } else if (n === 'milk_bucket') { this.effects = []; this.absorption = 0; if (!this.isCreative) this.replaceHeld(new ItemStack(g.items.get('bucket')!, 1)); }
    else if (n === 'potion') { const e = s.extra?.effect; if (e) this.addEffect({ id: e.id, amplifier: e.amplifier, duration: e.duration }); if (!this.isCreative) this.replaceHeld(new ItemStack(g.items.get('glass_bottle')!, 1)); g.sounds.playAt('entity.generic.drink', this.x, this.y, this.z, 0.5, 1); }
    else if (n === 'honey_bottle') { this.eatFood(6, 0.1); this.removeEffect('poison'); if (!this.isCreative) this.replaceHeld(new ItemStack(g.items.get('glass_bottle')!, 1)); }
    this.inventory.onChange?.();
    this.usingItem = null; this.itemUseTicks = 0;
  }

  private findArrow(consume = false): ItemStack | null {
    const off = this.offhandItem();
    if (off && off.item.name.endsWith('arrow')) { if (consume && !this.isCreative && (this.heldItem()?.enchantLevel('infinity') ?? 0) === 0) { off.count--; if (off.count <= 0) this.offhand.set(0, null); } return off; }
    const i = this.inventory.findSlot((s) => s.item.name.endsWith('arrow'));
    if (i < 0) return null;
    const s = this.inventory.get(i)!;
    if (consume && !this.isCreative && (this.heldItem()?.enchantLevel('infinity') ?? 0) === 0) { s.count--; if (s.count <= 0) this.inventory.set(i, null); }
    return s;
  }

  private shootArrow(bow: ItemStack, speed: number, critical: boolean): void {
    const g = this.game;
    const arrowStack = this.findArrow(false);
    if (!arrowStack && !this.isCreative) return;
    const d = lookDir(this.yaw, this.pitch);
    const a = new ArrowEntity(this, 2 + bow.enchantLevel('power') * 0.5 + (bow.enchantLevel('power') > 0 ? 0.5 : 0), arrowStack?.item.name === 'spectral_arrow' ? 'spectral' : arrowStack?.item.name === 'tipped_arrow' ? 'tipped' : 'normal');
    if (arrowStack?.extra?.effect) (a as any).effect = arrowStack.extra.effect;
    a.setPos(this.x, this.eyeY - 0.1, this.z);
    const spread = 1 * 0.0172 * 0.5;
    a.vx = d[0] * speed + (Math.random() - 0.5) * spread; a.vy = d[1] * speed + (Math.random() - 0.5) * spread; a.vz = d[2] * speed + (Math.random() - 0.5) * spread;
    a.critical = critical; a.knockback = bow.enchantLevel('punch'); a.fire = bow.enchantLevel('flame') > 0;
    a.pickup = !this.isCreative && bow.enchantLevel('infinity') === 0;
    g.addEntity(a);
    g.sounds.playAt(bow.item.name === 'crossbow' ? 'item.crossbow.shoot' : 'entity.arrow.shoot', this.x, this.y, this.z, 1, 1 / (Math.random() * 0.4 + 1.2) + speed / 3 * 0.5);
    this.findArrow(true);
    this.damageHeld(bow, 1);
  }

  damageHeld(stack: ItemStack, n: number): void {
    if (this.isCreative) return;
    if (stack.hurt(n)) {
      this.game.sounds.playAt('entity.item.break', this.x, this.y, this.z, 0.8, 0.8 + Math.random() * 0.4);
      this.game.particles.spawnItemBreak(this.x, this.eyeY - 0.3, this.z, stack.item.name, 5);
      if (this.inventory.get(this.selectedSlot) === stack) this.inventory.set(this.selectedSlot, null);
      else if (this.offhand.get(0) === stack) this.offhand.set(0, null);
    }
    this.inventory.onChange?.();
  }

  // ---------- attacking ----------
  attack(target: LivingEntity): void {
    const g = this.game;
    if (this.isSpectator) return;
    const held = this.heldItem();
    let dmg = held ? held.item.attackDamage : 1;
    const speed = held ? held.item.attackSpeed : 4;
    const cd = clamp((this.attackCooldownTicks + 0.5) / (20 / speed), 0, 1);
    dmg *= 0.2 + cd * cd * 0.8;
    if (this.hasEffect('strength')) dmg += 3 * this.effectLevel('strength');
    if (this.hasEffect('weakness')) dmg -= 4 * this.effectLevel('weakness');
    let enchDmg = 0;
    if (held) { enchDmg += held.enchantLevel('sharpness') > 0 ? 0.5 + held.enchantLevel('sharpness') * 0.5 : 0; if ((target as any).undead) enchDmg += held.enchantLevel('smite') * 2.5; if ((target as any).arthropod) enchDmg += held.enchantLevel('bane_of_arthropods') * 2.5; }
    const crit = cd > 0.9 && this.fallDistance > 0 && !this.onGround && !this.isClimbing() && !this.inWater && !this.hasEffect('blindness') && !this.isSprinting;
    if (crit) dmg *= 1.5;
    dmg += enchDmg;
    let kb = (held?.enchantLevel('knockback') ?? 0);
    if (this.isSprinting && cd > 0.9) { kb++; this.isSprinting = false; }
    const hurt = target.hurt({ amount: Math.max(0, dmg), source: 'attack', attacker: this });
    if (hurt) {
      // vanilla Player.attack: extra knockback (sprint / Knockback enchant) along the attacker's look direction,
      // and the attacker is slowed down
      if (kb > 0) { const yr = this.yaw * Math.PI / 180; target.knockback(kb * 0.5, Math.sin(yr), -Math.cos(yr)); this.vx *= 0.6; this.vz *= 0.6; this.isSprinting = false; }
      if (held && held.enchantLevel('fire_aspect') > 0) target.fireTicks = Math.max(target.fireTicks, 80 * held.enchantLevel('fire_aspect'));
      if (crit) { g.sounds.playAt('entity.player.attack.crit', this.x, this.y, this.z, 1, 1); g.particles.spawnCrit(target.x, target.y + target.height / 2, target.z, 8); }
      else if (kb > 0) g.sounds.playAt('entity.player.attack.knockback', this.x, this.y, this.z, 1, 1);
      else if (cd > 0.9) { g.sounds.playAt(held && held.item.tool === 'sword' ? 'entity.player.attack.sweep' : 'entity.player.attack.strong', this.x, this.y, this.z, 1, 1); if (held && held.item.tool === 'sword' && this.onGround) this.sweepAttack(target, dmg); }
      else g.sounds.playAt('entity.player.attack.weak', this.x, this.y, this.z, 1, 1);
      if (held && (held.item.tool !== 'none' || held.item.name === 'trident')) this.damageHeld(held, held.item.tool === 'sword' || held.item.name === 'trident' ? 1 : 2);
      this.addExhaustion(0.1);
    } else g.sounds.playAt('entity.player.attack.nodamage', this.x, this.y, this.z, 1, 1);
    this.attackCooldownTicks = 0;
    this.swing();
  }
  private sweepAttack(primary: LivingEntity, dmg: number): void {
    const g = this.game;
    const sweep = 1 + (this.heldItem()?.enchantLevel('sweeping_edge') ?? 0);
    const sd = 1 + dmg * (sweep / (sweep + 1));
    for (const e of g.livingEntitiesIncludingPlayer()) {
      if (e === this || e === primary || e.removed) continue;
      if (e.distSq(primary.x, primary.y, primary.z) < 9 && e.bb.intersects(primary.bb.clone().grow(1, 0.25, 1))) { const dx = e.x - this.x, dz = e.z - this.z, l = Math.hypot(dx, dz) || 1; e.hurt({ amount: sd, source: 'attack', attacker: this }); e.vx += dx / l * 0.4; e.vz += dz / l * 0.4; }
    }
    g.particles.spawnSweep(this.x + lookDir(this.yaw, 0)[0], this.y + this.height * 0.5, this.z + lookDir(this.yaw, 0)[2]);
  }

  // ---------- sleeping ----------
  trySleep(x: number, y: number, z: number, state: number): boolean {
    const g = this.game, reg = this.world.registry;
    if (g.client && !(this as any).isRemote) { const ok = this.trySleepLocal(x, y, z, state); if (ok) g.client.send({ t: 'sleep', sleeping: true }); return ok; }
    return this.trySleepLocal(x, y, z, state);
  }
  private trySleepLocal(x: number, y: number, z: number, state: number): boolean {
    const g = this.game, reg = this.world.registry;
    if (this.world.dimension !== 'overworld') { g.explode(x + 0.5, y + 0.5, z + 0.5, 5, true); g.world.setBlock(x, y, z, 0); return false; }
    const props = reg.getProps(state);
    // head position
    let hx = x, hz = z;
    if (props.part === 'foot') { const [dx, , dz] = facingOffset(props.facing); hx += dx; hz += dz; }
    this.setSpawn(hx, y, hz, false);
    const day = this.world.dayTime % 24000;
    const night = day >= 12542 && day < 23460;
    if (!night && !g.weather.thundering) { g.gui.showActionBar(g.assets.lang['block.minecraft.bed.no_sleep'] ?? 'You can only sleep at night'); return false; }
    // monsters nearby
    for (const e of g.entities) if ((e as any).hostile && !e.removed && e.distSq(x, y, z) < 8 * 8 + 5 * 5) { g.gui.showActionBar(g.assets.lang['block.minecraft.bed.not_safe'] ?? 'You may not rest now, there are monsters nearby'); return false; }
    if (this.distSq(x + 0.5, y, z + 0.5) > 3 * 3) { g.gui.showActionBar(g.assets.lang['block.minecraft.bed.too_far_away'] ?? 'You may not rest now, the bed is too far away'); return false; }
    this.sleeping = true; this.bedPos = [x, y, z];
    this.setPos(hx + 0.5, y + 0.19, hz + 0.5);
    this.yaw = { north: 180, south: 0, west: 90, east: -90 }[props.facing] ?? 0;
    this.pitch = 0;
    this.vx = this.vy = this.vz = 0;
    return true;
  }
  wakeUp(): void {
    if (this.game.client && !(this as any).isRemote && this.sleeping) this.game.client.send({ t: 'sleep', sleeping: false });
    if (!this.sleeping) return;
    this.sleeping = false;
    if (this.bedPos) {
      const [x, y, z] = this.bedPos;
      // stand next to the bed
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) if (this.game.canStandAt(x + dx + 0.5, y, z + dz + 0.5)) { this.setPos(x + dx + 0.5, y, z + dz + 0.5); break; }
    }
    this.bedPos = null; this.ticksSinceLastSleep = 0;
  }
  setSpawn(x: number, y: number, z: number, forced: boolean): void { this.spawnPos = [x, y, z]; this.spawnForced = forced; }

  /** vanilla LocalPlayer portalTime / spinningEffectIntensity: drives the screen overlay and nausea whirl. */
  portalTime = 0; prevPortalTime = 0;
  private checkPortal(): void {
    const g = this.game, reg = this.world.registry;
    this.prevPortalTime = this.portalTime;
    if (this.isInPortal) this.portalTime = Math.min(1, this.portalTime + 0.0125); else this.portalTime = Math.max(0, this.portalTime - 0.05);
    if (this.hasEffect('nausea')) this.portalTime = Math.min(1, this.portalTime + 0.05);
    const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.5), Math.floor(this.z));
    const n = s ? reg.nameOf(s) : '';
    if (n === 'nether_portal') { if (!this.isInPortal && this.portalTime === 0) g.sounds.playAt('block.portal.trigger', this.x, this.y, this.z, 1, Math.random() * 0.4 + 0.8, false); this.isInPortal = true; if (this.portalCooldown <= 0) { this.inPortalTicks++; if (this.inPortalTicks >= (this.isCreative ? 1 : 80)) { this.inPortalTicks = 0; this.portalCooldown = 300; g.travelDimension(this.world.dimension === 'the_nether' ? 'overworld' : 'the_nether'); } } }
    else if (n === 'end_portal') { if (this.portalCooldown <= 0) { this.portalCooldown = 300; g.travelDimension(this.world.dimension === 'the_end' ? 'overworld' : 'the_end'); } }
    else { this.isInPortal = false; if (this.inPortalTicks > 0) this.inPortalTicks = Math.max(0, this.inPortalTicks - 4); }
  }

  serialize(): any {
    return { ...super.serialize(), inventory: this.inventory.serialize(), armor: this.armor.serialize(), offhand: this.offhand.serialize(), enderChest: this.enderChest.serialize(), selectedSlot: this.selectedSlot, gameMode: this.gameMode, foodLevel: this.foodLevel, saturation: this.saturation, exhaustion: this.exhaustion, xpLevel: this.xpLevel, xpProgress: this.xpProgress, totalXp: this.totalXp, flying: this.flying, spawnPos: this.spawnPos, spawnForced: this.spawnForced, score: this.score, dimension: this.world.dimension };
  }
  deserialize(d: any): void {
    super.deserialize(d);
    const reg = this.game.items;
    this.inventory.deserialize(d.inventory, reg); this.armor.deserialize(d.armor, reg); this.offhand.deserialize(d.offhand, reg); this.enderChest.deserialize(d.enderChest, reg);
    this.selectedSlot = d.selectedSlot ?? 0; this.setGameMode(d.gameMode ?? 'survival'); this.foodLevel = d.foodLevel ?? 20; this.saturation = d.saturation ?? 5; this.exhaustion = d.exhaustion ?? 0;
    this.xpLevel = d.xpLevel ?? 0; this.xpProgress = d.xpProgress ?? 0; this.totalXp = d.totalXp ?? 0; this.flying = !!d.flying && this.isCreative; this.spawnPos = d.spawnPos ?? null; this.spawnForced = !!d.spawnForced; this.score = d.score ?? 0;
  }
}

function armorSound(name: string): string {
  if (name.startsWith('leather')) return 'item.armor.equip_leather';
  if (name.startsWith('chainmail')) return 'item.armor.equip_chain';
  if (name.startsWith('iron')) return 'item.armor.equip_iron';
  if (name.startsWith('golden')) return 'item.armor.equip_gold';
  if (name.startsWith('diamond')) return 'item.armor.equip_diamond';
  if (name.startsWith('netherite')) return 'item.armor.equip_netherite';
  if (name.startsWith('turtle')) return 'item.armor.equip_turtle';
  if (name === 'elytra') return 'item.armor.equip_elytra';
  return 'item.armor.equip_generic';
}

export { wrapDegrees, canSurvive, Item };
