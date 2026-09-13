// ItemStack + Inventory containers.
import type { Item, ItemRegistry } from './registry';

export interface Enchantment { id: string; level: number }

export class ItemStack {
  constructor(public item: Item, public count = 1, public damage = 0, public enchantments: Enchantment[] = [], public customName: string | null = null, public extra: Record<string, any> = {}) {}

  get name(): string { return this.item.name; }
  get maxStack(): number { return this.item.stackSize; }
  get isEmpty(): boolean { return this.count <= 0; }
  get maxDurability(): number { return this.item.maxDurability; }
  get isDamageable(): boolean { return this.item.maxDurability > 0; }

  enchantLevel(id: string): number { const e = this.enchantments.find((x) => x.id === id); return e ? e.level : 0; }

  clone(): ItemStack { return new ItemStack(this.item, this.count, this.damage, this.enchantments.map((e) => ({ ...e })), this.customName, { ...this.extra }); }
  split(n: number): ItemStack { const take = Math.min(n, this.count); const s = this.clone(); s.count = take; this.count -= take; return s; }
  canStackWith(o: ItemStack): boolean {
    return o.item === this.item && this.damage === o.damage && this.customName === o.customName && JSON.stringify(this.enchantments) === JSON.stringify(o.enchantments) && JSON.stringify(this.extra) === JSON.stringify(o.extra) && this.maxStack > 1;
  }
  /** Damage the item by n; returns true if it broke. */
  hurt(n: number, rnd = Math.random): boolean {
    if (!this.isDamageable) return false;
    const unb = this.enchantLevel('unbreaking');
    let dmg = 0;
    for (let i = 0; i < n; i++) if (unb === 0 || rnd() < 1 / (unb + 1)) dmg++;
    this.damage += dmg;
    if (this.damage >= this.maxDurability) { this.count = 0; return true; }
    return false;
  }

  serialize(): any { return { n: this.item.name, c: this.count, d: this.damage || undefined, e: this.enchantments.length ? this.enchantments : undefined, cn: this.customName ?? undefined, x: Object.keys(this.extra).length ? this.extra : undefined }; }
  static deserialize(d: any, reg: ItemRegistry): ItemStack | null {
    if (!d) return null;
    const it = reg.get(d.n);
    if (!it) return null;
    return new ItemStack(it, d.c ?? 1, d.d ?? 0, d.e ?? [], d.cn ?? null, d.x ?? {});
  }
}

export class Inventory {
  slots: (ItemStack | null)[];
  onChange?: () => void;
  constructor(public size: number) { this.slots = new Array(size).fill(null); }

  get(i: number): ItemStack | null { const s = this.slots[i]; return s && s.count > 0 ? s : null; }
  set(i: number, s: ItemStack | null): void { this.slots[i] = s && s.count > 0 ? s : null; this.onChange?.(); }

  /** Add a stack, merging; returns leftover count. */
  add(stack: ItemStack, range?: [number, number]): number {
    const [a, b] = range ?? [0, this.size];
    // merge first
    for (let i = a; i < b && stack.count > 0; i++) {
      const s = this.slots[i];
      if (s && s.canStackWith(stack) && s.count < s.maxStack) { const n = Math.min(stack.count, s.maxStack - s.count); s.count += n; stack.count -= n; }
    }
    for (let i = a; i < b && stack.count > 0; i++) {
      if (!this.slots[i]) { const n = Math.min(stack.count, stack.maxStack); const c = stack.clone(); c.count = n; this.slots[i] = c; stack.count -= n; }
    }
    this.onChange?.();
    return stack.count;
  }

  count(name: string): number { let n = 0; for (const s of this.slots) if (s && s.item.name === name) n += s.count; return n; }
  /** Remove up to n items of a name; returns removed count. */
  remove(name: string, n: number): number {
    let removed = 0;
    for (let i = 0; i < this.size && removed < n; i++) {
      const s = this.slots[i];
      if (s && s.item.name === name) { const take = Math.min(n - removed, s.count); s.count -= take; removed += take; if (s.count <= 0) this.slots[i] = null; }
    }
    if (removed) this.onChange?.();
    return removed;
  }
  findSlot(pred: (s: ItemStack) => boolean, from = 0, to = this.size): number { for (let i = from; i < to; i++) { const s = this.slots[i]; if (s && pred(s)) return i; } return -1; }
  isEmpty(): boolean { return this.slots.every((s) => !s || s.count <= 0); }
  clear(): void { this.slots.fill(null); this.onChange?.(); }

  serialize(): any[] { return this.slots.map((s) => (s && s.count > 0 ? s.serialize() : null)); }
  deserialize(d: any[] | undefined, reg: ItemRegistry): void {
    if (!d) return;
    for (let i = 0; i < this.size && i < d.length; i++) this.slots[i] = ItemStack.deserialize(d[i], reg);
  }
}
