// A player controlled by another client. On the host it is that guest's ServerPlayer: movement arrives as network
// snapshots (validated by NetHost) while health, hunger, air, effects, item use, fall damage, death and inventory
// are simulated here and reported back. On guests it is a purely visual mirror of the host and other guests.
import { Player } from './player';
import type { EntityDamage } from './entity';
import type { Dimension } from '../world/world';

export class RemotePlayer extends Player {
  isRemote = true;
  clientId = 0;
  /** latest snapshot target */
  tx = 0; ty = 0; tz = 0; tyaw = 0; tpitch = 0;
  snapshotAge = 0;
  lerpSteps = 0;
  private hasSnapshot = false;
  hurtHandler: ((d: EntityDamage) => void) | null = null;
  /** last full player state reported by the guest (persisted by the host) */
  lastSaved: any = null;
  skin: 'steve' | 'alex' = 'steve';
  /** host: round-trip latency the guest last measured, shown in the player list */
  ping = 0;
  /** host: something other than the guest's own movement moved this player (teleport, respawn, ender pearl,
   *  chorus fruit): the owner must be told (vanilla ClientboundPlayerPositionPacket). */
  needsCorrection = false;
  /** host: the guest's last movement packet said it was standing on the ground */
  reportedOnGround = true;
  /** the `use` flag of the previous snapshot (item use starts only on its rising edge) */
  private lastUseFlag = false;
  constructor(name: string) { super(); this.name = name; this.cheats = false; }

  setPos(x: number, y: number, z: number): void {
    super.setPos(x, y, z);
    // a vehicle repositioning its rider every tick is not a teleport: the guest follows the vehicle itself
    if (!this.remote) { this.tx = x; this.ty = y; this.tz = z; this.lerpSteps = 0; if (!this.vehicle) this.needsCorrection = true; }
  }

  applySnapshot(s: any): void {
    const host = !this.remote;
    // vanilla ServerGamePacketListenerImpl.handleMovePlayer + Entity.checkFallDamage: fall distance accumulates
    // from the reported movement and is settled when the client reports touching the ground
    if (host && this.hasSnapshot && !this.vehicle) {
      const dy = s.y - this.ty;
      const onGround = s.og !== undefined ? !!s.og : dy === 0;
      if (this.flying || this.inWater || this.inLava || this.isClimbing() || this.hasEffect('levitation')) this.fallDistance = 0;
      else if (!onGround && dy < 0) this.fallDistance -= dy;
      if (onGround) { if (this.fallDistance > 0) this.fall(this.fallDistance); this.fallDistance = 0; }
      this.reportedOnGround = onGround; this.onGround = onGround;
    }
    this.tx = s.x; this.ty = s.y; this.tz = s.z; this.tyaw = s.yaw; this.tpitch = s.pitch;
    this.hasSnapshot = true;
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
    if (s.use !== undefined) {
      // edge-triggered like vanilla's single ServerboundUseItemPacket: a guest whose meal (in its own, possibly
      // slower or delayed clock) is still flagged "using" after the host's timer finished must not start a second one
      const rising = !!s.use && !this.lastUseFlag;
      this.lastUseFlag = !!s.use;
      if (rising && !this.usingItem) {
        const held = this.heldItem();
        // the host actually consumes the item (vanilla ServerPlayer eats/drinks); mirrors only animate
        const duration = held ? (host ? this.useDurationFor(held) : 72000) : 0;
        if (held && duration > 0) this.startUsing(held, duration);
      } else if (!s.use && this.usingItem && !host) { this.usingItem = null; this.itemUseTicks = 0; }
      // the host keeps going until its own timer completes or the guest explicitly releases (vanilla
      // RELEASE_USE_ITEM): the guest finishing a couple of ticks earlier must not cancel the meal
    }
    if (s.hurt) this.hurtTime = this.hurtDuration;
    if (s.dead !== undefined && s.dead && this.deathTime === 0) this.deathTime = 1;
    if (s.dead === false) this.deathTime = 0;
    if (s.br && Number.isInteger(s.br.x) && Number.isInteger(s.br.y) && Number.isInteger(s.br.z) && Number.isInteger(s.br.stage)) this.breaking = { x: s.br.x, y: s.br.y, z: s.br.z, progress: Math.max(0, Math.min(9, s.br.stage)) / 10, state: s.br.state };
    else if (s.br === null) this.breaking = null;
    this.snapshotAge = 0;
    this.lerpSteps = 3;
    if (Math.abs(this.x - this.tx) + Math.abs(this.z - this.tz) > 16) {
      this.x = this.tx; this.y = this.ty; this.z = this.tz; this.updateBB();
      this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.yaw = this.prevYaw = this.tyaw; this.pitch = this.prevPitch = this.tpitch; this.lerpSteps = 0;
    }
  }

  networkSnapshot(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return this.hasSnapshot
      ? { x: this.tx, y: this.ty, z: this.tz, yaw: this.tyaw, pitch: this.tpitch }
      : { x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch };
  }

  remoteTick(): void { this.tick(); }
  tick(): void {
    const host = !this.remote;
    if (host) this.tickCooldowns(); else { this.attackCooldownTicks++; if (this.breakCooldown > 0) this.breakCooldown--; if (this.useCooldown > 0) this.useCooldown--; }
    if (this.vehicle?.removed) this.stopRiding();
    if (this.vehicle) { // the vehicle positions us; only animate
      this.prevYaw = this.yaw; this.prevPitch = this.pitch; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw; this.prevSwingProgress = this.swingProgress; this.prevLimbSwingAmount = this.limbSwingAmount;
      const f = this.lerpSteps > 0 ? 1 / this.lerpSteps : 1;
      let dy = this.tyaw - this.yaw; while (dy > 180) dy -= 360; while (dy < -180) dy += 360; this.yaw += dy * f; this.pitch += (this.tpitch - this.pitch) * f; this.headYaw = this.yaw;
      if (this.lerpSteps > 0) this.lerpSteps--;
      this.updateSwing();
      if (host) this.serverTick(); else if (this.hurtTime > 0) this.hurtTime--;
      this.fallDistance = 0;
      return;
    }
    // interpolate towards the last snapshot (3 ticks of smoothing, like vanilla's lerp steps)
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch; this.prevBodyYaw = this.bodyYaw; this.prevHeadYaw = this.headYaw;
    this.prevSwingProgress = this.swingProgress; this.prevLimbSwingAmount = this.limbSwingAmount; this.prevCameraEye = this.cameraEye;
    const f = this.lerpSteps > 0 ? 1 / this.lerpSteps : 1;
    const nx = this.x + (this.tx - this.x) * f, ny = this.y + (this.ty - this.y) * f, nz = this.z + (this.tz - this.z) * f;
    const dx = nx - this.x, dz = nz - this.z;
    // Do not use setPos here: it also overwrites prevX/Y/Z, which disables the renderer's
    // partial-tick interpolation and makes a smoothly lerped entity still look like it moves at 20 Hz.
    this.x = nx; this.y = ny; this.z = nz; this.updateBB();
    let dy = this.tyaw - this.yaw; while (dy > 180) dy -= 360; while (dy < -180) dy += 360;
    this.yaw += dy * f; this.pitch += (this.tpitch - this.pitch) * f;
    if (this.lerpSteps > 0) this.lerpSteps--;
    this.headYaw = this.yaw;
    // body follows head like vanilla
    let bd = this.yaw - this.bodyYaw; while (bd > 180) bd -= 360; while (bd < -180) bd += 360;
    if (Math.abs(bd) > 50) this.bodyYaw = this.yaw - Math.sign(bd) * 50; else if (Math.hypot(dx, dz) > 0.01) this.bodyYaw = this.yaw;
    // limb swing
    const amt = Math.min(1, Math.hypot(dx, dz) * 4);
    this.limbSwingAmount += (amt - this.limbSwingAmount) * 0.4;
    this.limbSwing += this.limbSwingAmount;
    this.updateSwing();
    this.height = this.sleeping ? 0.2 : this.swimmingPose ? 0.6 : this.isSneaking ? 1.5 : 1.8; this.updateBB();
    this.cameraEye = this.sleeping ? 0.2 : this.swimmingPose ? 0.4 : this.isSneaking ? 1.27 : 1.62; this.eyeHeight = this.cameraEye;
    if (host) this.serverTick();
    else { if (this.hurtTime > 0) this.hurtTime--; if (this.deathTime > 0) this.deathTime = Math.min(20, this.deathTime + 1); this.age++; }
    this.tickPassengers();
    this.snapshotAge++;
  }

  /** vanilla ServerPlayer.tick minus movement: everything the server owns about a player. */
  private serverTick(): void {
    this.baseTick();
    this.tickEffectsAndAir();
    if (this.health <= 0) { this.deathTime = Math.min(20, this.deathTime + 1); return; }
    this.checkBlockContacts();
    this.tickHunger();
    this.tickItemUse();
    this.tickMovementExhaustion();
    if (this.flying || this.isSpectator) this.fallDistance = 0;
    this.checkPortal();
  }
  protected travelTo(target: Dimension): void { void this.game.travelRemotePlayer(this, target); }

  /** The host applies damage to this mirror, then forwards the authoritative result to its owner. */
  hurt(d: EntityDamage): boolean {
    if (this.remote) return false;
    const before = this.health + this.absorption;
    const hurt = super.hurt(d);
    if (hurt) this.hurtHandler?.({ ...d, amount: Math.max(0, before - this.health - this.absorption), bypassArmor: true });
    return hurt;
  }
  addExhaustion(n: number): void { if (!this.remote) super.addExhaustion(n); }
}
