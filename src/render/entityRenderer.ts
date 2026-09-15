// Draws entities: box-model mobs/players with animation, item entities, projectiles, TNT, falling blocks, XP orbs.
import type { Renderer } from './renderer';
import type { SkyState } from './sky';
import { getModel, type ModelDef, type PartDef, type BoxDef } from './entityModels';
import { Entity, ItemEntity, LivingEntity, ExperienceOrb } from '../entity/entity';
import { RemotePlayer } from '../entity/remotePlayer';
import { BoatEntity } from '../entity/boat';
import { EndCrystalEntity, EnderDragonEntity, WitherEntity } from '../entity/boss';
import { Mob } from '../entity/mobs';
import { FallingBlockEntity, PrimedTnt, ArrowEntity, ThrownProjectile } from '../entity/misc';
import { Player } from '../entity/player';
import type { ItemRenderer } from './itemRenderer';
import type { Game } from '../game/game';
import { mat4Rotate, mat4Identity, mat4Mul, mat4Perspective, mat4RotateX, mat4RotateY, mat4RotateZ, mat4Scale, mat4Translate, DEG, type Mat4 } from '../math';
import { createTexture } from './gl';
import { ItemStack } from '../items/stack';
import { DYE_COLORS } from './mesher';

interface PartGpu { def: PartDef; start: number; count: number; children: PartGpu[] }
interface ModelGpu { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; parts: PartGpu[]; def: ModelDef }

const STRIDE = 32;

export class EntityRenderer {
  private models = new Map<string, ModelGpu>();
  private textures = new Map<string, WebGLTexture | null>();
  private white: WebGLTexture;
  private tmp = new Float32Array(16); private tmp2 = new Float32Array(16);
  time = 0;

  constructor(private renderer: Renderer, private items: ItemRenderer, private game: Game) {
    this.white = createTexture(renderer.gl, null, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
  }

  // ---------- resources ----------
  texture(path: string): WebGLTexture {
    const t = this.textures.get(path);
    if (t) return t;
    if (t === null) return this.white;
    this.textures.set(path, null);
    fetch('./assets/pack/assets/minecraft/textures/' + path + '.png').then(async (r) => {
      if (!r.ok) { const alt = path.replace(/_temperate$/, ''); if (alt !== path) { this.textures.delete(path); const t2 = this.texture(alt); this.textures.set(path, t2); } return; }
      const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none' });
      this.textures.set(path, createTexture(this.renderer.gl, bmp, { nearest: true }));
    }).catch(() => {});
    return this.white;
  }

  private model(name: string): ModelGpu {
    let m = this.models.get(name);
    if (m) return m;
    const def = getModel(name);
    const verts: number[] = [];
    const build = (p: PartDef): PartGpu => {
      const start = verts.length / 8;
      for (const b of p.boxes) this.emitBox(verts, b, def.texW, def.texH);
      const count = verts.length / 8 - start;
      return { def: p, start, count, children: (p.children ?? []).map(build) };
    };
    const parts = def.parts.map(build);
    const gl = this.renderer.gl;
    const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 20);
    gl.bindVertexArray(null);
    m = { vao, vbo, parts, def };
    this.models.set(name, m);
    return m;
  }

  /** Emit a vanilla-layout box (model space, pixels). */
  private emitBox(out: number[], b: BoxDef, tw: number, th: number): void {
    const inf = b.inflate ?? 0;
    const x1 = b.x - inf, y1 = b.y - inf, z1 = b.z - inf, x2 = b.x + b.w + inf, y2 = b.y + b.h + inf, z2 = b.z + b.d + inf;
    const { u, v, w, h, d } = b;
    const U = (px: number) => px / tw, V = (py: number) => py / th;
    const m = b.mirror ? -1 : 1;
    const mu = (a: number, c: number) => (b.mirror ? [c, a] : [a, c]);
    // face(vertices ccw as seen from outside), uv rect
    const quad = (p: number[][], uv: number[][], n: number[]) => {
      // two triangles: 0,1,2  0,2,3
      for (const i of [0, 1, 2, 0, 2, 3]) out.push(p[i][0], p[i][1], p[i][2], uv[i][0], uv[i][1], n[0], n[1], n[2]);
    };
    // x1 face (character's right): uv u..u+d, v+d..v+d+h ; u+d <-> z1
    { const [ua, ub] = mu(U(u), U(u + d)); quad([[x1, y1, z2], [x1, y2, z2], [x1, y2, z1], [x1, y1, z1]], [[ua, V(v + d)], [ua, V(v + d + h)], [ub, V(v + d + h)], [ub, V(v + d)]], [-1, 0, 0]); }
    // x2 face (left): u+d+w..u+2d+w ; u+d+w <-> z1
    { const [ua, ub] = mu(U(u + d + w), U(u + 2 * d + w)); quad([[x2, y1, z1], [x2, y2, z1], [x2, y2, z2], [x2, y1, z2]], [[ua, V(v + d)], [ua, V(v + d + h)], [ub, V(v + d + h)], [ub, V(v + d)]], [1, 0, 0]); }
    // z1 face (front): u+d..u+d+w <-> x1..x2
    { const [ua, ub] = mu(U(u + d), U(u + d + w)); quad([[x1, y1, z1], [x1, y2, z1], [x2, y2, z1], [x2, y1, z1]], [[ua, V(v + d)], [ua, V(v + d + h)], [ub, V(v + d + h)], [ub, V(v + d)]], [0, 0, -1]); }
    // z2 face (back): u+2d+w..u+2d+2w <-> x2..x1
    { const [ua, ub] = mu(U(u + 2 * d + w), U(u + 2 * d + 2 * w)); quad([[x2, y1, z2], [x2, y2, z2], [x1, y2, z2], [x1, y1, z2]], [[ua, V(v + d)], [ua, V(v + d + h)], [ub, V(v + d + h)], [ub, V(v + d)]], [0, 0, 1]); }
    // y1 face (top in model space = up): u+d..u+d+w <-> x1..x2, v..v+d <-> z2..z1
    { const [ua, ub] = mu(U(u + d), U(u + d + w)); quad([[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]], [[ua, V(v)], [ua, V(v + d)], [ub, V(v + d)], [ub, V(v)]], [0, -1, 0]); }
    // y2 face (bottom): u+d+w..u+d+2w, v..v+d
    { const [ua, ub] = mu(U(u + d + w), U(u + d + 2 * w)); quad([[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]], [[ua, V(v)], [ua, V(v + d)], [ub, V(v + d)], [ub, V(v)]], [0, 1, 0]); }
    void m;
  }

  // ---------- drawing ----------
  drawAll(entities: Entity[], player: Player, sky: SkyState, partial: number, firstPerson: boolean): void {
    const gl = this.renderer.gl;
    this.time += 1 / 60;
    const o = this.game.options;
    const maxD = (this.renderer.viewDistance * 16 + 32) * o.entityDistance;
    const shadows: { x: number; y: number; z: number; radius: number; alpha: number }[] = [];
    const shadowFor = (e: Entity, radius: number) => {
      if (!o.entityShadows || e instanceof ExperienceOrb) return;
      const pos = this.lerpPos(e, partial); const cb = this.renderer.camBase;
      const ex = pos[0] + cb[0], ey = pos[1] + cb[1], ez = pos[2] + cb[2];
      // ground within 2 blocks below the feet
      let gy = -1e9; for (let y = Math.floor(ey); y >= Math.floor(ey) - 2; y--) { const s = this.game.world.getBlock(Math.floor(ex), y, Math.floor(ez)); if (s && this.game.registry.fullCube[s]) { gy = y + 1; break; } }
      if (gy < -1e8) return;
      const a = Math.max(0, Math.min(1, (1 - (ey - gy) / 2))) * 0.5;
      if (a > 0.01) shadows.push({ x: ex, y: gy, z: ez, radius, alpha: a });
    };
    for (const e of entities) {
      if (e.removed) continue;
      const dx = e.x - this.renderer.camera.x, dz = e.z - this.renderer.camera.z;
      if (dx * dx + dz * dz > maxD * maxD) continue;
      if (!(e instanceof ArrowEntity || e instanceof ThrownProjectile)) shadowFor(e, Math.min(2, e.width * 0.6 + 0.1));
      if (e instanceof Mob) this.drawMob(e, sky, partial);
      else if (e instanceof ItemEntity) this.drawItemEntity(e, sky, partial);
      else if (e instanceof FallingBlockEntity) this.drawBlockEntity(e.blockState, e, sky, partial, false);
      else if (e instanceof PrimedTnt) this.drawBlockEntity(this.game.registry.defaultState('tnt'), e, sky, partial, (e.fuse / 5) % 2 < 1 && e.fuse < 20 || (e.fuse % 10) < 5 && e.fuse >= 20 && false);
      else if (e instanceof ArrowEntity) this.drawArrow(e, sky, partial);
      else if (e instanceof ThrownProjectile) this.drawThrown(e, sky, partial);
      else if (e instanceof ExperienceOrb) this.drawXp(e, sky, partial);
      else if (e instanceof RemotePlayer) this.drawPlayer(e, sky, partial);
      else if (e instanceof BoatEntity) this.drawBoat(e, sky, partial);
      else if (e instanceof EndCrystalEntity) this.drawCrystal(e, sky, partial);
    }
    if (!firstPerson && !player.removed) { this.drawPlayer(player, sky, partial); shadowFor(player, 0.5); }
    gl.bindVertexArray(null);
    this.renderer.drawShadows(shadows);
  }

  private lerpPos(e: Entity, partial: number): [number, number, number] {
    const cb = this.renderer.camBase;
    return [e.prevX + (e.x - e.prevX) * partial - cb[0], e.prevY + (e.y - e.prevY) * partial - cb[1], e.prevZ + (e.z - e.prevZ) * partial - cb[2]];
  }

  private lightAt(e: Entity): [number, number] {
    const l = this.game.world.getLight(Math.floor(e.x), Math.floor(e.eyeY), Math.floor(e.z));
    return [l & 15, l >> 4];
  }

  private beginEntityProgram(sky: SkyState, tex: WebGLTexture, light: [number, number], color: [number, number, number, number], alphaCut = 0.1): void {
    const gl = this.renderer.gl;
    const p = this.renderer.entityProg;
    p.use();
    gl.uniformMatrix4fv(p.u('uVP'), false, this.renderer.vp);
    gl.uniform3f(p.u('uCamPos'), 0, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(p.u('uTex'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.renderer.lightmapTex); gl.uniform1i(p.u('uLightmap'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(p.u('uLight'), light[0], light[1]);
    gl.uniform4fv(p.u('uColor'), color);
    gl.uniform4f(p.u('uFogColor'), sky.fogColor[0], sky.fogColor[1], sky.fogColor[2], 1);
    gl.uniform2f(p.u('uFogRange'), sky.fogStart, sky.fogEnd);
    gl.uniform1f(p.u('uAlphaCut'), alphaCut);
  }

  /** Base entity matrix: world pos (camera-relative), body yaw, vanilla model-space conversion. */
  private entityMatrix(out: Mat4, pos: [number, number, number], bodyYaw: number, scale = 1): Mat4 {
    mat4Identity(out);
    mat4Translate(out, out, pos[0], pos[1], pos[2]);
    mat4RotateY(out, out, (180 - bodyYaw) * DEG);
    mat4Scale(out, out, -scale / 16, -scale / 16, scale / 16);
    mat4Translate(out, out, 0, -24, 0);
    return out;
  }

  private drawParts(m: ModelGpu, base: Mat4, pose: Record<string, { rx?: number; ry?: number; rz?: number; tx?: number; ty?: number; tz?: number; scale?: number; hidden?: boolean }>, gl: WebGL2RenderingContext): void {
    const p = this.renderer.entityProg;
    gl.bindVertexArray(m.vao);
    const stack: Float32Array[] = [];
    const draw = (part: PartGpu, parent: Mat4) => {
      const po = pose[part.def.name] ?? {};
      if (po.hidden || part.def.visible === false) return;
      const mm = stack.pop() ?? new Float32Array(16);
      mm.set(parent);
      const pv = part.def.pivot;
      mat4Translate(mm, mm, pv[0] + (po.tx ?? 0), pv[1] + (po.ty ?? 0), pv[2] + (po.tz ?? 0));
      const rot = part.def.rot ?? [0, 0, 0];
      const rz = (po.rz ?? 0) + rot[2], ry = (po.ry ?? 0) + rot[1], rx = (po.rx ?? 0) + rot[0];
      if (rz) mat4RotateZ(mm, mm, rz);
      if (ry) mat4RotateY(mm, mm, ry);
      if (rx) mat4RotateX(mm, mm, rx);
      if (po.scale && po.scale !== 1) mat4Scale(mm, mm, po.scale, po.scale, po.scale);
      if (part.count > 0) { gl.uniformMatrix4fv(p.u('uModel'), false, mm); gl.drawArrays(gl.TRIANGLES, part.start, part.count); this.renderer.stats.drawCalls++; }
      for (const c of part.children) draw(c, mm);
      stack.push(mm);
    };
    for (const part of m.parts) draw(part, base);
  }

  private drawMob(e: Mob, sky: SkyState, partial: number): void {
    const gl = this.renderer.gl;
    const def = e.def;
    let modelName = def.model;
    let tex = def.texture;
    if (e.type === 'wolf' && e.tamed) tex = 'entity/wolf/wolf_tame'; else if (e.type === 'wolf' && e.angerTicks > 0) tex = 'entity/wolf/wolf_angry';
    if (e.type === 'sheep' && e.isBaby) tex = 'entity/sheep/sheep_baby';
    if (e.type === 'ghast' && e.rangedTicks > 45) tex = 'entity/ghast/ghast_shooting';
    // vanilla rabbit variants (the "Toast" skin is the rare named one)
    if (e.type === 'rabbit') tex = 'entity/rabbit/rabbit_' + (['brown', 'white', 'black', 'white_splotched', 'gold', 'salt'][e.variant % 6] ?? 'brown');
    if (e.isBaby && (e.type === 'zombie' || e.type === 'husk' || e.type === 'drowned' || e.type === 'rabbit')) tex = tex + '_baby';
    const m = this.model(modelName);
    const pos = this.lerpPos(e, partial);
    const bodyYaw = e.prevBodyYaw + ((((e.bodyYaw - e.prevBodyYaw) % 360) + 540) % 360 - 180) * partial;
    const headYaw = e.prevYaw + ((((e.yaw - e.prevYaw) % 360) + 540) % 360 - 180) * partial;
    const pitch = e.prevPitch + (e.pitch - e.prevPitch) * partial;
    const light = this.lightAt(e);
    const hurt = e.hurtTime > 0 || e.deathTime > 0;
    const scale = def.ai.slime ? e.slimeSize : e.isBaby ? 0.5 : 1;
    const color: [number, number, number, number] = hurt ? [1, 0.5, 0.5, 1] : [1, 1, 1, 1];
    // creeper flash
    let flash = 0;
    if (def.ai.creeper && e.swell > 0) { const s = (e.prevSwell + (e.swell - e.prevSwell) * partial) / 30; flash = Math.floor(s * 30) % 2 === 0 ? 0 : 0.6 * s; }
    this.beginEntityProgram(sky, this.texture(tex), light, flash ? [1, 1, 1, 1] : color);
    if (flash) gl.uniform4f(this.renderer.entityProg.u('uColor'), 1 + flash, 1 + flash, 1 + flash, 1);
    const base = this.entityMatrix(this.tmp, pos, bodyYaw, scale);
    if (def.ai.creeper && e.swell > 0) { const s = (e.prevSwell + (e.swell - e.prevSwell) * partial) / 30; const f = 1 + Math.sin(s * 100) * s * 0.01; mat4Scale(base, base, f, 1 / f, f); }
    if (e.deathTime > 0) { const t = Math.min(1, (e.deathTime + partial) / 20); mat4Translate(base, base, 0, 24, 0); mat4RotateZ(base, base, -t * Math.PI / 2 * -1); mat4Translate(base, base, 0, -24, 0); }
    const limb = e.limbSwing - e.limbSwingAmount * (1 - partial), amt = e.prevLimbSwingAmount + (e.limbSwingAmount - e.prevLimbSwingAmount) * partial;
    const pose = this.poseFor(e, modelName, limb, amt, headYaw - bodyYaw, pitch, partial);
    this.drawParts(m, base, pose, gl);
    // overlays
    if (def.ai.sheep && !e.sheared) {
      const fur = this.model('sheep_fur');
      const c = DYE_COLORS[e.woolColor] ?? 0xffffff;
      const col: [number, number, number, number] = hurt ? [1, 0.5, 0.5, 1] : [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1];
      this.beginEntityProgram(sky, this.texture('entity/sheep/sheep_wool'), light, col);
      this.drawParts(fur, base, pose, gl);
    }
    if (e.type === 'enderman' || e.type === 'spider' || e.type === 'cave_spider' || e.type === 'creaking' || e.type === 'breeze') {
      const eyes = e.type === 'enderman' ? 'entity/enderman/enderman_eyes' : e.type.includes('spider') ? 'entity/spider/spider_eyes' : e.type === 'creaking' ? 'entity/creaking/creaking_eyes' : 'entity/breeze/breeze_eyes';
      this.beginEntityProgram(sky, this.texture(eyes), [15, 15], [1, 1, 1, 1]);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      this.drawParts(m, base, pose, gl);
      gl.disable(gl.BLEND);
    }
    if (def.ai.slime && e.type === 'slime') {
      // translucent outer layer is drawn as part of the model; make it slightly transparent
    }
    if (e.type === 'drowned') { this.beginEntityProgram(sky, this.texture('entity/zombie/drowned_outer_layer'), light, color); this.drawParts(m, base, pose, gl); }
    if (e.type === 'stray' || e.type === 'bogged') { this.beginEntityProgram(sky, this.texture(`entity/skeleton/${e.type}_overlay`), light, color); this.drawParts(m, base, pose, gl); }
    // held items (skeleton bow, zombie held items)
    if (def.ai.ranged === 'arrow' && (modelName === 'skeleton' || modelName === 'villager')) this.drawMobHeldItem(e, base, pose, new ItemStack(this.game.items.get(e.type === 'pillager' ? 'crossbow' : 'bow')!, 1), sky, light, modelName);
    if (e.type === 'wither_skeleton') this.drawMobHeldItem(e, base, pose, new ItemStack(this.game.items.get('stone_sword')!, 1), sky, light, modelName);
    if (e.type === 'zombified_piglin') this.drawMobHeldItem(e, base, pose, new ItemStack(this.game.items.get('golden_sword')!, 1), sky, light, modelName);
    if (e.type === 'piglin' || e.type === 'piglin_brute') this.drawMobHeldItem(e, base, pose, new ItemStack(this.game.items.get(e.type === 'piglin' ? 'crossbow' : 'golden_axe')!, 1), sky, light, modelName);
    if (e.type === 'vindicator') this.drawMobHeldItem(e, base, pose, new ItemStack(this.game.items.get('iron_axe')!, 1), sky, light, modelName);
    if (e.type === 'enderman' && e.carriedBlock) { /* carried block */ }
    // name tag
    if ((e as any).customName) this.game.gui.queueNameTag((e as any).customName, e.x, e.y + e.height + 0.5, e.z);
  }

  /** vanilla HumanoidModel.setupAttackAnimation (right-handed): body twist, arm reposition and the swing itself. */
  private humanoidAttack(pose: Record<string, any>, attackTime: number, headPitch: number): void {
    if (attackTime <= 0) return;
    const by = Math.sin(Math.sqrt(attackTime) * Math.PI * 2) * 0.2;
    pose.body = { ...(pose.body ?? {}), ry: by };
    const ra = pose.rightArm ?? {}, la = pose.leftArm ?? {};
    ra.tz = Math.sin(by) * 5; ra.tx = 5 - Math.cos(by) * 5;
    la.tz = -Math.sin(by) * 5; la.tx = Math.cos(by) * 5 - 5;
    ra.ry = (ra.ry ?? 0) + by; la.ry = (la.ry ?? 0) + by; la.rx = (la.rx ?? 0) + by;
    let f = 1 - attackTime; f *= f; f *= f; f = 1 - f;
    const f1 = Math.sin(f * Math.PI);
    const f2 = Math.sin(attackTime * Math.PI) * -(headPitch - 0.7) * 0.75;
    ra.rx = (ra.rx ?? 0) - (f1 * 1.2 + f2);
    ra.ry += by * 2;
    ra.rz = (ra.rz ?? 0) + Math.sin(attackTime * Math.PI) * -0.4;
    pose.rightArm = ra; pose.leftArm = la;
  }

  private poseFor(e: LivingEntity, model: string, limb: number, amt: number, headYawRel: number, pitch: number, partial: number): Record<string, any> {
    const pose: Record<string, any> = {};
    const hy = headYawRel * DEG, hp = pitch * DEG;
    const swing = Math.cos(limb * 0.6662) * 1.4 * amt, swing2 = Math.cos(limb * 0.6662 + Math.PI) * 1.4 * amt;
    const t = this.time;
    const attack = (e as any).attackAnim ? ((e as any).attackAnim / 10) : 0;
    switch (model) {
      case 'player': case 'player_slim': case 'zombie': case 'skeleton': case 'enderman': case 'villager_biped': case 'vex': case 'breeze': case 'creaking': case 'warden': {
        pose.head = { ry: hy, rx: hp };
        const zombieArms = model === 'zombie' && e instanceof Mob && (e.type === 'zombie' || e.type === 'husk' || e.type === 'drowned' || e.type === 'zombie_villager' || e.type === 'zombified_piglin');
        const aim = e instanceof Mob && e.def.ai.ranged === 'arrow' && e.target;
        if (zombieArms) { const s = Math.sin(t * 3) * 0.05; pose.rightArm = { rx: -Math.PI / 2 + s, ry: -0.1 + Math.sin(limb * 0.6662) * amt * 0.2 }; pose.leftArm = { rx: -Math.PI / 2 - s, ry: 0.1 - Math.sin(limb * 0.6662) * amt * 0.2 }; }
        else if (aim) { pose.rightArm = { rx: -Math.PI / 2 + hp, ry: -0.1 + hy }; pose.leftArm = { rx: -Math.PI / 2 + hp + 0.3, ry: 0.4 + hy }; }
        else if (model === 'enderman' && e instanceof Mob && e.angerTicks > 0) { pose.rightArm = { rx: -Math.PI / 2 }; pose.leftArm = { rx: -Math.PI / 2 }; }
        else {
          // vanilla HumanoidModel: arms swing at cos(limb*0.6662[+PI]) * 2 * amt * 0.5, plus the idle bobArms wobble
          pose.rightArm = { rx: swing2 / 1.4 + Math.sin(t * 1.34) * 0.05, rz: Math.cos(t * 1.8) * 0.05 + 0.05 };
          pose.leftArm = { rx: swing / 1.4 - Math.sin(t * 1.34) * 0.05, rz: -Math.cos(t * 1.8) * 0.05 - 0.05 };
        }
        pose.rightLeg = { rx: swing }; pose.leftLeg = { rx: swing2 };
        if (!zombieArms) this.humanoidAttack(pose, e.swingAnim(partial), hp);
        if (e.vehicle) { pose.rightLeg = { rx: -1.4137167, ry: Math.PI / 10, rz: 0.07853982 }; pose.leftLeg = { rx: -1.4137167, ry: -Math.PI / 10, rz: -0.07853982 }; pose.rightArm = { ...(pose.rightArm ?? {}), rx: (pose.rightArm?.rx ?? 0) - Math.PI / 5 }; pose.leftArm = { ...(pose.leftArm ?? {}), rx: (pose.leftArm?.rx ?? 0) - Math.PI / 5 }; }
        if (e instanceof Player && e.isSneaking) {
          pose.body = { ...(pose.body ?? {}), rx: 0.5, ty: 3.2 }; pose.head = { ry: hy, rx: hp, ty: 4.2 };
          pose.rightArm = { ...(pose.rightArm ?? {}), rx: (pose.rightArm?.rx ?? 0) + 0.4, ty: 3.2 }; pose.leftArm = { ...(pose.leftArm ?? {}), rx: (pose.leftArm?.rx ?? 0) + 0.4, ty: 3.2 };
          pose.rightLeg = { rx: swing, ty: 0.2, tz: 3.9 }; pose.leftLeg = { rx: swing2, ty: 0.2, tz: 3.9 };
        }
        if (e instanceof Mob && e.sitting) { pose.rightLeg = { rx: -1.4 }; pose.leftLeg = { rx: -1.4 }; }
        break;
      }
      case 'creeper': { pose.head = { ry: hy, rx: hp }; pose.leg0 = { rx: swing }; pose.leg1 = { rx: swing2 }; pose.leg2 = { rx: swing2 }; pose.leg3 = { rx: swing }; break; }
      case 'spider': {
        pose.head = { ry: hy, rx: hp };
        const base = Math.PI / 4;
        for (let i = 0; i < 4; i++) {
          const zr = [0.7854, 0.3927, -0.3927, -0.7854][i];
          const ang = -(Math.cos(limb * 0.6662 * 2 + i * Math.PI / 2) * 0.4) * amt, lift = Math.abs(Math.sin(limb * 0.6662 + i * Math.PI / 2) * 0.4) * amt;
          pose[`legR${i}`] = { rz: -base, ry: -zr - ang, rx: 0, rzExtra: 0 }; pose[`legL${i}`] = { rz: base, ry: zr + ang };
          pose[`legR${i}`].rz = -base - lift; pose[`legL${i}`].rz = base + lift;
        }
        break;
      }
      case 'pig': case 'cow': case 'sheep': case 'wolf': case 'goat': case 'llama': case 'horse': case 'hoglin': case 'polar_bear': case 'panda': case 'cat': case 'fox': case 'rabbit': case 'turtle': case 'armadillo': case 'camel': case 'sniffer': case 'strider': case 'frog': case 'axolotl': case 'ravager': {
        pose.head = { ry: hy, rx: hp };
        pose.leg0 = { rx: swing }; pose.leg1 = { rx: swing2 }; pose.leg2 = { rx: swing2 }; pose.leg3 = { rx: swing };
        if (model === 'sheep' && e instanceof Mob && e.eatTimer > 0) pose.head = { ry: hy, rx: 0.8, ty: 3 };
        if (model === 'wolf' && e instanceof Mob) { pose.tail = { rx: e.angerTicks > 0 || e.tamed ? 0.6 : Math.PI / 4 + Math.sin(t * 3) * 0.1 }; if (e.sitting) { pose.body = { rx: Math.PI / 4 * 2, ty: 4 }; pose.leg0 = { rx: -1.3, ty: 4 }; pose.leg1 = { rx: -1.3, ty: 4 }; pose.leg2 = { rx: 0, ty: 4 }; pose.leg3 = { rx: 0, ty: 4 }; pose.mane = { ty: 4, rx: Math.PI / 2 }; pose.head = { ry: hy, rx: hp, ty: 4 }; } }
        if (model === 'wolf' && e instanceof Mob && e.attackAnim > 0) pose.head = { ry: hy, rx: hp + 0.3 };
        if (model === 'turtle') { pose.leg0 = { rx: swing2 }; pose.leg1 = { rx: swing }; pose.leg2 = { rz: swing2 }; pose.leg3 = { rz: swing }; }
        if (model === 'rabbit') {
          // vanilla: jumpRotation = sin(jumpCompletion * PI) drives haunches, feet, front legs and body pitch
          const jc = e instanceof Mob ? Math.max(0, Math.min(1, e.jumpProgress(partial))) : 0;
          const j = Math.sin(jc * Math.PI);
          pose.head = { ry: hy, rx: hp };
          pose.earL = { ry: 0, rx: hp + j * 0.2 }; pose.earR = { ry: 0, rx: hp + j * 0.2 };
          pose.body = { rx: j * 0.5 };
          pose.haunchL = { rx: j * 0.8 }; pose.haunchR = { rx: j * 0.8 };
          pose.footL = { rx: j * 0.8 }; pose.footR = { rx: j * 0.8 };
          pose.legL = { rx: -j * 0.6 }; pose.legR = { rx: -j * 0.6 };
          pose.tail = { rx: j * 0.3 };
          delete pose.leg0; delete pose.leg1; delete pose.leg2; delete pose.leg3;
        }
        break;
      }
      case 'chicken': { pose.head = { ry: hy, rx: hp }; pose.leg0 = { rx: swing }; pose.leg1 = { rx: swing2 }; const flap = e.onGround ? 0 : Math.sin(t * 40) * 0.8 + 0.3; pose.wingR = { rz: flap }; pose.wingL = { rz: -flap }; break; }
      case 'slime': case 'magma_cube': { const sq = e instanceof Mob && !e.onGround ? 0.9 : 1 + Math.sin(t * 5) * 0.02; pose.outer = { scale: sq }; pose.inner = { scale: sq }; if (model === 'magma_cube') { for (let i = 0; i < 8; i++) pose[`seg${i}`] = { ty: e.onGround ? 0 : (i - 4) * 0.8 * Math.max(0, -e.vy) * 5 }; } break; }
      case 'squid': { for (let i = 0; i < 8; i++) { const a = i * Math.PI * 2 / 8; pose[`t${i}`] = { rx: Math.sin(t * 4) * 0.3 + 0.2, ry: -a + Math.PI / 2 }; } pose.body = { rx: e.vy > 0 ? -0.3 : 0.2 }; break; }
      case 'cod': case 'salmon': { pose.tail = { ry: Math.sin(t * 8) * 0.5 * (e.inWater ? 1 : 3) }; pose.body = { rx: e.inWater ? 0 : Math.PI / 2 * 0 }; break; }
      case 'ghast': { for (let i = 0; i < 9; i++) pose[`t${i}`] = { rx: Math.sin(t * 3 + i) * 0.2 }; break; }
      case 'blaze': { for (let i = 0; i < 12; i++) { const ring = Math.floor(i / 4), a = (i % 4) * Math.PI / 2 + t * (ring === 1 ? -3 : 3) + ring; const r = ring === 1 ? 7 : 9; pose[`rod${i}`] = { tx: Math.cos(a) * r, ty: 2 + ring * 6 + Math.sin(t * 2 + i) * 2, tz: Math.sin(a) * r }; } pose.head = { ry: hy, rx: hp }; break; }
      case 'bat': { pose.wingR = { ry: Math.sin(t * 40) * 0.8 + 0.4 }; pose.wingL = { ry: -Math.sin(t * 40) * 0.8 - 0.4 }; pose.head = { ry: hy, rx: hp + 0.5 }; break; }
      case 'villager': { pose.head = { ry: hy, rx: hp }; pose.rightLeg = { rx: swing * 0.5 }; pose.leftLeg = { rx: swing2 * 0.5 }; break; }
      case 'iron_golem': { pose.head = { ry: hy, rx: hp }; pose.rightLeg = { rx: swing * 0.7 }; pose.leftLeg = { rx: swing2 * 0.7 }; pose.rightArm = { rx: attack > 0 ? -2 + attack * 2 : swing2 * 0.5 }; pose.leftArm = { rx: attack > 0 ? -2 + attack * 2 : swing * 0.5 }; break; }
      case 'snow_golem': { pose.head = { ry: hy, rx: hp }; break; }
      case 'phantom': { const f = Math.sin(t * 6); pose.wingL = { rz: 0.1 + f * 0.6 }; pose.wingR = { rz: -0.1 - f * 0.6 }; pose.tipL = { rz: f * 0.4 }; pose.tipR = { rz: -f * 0.4 }; pose.head = { ry: hy, rx: hp * 0.3 }; break; }
      case 'bee': { pose.wingR = { ry: Math.sin(t * 60) * 0.5 - 0.3 }; pose.wingL = { ry: -Math.sin(t * 60) * 0.5 + 0.3 }; break; }
      case 'parrot': { pose.head = { ry: hy, rx: hp }; const f = e.onGround ? 0 : Math.sin(t * 30) * 0.8; pose.wingR = { rz: f }; pose.wingL = { rz: -f }; pose.leg0 = { rx: swing }; pose.leg1 = { rx: swing2 }; break; }
      case 'dolphin': { pose.tail = { rx: Math.sin(t * 6) * 0.3 }; pose.fluke = { rx: Math.sin(t * 6 + 1) * 0.3 }; break; }
      case 'silverfish': { for (let i = 0; i < 5; i++) pose[`seg${i}`] = { ry: Math.sin(t * 20 + i) * 0.2 * amt }; break; }
      case 'dragon': { const f = Math.sin(t * 2); pose.wingL = { rx: f * 0.5 }; pose.wingR = { rx: f * 0.5 }; pose.head = { ry: hy * 0.3, rx: hp * 0.3 }; break; }
      case 'wither': { pose.head = { ry: hy, rx: hp }; pose.headL = { ry: hy + Math.sin(t) * 0.3 }; pose.headR = { ry: hy - Math.sin(t) * 0.3 }; break; }
    }
    void partial;
    return pose;
  }

  private drawMobHeldItem(e: Mob, base: Mat4, pose: Record<string, any>, stack: ItemStack, sky: SkyState, light: [number, number], model: string): void {
    this.drawHandItem(base, pose, stack, sky, light, false, false, e.hurtTime > 0, model === 'villager' ? [-6, 6, 0] : null);
  }

  drawPlayer(p: Player, sky: SkyState, partial: number): void {
    const gl = this.renderer.gl;
    const skin: string = (p as any).skin ?? this.game.options.skin;
    const slim = skin === 'alex';
    const m = this.model(slim ? 'player_slim' : 'player');
    const pos = this.lerpPos(p, partial);
    const bodyYaw = p.prevBodyYaw + ((((p.bodyYaw - p.prevBodyYaw) % 360) + 540) % 360 - 180) * partial;
    const headYaw = p.prevYaw + ((((p.yaw - p.prevYaw) % 360) + 540) % 360 - 180) * partial;
    const pitch = p.prevPitch + (p.pitch - p.prevPitch) * partial;
    const light = this.lightAt(p);
    const hurt = p.hurtTime > 0 || p.deathTime > 0;
    this.beginEntityProgram(sky, this.texture(slim ? 'entity/player/slim/alex' : 'entity/player/wide/steve'), light, hurt ? [1, 0.5, 0.5, 1] : [1, 1, 1, 1]);
    const base = this.entityMatrix(this.tmp, pos, bodyYaw, 1);
    if (p.deathTime > 0) { const t = Math.min(1, (p.deathTime + partial) / 20); mat4Translate(base, base, 0, 24, 0); mat4RotateZ(base, base, t * Math.PI / 2); mat4Translate(base, base, 0, -24, 0); }
    if (p.sleeping) { mat4Translate(base, base, 0, 24, 0); mat4RotateX(base, base, Math.PI / 2); mat4Translate(base, base, 0, -24, 0); }
    else if (p.swimmingPose) { mat4Translate(base, base, 0, 24, 0); mat4RotateX(base, base, Math.PI / 2 - 0.2); mat4Translate(base, base, 0, -24, 0); }
    const limb = p.limbSwing - p.limbSwingAmount * (1 - partial), amt = p.prevLimbSwingAmount + (p.limbSwingAmount - p.prevLimbSwingAmount) * partial;
    const pose = this.poseFor(p, 'player', limb, amt, headYaw - bodyYaw, pitch, partial);
    if (p.usingItem && p.usingItem.item.name === 'bow') { pose.rightArm = { rx: -Math.PI / 2 + pitch * DEG, ry: -0.1 + (headYaw - bodyYaw) * DEG }; pose.leftArm = { rx: -Math.PI / 2 + pitch * DEG + 0.3, ry: 0.4 + (headYaw - bodyYaw) * DEG }; }
    this.drawParts(m, base, pose, gl);
    // armour
    for (let i = 0; i < 4; i++) {
      const a = p.armor.get(i);
      if (!a || !a.item.armorSlot) continue;
      const mat = a.item.name.split('_')[0];
      if (a.item.name === 'elytra' || a.item.name === 'carved_pumpkin' || a.item.name.endsWith('_head') || a.item.name.endsWith('_skull')) continue;
      const layer = i === 2 ? 2 : 1;
      const tex = `entity/equipment/humanoid${layer === 2 ? '_leggings' : ''}/${mat === 'golden' ? 'gold' : mat}`;
      const col = a.item.name.startsWith('leather') ? (a.extra?.dyeColor ?? 0xa06540) : 0xffffff;
      this.beginEntityProgram(sky, this.texture(tex), light, hurt ? [1, 0.5, 0.5, 1] : [((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 1]);
      const armorPose = { ...pose };
      const inflate = i === 0 ? 1.0 : i === 1 ? 1.01 : i === 2 ? 0.5 : 1.0;
      const hide: Record<string, boolean> = { head: i !== 0, hat: true, body: i !== 1 && i !== 2, rightArm: i !== 1, leftArm: i !== 1, rightLeg: i !== 2 && i !== 3, leftLeg: i !== 2 && i !== 3 };
      for (const k of Object.keys(hide)) if (hide[k]) armorPose[k] = { ...(armorPose[k] ?? {}), hidden: true };
      for (const k of ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) if (!hide[k]) armorPose[k] = { ...(armorPose[k] ?? {}), scale: 1 + inflate / 8 * 0.5 };
      this.drawParts(m, base, armorPose, gl);
    }
    // held items (vanilla ItemInHandLayer)
    const held = p.heldItem();
    if (held) this.drawHandItem(base, pose, held, sky, light, false, slim, hurt);
    const off = p.offhandItem();
    if (off) this.drawHandItem(base, pose, off, sky, light, true, slim, hurt);
    // name tag for other players (vanilla hides it while sneaking (isDiscrete) and for dead players)
    if ((p as any).isRemote && !p.sleeping && !p.isSneaking && p.health > 0 && p.deathTime === 0 && !p.isSpectator) {
      const cb = this.renderer.camBase;
      this.game.gui.queueNameTag(p.name, pos[0] + cb[0], pos[1] + cb[1] + p.height + 0.5, pos[2] + cb[2]);
    }
  }

  /** vanilla ItemInHandLayer.renderArmWithItem: hand transform in the (flipped) model space, then the item's
   *  third-person display transform. All translations in pixels (model units). */
  private drawHandItem(base: Mat4, pose: Record<string, any>, stack: ItemStack, sky: SkyState, light: [number, number], left: boolean, slim: boolean, hurt = false, armPivot: [number, number, number] | null = null): void {
    const mm = this.tmp2; mm.set(base);
    const arm = (left ? pose.leftArm : pose.rightArm) ?? {};
    const piv = armPivot ?? [left ? 5 : -5, 2, 0];
    mat4Translate(mm, mm, piv[0] + (arm.tx ?? 0), piv[1] + (arm.ty ?? 0), piv[2] + (arm.tz ?? 0));
    if (arm.rz) mat4RotateZ(mm, mm, arm.rz); if (arm.ry) mat4RotateY(mm, mm, arm.ry); if (arm.rx) mat4RotateX(mm, mm, arm.rx);
    if (slim) mat4Translate(mm, mm, left ? -0.5 : 0.5, 0, 0);
    mat4RotateX(mm, mm, -Math.PI / 2);
    mat4RotateY(mm, mm, Math.PI);
    mat4Translate(mm, mm, left ? -1 : 1, 2, -10);
    const mesh = this.items.getMesh(stack);
    const disp = new Float32Array(16); this.items.applyDisplay(disp, mesh, left ? 'thirdperson_lefthand' : 'thirdperson_righthand', left);
    const item = new Float32Array(16); mat4Identity(item); mat4Scale(item, item, 16, 16, 16); mat4Mul(item, mm, item); mat4Mul(item, item, disp);
    this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, item, sky, { light: (light[1] << 4) | light[0], alphaCut: 0.1, noCull: mesh.flat, colorMul: hurt ? [1, 0.5, 0.5, 1] : undefined });
  }

  private drawItemEntity(e: ItemEntity, sky: SkyState, partial: number): void {
    const pos = this.lerpPos(e, partial);
    const mesh = this.items.getMesh(e.stack);
    const light = this.lightAt(e);
    const t = (e.age + partial) / 20 + e.bobOffset;
    const bob = Math.sin(t) * 0.1 + 0.1;
    const m = new Float32Array(16);
    mat4Identity(m);
    mat4Translate(m, m, pos[0], pos[1] + bob + 0.125, pos[2]);
    mat4RotateY(m, m, t * 2 % (Math.PI * 2));
    const copies = e.stack.count > 48 ? 5 : e.stack.count > 32 ? 4 : e.stack.count > 16 ? 3 : e.stack.count > 1 ? 2 : 1;
    const disp = new Float32Array(16); this.items.applyDisplay(disp, mesh, 'ground');
    const scale = mesh.flat ? 0.5 : 0.5;
    for (let i = 0; i < copies; i++) {
      const mm = new Float32Array(16); mm.set(m);
      mat4Translate(mm, mm, 0, i * 0.0625 * (mesh.flat ? 1.5 : 1), mesh.flat ? i * 0.02 : 0);
      mat4Scale(mm, mm, scale * 2 * (disp[0] || 1) / (disp[0] || 1), scale * 2, scale * 2);
      mat4Mul(mm, mm, disp);
      this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, mm, sky, { light: (light[1] << 4) | light[0], alphaCut: 0.1, noCull: mesh.flat });
    }
  }

  private drawBlockEntity(state: number, e: Entity, sky: SkyState, partial: number, flash: boolean): void {
    const model = this.game.baker.firstModel(state);
    if (!model) return;
    const mesh = this.items.getMesh(new ItemStack(this.game.items.itemForBlock(this.game.registry.nameOf(state)) ?? this.game.items.get('stone')!, 1));
    const pos = this.lerpPos(e, partial);
    const light = this.lightAt(e);
    const m = new Float32Array(16); mat4Identity(m); mat4Translate(m, m, pos[0], pos[1] + 0.5, pos[2]);
    if (e instanceof PrimedTnt) { const f = 1 + (e.fuse < 10 ? (10 - e.fuse) * 0.05 : 0); mat4Scale(m, m, f, f, f); }
    this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, m, sky, { light: (light[1] << 4) | light[0], alphaCut: 0.1, colorMul: flash ? [2, 2, 2, 1] : undefined });
    if (e instanceof PrimedTnt && Math.floor(e.fuse / 5) % 2 === 0 && e.fuse < 100) {
      const gl = this.renderer.gl;
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, m, sky, { light: 0xff, alphaCut: 0.1, colorMul: [1, 1, 1, 0.6], blend: true });
    }
  }

  private drawArrow(e: ArrowEntity, sky: SkyState, partial: number): void {
    const pos = this.lerpPos(e, partial);
    const light = this.lightAt(e);
    const tex = (e as any).trident ? null : e.kind === 'spectral' ? 'entity/projectiles/arrow_spectral' : e.kind === 'tipped' ? 'entity/projectiles/arrow_tipped' : 'entity/projectiles/arrow';
    if (!tex) { const mesh = this.items.getMesh((e as any).trident); const m = new Float32Array(16); mat4Identity(m); mat4Translate(m, m, pos[0], pos[1], pos[2]); mat4RotateY(m, m, -e.yaw * DEG); mat4RotateX(m, m, (e.pitch + 90) * DEG); this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, m, sky, { light: (light[1] << 4) | light[0], noCull: true }); return; }
    // arrow: shaft (16x2x2 at uv 0,0..) rendered as two crossed quads + back fin, using the 32x32 texture
    const gl = this.renderer.gl;
    const verts = new Float32Array([
      // shaft quad 1 (xz plane): 16 long, 2 wide  uv (0,0)-(16,2)/32
      -8, 0, -1, 0, 0, 0, 1, 0, 8, 0, -1, 0.5, 0, 0, 1, 0, 8, 0, 1, 0.5, 0.0625, 0, 1, 0, -8, 0, -1, 0, 0, 0, 1, 0, 8, 0, 1, 0.5, 0.0625, 0, 1, 0, -8, 0, 1, 0, 0.0625, 0, 1, 0,
      // shaft quad 2 (xy plane)
      -8, -1, 0, 0, 0.0625, 0, 0, 1, 8, -1, 0, 0.5, 0.0625, 0, 0, 1, 8, 1, 0, 0.5, 0.125, 0, 0, 1, -8, -1, 0, 0, 0.0625, 0, 0, 1, 8, 1, 0, 0.5, 0.125, 0, 0, 1, -8, 1, 0, 0, 0.125, 0, 0, 1,
      // fin/head (yz plane at back) uv (0,0)-(5,5)/32 at x=-7..-4
      -7, -2.5, 0, 0, 0, 1, 0, 0, -7, 2.5, 0, 0.15625, 0, 1, 0, 0, -3, 2.5, 0, 0.15625, 0.15625, 1, 0, 0, -7, -2.5, 0, 0, 0, 1, 0, 0, -3, 2.5, 0, 0.15625, 0.15625, 1, 0, 0, -3, -2.5, 0, 0, 0.15625, 1, 0, 0,
    ]);
    this.beginEntityProgram(sky, this.texture(tex), light, [1, 1, 1, 1], 0.1);
    const m = new Float32Array(16); mat4Identity(m); mat4Translate(m, m, pos[0], pos[1], pos[2]);
    mat4RotateY(m, m, (-e.yaw + 90) * DEG); mat4RotateZ(m, m, e.pitch * DEG); mat4Scale(m, m, 1 / 16, 1 / 16, 1 / 16);
    gl.uniformMatrix4fv(this.renderer.entityProg.u('uModel'), false, m);
    gl.disable(gl.CULL_FACE);
    const vao = this.scratchVao(verts);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 8);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }

  private scratch: { vao: WebGLVertexArrayObject; vbo: WebGLBuffer } | null = null;
  private scratchVao(data: Float32Array): WebGLVertexArrayObject {
    const gl = this.renderer.gl;
    if (!this.scratch) {
      const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 20);
      gl.bindVertexArray(null);
      this.scratch = { vao, vbo };
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    return this.scratch.vao;
  }

  private drawThrown(e: ThrownProjectile, sky: SkyState, partial: number): void {
    const pos = this.lerpPos(e, partial);
    const light = this.lightAt(e);
    const stackName = e.kind === 'ghast_fireball' || e.kind === 'fire_charge' ? 'fire_charge' : e.kind;
    const it = this.game.items.get(stackName) ?? this.game.items.get('snowball')!;
    const mesh = this.items.getMesh(e.stack ?? new ItemStack(it, 1));
    const m = new Float32Array(16); mat4Identity(m); mat4Translate(m, m, pos[0], pos[1] + e.height / 2, pos[2]);
    mat4RotateY(m, m, -this.renderer.camera.yaw * DEG);
    const s = e.kind === 'ghast_fireball' ? 1.5 : 0.5;
    mat4Scale(m, m, s, s, s);
    this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, m, sky, { light: (light[1] << 4) | light[0], noCull: true });
  }

  /** vanilla BoatRenderer: translate 0.375 up, yaw, hurt wobble, scale(-1,-1,1), rotate 90, paddles rowing. */
  private drawBoat(b: BoatEntity, sky: SkyState, partial: number): void {
    const gl = this.renderer.gl;
    const raft = b.isRaft;
    const m = this.model(raft ? 'raft' : b.chest ? 'chest_boat' : 'boat');
    const tex = this.texture(`entity/${b.chest ? 'chest_boat' : 'boat'}/${b.wood}`);
    const pos = this.lerpPos(b, partial);
    const yaw = b.prevYaw + ((((b.yaw - b.prevYaw) % 360) + 540) % 360 - 180) * partial;
    const light = this.lightAt(b);
    this.beginEntityProgram(sky, tex, light, [1, 1, 1, 1]);
    const base = this.tmp;
    mat4Identity(base);
    mat4Translate(base, base, pos[0], pos[1] + 0.375, pos[2]);
    mat4RotateY(base, base, (180 - yaw) * DEG);
    const ht = b.hurtTime - partial;
    if (ht > 0) mat4RotateX(base, base, Math.sin(ht) * ht * Math.min(40, b.damage) / 10 * b.hurtDir * DEG);
    mat4Scale(base, base, -1 / 16, -1 / 16, 1 / 16);
    mat4RotateY(base, base, Math.PI / 2);
    const pose: Record<string, any> = {};
    for (let i = 0; i < 2; i++) {
      const rowing = i === 0 ? b.paddleLeft : b.paddleRight;
      const t = rowing ? b.prevPaddlePos[i] + (b.paddlePos[i] - b.prevPaddlePos[i]) * partial : 0;
      // vanilla BoatModel.animatePaddle (rotations are added to the part's base pose by drawParts)
      const lerp = (a: number, c: number, f: number) => a + (c - a) * Math.max(0, Math.min(1, f));
      const rx = lerp(-Math.PI / 3, -0.2617994, (Math.sin(-t) + 1) / 2);
      let ry = lerp(-Math.PI / 4, Math.PI / 4, (Math.sin(-t + 1) + 1) / 2);
      if (i === 1) ry = -ry; // the right paddle's base pose already carries the PI turn
      pose[i === 0 ? 'paddleL' : 'paddleR'] = { rx, ry };
    }
    this.drawParts(m, base, pose, gl);
    // water-mask: hide water inside the hull is a vanilla trick we approximate by drawing nothing extra
  }

  /** vanilla EndCrystalRenderer: bobbing, spinning nested cubes on a base, plus the healing beam to the dragon. */
  private drawCrystal(c: EndCrystalEntity, sky: SkyState, partial: number): void {
    const gl = this.renderer.gl;
    const m = this.model('end_crystal');
    const pos = this.lerpPos(c, partial);
    const light: [number, number] = [15, 15];
    this.beginEntityProgram(sky, this.texture('entity/end_crystal/end_crystal'), light, [1, 1, 1, 1]);
    const t = c.age + partial;
    const f = Math.sin(t * 0.2) / 2 + 0.5; const bob = f * f + f; // vanilla getY
    const spin = t * 3 * DEG;
    const base = new Float32Array(16);
    const S45 = Math.SQRT1_2;
    const build = (scale: number, extra: (mm: Mat4) => void) => {
      mat4Identity(base);
      mat4Translate(base, base, pos[0], pos[1], pos[2]);
      mat4Scale(base, base, 2, 2, 2); mat4Translate(base, base, 0, -0.5, 0);
      extra(base);
      mat4Scale(base, base, scale / 16, scale / 16, scale / 16);
      mat4Scale(base, base, -1, -1, 1); // vanilla entity flip so the model's y-down matches
      return base;
    };
    // base plate
    if (c.showBottom) this.drawParts(m, build(1, () => {}), { glass: { hidden: true }, cube: { hidden: true } }, gl);
    // outer glass
    this.drawParts(m, build(1, (mm) => { mat4RotateY(mm, mm, spin); mat4Translate(mm, mm, 0, -(1.5 + bob / 2), 0); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); }), { cube: { hidden: true }, base: { hidden: true } }, gl);
    // inner glass
    this.drawParts(m, build(0.875, (mm) => { mat4RotateY(mm, mm, spin); mat4Translate(mm, mm, 0, -(1.5 + bob / 2), 0); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); mat4RotateY(mm, mm, spin); }), { cube: { hidden: true }, base: { hidden: true } }, gl);
    // core cube
    this.drawParts(m, build(0.875 * 0.875, (mm) => { mat4RotateY(mm, mm, spin); mat4Translate(mm, mm, 0, -(1.5 + bob / 2), 0); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); mat4RotateY(mm, mm, spin); mat4Rotate(mm, mm, 60 * DEG, S45, 0, S45); mat4RotateY(mm, mm, spin); }), { glass: { hidden: true }, base: { hidden: true } }, gl);
    // healing beam
    if (c.beamTarget) {
      const cb = this.renderer.camBase;
      const y0 = pos[1] + 2 + bob;
      this.renderer.drawLines(new Float32Array([pos[0], y0, pos[2], c.beamTarget[0] - cb[0], c.beamTarget[1] - cb[1], c.beamTarget[2] - cb[2]]), [0.9, 0.3, 1, 0.8], 4);
    }
  }

  private drawXp(e: ExperienceOrb, sky: SkyState, partial: number): void {
    const pos = this.lerpPos(e, partial);
    const gl = this.renderer.gl;
    const tex = this.texture('entity/experience/experience_orb');
    const t = (e.age + partial) / 20;
    // 4x4 sprite sheet (16px each in 64x64); frame by time; colour pulse
    const frame = Math.floor(t * 10) % 16; const fx = (frame % 4) / 4, fy = Math.floor(frame / 4) / 4;
    const s = 0.15 + Math.min(0.15, e.value / 100);
    const verts = new Float32Array([-s, -s, 0, fx, fy + 0.25, 0, 0, 1, s, -s, 0, fx + 0.25, fy + 0.25, 0, 0, 1, s, s, 0, fx + 0.25, fy, 0, 0, 1, -s, -s, 0, fx, fy + 0.25, 0, 0, 1, s, s, 0, fx + 0.25, fy, 0, 0, 1, -s, s, 0, fx, fy, 0, 0, 1]);
    const g = Math.sin(t * 6) * 0.5 + 0.5;
    this.beginEntityProgram(sky, tex, [15, 15], [0.5 + g * 0.5, 1, 0.3 + g * 0.3, 1], 0.1);
    const m = new Float32Array(16); mat4Identity(m); mat4Translate(m, m, pos[0], pos[1] + 0.2, pos[2]); mat4RotateY(m, m, -this.renderer.camera.yaw * DEG); mat4RotateX(m, m, this.renderer.camera.pitch * DEG);
    gl.uniformMatrix4fv(this.renderer.entityProg.u('uModel'), false, m);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.scratchVao(verts));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // ---------- inventory player preview ----------
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewFbo: WebGLFramebuffer | null = null; private previewTex: WebGLTexture | null = null; private previewDepth: WebGLRenderbuffer | null = null;
  /** Render the player looking toward the mouse into a 98x140 canvas (2x of the 49x70 GUI area). */
  playerPreview(mouseDx: number, mouseDy: number): HTMLCanvasElement | null {
    const gl = this.renderer.gl;
    const W = 98, H = 140;
    if (!this.previewFbo) {
      this.previewFbo = gl.createFramebuffer()!; this.previewTex = gl.createTexture()!; this.previewDepth = gl.createRenderbuffer()!;
      gl.bindTexture(gl.TEXTURE_2D, this.previewTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.previewDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.previewFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.previewTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.previewDepth);
      this.previewCanvas = document.createElement('canvas'); this.previewCanvas.width = W; this.previewCanvas.height = H;
    }
    const p = this.game.player;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.previewFbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const savedVp = this.renderer.vp.slice();
    const proj = new Float32Array(16);
    // orthographic: 2.2 blocks tall
    const h = 2.2, w = h * W / H;
    proj.set([2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, -0.1, 0, 0, -0.95, 0, 1]);
    this.renderer.vp.set(proj);
    const sky = { fogColor: [0, 0, 0], fogStart: 1e6, fogEnd: 1e6 + 1 } as any;
    const m = this.model('player');
    this.beginEntityProgram(sky, this.texture('entity/player/wide/steve'), [15, 15], [1, 1, 1, 1]);
    const yaw = -Math.atan(mouseDx / 40) * 20, pitch = Math.atan(mouseDy / 40) * 20;
    const base = new Float32Array(16);
    this.entityMatrix(base, [0, 0, 0], yaw * 0.5, 1);
    const pose = this.poseFor(p, 'player', 0, 0, yaw * 0.5, pitch, 0);
    this.drawParts(m, base, pose, gl);
    // armour layers
    for (let i = 0; i < 4; i++) {
      const a = p.armor.get(i);
      if (!a || !a.item.armorSlot || a.item.name === 'elytra' || a.item.name === 'carved_pumpkin' || a.item.name.endsWith('_head') || a.item.name.endsWith('_skull')) continue;
      const mat = a.item.name.split('_')[0];
      const tex = `entity/equipment/humanoid${i === 2 ? '_leggings' : ''}/${mat === 'golden' ? 'gold' : mat}`;
      const col = a.item.name.startsWith('leather') ? (a.extra?.dyeColor ?? 0xa06540) : 0xffffff;
      this.beginEntityProgram(sky, this.texture(tex), [15, 15], [((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 1]);
      const armorPose: Record<string, any> = { ...pose };
      const hide: Record<string, boolean> = { head: i !== 0, hat: true, body: i !== 1 && i !== 2, rightArm: i !== 1, leftArm: i !== 1, rightLeg: i !== 2 && i !== 3, leftLeg: i !== 2 && i !== 3 };
      for (const k of Object.keys(hide)) if (hide[k]) armorPose[k] = { ...(armorPose[k] ?? {}), hidden: true };
      for (const k of ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) if (!hide[k]) armorPose[k] = { ...(armorPose[k] ?? {}), scale: 1 + (i === 2 ? 0.5 : 1) / 16 };
      this.drawParts(m, base, armorPose, gl);
    }
    this.renderer.vp.set(savedVp);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderer.canvas.width, this.renderer.canvas.height);
    const img = this.previewCanvas!.getContext('2d')!.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    this.previewCanvas!.getContext('2d')!.putImageData(img, 0, 0);
    return this.previewCanvas;
  }

  /** First-person hand/held item. */
  drawFirstPerson(p: Player, sky: SkyState, partial: number, swingProgress: number, equipProgress: number): void {
    const gl = this.renderer.gl;
    const held = p.heldItem();
    const light = this.lightAt(p);
    const vp = this.renderer.vp;
    // view-space rendering with a fixed 70° projection (vanilla ignores the FOV setting for the hand)
    const savedVp = vp.slice();
    const proj = new Float32Array(16);
    const aspect = this.renderer.canvas.width / Math.max(1, this.renderer.canvas.height);
    mat4Perspective(proj, 70 * DEG, aspect, 0.05, 32);
    vp.set(proj);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const swing = swingProgress;
    const f1 = Math.sin(swing * swing * Math.PI), f2 = Math.sin(Math.sqrt(swing) * Math.PI);
    // main hand option: everything is mirrored on x for left-handed players (vanilla HumanoidArm sign)
    const left = this.game.options.mainHand === 'left';
    const i = left ? -1 : 1;
    const slim = this.game.options.skin === 'alex';
    if (held) {
      const mesh = this.items.getMesh(held);
      const m = new Float32Array(16);
      mat4Identity(m);
      // vanilla ItemInHandRenderer.renderArmWithItem
      const f5 = -0.4 * Math.sin(Math.sqrt(swing) * Math.PI), f6 = 0.2 * Math.sin(Math.sqrt(swing) * Math.PI * 2), f10 = -0.2 * Math.sin(swing * Math.PI);
      mat4Translate(m, m, i * f5, f6, f10);
      const using = p.usingItem === held;
      const useT = using ? Math.min(1, (p.itemUseTicks + partial) / Math.max(1, p.useDuration)) : 0;
      mat4Translate(m, m, i * 0.56, -0.52 - equipProgress * 0.6, -0.72); // applyItemArmTransform
      if (using && held.item.food) {
        // applyEatTransform
        const f = (p.useDuration - p.itemUseTicks) - partial + 1, fr = f / p.useDuration;
        if (fr < 0.8) mat4Translate(m, m, 0, Math.abs(Math.cos(f / 4 * Math.PI) * 0.1), 0);
        const fe = 1 - Math.pow(fr, 27);
        mat4Translate(m, m, i * fe * 0.6, fe * -0.5, 0);
        mat4RotateY(m, m, i * fe * 90 * DEG); mat4RotateX(m, m, fe * 10 * DEG); mat4RotateY(m, m, i * fe * 30 * DEG);
      } else if (using && (held.item.name === 'bow' || held.item.name === 'crossbow' || held.item.name === 'trident')) {
        mat4Translate(m, m, i * -0.2785682, 0.18344387, 0.15731531);
        mat4RotateX(m, m, -13.935 * DEG); mat4RotateY(m, m, i * 35.3 * DEG); mat4RotateZ(m, m, i * -9.785 * DEG);
        const pull = Math.min(1, useT * 20 / 20 * (p.useDuration > 100 ? 20 / 20 : 1));
        const f = Math.min(1, (p.itemUseTicks + partial) / 20);
        const f7 = f > 0.1 ? Math.sin((f - 0.1) * 1.3) * 0.01 : 0;
        mat4Translate(m, m, f7 * 0.5, f7 * 0, f7 * 0);
        mat4Translate(m, m, f * 0.1 * 0, -f * 0.1 * 0.3, f * 0.1);
        void pull;
      } else {
        // applyItemArmAttackTransform
        mat4RotateY(m, m, i * (45 + f1 * -20) * DEG);
        mat4RotateZ(m, m, i * f2 * -20 * DEG);
        mat4RotateX(m, m, f2 * -80 * DEG);
        mat4RotateY(m, m, i * -45 * DEG);
      }
      const disp = new Float32Array(16); this.items.applyDisplay(disp, mesh, left ? 'firstperson_lefthand' : 'firstperson_righthand', left);
      mat4Mul(m, m, disp);
      // view bobbing of the hand (vanilla renderHandsWithItems)
      const bobM = new Float32Array(16); mat4Identity(bobM);
      const wd = -(p.prevWalkDist + (p.walkDist - p.prevWalkDist) * partial), bob = p.prevBob + (p.bob - p.prevBob) * partial;
      mat4Translate(bobM, bobM, Math.sin(wd * Math.PI) * bob * 0.5, -Math.abs(Math.cos(wd * Math.PI) * bob), 0);
      mat4RotateZ(bobM, bobM, Math.sin(wd * Math.PI) * bob * 3 * DEG);
      mat4RotateX(bobM, bobM, Math.abs(Math.cos(wd * Math.PI - 0.2) * bob) * 5 * DEG);
      mat4Mul(m, bobM, m);
      this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, m, sky, { light: (light[1] << 4) | light[0], alphaCut: 0.1, noCull: mesh.flat, noFog: true });
    } else {
      // arm (vanilla ItemInHandRenderer.renderPlayerArm transform sequence)
      const m = this.model(slim ? 'player_slim' : 'player');
      this.beginEntityProgram(sky, this.texture(slim ? 'entity/player/slim/alex' : 'entity/player/wide/steve'), light, [1, 1, 1, 1]);
      gl.uniform2f(this.renderer.entityProg.u('uFogRange'), 1e6, 1e6 + 1);
      const base = new Float32Array(16);
      mat4Identity(base);
      mat4Translate(base, base, i * 0.64, -0.6 - equipProgress * 0.6, -0.72);
      mat4RotateY(base, base, i * 45 * DEG);
      mat4RotateY(base, base, i * f2 * 70 * DEG);
      mat4RotateZ(base, base, i * f1 * -20 * DEG);
      mat4Translate(base, base, i * -1, 3.6, 3.5);
      mat4RotateZ(base, base, i * 120 * DEG);
      mat4RotateX(base, base, 200 * DEG);
      mat4RotateY(base, base, i * -135 * DEG);
      mat4Translate(base, base, i * 5.6, 0, 0);
      mat4Scale(base, base, 1 / 16, 1 / 16, 1 / 16);
      const pose: Record<string, any> = { head: { hidden: true }, hat: { hidden: true }, body: { hidden: true }, rightLeg: { hidden: true }, leftLeg: { hidden: true } };
      pose[left ? 'rightArm' : 'leftArm'] = { hidden: true };
      if (left) pose.leftArm = { tx: -10 };
      this.drawParts(m, base, pose, gl);
    }
    vp.set(savedVp);
    gl.bindVertexArray(null);
  }
}
