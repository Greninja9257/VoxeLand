// Falling blocks, primed TNT, arrows and thrown projectiles.
import { AreaEffectCloud } from './boss';
import { Entity, LivingEntity, type EntityDamage } from './entity';
import type { ItemStack } from '../items/stack';
import { ItemStack as Stack } from '../items/stack';
import { AABB } from '../math';

export class FallingBlockEntity extends Entity {
  type = 'falling_block';
  constructor(public blockState: number, public blockEntityData: any = null) { super(); this.width = 0.98; this.height = 0.98; this.eyeHeight = 0.49; }
  tick(): void {
    super.tick();
    this.vy -= 0.04;
    this.move(this.vx, this.vy, this.vz);
    this.vx *= 0.98; this.vy *= 0.98; this.vz *= 0.98;
    const reg = this.world.registry;
    const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z);
    if (this.age > 600) { this.dropAsItem(); this.remove(); return; }
    if (this.onGround) {
      const n = reg.nameOf(this.blockState);
      const cur = this.world.getBlock(bx, by, bz);
      const canPlace = cur === 0 || reg.isAir(cur) || reg.isFluid(cur) || (reg.block(cur).hardness === 0 && reg.block(cur).boundingBox === 'empty');
      if (canPlace) {
        let st = this.blockState;
        if (n.endsWith('_concrete_powder') && cur !== 0 && reg.hasWater(cur)) st = reg.defaultState(n.replace('_powder', ''));
        this.world.setBlock(bx, by, bz, st);
        if (this.blockEntityData) this.game.blockEntities.put(bx, by, bz, this.blockEntityData);
        if (n.endsWith('anvil')) { this.game.sounds.playAt('block.anvil.land', this.x, this.y, this.z, 1, 1); if (this.fallDistance > 1) this.game.damageEntitiesIn(new AABB(bx, by, bz, bx + 1, by + 2, bz + 1), Math.min(40, Math.ceil(this.fallDistance - 1) * 2), 'generic'); }
      } else this.dropAsItem();
      this.remove();
    } else if (this.age > 1) {
      // concrete powder solidifies in water while falling
      const n = reg.nameOf(this.blockState);
      if (n.endsWith('_concrete_powder') && this.inWater) { this.blockState = reg.defaultState(n.replace('_powder', '')); }
    }
  }
  private dropAsItem(): void {
    const item = this.game.items.itemForBlock(this.world.registry.nameOf(this.blockState));
    if (item) this.game.dropItem(this.x, this.y, this.z, new Stack(item, 1));
  }
  serialize(): any { return { ...super.serialize(), blockState: this.blockState }; }
  deserialize(d: any): void { super.deserialize(d); this.blockState = d.blockState ?? this.blockState; }
}

export class PrimedTnt extends Entity {
  type = 'tnt';
  constructor(public fuse = 80) { super(); this.width = 0.98; this.height = 0.98; this.eyeHeight = 0; }
  tick(): void {
    super.tick();
    if (!this.noGravity) this.vy -= 0.04;
    this.move(this.vx, this.vy, this.vz);
    this.vx *= 0.98; this.vy *= 0.98; this.vz *= 0.98;
    if (this.onGround) { this.vx *= 0.7; this.vz *= 0.7; this.vy *= -0.5; }
    this.fuse--;
    if (this.fuse <= 0) { this.remove(); this.game.explode(this.x, this.y + 0.0625, this.z, 4, true, this); }
    else if (this.inWater === false) this.game.particles.spawnSmoke(this.x, this.y + 0.5, this.z, 1);
  }
  hurt(): boolean { return false; }
  serialize(): any { return { ...super.serialize(), fuse: this.fuse }; }
  deserialize(d: any): void { super.deserialize(d); this.fuse = d.fuse ?? 80; }
}

export class ArrowEntity extends Entity {
  type = 'arrow';
  inGround = false;
  pickup = true;
  life = 0;
  critical = false;
  knockback = 0;
  fire = false;
  constructor(public owner: Entity | null, public damage = 2, public kind: 'normal' | 'spectral' | 'tipped' = 'normal') { super(); this.width = 0.5; this.height = 0.5; this.eyeHeight = 0.13; }
  tick(): void {
    super.tick();
    if (this.inGround) { this.life++; if (this.life >= 1200) this.remove(); return; }
    // raycast along motion for blocks & entities
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    const hit = this.game.raycastBlocks(this.x, this.y, this.z, this.vx / speed, this.vy / speed, this.vz / speed, speed, false);
    let stopAt = hit ? hit.t : speed;
    // entity hit
    const bb = this.bb.clone().expand(this.vx, this.vy, this.vz).grow(1, 1, 1);
    let target: LivingEntity | null = null, bestT = stopAt;
    for (const e of this.game.livingEntitiesIncludingPlayer()) {
      if (e === this.owner && this.age < 5) continue;
      if (e.removed || !e.bb.intersects(bb)) continue;
      const r = e.bb.clone().grow(0.3, 0.3, 0.3).rayIntersect(this.x, this.y, this.z, this.vx / speed, this.vy / speed, this.vz / speed);
      if (r && r[0] < bestT) { bestT = r[0]; target = e; }
    }
    if (target) {
      let dmg = Math.ceil(Math.min(speed * this.damage, 2.147e9));
      if (this.critical) dmg += Math.floor(Math.random() * (dmg / 2 + 2));
      const kb = this.knockback;
      const hurt = target.hurt({ amount: dmg, source: 'arrow', attacker: this.owner ?? this });
      if (hurt) {
        // vanilla Punch: push along the arrow's travel direction by knockback * 0.6 (+0.1 up)
        if (kb > 0 && speed > 0) { const h = Math.hypot(this.vx, this.vz) || 1; target.vx += this.vx / h * kb * 0.6; target.vz += this.vz / h * kb * 0.6; target.vy += 0.1; }
        if (this.fire) target.fireTicks = Math.max(target.fireTicks, 100);
        if (this.kind === 'tipped' && (this as any).effect) target.addEffect((this as any).effect);
        this.game.sounds.playAt('entity.arrow.hit', this.x, this.y, this.z, 1, 1.2 / (Math.random() * 0.2 + 0.9));
        if (this.owner === this.game.player) this.game.sounds.play('entity.arrow.hit_player', 0.18, 0.45);
      }
      this.remove();
      return;
    }
    if (hit) {
      this.x += this.vx / speed * hit.t; this.y += this.vy / speed * hit.t; this.z += this.vz / speed * hit.t;
      this.inGround = true;
      this.vx = this.vy = this.vz = 0;
      this.game.sounds.playAt('entity.arrow.hit', this.x, this.y, this.z, 1, 1.2 / (Math.random() * 0.2 + 0.9));
      const bs = this.world.getBlock(hit.x, hit.y, hit.z);
      const bn = bs ? this.world.registry.nameOf(bs) : '';
      if (bn === 'tnt' && this.fire) this.game.igniteTnt(hit.x, hit.y, hit.z);
      if (bn.endsWith('_button') && bn.includes('oak') || bn === 'target') { if (bn === 'target') { this.world.setBlock(hit.x, hit.y, hit.z, this.world.registry.withProp(bs, 'power', '15')); this.world.scheduleTick(hit.x, hit.y, hit.z, 8); this.game.redstone.sourceChanged(hit.x, hit.y, hit.z); } }
      this.updateBB();
      return;
    }
    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    this.updateBB();
    this.yaw = Math.atan2(-this.vx, this.vz) * 180 / Math.PI;
    this.pitch = -Math.atan2(this.vy, Math.hypot(this.vx, this.vz)) * 180 / Math.PI;
    const drag = this.inWater ? 0.6 : 0.99;
    this.vx *= drag; this.vy *= drag; this.vz *= drag;
    this.vy -= 0.05;
    if (this.critical) this.game.particles.spawnCrit(this.x, this.y, this.z, 1);
    if (this.age > 1200) this.remove();
  }
  hurt(): boolean { return false; }
}

/** Snowballs, eggs, ender pearls, splash potions, XP bottles, fire charges. */
export class ThrownProjectile extends Entity {
  type: string;
  constructor(public kind: string, public owner: Entity | null, public stack: ItemStack | null = null) { super(); this.type = kind; this.width = 0.25; this.height = 0.25; this.eyeHeight = 0.125; }
  tick(): void {
    super.tick();
    const speed = Math.hypot(this.vx, this.vy, this.vz) || 1e-6;
    const hit = this.game.raycastBlocks(this.x, this.y, this.z, this.vx / speed, this.vy / speed, this.vz / speed, speed, false);
    let target: LivingEntity | null = null; let bestT = hit ? hit.t : speed;
    const bb = this.bb.clone().expand(this.vx, this.vy, this.vz).grow(1, 1, 1);
    for (const e of this.game.livingEntitiesIncludingPlayer()) {
      if (e === this.owner && this.age < 5) continue;
      if (e.removed || !e.bb.intersects(bb)) continue;
      const r = e.bb.clone().grow(0.3, 0.3, 0.3).rayIntersect(this.x, this.y, this.z, this.vx / speed, this.vy / speed, this.vz / speed);
      if (r && r[0] < bestT) { bestT = r[0]; target = e; }
    }
    if (target || hit) {
      const hx = this.x + this.vx / speed * bestT, hy = this.y + this.vy / speed * bestT, hz = this.z + this.vz / speed * bestT;
      this.onImpact(target, hit ? [hit.x, hit.y, hit.z, hit.face] : null, hx, hy, hz);
      this.remove();
      return;
    }
    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    this.updateBB();
    const drag = this.inWater ? 0.8 : 0.99;
    this.vx *= drag; this.vy *= drag; this.vz *= drag;
    this.vy -= this.kind === 'experience_bottle' ? 0.07 : this.kind === 'fire_charge' ? 0 : 0.03;
    if (this.age > 600) this.remove();
  }
  private onImpact(target: LivingEntity | null, block: [number, number, number, number] | null, hx: number, hy: number, hz: number): void {
    const g = this.game;
    switch (this.kind) {
      case 'snowball': if (target) target.hurt({ amount: (target as any).type === 'blaze' ? 3 : 0, source: 'attack', attacker: this.owner }); g.particles.spawnItemBreak(hx, hy, hz, 'snowball', 8); break;
      case 'egg': if (target) target.hurt({ amount: 0, source: 'attack', attacker: this.owner }); g.particles.spawnItemBreak(hx, hy, hz, 'egg', 8); if (Math.random() < 1 / 8 && this.world.dimension === 'overworld') { const n = Math.random() < 1 / 32 ? 4 : 1; for (let i = 0; i < n; i++) g.spawnMob('chicken', hx, hy, hz, true); } break;
      case 'ender_pearl': if (this.owner instanceof LivingEntity && !this.owner.removed) { this.owner.setPos(hx, Math.max(hy, this.world.getHeight(Math.floor(hx), Math.floor(hz)) - 1000), hz); this.owner.setPos(hx, hy, hz); this.owner.fallDistance = 0; this.owner.hurt({ amount: 5, source: 'fall', bypassArmor: true }); g.sounds.playAt('entity.enderman.teleport', hx, hy, hz, 1, 1); g.particles.spawnPortal(hx, hy, hz, 32); } break;
      case 'experience_bottle': { g.sounds.playAt('entity.experience_bottle.throw', hx, hy, hz, 1, 1); g.spawnXp(hx, hy, hz, 3 + Math.floor(Math.random() * 9)); g.particles.spawnSplash(hx, hy, hz, 0x00ff00); break; }
      case 'splash_potion': case 'lingering_potion': { const effect = this.stack?.extra?.effect; g.sounds.playAt('entity.splash_potion.break', hx, hy, hz, 1, 1); g.particles.spawnSplash(hx, hy, hz, this.stack?.extra?.color ?? 0x385dc6); if (effect) for (const e of g.livingEntitiesIncludingPlayer()) { const d = e.distSq(hx, hy, hz); if (d < 16) e.addEffect({ id: effect.id, amplifier: effect.amplifier, duration: Math.floor(effect.duration * (1 - Math.sqrt(d) / 4)) }); } if (this.stack?.extra?.potion === 'water') { for (const e of g.livingEntitiesIncludingPlayer()) if (e.distSq(hx, hy, hz) < 16) e.fireTicks = 0; if (block) { const [bx, by, bz, face] = block; const dir = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][face]; const fx = bx + dir[0], fy = by + dir[1], fz = bz + dir[2]; const fs = this.world.getBlock(fx, fy, fz); if (fs && (this.world.registry.nameOf(fs) === 'fire')) this.world.setBlock(fx, fy, fz, 0); } } break; }
      case 'fire_charge': { if (target) { target.hurt({ amount: 5, source: 'fire', attacker: this.owner }); target.fireTicks = 100; } if (block) { const [bx, by, bz, face] = block; const dir = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][face]; const fx = bx + dir[0], fy = by + dir[1], fz = bz + dir[2]; if (this.world.getBlock(fx, fy, fz) === 0) this.world.setBlock(fx, fy, fz, g.blocks.fireStateFor(fx, fy, fz)); } break; }
      case 'wind_charge': g.explode(hx, hy, hz, 1.2, false, this, true); break;
      case 'ghast_fireball': g.explode(hx, hy, hz, 1, g.rules.mobGriefing !== false, this.owner); if (target) target.fireTicks = Math.max(target.fireTicks, 100); break;
      case 'wither_skull': case 'wither_skull_dangerous': {
        const dangerous = this.kind === 'wither_skull_dangerous';
        if (target) { target.hurt({ amount: 8, source: 'attack', attacker: this.owner }); target.addEffect({ id: 'wither', amplifier: 1, duration: [0, 200, 400, 800][g.difficulty] || 200 }); if (this.owner instanceof LivingEntity) this.owner.heal(5); }
        g.explode(hx, hy, hz, 1, g.rules.mobGriefing !== false, this.owner, false);
        if (dangerous && g.rules.mobGriefing !== false) { const reg = this.world.registry; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const bx = Math.floor(hx) + dx, by = Math.floor(hy) + dy, bz = Math.floor(hz) + dz; const st = this.world.getBlock(bx, by, bz); if (st && !/bedrock|end_portal|command_block|barrier/.test(reg.nameOf(st))) g.breakBlock(bx, by, bz, null, true, true); } }
        break;
      }
      case 'dragon_fireball': {
        const c = new AreaEffectCloud(); c.effect = { id: 'instant_damage', amplifier: 0, duration: 1 }; c.duration = 600; c.setPos(hx, hy, hz); g.addEntity(c);
        g.sounds.playAt('entity.ender_dragon.shoot', hx, hy, hz, 2, 1); for (let i = 0; i < 20; i++) g.particles.spawnDragonBreath(hx + (Math.random() - 0.5) * 2, hy + Math.random(), hz + (Math.random() - 0.5) * 2);
        break;
      }
    }
  }
  hurt(): boolean { return false; }
}

export type { EntityDamage };
