// A player controlled by another client. On the host it stands in for a guest (mob targeting, explosions,
// pickups); on guests it represents the host and other guests. Movement comes from network snapshots.
import { Player } from './player';
import type { EntityDamage } from './entity';

export class RemotePlayer extends Player {
  isRemote = true;
  clientId = 0;
  /** latest snapshot target */
  tx = 0; ty = 0; tz = 0; tyaw = 0; tpitch = 0;
  snapshotAge = 0;
  hurtHandler: ((d: EntityDamage) => void) | null = null;
  /** last full player state reported by the guest (persisted by the host) */
  lastSaved: any = null;
  skin: 'steve' | 'alex' = 'steve';
  remoteVehicleId: number | null = null;
  remoteVehicleSeat = -1;
  constructor(name: string) { super(); this.name = name; this.cheats = false; }

  applySnapshot(s: any): void {
    this.tx = s.x; this.ty = s.y; this.tz = s.z; this.tyaw = s.yaw; this.tpitch = s.pitch;
    if (s.sneak !== undefined) this.isSneaking = !!s.sneak;
    if (s.sprint !== undefined) this.isSprinting = !!s.sprint;
    if (s.swim !== undefined) this.swimmingPose = !!s.swim;
    if (s.sleep !== undefined) this.sleeping = !!s.sleep;
    if (s.fly !== undefined) this.flying = !!s.fly;
    if (s.vid !== undefined) this.remoteVehicleId = Number.isInteger(s.vid) ? s.vid : null;
    if (s.seat !== undefined) this.remoteVehicleSeat = Number.isInteger(s.seat) ? s.seat : -1;
    if (s.health !== undefined) this.health = s.health;
    if (s.slot !== undefined) this.selectedSlot = s.slot;
    if (s.mode) this.gameMode = s.mode;
    if (s.swing) this.swing();
    if (s.use !== undefined) { this.usingItem = s.use ? this.heldItem() : null; }
    if (s.hurt) this.hurtTime = this.hurtDuration;
    if (s.dead !== undefined && s.dead && this.deathTime === 0) this.deathTime = 1;
    if (s.dead === false) this.deathTime = 0;
    if (s.br && Number.isInteger(s.br.x) && Number.isInteger(s.br.y) && Number.isInteger(s.br.z) && Number.isInteger(s.br.stage)) this.breaking = { x: s.br.x, y: s.br.y, z: s.br.z, progress: Math.max(0, Math.min(9, s.br.stage)) / 10, state: s.br.state };
    else if (s.br === null) this.breaking = null;
    this.snapshotAge = 0;
    if (this.snapshotAge === 0 && Math.abs(this.x - this.tx) + Math.abs(this.z - this.tz) > 16) { this.setPos(this.tx, this.ty, this.tz); this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; }
  }

  remoteTick(): void { this.tick(); }
  tick(): void {
    this.attackCooldownTicks++;
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.vehicle?.removed) this.vehicle = null;
    if (this.vehicle) { // the vehicle positions us; only animate
      this.prevYaw = this.yaw; this.prevPitch = this.pitch; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw; this.prevSwingProgress = this.swingProgress; this.prevLimbSwingAmount = this.limbSwingAmount;
      let dy = this.tyaw - this.yaw; while (dy > 180) dy -= 360; while (dy < -180) dy += 360; this.yaw += dy / 3; this.pitch += (this.tpitch - this.pitch) / 3; this.headYaw = this.yaw;
      this.updateSwingRemote(); if (this.hurtTime > 0) this.hurtTime--; this.age++;
      return;
    }
    // interpolate towards the last snapshot (3 ticks of smoothing, like vanilla's lerp steps)
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw;
    this.prevSwingProgress = this.swingProgress; this.prevLimbSwingAmount = this.limbSwingAmount; this.prevCameraEye = this.cameraEye;
    const f = 1 / 3;
    const nx = this.x + (this.tx - this.x) * f, ny = this.y + (this.ty - this.y) * f, nz = this.z + (this.tz - this.z) * f;
    const dx = nx - this.x, dz = nz - this.z;
    this.setPos(nx, ny, nz);
    let dy = this.tyaw - this.yaw; while (dy > 180) dy -= 360; while (dy < -180) dy += 360;
    this.yaw += dy * f; this.pitch += (this.tpitch - this.pitch) * f;
    this.headYaw = this.yaw;
    // body follows head like vanilla
    let bd = this.yaw - this.bodyYaw; while (bd > 180) bd -= 360; while (bd < -180) bd += 360;
    if (Math.abs(bd) > 50) this.bodyYaw = this.yaw - Math.sign(bd) * 50; else if (Math.hypot(dx, dz) > 0.01) this.bodyYaw = this.yaw;
    // limb swing
    const amt = Math.min(1, Math.hypot(dx, dz) * 4);
    this.limbSwingAmount += (amt - this.limbSwingAmount) * 0.4;
    this.limbSwing += this.limbSwingAmount;
    this.updateSwingRemote();
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.deathTime > 0) this.deathTime = Math.min(20, this.deathTime + 1);
    this.height = this.sleeping ? 0.2 : this.swimmingPose ? 0.6 : this.isSneaking ? 1.5 : 1.8; this.updateBB();
    this.cameraEye = this.sleeping ? 0.2 : this.swimmingPose ? 0.4 : this.isSneaking ? 1.27 : 1.62; this.eyeHeight = this.cameraEye;
    this.snapshotAge++;
    this.age++;
  }
  private updateSwingRemote(): void {
    if (this.swinging) { this.swingTime++; if (this.swingTime >= 6) { this.swingTime = 0; this.swinging = false; } } else this.swingTime = 0;
    this.swingProgress = this.swingTime / 6;
  }

  /** The host applies damage to this mirror, then forwards the authoritative result to its owner. */
  hurt(d: EntityDamage): boolean {
    const before = this.health;
    const hurt = super.hurt(d);
    if (hurt) this.hurtHandler?.({ ...d, amount: Math.max(0, before - this.health), bypassArmor: true, attacker: null });
    return hurt;
  }
  die(): void { this.health = 0; this.isDead = true; }
  addExhaustion(): void {}
}
