// Enchantment tables shared by the enchanting screen, anvils and villager trades.
import type { ItemStack } from './stack';

export function maxLevel(id: string): number { return { sharpness: 5, smite: 5, bane_of_arthropods: 5, efficiency: 5, power: 5, protection: 4, fire_protection: 4, blast_protection: 4, projectile_protection: 4, unbreaking: 3, fortune: 3, looting: 3, respiration: 3, depth_strider: 3, thorns: 3, knockback: 2, fire_aspect: 2, punch: 2, sweeping_edge: 3, feather_falling: 4, aqua_affinity: 1, silk_touch: 1, infinity: 1, mending: 1, flame: 1, loyalty: 3, riptide: 3, impaling: 5, channeling: 1, quick_charge: 3, multishot: 1, piercing: 4, soul_speed: 3, swift_sneak: 3, lure: 3, luck_of_the_sea: 3, frost_walker: 2, wind_burst: 3, density: 5, breach: 4 }[id] ?? 1; }

export const ENCH_POOL: Record<string, string[]> = { mining: ['efficiency', 'unbreaking', 'fortune', 'silk_touch', 'mending'], weapon: ['sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping_edge', 'unbreaking', 'mending'], armor: ['protection', 'fire_protection', 'blast_protection', 'projectile_protection', 'thorns', 'unbreaking', 'mending'], armor_feet: ['feather_falling', 'depth_strider', 'frost_walker', 'soul_speed'], armor_head: ['respiration', 'aqua_affinity'], bow: ['power', 'punch', 'flame', 'infinity', 'unbreaking', 'mending'], crossbow: ['quick_charge', 'multishot', 'piercing', 'unbreaking', 'mending'], trident: ['loyalty', 'impaling', 'riptide', 'channeling', 'unbreaking', 'mending'], fishing: ['lure', 'luck_of_the_sea', 'unbreaking', 'mending'], durability: ['unbreaking', 'mending'], book: ['sharpness', 'efficiency', 'protection', 'unbreaking', 'fortune', 'power', 'looting', 'silk_touch', 'mending', 'feather_falling', 'thorns', 'respiration', 'depth_strider', 'infinity', 'fire_aspect', 'knockback'] };

/** Random enchantments for an item at an enchanting level (vanilla EnchantmentHelper.selectEnchantment, simplified). */
export function pickEnchants(s: ItemStack, level: number): { id: string; level: number }[] {
    const cats = s.item.name === 'book' ? ['book'] : s.item.enchantCategories.concat(s.item.armorSlot === 'feet' ? ['armor_feet'] : [], s.item.armorSlot === 'head' ? ['armor_head'] : []);
    const pool = new Set<string>();
    for (const c of cats) for (const e of ENCH_POOL[c] ?? []) pool.add(e);
    const list = [...pool];
    if (!list.length) return [];
    const out: { id: string; level: number }[] = [];
    let l = level;
    const conflicts: Record<string, string[]> = { sharpness: ['smite', 'bane_of_arthropods'], smite: ['sharpness', 'bane_of_arthropods'], bane_of_arthropods: ['sharpness', 'smite'], protection: ['fire_protection', 'blast_protection', 'projectile_protection'], fire_protection: ['protection', 'blast_protection', 'projectile_protection'], blast_protection: ['protection', 'fire_protection', 'projectile_protection'], projectile_protection: ['protection', 'fire_protection', 'blast_protection'], fortune: ['silk_touch'], silk_touch: ['fortune'], infinity: ['mending'], mending: ['infinity'], depth_strider: ['frost_walker'], frost_walker: ['depth_strider'], riptide: ['loyalty', 'channeling'], loyalty: ['riptide'], channeling: ['riptide'], multishot: ['piercing'], piercing: ['multishot'] };
    while (list.length && (out.length === 0 || Math.random() < (l + 1) / 50)) {
      const id = list[Math.floor(Math.random() * list.length)];
      if (out.some((o) => o.id === id || conflicts[o.id]?.includes(id))) { list.splice(list.indexOf(id), 1); continue; }
      const max = maxLevel(id);
      const lvl = Math.max(1, Math.min(max, Math.round(l / (50 / max))));
      out.push({ id, level: lvl });
      list.splice(list.indexOf(id), 1);
      l = Math.floor(l / 2);
    }
    return out;
  }
