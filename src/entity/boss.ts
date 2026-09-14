// Boss mobs: the ender dragon (phase AI around the End pillars, crystals, breath, exit portal) and the wither
// (spawn charge, skulls, block breaking, armour), plus end crystals and area-effect clouds.
import { Mob, MOB_DEFS } from './mobs';
import { Entity, LivingEntity, type EntityDamage } from './entity';
import { ThrownProjectile } from './misc';
import { Player } from './player';
import { ItemStack } from '../items/stack';
import { clamp, wrapDegrees } from '../math';

export class EndCrystalEntity extends Entity {
  type = 'end_crystal';
  showBottom = true;
  beamTarget: [number, number, number] | null = null;
  constructor() { super(); this.width = 2; this.height = 2; this.eyeHeight = 1; this.noGravity = true; }
  tick(): void {
    super.tick();
    // keep fire burning underneath like vanilla (in the End)
    if (this.world.dimension === 'the_end' && this.age % 20 === 0) { const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z); if (this.world.getBlock(bx, by, bz) === 0) this.world.setBlock(bx, by, bz, this.game.blocks.fireStateFor(bx, by, bz), 0); }
  }
  hurt(d: EntityDamage): boolean {
    if (this.removed) return false;
    if (d.source === 'explosion' && d.attacker === this) return false;
    this.remove();
    this.game.explode(this.x, this.y, this.z, 6, this.game.rules.mobGriefing !== false, this);
    // damaging a crystal near the dragon hurts it (vanilla: the dragon takes 10 when its healing crystal breaks)
    for (const e of this.game.entities) if (e instanceof EnderDragonEntity && !e.removed && e.nearestCrystal === this) { e.nearestCrystal = null; e.hurt({ amount: 10, source: 'explosion' }); }
    return true;
  }
  serialize(): any { return { ...super.serialize(), showBottom: this.showBottom }; }
}

/** Lingering damage/effect zone (dragon breath, lingering potions). */
export class AreaEffectCloud extends Entity {
  type = 'area_effect_cloud';
  radius = 3; duration = 600; effect: { id: string; amplifier: number; duration: number } | null = null; color = 0xff00ff;
  constructor() { super(); this.width = 6; this.height = 0.5; this.noGravity = true; }
  tick(): void {
    super.tick();
    if (this.age >= this.duration) { this.remove(); return; }
    this.radius = Math.max(0.5, 3 - this.age / this.duration * 2.5);
    this.width = this.radius * 2; this.updateBB();
    if (this.age % 5 === 0) for (const e of this.game.livingEntitiesIncludingPlayer()) {
      if (e instanceof EnderDragonEntity) continue;
      const dx = e.x - this.x, dz = e.z - this.z;
      if (dx * dx + dz * dz > this.radius * this.radius || e.y > this.y + 1.5 || e.y + e.height < this.y) continue;
      if (this.effect?.id === 'instant_damage') e.hurt({ amount: 6 * (this.effect.amplifier + 1), source: 'magic' as any, bypassArmor: true });
      else if (this.effect) e.addEffect({ ...this.effect });
    }
    if (this.age % 2 === 0) for (let i = 0; i < 3; i++) { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.radius; this.game.particles.spawnDragonBreath(this.x + Math.cos(a) * r, this.y + Math.random() * 0.3, this.z + Math.sin(a) * r); }
  }
  hurt(): boolean { return false; }
}

const DRAGON_IMMUNE = /obsidian|end_stone|bedrock|iron_bars|respawn_anchor|crying_obsidian|end_portal|end_gateway|command_block|structure|jigsaw|barrier|reinforced_deepslate/;
type DragonPhase = 'holding' | 'strafe' | 'landing_approach' | 'landing' | 'sitting_scan' | 'sitting_attack' | 'sitting_flame' | 'takeoff' | 'charge' | 'dying';

export class EnderDragonEntity extends Mob {
  phase: DragonPhase = 'holding';
  phaseTicks = 0;
  nearestCrystal: EndCrystalEntity | null = null;
  target2: [number, number, number] = [0, 90, 0];
  dragonDeathTime = 0;
  flapTime = 0; prevFlapTime = 0;
  circleAngle = Math.random() * Math.PI * 2;
  chargeTarget: LivingEntity | null = null;
  fireballCooldown = 0;
  centerX = 0; centerZ = 0;
  constructor() { super(MOB_DEFS.ender_dragon); this.persistent = true; this.noGravity = true; this.width = 16; this.height = 8; this.eyeHeight = 3; }

  get isDying(): boolean { return this.dragonDeathTime > 0; }

  tick(): void {
    const g = this.game;
    if (this.dragonDeathTime > 0) { this.deathTick(); return; }
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw; this.prevSwingProgress = this.swingProgress; this.prevFlapTime = this.flapTime;
    this.age++;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.fireballCooldown > 0) this.fireballCooldown--;
    this.phaseTicks++;
    const flying = !this.phase.startsWith('sitting');
    this.flapTime += flying ? 0.1 : 0.03;
    // wing flap sound
    if (flying && Math.floor(this.flapTime * 2) !== Math.floor(this.prevFlapTime * 2) && Math.floor(this.flapTime * 2) % 4 === 0) g.sounds.playAt('entity.ender_dragon.flap', this.x, this.y, this.z, 5, 0.8 + Math.random() * 0.3);
    if (this.age % 200 === 0 && Math.random() < 0.3) g.sounds.playAt('entity.ender_dragon.ambient', this.x, this.y, this.z, 10, 0.8 + Math.random() * 0.3);
    this.checkCrystals();
    this.runPhase();
    if (flying) {
      this.x += this.vx; this.y += this.vy; this.z += this.vz; this.updateBB();
    }
    this.bodyYaw = this.yaw; this.headYaw = this.yaw;
    if (g.rules.mobGriefing !== false) this.destroyBlocks();
    this.hitEntities();
    // limb animation for the model
    this.limbSwingAmount = flying ? 1 : 0;
  }

  private runPhase(): void {
    const g = this.game, p = g.nearestPlayer(this.x, this.y, this.z);
    const target = p && !p.isCreative && !p.isSpectator && p.health > 0 ? p : null;
    switch (this.phase) {
      case 'holding': {
        // circle the pillars at ~40 blocks, occasionally strafe or land
        this.circleAngle += 0.012;
        const r = 40 + Math.sin(this.age * 0.01) * 12;
        this.target2 = [this.centerX + Math.cos(this.circleAngle) * r, 75 + Math.sin(this.age * 0.02) * 10, this.centerZ + Math.sin(this.circleAngle) * r];
        this.flyTowards(this.target2, 0.6);
        if (this.phaseTicks > 100 && target && Math.random() < 0.01) { this.phase = Math.random() < 0.5 ? 'strafe' : 'charge'; this.phaseTicks = 0; this.chargeTarget = target; }
        else if (this.phaseTicks > 400 && Math.random() < 0.003 && this.health < this.maxHealth * 0.95 + 1) { this.phase = 'landing_approach'; this.phaseTicks = 0; }
        else if (this.phaseTicks > 600 && Math.random() < 0.005) { this.phase = 'landing_approach'; this.phaseTicks = 0; }
        break;
      }
      case 'strafe': {
        const t = this.chargeTarget;
        if (!t || t.removed || this.phaseTicks > 200) { this.phase = 'holding'; this.phaseTicks = 0; break; }
        // fly in a wide arc around the target and spit a fireball when facing it
        const a = this.age * 0.02;
        this.target2 = [t.x + Math.cos(a) * 30, t.y + 15, t.z + Math.sin(a) * 30];
        this.flyTowards(this.target2, 0.5);
        const dx = t.x - this.x, dz = t.z - this.z;
        const yawTo = Math.atan2(-dx, dz) * 180 / Math.PI;
        if (Math.abs(wrapDegrees(yawTo - this.yaw)) < 12 && this.fireballCooldown === 0 && Math.hypot(dx, dz) < 64) {
          const f = new ThrownProjectile('dragon_fireball', this);
          const hx = this.x - Math.sin(this.yaw * Math.PI / 180) * 6, hz = this.z + Math.cos(this.yaw * Math.PI / 180) * 6;
          f.setPos(hx, this.y + 2, hz);
          const dy = t.eyeY - (this.y + 2), l = Math.hypot(dx, dy, dz) || 1;
          f.vx = dx / l; f.vy = dy / l; f.vz = dz / l; f.noGravity = true;
          g.addEntity(f);
          g.sounds.playAt('entity.ender_dragon.shoot', this.x, this.y, this.z, 10, 1);
          this.fireballCooldown = 100; this.phase = 'holding'; this.phaseTicks = 0;
        }
        break;
      }
      case 'charge': {
        const t = this.chargeTarget;
        if (!t || t.removed || this.phaseTicks > 100) { this.phase = 'holding'; this.phaseTicks = 0; break; }
        this.flyTowards([t.x, t.y + 1, t.z], 1.2);
        if (this.distSq(t.x, t.y, t.z) < 36) { this.phase = 'holding'; this.phaseTicks = 0; }
        break;
      }
      case 'landing_approach': {
        this.target2 = [this.centerX, 72, this.centerZ + 24];
        this.flyTowards(this.target2, 0.5);
        if (this.distSq(this.target2[0], this.target2[1], this.target2[2]) < 25 || this.phaseTicks > 300) { this.phase = 'landing'; this.phaseTicks = 0; }
        break;
      }
      case 'landing': {
        const portalY = 62;
        this.target2 = [this.centerX, portalY + 4, this.centerZ];
        this.flyTowards(this.target2, 0.35);
        if (Math.hypot(this.x - this.centerX, this.z - this.centerZ) < 2 && Math.abs(this.y - this.target2[1]) < 2) { this.setPos(this.centerX, portalY + 4, this.centerZ); this.vx = this.vy = this.vz = 0; this.phase = 'sitting_scan'; this.phaseTicks = 0; }
        else if (this.phaseTicks > 200) { this.phase = 'holding'; this.phaseTicks = 0; }
        break;
      }
      case 'sitting_scan': {
        if (target) { const d = Math.hypot(target.x - this.x, target.z - this.z); if (d < 20) { this.lookAt(target.x, target.eyeY, target.z, 5, 5); if (d < 10) { this.phase = 'sitting_flame'; this.phaseTicks = 0; } else if (this.phaseTicks > 60 && Math.random() < 0.05) { this.phase = 'sitting_attack'; this.phaseTicks = 0; } } }
        if (this.phaseTicks > 100 + Math.random() * 100 && (!target || Math.hypot(target.x - this.x, target.z - this.z) > 20)) { this.phase = 'takeoff'; this.phaseTicks = 0; }
        if (this.hurtTime > 0 && Math.random() < 0.1) { this.phase = 'takeoff'; this.phaseTicks = 0; }
        break;
      }
      case 'sitting_attack': { if (this.phaseTicks > 40) { this.phase = 'sitting_flame'; this.phaseTicks = 0; } break; }
      case 'sitting_flame': {
        // breath attack: spawn an acid cloud in front of the head
        if (this.phaseTicks === 5) { g.sounds.playAt('entity.ender_dragon.growl', this.x, this.y, this.z, 10, 0.8); const yr = this.yaw * Math.PI / 180; const c = new AreaEffectCloud(); c.effect = { id: 'instant_damage', amplifier: 0, duration: 1 }; c.duration = 200; c.setPos(this.x - Math.sin(yr) * 5, 62, this.z + Math.cos(yr) * 5); g.addEntity(c); }
        if (this.phaseTicks > 200) { this.phase = Math.random() < 0.5 ? 'sitting_scan' : 'takeoff'; this.phaseTicks = 0; }
        break;
      }
      case 'takeoff': {
        this.target2 = [this.centerX, 90, this.centerZ + 30];
        this.flyTowards(this.target2, 0.5);
        if (this.phaseTicks > 60) { this.phase = 'holding'; this.phaseTicks = 0; }
        break;
      }
    }
  }

  private flyTowards(t: [number, number, number], speed: number): void {
    const dx = t[0] - this.x, dy = t[1] - this.y, dz = t[2] - this.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const yawTo = Math.atan2(-dx, dz) * 180 / Math.PI;
    const dyaw = clamp(wrapDegrees(yawTo - this.yaw), -4, 4);
    this.yaw += dyaw;
    const yr = this.yaw * Math.PI / 180;
    const fx = -Math.sin(yr), fz = Math.cos(yr);
    const sp = speed * 0.5;
    this.vx = this.vx * 0.8 + fx * sp * 0.2; this.vz = this.vz * 0.8 + fz * sp * 0.2;
    this.vy = this.vy * 0.8 + clamp(dy / l, -1, 1) * sp * 0.2;
    this.pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI * 0.5, -40, 40);
  }

  private checkCrystals(): void {
    if (this.nearestCrystal && (this.nearestCrystal.removed || this.distSq(this.nearestCrystal.x, this.nearestCrystal.y, this.nearestCrystal.z) > 32 * 32)) this.nearestCrystal = null;
    if (this.age % 10 === 0) {
      if (!this.nearestCrystal) { let best: EndCrystalEntity | null = null, bd = 32 * 32; for (const e of this.game.entities) if (e instanceof EndCrystalEntity && !e.removed) { const d = this.distSq(e.x, e.y, e.z); if (d < bd) { bd = d; best = e; } } this.nearestCrystal = best; }
      if (this.nearestCrystal) { this.nearestCrystal.beamTarget = [this.x, this.y + 3, this.z]; if (this.health < this.maxHealth) this.heal(1); }
    }
  }

  private destroyBlocks(): void {
    const w = this.world, reg = this.world.registry;
    const bb = this.bb;
    let broke = false;
    for (let x = Math.floor(bb.minX) + 4; x < Math.ceil(bb.maxX) - 4; x++) for (let y = Math.floor(bb.minY) + 1; y < Math.ceil(bb.maxY) - 2; y++) for (let z = Math.floor(bb.minZ) + 4; z < Math.ceil(bb.maxZ) - 4; z++) {
      const s = w.getBlock(x, y, z);
      if (!s || reg.isFluid(s)) continue;
      const n = reg.nameOf(s);
      if (DRAGON_IMMUNE.test(n) || reg.block(s).hardness < 0) continue;
      w.setBlock(x, y, z, 0, 1); broke = true;
    }
    if (broke && this.age % 4 === 0) this.game.particles.spawnExplosion(this.x, this.y, this.z, 1);
  }

  private hitEntities(): void {
    if (this.phase.startsWith('sitting')) return;
    for (const e of this.game.livingEntitiesIncludingPlayer()) {
      if (e === this || e.removed || (e instanceof Player && (e.isCreative || e.isSpectator))) continue;
      if (!e.bb.intersects(this.bb.clone().grow(-2, -1, -2))) continue;
      const hurt = e.hurt({ amount: 10 * [0.5, 0.75, 1, 1.5][this.game.difficulty] || 10, source: 'attack', attacker: this });
      if (hurt) { const dx = e.x - this.x, dz = e.z - this.z, d = Math.hypot(dx, dz) || 1; e.vx += dx / d * 1.2; e.vz += dz / d * 1.2; e.vy += 0.6; }
    }
  }

  hurt(d: EntityDamage): boolean {
    if (this.dragonDeathTime > 0) return false;
    if (d.source === 'explosion' && this.phase.startsWith('sitting')) return false;
    // vanilla: while perched only the head takes full damage; elsewhere 1/4
    const sitting = this.phase.startsWith('sitting');
    const amount = sitting ? d.amount : d.amount / 4;
    if (d.source === 'arrow' && !sitting) { this.hurtTime = 5; return false; }
    const r = super.hurt({ ...d, amount });
    if (r && sitting && Math.random() < 0.3) { this.phase = 'takeoff'; this.phaseTicks = 0; }
    if (r) this.game.sounds.playAt('entity.ender_dragon.hurt', this.x, this.y, this.z, 10, 1);
    return r;
  }

  die(): void {
    if (this.dragonDeathTime > 0) return;
    this.health = 0; this.dragonDeathTime = 1; this.phase = 'dying';
    this.game.sounds.playAt('entity.ender_dragon.death', this.x, this.y, this.z, 20, 1);
    this.game.gui.showTitle('', 'The dragon has been slain!');
  }
  private deathTick(): void {
    const g = this.game;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevYaw = this.yaw; this.prevPitch = this.pitch; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw;
    this.dragonDeathTime++;
    this.deathTime = Math.min(19, this.dragonDeathTime);
    if (this.dragonDeathTime % 10 === 0) g.particles.spawnExplosion(this.x + (Math.random() - 0.5) * 8, this.y + 2 + (Math.random() - 0.5) * 4, this.z + (Math.random() - 0.5) * 8, 2);
    if (this.dragonDeathTime > 150 && this.dragonDeathTime % 5 === 0) g.spawnXp(this.x, this.y, this.z, g.dragonKills === 0 ? 500 : 20);
    if (this.dragonDeathTime === 1) { this.vx = this.vy = this.vz = 0; }
    this.y += 0.1; this.yaw += 20; this.updateBB();
    if (this.dragonDeathTime >= 200) {
      g.spawnXp(this.x, this.y, this.z, g.dragonKills === 0 ? 2000 : 500);
      g.onDragonKilled(this);
      super.remove();
    }
  }
  remove(): void { super.remove(); }
  serialize(): any { return { ...super.serialize(), type: 'ender_dragon', phase: this.phase }; }
}

const WITHER_IMMUNE = /bedrock|end_portal|end_gateway|command_block|structure|jigsaw|barrier|reinforced_deepslate|obsidian$|crying_obsidian|end_stone|respawn_anchor|ancient_debris|netherite_block|moving_piston/;

export class WitherEntity extends Mob {
  spawnTicks = 220;   // invulnerable charge-up
  destroyBlocksTick = 0;
  headYaws = [0, 0];
  skullCooldown = [40, 40, 40];
  constructor() { super(MOB_DEFS.wither); this.persistent = true; this.noGravity = true; this.health = this.maxHealth / 3; }

  get armored(): boolean { return this.health <= this.maxHealth / 2; }

  tick(): void {
    const g = this.game;
    if (this.health <= 0) { super.tick(); return; }
    if (this.spawnTicks > 0) {
      // charging: heal to full, shake, explode when done
      this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw;
      this.spawnTicks--; this.age++;
      if (this.spawnTicks % 10 === 0 && this.health < this.maxHealth) this.heal(10);
      if (this.spawnTicks === 0) {
        g.explode(this.x, this.y + 1, this.z, 7, g.rules.mobGriefing !== false, this);
        g.sounds.playAt('entity.wither.spawn', this.x, this.y, this.z, 10, 1);
        g.gui.showTitle('', 'The Wither has been summoned');
        this.health = this.maxHealth;
      }
      return;
    }
    super.tick();
    if (this.removed) return;
    if (this.age % 100 === 0 && Math.random() < 0.5) g.sounds.playAt('entity.wither.ambient', this.x, this.y, this.z, 5, 1);
    // block breaking after being hurt (vanilla destroyBlocksTick)
    if (this.destroyBlocksTick > 0) {
      this.destroyBlocksTick--;
      if (this.destroyBlocksTick === 0 && g.rules.mobGriefing !== false) {
        const w = this.world, reg = w.registry; let broke = false;
        const bb = this.bb;
        for (let x = Math.floor(bb.minX) - 1; x <= Math.floor(bb.maxX) + 1; x++) for (let y = Math.floor(bb.minY); y <= Math.floor(bb.maxY) + 1; y++) for (let z = Math.floor(bb.minZ) - 1; z <= Math.floor(bb.maxZ) + 1; z++) {
          const s = w.getBlock(x, y, z); if (!s || reg.isFluid(s)) continue;
          if (WITHER_IMMUNE.test(reg.nameOf(s)) || reg.block(s).hardness < 0) continue;
          g.breakBlock(x, y, z, null, true, true); broke = true;
        }
        if (broke) g.sounds.playAt('entity.wither.break_block', this.x, this.y, this.z, 1, 1);
      }
    }
    // slow regeneration
    if (this.age % 20 === 0) this.heal(1);
  }

  protected aiStep(): void {
    const g = this.game;
    const p = g.nearestPlayer(this.x, this.y, this.z);
    this.moveForward = 0; this.moveStrafe = 0; this.jumping = false;
    if (this.target && (this.target.removed || this.target.health <= 0 || this.distSq(this.target.x, this.target.y, this.target.z) > 64 * 64)) this.target = null;
    if (!this.target && p && !p.isCreative && !p.isSpectator && p.health > 0 && this.distSq(p.x, p.y, p.z) < 64 * 64) this.target = p;
    if (!this.target) { // target other mobs too (vanilla attacks any non-undead living entity)
      for (const e of g.entities) if (e instanceof LivingEntity && e !== this && !e.removed && e.health > 0 && !(e as any).undead && !(e instanceof Player) && this.distSq(e.x, e.y, e.z) < 20 * 20) { this.target = e; break; }
    }
    const t = this.target;
    if (t) {
      // hover above the target unless armoured (then it stays low so melee can reach it)
      const wantY = this.armored ? t.y + 0.5 : t.y + 3;
      const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz) || 1;
      const sp = 0.05;
      if (d > 8) { this.vx += dx / d * sp; this.vz += dz / d * sp; }
      this.vy += (wantY - this.y) * 0.02;
      this.lookAt(t.x, t.eyeY, t.z, 10, 10);
      // three heads shoot skulls (centre head every 40 ticks, side heads at random targets nearby)
      for (let i = 0; i < 3; i++) {
        if (--this.skullCooldown[i] > 0) continue;
        this.skullCooldown[i] = i === 0 ? 40 + Math.floor(Math.random() * 20) : 60 + Math.floor(Math.random() * 40);
        const dangerous = Math.random() < 0.001 || (this.armored && Math.random() < 0.1);
        const s = new ThrownProjectile(dangerous ? 'wither_skull_dangerous' : 'wither_skull', this);
        const hx = this.x + (i === 0 ? 0 : (i === 1 ? -1.3 : 1.3)) * Math.cos(this.yaw * Math.PI / 180), hz = this.z + (i === 0 ? 0 : (i === 1 ? -1.3 : 1.3)) * Math.sin(this.yaw * Math.PI / 180);
        s.setPos(hx, this.y + (i === 0 ? 3.1 : 2.6), hz);
        const ddx = t.x - hx, ddy = t.eyeY - 0.5 - s.y, ddz = t.z - hz, l = Math.hypot(ddx, ddy, ddz) || 1;
        const spd = dangerous ? 0.6 : 0.9;
        s.vx = ddx / l * spd + (Math.random() - 0.5) * 0.05; s.vy = ddy / l * spd; s.vz = ddz / l * spd + (Math.random() - 0.5) * 0.05; s.noGravity = true;
        g.addEntity(s);
        g.sounds.playAt('entity.wither.shoot', this.x, this.y, this.z, 3, 1);
      }
    } else {
      if (this.age % 80 === 0) { this.vx += (Math.random() - 0.5) * 0.3; this.vz += (Math.random() - 0.5) * 0.3; }
      this.vy += ((this.world.getHeight(Math.floor(this.x), Math.floor(this.z)) + 5) - this.y) * 0.01;
    }
    this.vx *= 0.9; this.vy *= 0.9; this.vz *= 0.9;
  }
  protected travel(): void { this.move(this.vx, this.vy, this.vz); }

  hurt(d: EntityDamage): boolean {
    if (this.spawnTicks > 0) return false;
    if (d.attacker === this || d.source === 'explosion' && !d.attacker) return false; // own explosions / skulls
    if (d.source === 'arrow' && this.armored) return false;
    if (d.source === 'drown' || d.source === 'wither' as any) return false;
    const r = super.hurt(d);
    if (r) { if (this.destroyBlocksTick <= 0) this.destroyBlocksTick = 20; }
    return r;
  }
  die(d: EntityDamage): void {
    super.die(d);
    const g = this.game;
    const it = g.items.get('nether_star');
    if (it) g.dropItem(this.x, this.y + 1, this.z, new ItemStack(it, 1));
    g.sounds.playAt('entity.wither.death', this.x, this.y, this.z, 10, 1);
  }
  serialize(): any { return { ...super.serialize(), type: 'wither', spawnTicks: this.spawnTicks }; }
  deserialize(d: any): void { super.deserialize(d); this.spawnTicks = d.spawnTicks ?? 0; }
}
