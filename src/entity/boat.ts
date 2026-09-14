// Boats and chest boats (vanilla Boat physics: float on the water surface, paddle acceleration, turning,
// friction by status, one/two passengers, a ridden player steers with the movement keys).
import { Entity, fluidSurface } from './entity';
import type { EntityDamage } from './entity';
import { Inventory, ItemStack } from '../items/stack';
import { Player } from './player';

export type BoatStatus = 'in_water' | 'under_water' | 'under_flowing_water' | 'on_land' | 'in_air';

export class BoatEntity extends Entity {
  type = 'boat';
  /** wood type: oak, spruce, ..., bamboo (raft) */
  wood = 'oak';
  chest = false;
  inventory = new Inventory(27);
  damage = 0;              // vanilla "damage" that decays; > 40 breaks the boat
  hurtTime = 0; hurtDir = 1;
  status: BoatStatus = 'in_air';
  lastStatus: BoatStatus = 'in_air';
  waterLevel = 0;
  landFriction = 0;
  deltaRotation = 0;
  inputLeft = false; inputRight = false; inputUp = false; inputDown = false;
  paddleLeft = false; paddleRight = false;
  paddlePos = [0, 0]; prevPaddlePos = [0, 0];
  bubbleAngle = 0;
  outOfControl = 0;

  constructor(wood = 'oak', chest = false) {
    super();
    this.wood = wood; this.chest = chest;
    this.width = 1.375; this.height = 0.5625; this.eyeHeight = 0.3;
  }

  get isRaft(): boolean { return this.wood === 'bamboo'; }
  get maxPassengers(): number { return this.chest ? 1 : 2; }
  itemName(): string { return this.wood === 'bamboo' ? (this.chest ? 'bamboo_chest_raft' : 'bamboo_raft') : `${this.wood}_${this.chest ? 'chest_boat' : 'boat'}`; }

  tick(): void {
    this.lastStatus = this.status;
    this.status = this.getStatus();
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.damage > 0) this.damage--;
    super.tick();
    this.prevPaddlePos[0] = this.paddlePos[0]; this.prevPaddlePos[1] = this.paddlePos[1];
    if (this.status === 'under_water' || this.status === 'under_flowing_water') this.outOfControl++; else this.outOfControl = 0;
    if (this.outOfControl >= 60) this.ejectPassengers();
    this.floatBoat();
    this.controlBoat();
    this.move(this.vx, this.vy, this.vz);
    this.yaw += this.deltaRotation;
    // paddle animation (vanilla: pi/8 per tick while rowing)
    for (let i = 0; i < 2; i++) { const rowing = i === 0 ? this.paddleLeft : this.paddleRight; if (rowing) this.paddlePos[i] += Math.PI / 8; else this.paddlePos[i] = 0; }
    this.positionPassengers();
    // rowing sound
    if ((this.paddleLeft || this.paddleRight) && this.age % 6 === 0 && this.status === 'in_water') this.game.sounds.playAt('entity.boat.paddle_water', this.x, this.y, this.z, 1, 0.8 + Math.random() * 0.4);
    if ((this.paddleLeft || this.paddleRight) && this.age % 6 === 0 && this.status === 'on_land') this.game.sounds.playAt('entity.boat.paddle_land', this.x, this.y, this.z, 1, 0.8 + Math.random() * 0.4);
    // pick up item entities? no; push nearby boats apart
    if (this.age % 10 === 0) for (const e of this.game.entities) if (e instanceof BoatEntity && e !== this && !e.removed && e.bb.intersects(this.bb.clone().grow(0.2, -0.01, 0.2))) { const dx = this.x - e.x, dz = this.z - e.z, d = Math.hypot(dx, dz) || 1; this.vx += dx / d * 0.02; this.vz += dz / d * 0.02; }
  }

  private getStatus(): BoatStatus {
    const reg = this.world.registry, w = this.world;
    // under water: water above the boat's top
    const bb = this.bb;
    const yTop = bb.maxY + 0.001;
    let under = false, flowing = false, any = false; let level = -Infinity;
    for (let x = Math.floor(bb.minX); x < Math.ceil(bb.maxX); x++) for (let z = Math.floor(bb.minZ); z < Math.ceil(bb.maxZ); z++) for (let y = Math.floor(bb.minY) - 1; y < Math.ceil(bb.maxY) + 1; y++) {
      const s = w.getBlock(x, y, z);
      if (!s || !reg.hasWater(s)) continue;
      const h = y + fluidSurface(reg, s, w, x, y, z);
      if (h > level) level = h;
      if (h > bb.minY) any = true;
      if (h > yTop) { under = true; if (reg.fluidLevel(s) !== 0) flowing = true; }
    }
    this.waterLevel = level;
    if (under) return flowing ? 'under_flowing_water' : 'under_water';
    if (any) return 'in_water';
    // on land: something solid under the hull
    this.landFriction = this.groundFriction();
    if (this.landFriction >= 0) return 'on_land';
    return 'in_air';
  }
  private groundFriction(): number {
    const bb = this.bb, w = this.world, reg = this.world.registry;
    let fr = 0, n = 0;
    for (let x = Math.floor(bb.minX); x < Math.ceil(bb.maxX); x++) for (let z = Math.floor(bb.minZ); z < Math.ceil(bb.maxZ); z++) {
      const y = Math.floor(bb.minY - 0.001);
      const s = w.getBlock(x, y, z);
      if (s && reg.collisionBoxes(s).length && !reg.isFluid(s)) { const nm = reg.nameOf(s); fr += nm.includes('ice') ? 0.98 : nm === 'slime_block' ? 0.8 : 0.6; n++; }
    }
    return n ? fr / n : -1;
  }

  private floatBoat(): void {
    const s = this.status;
    let invFriction = 0.05, gravity = -0.04, bounce = 0;
    if (s === 'in_air') { invFriction = 0.9; }
    else if (s === 'in_water') {
      invFriction = 0.9;
      // vanilla: d1 = waterLevel - y ... vertical acceleration towards the surface
      const d = this.waterLevel - this.y - 0.05; // hull sits slightly below the surface
      if (d > 0) { this.vy = Math.min(0.1, this.vy + Math.min(d, 0.1) * 0.5); gravity = 0; }
      else if (d > -0.1) { this.vy *= 0.5; gravity = 0; }
      this.vy = Math.max(-0.1, this.vy);
      bounce = 1;
    }
    else if (s === 'under_water' || s === 'under_flowing_water') { invFriction = 0.9; gravity = -0.04; this.vy = Math.min(0, this.vy) + 0.07 * (s === 'under_flowing_water' ? 0.5 : 1); if (this.vy > 0.05) this.vy = 0.05; }
    else if (s === 'on_land') { invFriction = this.landFriction; if (this.passengers.length) invFriction /= 2; }
    if (gravity !== 0 && s !== 'in_water') this.vy += gravity;
    this.vx *= invFriction; this.vz *= invFriction;
    this.deltaRotation *= invFriction;
    void bounce;
    if (this.onGround && s !== 'in_water' && this.vy < 0) this.vy = 0;
  }

  private controlBoat(): void {
    if (!this.passengers.length) { this.paddleLeft = this.paddleRight = false; this.inputLeft = this.inputRight = this.inputUp = this.inputDown = false; return; }
    let f = 0;
    if (this.inputLeft) this.deltaRotation -= 1;
    if (this.inputRight) this.deltaRotation += 1;
    if (this.inputRight !== this.inputLeft && !this.inputUp && !this.inputDown) f += 0.005;
    if (this.inputUp) f += 0.04;
    if (this.inputDown) f -= 0.005;
    const yaw = this.yaw * Math.PI / 180;
    this.vx += -Math.sin(yaw) * f; this.vz += Math.cos(yaw) * f;
    this.paddleRight = this.inputRight && !this.inputLeft || this.inputUp || this.inputDown;
    this.paddleLeft = this.inputLeft && !this.inputRight || this.inputUp || this.inputDown;
  }

  // ---- passengers ----
  addPassenger(e: Entity): boolean {
    if (this.passengers.length >= this.maxPassengers || e.vehicle) return false;
    this.passengers.push(e); e.vehicle = this;
    this.positionPassengers();
    e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
    return true;
  }
  ejectPassenger(e: Entity): void {
    this.passengers = this.passengers.filter((p) => p !== e);
    e.vehicle = null;
    // vanilla dismount: put the passenger beside the boat on solid ground if possible
    const yaw = this.yaw * Math.PI / 180;
    const sx = Math.cos(yaw), sz = Math.sin(yaw);
    for (const side of [1, -1]) {
      const x = this.x + sx * side * 1.1, z = this.z + sz * side * 1.1;
      const y = this.world.getHeight(Math.floor(x), Math.floor(z));
      if (Math.abs(y - this.y) <= 1.5 && this.game.canStandAt(x, y, z)) { e.setPos(x, y, z); e.vy = 0; return; }
    }
    e.setPos(this.x, this.y + this.height, this.z); e.vy = 0;
  }
  ejectPassengers(): void { for (const p of [...this.passengers]) this.ejectPassenger(p); }
  positionPassengers(): void {
    const yaw = this.yaw * Math.PI / 180;
    this.passengers.forEach((e, i) => {
      // vanilla: front passenger at +0.2 forward (or 0), second at -0.6; y = boat y - 0.1 + rider offset (player -0.35)
      let fwd = this.passengers.length > 1 ? (i === 0 ? 0.2 : -0.6) : 0;
      if (this.isRaft) fwd += 0.2;
      // vanilla: boat.getPassengersRidingOffset (-0.1, raft 0.3) + passenger.getMyRidingOffset (player -0.35)
      const rideOff = e instanceof Player ? -0.35 : 0;
      const yOff = (this.isRaft ? 0.3 : -0.1) + rideOff;
      const x = this.x + -Math.sin(yaw) * fwd, z = this.z + Math.cos(yaw) * fwd;
      e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
      e.x = x; e.y = this.y + yOff; e.z = z; e.updateBB();
      e.vx = 0; e.vy = 0; e.vz = 0;
      e.onGround = true; e.fallDistance = 0;
    });
  }

  interact(player: Player, held: ItemStack | null): boolean {
    if (player.isSneaking) return false;
    if (this.chest && held?.item.name !== undefined && player.isSneaking) return false;
    if (this.chest && player.vehicle !== this && this.passengers.length && this.passengers[0] !== player) { this.game.gui.openContainer(this.inventory, 'container.chestBoat', 3); return true; }
    if (this.chest && (held === null || true) && player.isSneaking) { this.game.gui.openContainer(this.inventory, 'container.chestBoat', 3); return true; }
    if (this.outOfControl >= 60) return false;
    return this.addPassenger(player);
  }

  hurt(d: EntityDamage): boolean {
    if (this.removed) return false;
    this.hurtDir = -this.hurtDir; this.hurtTime = 10; this.damage += d.amount * 10;
    this.game.sounds.playAt('entity.generic.hurt', this.x, this.y, this.z, 0.5, 1.2);
    const creative = d.attacker instanceof Player && d.attacker.isCreative;
    if (creative || this.damage > 40) {
      this.ejectPassengers();
      if (!creative && this.game.rules.doTileDrops !== false) {
        const it = this.game.items.get(this.itemName());
        if (it) this.game.dropItem(this.x, this.y + 0.5, this.z, new ItemStack(it, 1));
        if (this.chest) for (const s of this.inventory.slots) if (s) this.game.dropItem(this.x, this.y + 0.5, this.z, s);
      }
      this.remove();
    }
    return true;
  }
  remove(): void { this.ejectPassengers(); super.remove(); }

  /** Guest side: interpolate and carry our passengers (the local player when riding). */
  remoteTick(): void {
    this.prevPaddlePos[0] = this.paddlePos[0]; this.prevPaddlePos[1] = this.paddlePos[1];
    super.remoteTick();
    for (let i = 0; i < 2; i++) { const rowing = i === 0 ? this.paddleLeft : this.paddleRight; if (rowing) this.paddlePos[i] += Math.PI / 8; else this.paddlePos[i] = 0; }
    this.positionPassengers();
  }
  applySnapshot(s: any): void { super.applySnapshot(s); if (s.pl !== undefined) { this.paddleLeft = !!s.pl; this.paddleRight = !!s.pr; } if (s.dmg !== undefined) { if (s.dmg > this.damage) { this.hurtTime = 10; this.hurtDir = -this.hurtDir; } this.damage = s.dmg; } }

  serialize(): any { return { ...super.serialize(), wood: this.wood, chest: this.chest, inventory: this.chest ? this.inventory.serialize() : undefined }; }
  deserialize(d: any): void { super.deserialize(d); this.wood = d.wood ?? 'oak'; this.chest = !!d.chest; if (d.inventory) this.inventory.deserialize(d.inventory, this.game.items); }
}
