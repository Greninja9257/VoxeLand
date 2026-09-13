// Entities: physics (vanilla-style AABB sweep), living entities, item entities.
import { AABB, clamp, wrapDegrees } from '../math';
import type { World } from '../world/world';
import type { ItemStack } from '../items/stack';
import type { Game } from '../game/game';

let nextEntityId = 1;

export type DamageSource = 'generic' | 'fall' | 'drown' | 'lava' | 'fire' | 'onFire' | 'cactus' | 'starve' | 'void' | 'explosion' | 'attack' | 'arrow' | 'magma' | 'sweetBerryBush' | 'lightning' | 'freeze' | 'wither' | 'outOfWorld' | 'stalagmite' | 'flyIntoWall' | 'thorns' | 'dragonBreath' | 'witherRose' | 'cramming';

export interface EntityDamage { amount: number; source: DamageSource; attacker?: Entity | null; knockbackX?: number; knockbackZ?: number; fire?: boolean; bypassArmor?: boolean }

export abstract class Entity {
  id = nextEntityId++;
  abstract type: string;
  x = 0; y = 0; z = 0;
  prevX = 0; prevY = 0; prevZ = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0; pitch = 0; prevYaw = 0; prevPitch = 0;
  width = 0.6; height = 1.8;
  bb = new AABB();
  onGround = false; horizontalCollision = false; verticalCollision = false;
  inWater = false; inLava = false; wasInWater = false; eyeInWater = false;
  fallDistance = 0;
  removed = false;
  age = 0;
  fireTicks = 0;
  noClip = false;
  noGravity = false;
  stepHeight = 0;
  eyeHeight = 1.62;
  invulnerable = false;
  isSneaking = false;
  isSprinting = false;
  /** Interpolation helpers */
  uuid = Math.random().toString(36).slice(2);
  passengers: Entity[] = [];
  vehicle: Entity | null = null;
  portalCooldown = 0;
  inPortalTicks = 0;
  isInPortal = false;
  world!: World;
  game!: Game;
  glowing = false;

  setPos(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.updateBB();
  }
  updateBB(): void {
    const hw = this.width / 2;
    this.bb.set(this.x - hw, this.y, this.z - hw, this.x + hw, this.y + this.height, this.z + hw);
  }
  get eyeY(): number { return this.y + this.eyeHeight; }

  /** Called each game tick (20/s). */
  tick(): void {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.age++;
    if (this.portalCooldown > 0) this.portalCooldown--;
    if (this.y < -128) this.hurt({ amount: 4, source: 'void', bypassArmor: true });
    this.updateFluidState();
    if (this.fireTicks > 0) {
      if (this.inWater || this.isInRain()) { this.fireTicks = 0; }
      else { if (this.fireTicks % 20 === 0) this.hurt({ amount: 1, source: 'onFire', bypassArmor: false }); this.fireTicks--; }
    }
  }

  isInRain(): boolean { return this.game?.weather?.isRainingAt(this.world, this.x, this.y, this.z) ?? false; }

  updateFluidState(): void {
    const reg = this.world.registry;
    this.wasInWater = this.inWater;
    this.inWater = false; this.inLava = false;
    const bb = this.bb;
    const x0 = Math.floor(bb.minX), x1 = Math.floor(bb.maxX), y0 = Math.floor(bb.minY), y1 = Math.floor(bb.maxY), z0 = Math.floor(bb.minZ), z1 = Math.floor(bb.maxZ);
    for (let x = x0; x <= x1 && !this.inWater; x++) for (let y = y0; y <= y1 && !this.inWater; y++) for (let z = z0; z <= z1; z++) {
      const s = this.world.getBlock(x, y, z);
      if (s === 0) continue;
      if (reg.hasWater(s)) {
        const h = fluidSurface(reg, s, this.world, x, y, z);
        if (bb.minY < y + h) { this.inWater = true; break; }
      } else if (reg.isLava(s)) {
        const h = fluidSurface(reg, s, this.world, x, y, z);
        if (bb.minY < y + h) { this.inLava = true; }
      }
    }
    const ex = Math.floor(this.x), ey = Math.floor(this.eyeY), ez = Math.floor(this.z);
    const es = this.world.getBlock(ex, ey, ez);
    this.eyeInWater = es !== 0 && reg.hasWater(es) && this.eyeY < ey + fluidSurface(reg, es, this.world, ex, ey, ez);
    if (this.inLava && this.fireTicks < 300 && !this.isFireImmune()) { this.hurt({ amount: 4, source: 'lava', bypassArmor: false }); this.fireTicks = 300; }
  }

  isFireImmune(): boolean { return false; }

  /** Move with collision. */
  move(dx: number, dy: number, dz: number): void {
    if (this.noClip) { this.x += dx; this.y += dy; this.z += dz; this.updateBB(); return; }
    const ox = dx, oy = dy, oz = dz;
    const bb = this.bb;
    // sneaking edge protection (don't fall off edges)
    if (this.isSneaking && this.onGround && (this as any).isPlayer) {
      const step = 0.05;
      const test = new AABB();
      while (dx !== 0 && !this.collides(test.copy(bb).offset(dx, -1, 0))) { dx = Math.abs(dx) < step ? 0 : dx > 0 ? dx - step : dx + step; }
      while (dz !== 0 && !this.collides(test.copy(bb).offset(0, -1, dz))) { dz = Math.abs(dz) < step ? 0 : dz > 0 ? dz - step : dz + step; }
      while (dx !== 0 && dz !== 0 && !this.collides(test.copy(bb).offset(dx, -1, dz))) { dx = Math.abs(dx) < step ? 0 : dx > 0 ? dx - step : dx + step; dz = Math.abs(dz) < step ? 0 : dz > 0 ? dz - step : dz + step; }
    }
    const moved = this.sweep(bb, dx, dy, dz);
    let [mx, my, mz] = moved;
    // step up
    if (this.stepHeight > 0 && this.onGround !== false && (mx !== dx || mz !== dz) && (this.onGround || (oy !== my && oy < 0))) {
      const stepBB = bb.clone();
      const [sx, sy, sz] = this.sweep(stepBB, dx, this.stepHeight, dz);
      const [sx2, sy2, sz2] = this.sweep(stepBB, 0, this.stepHeight, 0);
      let bestX = sx, bestZ = sz, bestY = sy, bestBB = stepBB.clone();
      // alternative: step up first, then move
      const alt = bb.clone(); const up = this.sweep(alt, 0, this.stepHeight, 0); const hm = this.sweep(alt, dx, 0, dz);
      if (hm[0] * hm[0] + hm[2] * hm[2] > bestX * bestX + bestZ * bestZ) { bestX = hm[0]; bestZ = hm[2]; bestY = up[1]; bestBB = alt.clone(); }
      void sx2; void sy2; void sz2;
      if (bestX * bestX + bestZ * bestZ > mx * mx + mz * mz) {
        // step down to ground
        const down = this.sweep(bestBB, 0, -this.stepHeight - 0.001, 0);
        mx = bestX; mz = bestZ; my = bestY + down[1];
        bb.copy(bestBB);
      }
    }
    this.horizontalCollision = mx !== dx || mz !== dz;
    this.verticalCollision = my !== dy;
    this.onGround = this.verticalCollision && dy < 0;
    this.x = (bb.minX + bb.maxX) / 2; this.y = bb.minY; this.z = (bb.minZ + bb.maxZ) / 2;
    this.updateBB();
    if (mx !== dx) this.vx = 0;
    if (mz !== dz) this.vz = 0;
    if (my !== dy) { this.vy = 0; if (this.onGround) { this.onLand(); } }
    // fall distance
    if (this.onGround) { if (this.fallDistance > 0) { this.fall(this.fallDistance); this.fallDistance = 0; } }
    else if (my < 0) this.fallDistance -= my;
    void ox; void oz;
  }

  protected onLand(): void {}
  protected fall(distance: number): void { void distance; }

  private collides(bb: AABB): boolean {
    let hit = false;
    this.world.forEachCollisionBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, (x0, y0, z0, x1, y1, z1) => {
      if (!hit && bb.minX < x1 && bb.maxX > x0 && bb.minY < y1 && bb.maxY > y0 && bb.minZ < z1 && bb.maxZ > z0) hit = true;
    });
    return hit;
  }

  /** Sweep bb by (dx,dy,dz) against world collision boxes (Y, then X, then Z). Mutates bb. Returns actual movement. */
  sweep(bb: AABB, dx: number, dy: number, dz: number): [number, number, number] {
    const boxes: number[][] = [];
    const ex = bb.clone().expand(dx, dy, dz).grow(0.01, 0.01, 0.01);
    this.world.forEachCollisionBox(ex.minX, ex.minY, ex.minZ, ex.maxX, ex.maxY, ex.maxZ, (x0, y0, z0, x1, y1, z1) => { boxes.push([x0, y0, z0, x1, y1, z1]); });
    const tmp = new AABB();
    if (dy !== 0) { for (const b of boxes) dy = bb.clipY(tmp.set(b[0], b[1], b[2], b[3], b[4], b[5]), dy); bb.offset(0, dy, 0); }
    if (dx !== 0) { for (const b of boxes) dx = bb.clipX(tmp.set(b[0], b[1], b[2], b[3], b[4], b[5]), dx); bb.offset(dx, 0, 0); }
    if (dz !== 0) { for (const b of boxes) dz = bb.clipZ(tmp.set(b[0], b[1], b[2], b[3], b[4], b[5]), dz); bb.offset(0, 0, dz); }
    return [dx, dy, dz];
  }

  hurt(_d: EntityDamage): boolean { return false; }
  remove(): void { this.removed = true; }

  /** Distance squared to a point. */
  distSq(x: number, y: number, z: number): number { return (this.x - x) ** 2 + (this.y - y) ** 2 + (this.z - z) ** 2; }

  lookAt(x: number, y: number, z: number, maxYawDelta = 360, maxPitchDelta = 360): void {
    const dx = x - this.x, dz = z - this.z, dy = y - this.eyeY;
    const targetYaw = Math.atan2(-dx, dz) * 180 / Math.PI;
    const targetPitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    this.yaw += clamp(wrapDegrees(targetYaw - this.yaw), -maxYawDelta, maxYawDelta);
    this.pitch += clamp(wrapDegrees(targetPitch - this.pitch), -maxPitchDelta, maxPitchDelta);
  }

  serialize(): any {
    return { type: this.type, uuid: this.uuid, x: this.x, y: this.y, z: this.z, vx: this.vx, vy: this.vy, vz: this.vz, yaw: this.yaw, pitch: this.pitch, age: this.age, fire: this.fireTicks };
  }
  deserialize(d: any): void {
    this.uuid = d.uuid ?? this.uuid; this.setPos(d.x, d.y, d.z); this.vx = d.vx ?? 0; this.vy = d.vy ?? 0; this.vz = d.vz ?? 0; this.yaw = d.yaw ?? 0; this.pitch = d.pitch ?? 0; this.age = d.age ?? 0; this.fireTicks = d.fire ?? 0;
  }
}

/** Height of fluid surface within its block (0..1). */
export function fluidSurface(reg: World['registry'], state: number, world: World, x: number, y: number, z: number): number {
  const above = world.getBlock(x, y + 1, z);
  if (above !== 0 && (reg.isFluid(above) || reg.isWaterlogged(above))) return 1;
  if (reg.isWaterlogged(state)) return 8 / 9;
  const level = reg.fluidLevel(state);
  if (level === 0 || level >= 8) return 8 / 9;
  return (8 - level) / 9;
}

export interface PotionEffect { id: string; amplifier: number; duration: number; ambient?: boolean }

export abstract class LivingEntity extends Entity {
  health = 20; maxHealth = 20;
  hurtTime = 0; hurtDuration = 10; deathTime = 0; invulnerableTicks = 0; lastDamage = 0;
  air = 300; maxAir = 300;
  effects: PotionEffect[] = [];
  moveForward = 0; moveStrafe = 0; jumping = false;
  speed = 0.1; // ground movement speed attribute
  jumpTicks = 0;
  swingTime = 0; swinging = false; swingProgress = 0; prevSwingProgress = 0;
  limbSwing = 0; limbSwingAmount = 0; prevLimbSwingAmount = 0;
  attackTarget: LivingEntity | null = null;
  lastAttacker: Entity | null = null;
  absorption = 0;
  isBaby = false;
  isDead = false;
  isSwimming = false;
  bodyYaw = 0; prevBodyYaw = 0; headYaw = 0; prevHeadYaw = 0;
  deathLootDropped = false;
  fallFlying = false;
  yBodyRotOffset = 0;
  gravityMultiplier = 1;

  constructor() { super(); this.stepHeight = 0.6; }

  get isAlive(): boolean { return !this.removed && this.health > 0; }

  hasEffect(id: string): boolean { return this.effects.some((e) => e.id === id); }
  effectLevel(id: string): number { const e = this.effects.find((x) => x.id === id); return e ? e.amplifier + 1 : 0; }
  addEffect(e: PotionEffect): void {
    const ex = this.effects.find((x) => x.id === e.id);
    if (ex) { if (e.amplifier >= ex.amplifier) { ex.amplifier = e.amplifier; ex.duration = Math.max(ex.duration, e.duration); } }
    else this.effects.push({ ...e });
    if (e.id === 'absorption') this.absorption = Math.max(this.absorption, 4 * (e.amplifier + 1));
  }
  removeEffect(id: string): void { this.effects = this.effects.filter((e) => e.id !== id); if (id === 'absorption') this.absorption = 0; }

  /** Armour points (overridden by player/mobs with equipment). */
  armorValue(): number { return 0; }
  armorToughness(): number { return 0; }
  enchantProtection(_source: DamageSource): number { return 0; }

  hurt(d: EntityDamage): boolean {
    if (this.invulnerable || this.removed || this.health <= 0) return false;
    if (d.source === 'onFire' && this.isFireImmune()) return false;
    if (d.source === 'fall' && this.hasEffect('slow_falling')) return false;
    let amount = d.amount;
    if (this.invulnerableTicks > 10 && d.source !== 'void' && d.source !== 'starve') {
      if (amount <= this.lastDamage) return false;
      amount -= this.lastDamage;
    } else {
      this.invulnerableTicks = 20;
      this.hurtTime = this.hurtDuration;
    }
    this.lastDamage = d.amount;
    // armour
    if (!d.bypassArmor) {
      const armor = this.armorValue(), tough = this.armorToughness();
      const f = 1 - Math.min(20, Math.max(armor / 5, armor - amount / (2 + tough / 4))) / 25;
      amount *= f;
    }
    // resistance effect
    const res = this.effectLevel('resistance');
    if (res > 0 && d.source !== 'void' && d.source !== 'starve') amount *= Math.max(0, 1 - res * 0.2);
    // enchantment protection
    const epf = Math.min(20, this.enchantProtection(d.source));
    if (epf > 0) amount *= 1 - epf / 25;
    if (amount <= 0 && d.amount > 0) amount = 0;
    // absorption
    if (this.absorption > 0) { const a = Math.min(this.absorption, amount); this.absorption -= a; amount -= a; }
    this.health -= amount;
    if (d.attacker) this.lastAttacker = d.attacker;
    // knockback
    if (d.knockbackX !== undefined || d.attacker) {
      let kx = d.knockbackX ?? (d.attacker ? this.x - d.attacker.x : 0), kz = d.knockbackZ ?? (d.attacker ? this.z - d.attacker.z : 0);
      const len = Math.hypot(kx, kz) || 1;
      kx /= len; kz /= len;
      const strength = 0.4 * (1 - this.knockbackResistance());
      this.vx = this.vx / 2 - kx * strength; this.vz = this.vz / 2 - kz * strength;
      if (this.onGround) this.vy = Math.min(0.4, this.vy / 2 + strength);
    }
    this.onHurt(d, amount);
    if (this.health <= 0) this.die(d);
    return true;
  }

  knockbackResistance(): number { return 0; }
  protected onHurt(_d: EntityDamage, _amount: number): void {}
  die(_d: EntityDamage): void { this.health = 0; this.isDead = true; }

  heal(n: number): void { if (this.health > 0) this.health = Math.min(this.maxHealth, this.health + n); }

  protected fall(distance: number): void {
    const jb = this.effectLevel('jump_boost');
    const dmg = Math.ceil(distance - 3 - jb);
    if (dmg > 0 && !this.inWater) {
      const feet = this.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
      const name = feet ? this.world.registry.nameOf(feet) : '';
      if (name === 'hay_block' || name === 'slime_block' || name === 'honey_block' || name === 'powder_snow' || name.endsWith('_bed') || name === 'sweet_berry_bush' || name === 'cobweb') {
        if (name === 'hay_block') this.hurt({ amount: dmg * 0.2, source: 'fall', bypassArmor: true });
        else if (name.endsWith('_bed')) { this.hurt({ amount: dmg * 0.5, source: 'fall', bypassArmor: true }); }
        return;
      }
      this.hurt({ amount: dmg, source: 'fall', bypassArmor: true });
      this.game?.sounds.playAt(dmg > 4 ? 'entity.player.big_fall' : 'entity.player.small_fall', this.x, this.y, this.z, 1, 1);
    }
  }

  tick(): void {
    super.tick();
    this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw;
    this.prevSwingProgress = this.swingProgress;
    this.prevLimbSwingAmount = this.limbSwingAmount;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.jumpTicks > 0) this.jumpTicks--;
    // effects
    for (const e of this.effects) e.duration--;
    if (this.effects.some((e) => e.duration <= 0)) this.effects = this.effects.filter((e) => e.duration > 0);
    if (this.hasEffect('regeneration') && this.age % Math.max(1, 50 >> this.effectLevel('regeneration') - 1) === 0) this.heal(1);
    if (this.hasEffect('poison') && this.age % Math.max(1, 25 >> this.effectLevel('poison') - 1) === 0 && this.health > 1) this.hurt({ amount: 1, source: 'generic', bypassArmor: true });
    if (this.hasEffect('wither') && this.age % Math.max(1, 40 >> this.effectLevel('wither') - 1) === 0) this.hurt({ amount: 1, source: 'wither', bypassArmor: true });
    // air / drowning
    if (this.eyeInWater && !this.hasEffect('water_breathing') && !this.canBreatheUnderwater()) {
      const resp = this.respirationLevel();
      if (resp === 0 || Math.random() < 1 / (resp + 1)) this.air--;
      if (this.air <= -20) { this.air = 0; this.hurt({ amount: 2, source: 'drown', bypassArmor: true }); }
    } else if (this.air < this.maxAir) this.air = Math.min(this.maxAir, this.air + 4);
    // swing animation
    this.updateSwing();
    // death
    if (this.health <= 0) {
      this.deathTime++;
      if (this.deathTime >= 20) { this.onDeathFinished(); this.remove(); }
      return;
    }
    // block contact effects
    this.checkBlockContacts();
    // movement
    this.aiStep();
    this.travel();
    // limb animation
    const dx = this.x - this.prevX, dz = this.z - this.prevZ;
    let amt = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 4);
    this.limbSwingAmount += (amt - this.limbSwingAmount) * 0.4;
    this.limbSwing += this.limbSwingAmount;
    // body yaw follows head
    const hd = wrapDegrees(this.yaw - this.bodyYaw);
    if (this.limbSwingAmount > 0.05) this.bodyYaw = this.yaw;
    else if (Math.abs(hd) > 50) this.bodyYaw = this.yaw - Math.sign(hd) * 50;
    this.headYaw = this.yaw;
  }

  protected onDeathFinished(): void {}
  canBreatheUnderwater(): boolean { return false; }
  respirationLevel(): number { return 0; }

  protected updateSwing(): void {
    if (this.swinging) {
      this.swingTime++;
      if (this.swingTime >= 6) { this.swingTime = 0; this.swinging = false; }
    } else this.swingTime = 0;
    this.swingProgress = this.swingTime / 6;
  }
  swing(): void { if (!this.swinging || this.swingTime >= 3 || this.swingTime < 0) { this.swingTime = -1; this.swinging = true; } }
  /** Interpolated swing progress; wraps forward when the animation restarts (vanilla getAttackAnim). */
  swingAnim(partial: number): number { let f = this.swingProgress - this.prevSwingProgress; if (f < 0) f += 1; return this.prevSwingProgress + f * partial; }

  protected checkBlockContacts(): void {
    const reg = this.world.registry;
    const bb = this.bb;
    const x0 = Math.floor(bb.minX + 0.001), x1 = Math.floor(bb.maxX - 0.001), y0 = Math.floor(bb.minY + 0.001), y1 = Math.floor(bb.maxY - 0.001), z0 = Math.floor(bb.minZ + 0.001), z1 = Math.floor(bb.maxZ - 0.001);
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0; y <= y1; y++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      const s = this.world.getBlock(x, y, z);
      if (s === 0) continue;
      const n = reg.nameOf(s);
      const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1;
      if (n === 'cactus') { if (bb.minX < x + 1.0625 && bb.maxX > x - 0.0625 && bb.minZ < z + 1.0625 && bb.maxZ > z - 0.0625 && bb.minY < y + 1 && bb.maxY > y) this.hurt({ amount: 1, source: 'cactus' }); }
      else if (!inside) continue;
      else if (n === 'fire' || n === 'soul_fire') { if (!this.isFireImmune()) { this.hurt({ amount: 1, source: 'fire' }); this.fireTicks = Math.max(this.fireTicks, 160); } }
      else if (n === 'sweet_berry_bush' && (this.vx !== 0 || this.vz !== 0)) { const age = +(reg.getProps(s).age ?? 0); if (age > 0) this.hurt({ amount: 1, source: 'sweetBerryBush' }); }
      else if (n === 'wither_rose' && !this.hasEffect('wither')) this.addEffect({ id: 'wither', amplifier: 0, duration: 40 });
      else if (n === 'campfire' || n === 'soul_campfire') { if (reg.getProps(s).lit === 'true' && !this.isFireImmune()) { this.hurt({ amount: n === 'campfire' ? 1 : 2, source: 'fire' }); } }
      else if (n === 'powder_snow') { this.addEffect({ id: 'freezing', amplifier: 0, duration: 2 }); }
    }
    // magma: standing on it
    const below = this.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
    if (below !== 0 && this.onGround && reg.nameOf(below) === 'magma_block' && !this.isSneaking && !this.isFireImmune()) this.hurt({ amount: 1, source: 'magma' });
    if (this.hasEffect('freezing') && this.age % 40 === 0) this.hurt({ amount: 1, source: 'freeze', bypassArmor: true });
  }

  /** AI / input hook before movement. */
  protected aiStep(): void {}

  /** Block below friction (slipperiness). */
  protected blockFriction(): number {
    const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.bb.minY - 0.5000001), Math.floor(this.z));
    if (s === 0) return 0.6;
    const n = this.world.registry.nameOf(s);
    if (n === 'ice' || n === 'packed_ice' || n === 'frosted_ice') return 0.98;
    if (n === 'blue_ice') return 0.989;
    if (n === 'slime_block') return 0.8;
    return 0.6;
  }

  isClimbing(): boolean {
    const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    if (s === 0) return false;
    const n = this.world.registry.nameOf(s);
    if (n === 'ladder' || n === 'vine' || n === 'scaffolding' || n === 'weeping_vines' || n === 'weeping_vines_plant' || n === 'twisting_vines' || n === 'twisting_vines_plant' || n === 'cave_vines' || n === 'cave_vines_plant') return true;
    if (n.endsWith('_trapdoor') && this.world.registry.getProps(s).open === 'true') {
      const below = this.world.getBlock(Math.floor(this.x), Math.floor(this.y) - 1, Math.floor(this.z));
      return below !== 0 && this.world.registry.nameOf(below) === 'ladder';
    }
    return false;
  }

  getJumpPower(): number { return 0.42 + this.effectLevel('jump_boost') * 0.1; }

  jump(): void {
    this.vy = this.getJumpPower();
    if (this.isSprinting) { const yaw = this.yaw * Math.PI / 180; this.vx += -Math.sin(yaw) * 0.2; this.vz += Math.cos(yaw) * 0.2; }
    this.jumpTicks = 10;
  }

  isFlying(): boolean { return false; }

  /** Vanilla LivingEntity.travel(). */
  protected travel(): void {
    const forward = this.moveForward, strafe = this.moveStrafe;
    let speedMod = 1;
    if (this.hasEffect('speed')) speedMod *= 1 + 0.2 * this.effectLevel('speed');
    if (this.hasEffect('slowness')) speedMod *= Math.max(0, 1 - 0.15 * this.effectLevel('slowness'));
    const gravity = this.hasEffect('slow_falling') && this.vy < 0 ? 0.01 : 0.08 * this.gravityMultiplier;
    if (this.isFlying()) {
      this.moveRelative(forward, strafe, this.speed * (this.isSprinting ? 2 : 1) * 0.5);
      this.move(this.vx, this.vy, this.vz);
      this.vx *= 0.91; this.vy *= 0.6; this.vz *= 0.91;
      this.fallDistance = 0;
      return;
    }
    if (this.inWater && !this.isFlying()) {
      const depthStrider = this.depthStriderLevel();
      let drag = this.isSprinting ? 0.9 : 0.8;
      let acc = 0.02;
      if (depthStrider > 0) { const ds = Math.min(3, depthStrider); drag += (0.54600006 - drag) * ds / 3; acc += (this.speed - acc) * ds / 3; }
      if (this.hasEffect('dolphins_grace')) drag = 0.96;
      this.moveRelative(forward, strafe, acc * speedMod);
      this.move(this.vx, this.vy, this.vz);
      this.vx *= drag; this.vz *= drag; this.vy *= 0.8;
      if (!this.hasEffect('slow_falling') && !this.jumping) this.vy -= 0.02;
      if (this.jumping) this.vy += 0.04;
      // step out of water onto land
      if (this.horizontalCollision && this.isFreeAt(this.vx, this.vy + 0.6 - this.y + this.prevY, this.vz)) this.vy = 0.3;
    } else if (this.inLava) {
      this.moveRelative(forward, strafe, 0.02);
      this.move(this.vx, this.vy, this.vz);
      this.vx *= 0.5; this.vy *= 0.5; this.vz *= 0.5;
      if (this.jumping) this.vy += 0.04; else this.vy -= 0.02;
      if (this.horizontalCollision && this.isFreeAt(this.vx, this.vy + 0.6 - this.y + this.prevY, this.vz)) this.vy = 0.3;
    } else {
      const friction = this.onGround ? this.blockFriction() * 0.91 : 0.91;
      const acc = this.onGround ? this.speed * speedMod * (0.16277136 / (friction * friction * friction)) : (this.isSprinting ? 0.026 : 0.02);
      this.moveRelative(forward, strafe, acc);
      if (this.isClimbing()) {
        this.vx = clamp(this.vx, -0.15, 0.15); this.vz = clamp(this.vz, -0.15, 0.15);
        this.fallDistance = 0;
        if (this.vy < -0.15) this.vy = -0.15;
        if (this.isSneaking && this.vy < 0) this.vy = 0;
        if (this.horizontalCollision && this.vy < 0.2) this.vy = 0.2;
      }
      this.move(this.vx, this.vy, this.vz);
      if (this.horizontalCollision && this.isClimbing()) this.vy = 0.2;
      if (this.hasEffect('levitation')) this.vy += (0.05 * this.effectLevel('levitation') - this.vy) * 0.2;
      else if (!this.noGravity) this.vy -= gravity;
      this.vy *= 0.98;
      this.vx *= friction; this.vz *= friction;
    }
    if (this.jumping && this.jumpTicks === 0) {
      if (this.onGround && !this.inWater && !this.inLava) this.jump();
    }
  }

  depthStriderLevel(): number { return 0; }

  private isFreeAt(dx: number, dy: number, dz: number): boolean {
    const bb = this.bb.clone().offset(dx, dy, dz);
    let free = true;
    this.world.forEachCollisionBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, (x0, y0, z0, x1, y1, z1) => {
      if (bb.minX < x1 && bb.maxX > x0 && bb.minY < y1 && bb.maxY > y0 && bb.minZ < z1 && bb.maxZ > z0) free = false;
    });
    return free;
  }

  /** Apply movement input relative to yaw. */
  moveRelative(forward: number, strafe: number, acc: number): void {
    let d = forward * forward + strafe * strafe;
    if (d < 1e-4) return;
    d = Math.sqrt(d);
    if (d < 1) d = 1;
    d = acc / d;
    forward *= d; strafe *= d;
    const yaw = this.yaw * Math.PI / 180;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    this.vx += strafe * c - forward * s;
    this.vz += forward * c + strafe * s;
  }

  serialize(): any { return { ...super.serialize(), health: this.health, air: this.air, effects: this.effects, absorption: this.absorption, baby: this.isBaby }; }
  deserialize(d: any): void { super.deserialize(d); this.health = d.health ?? this.maxHealth; this.air = d.air ?? 300; this.effects = d.effects ?? []; this.absorption = d.absorption ?? 0; this.isBaby = !!d.baby; }
}

export class ItemEntity extends Entity {
  type = 'item';
  pickupDelay = 10;
  thrower: string | null = null;
  bobOffset = Math.random() * Math.PI * 2;
  constructor(public stack: ItemStack) { super(); this.width = 0.25; this.height = 0.25; this.eyeHeight = 0.125; }

  tick(): void {
    super.tick();
    if (this.pickupDelay > 0) this.pickupDelay--;
    if (this.age >= 6000 || this.stack.count <= 0) { this.remove(); return; }
    if (this.inWater) { this.vy += 0.04 * (0.9 - 0.5 * 0.5); if (this.vy > 0.06) this.vy = 0.06; this.vx *= 0.99; this.vz *= 0.99; }
    else if (this.inLava) { this.vy += 0.04; this.vx *= 0.95; this.vz *= 0.95; }
    else if (!this.noGravity) this.vy -= 0.04;
    this.move(this.vx, this.vy, this.vz);
    let f = 0.98;
    if (this.onGround) f = this.groundFriction() * 0.98;
    this.vx *= f; this.vz *= f; this.vy *= 0.98;
    if (this.onGround && this.vy < 0) this.vy *= -0.5;
    // burn in fire/lava
    if (this.inLava && !this.stack.item.isFireResistant) { this.remove(); return; }
    // merge with nearby items
    if (this.age % 20 === 0 && this.stack.count < this.stack.maxStack) {
      for (const e of this.game.entities) {
        if (e === this || !(e instanceof ItemEntity) || e.removed || e.pickupDelay !== this.pickupDelay && false) continue;
        if (e.distSq(this.x, this.y, this.z) < 0.5 * 0.5 && e.stack.canStackWith(this.stack) && e.stack.count + this.stack.count <= this.stack.maxStack) {
          this.stack.count += e.stack.count; e.remove(); this.pickupDelay = Math.max(this.pickupDelay, e.pickupDelay);
        }
      }
    }
    // push out of solid blocks
    const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z));
    if (s !== 0 && this.world.registry.fullCube[s]) { this.vy = 0.1; this.y += 0.1; this.updateBB(); }
  }
  private groundFriction(): number {
    const s = this.world.getBlock(Math.floor(this.x), Math.floor(this.bb.minY - 0.5), Math.floor(this.z));
    if (s === 0) return 0.6;
    const n = this.world.registry.nameOf(s);
    return n === 'ice' || n === 'packed_ice' ? 0.98 : n === 'blue_ice' ? 0.989 : n === 'slime_block' ? 0.8 : 0.6;
  }
  hurt(d: EntityDamage): boolean { if (d.source === 'explosion' || d.source === 'lava' || d.source === 'fire' || d.source === 'onFire') { if (!this.stack.item.isFireResistant || d.source === 'explosion') this.remove(); } return false; }
  serialize(): any { return { ...super.serialize(), stack: this.stack.serialize(), pickupDelay: this.pickupDelay, thrower: this.thrower }; }
  deserialize(d: any): void { super.deserialize(d); this.pickupDelay = d.pickupDelay ?? 10; this.thrower = d.thrower ?? null; }
}

/** Experience orb. */
export class ExperienceOrb extends Entity {
  type = 'experience_orb';
  constructor(public value: number) { super(); this.width = 0.5; this.height = 0.5; this.eyeHeight = 0.25; }
  tick(): void {
    super.tick();
    if (this.age >= 6000) { this.remove(); return; }
    if (!this.noGravity) this.vy -= 0.03;
    if (this.inWater) { this.vy = Math.min(0.06, this.vy + 0.06); }
    // attracted to player
    const p = this.game.player;
    if (p && !p.isDead) {
      const dx = p.x - this.x, dy = p.y + p.eyeHeight / 2 - this.y, dz = p.z - this.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 8) { const f = (1 - d / 8); this.vx += dx / d * f * f * 0.1; this.vy += dy / d * f * f * 0.1; this.vz += dz / d * f * f * 0.1; }
    }
    this.move(this.vx, this.vy, this.vz);
    const f = this.onGround ? 0.6 * 0.98 : 0.98;
    this.vx *= f; this.vz *= f; this.vy *= 0.98;
  }
  serialize(): any { return { ...super.serialize(), value: this.value }; }
}
