<h1 align="center">VoxeLand<br>
<sub><sup><font color="gray">/ˈvɒk.si.lænd/</font></sup></sub>
</h1>

<br>

A faithful remake of the latest **Minecraft: Java Edition** (26.x assets) that runs in the browser — WebGL2 + TypeScript, zero runtime dependencies.

VoxeLand is *data-driven from the real game files*: every one of the ~1,200 blocks renders from the vanilla JSON block models and blockstates, item icons come from the vanilla item definitions, block hardness / tool tiers / collision shapes / light values come from PrismarineJS `minecraft-data`, and crafting recipes, loot tables and tags are the actual data-pack files from the client jar. Sounds are the real vanilla sound events (`sounds.json`) played from Mojang's asset server files.

> VoxeLand is **not** an official Minecraft product and is not approved by or associated with Mojang Studios or Microsoft. All Minecraft assets remain the property of Mojang AB and are downloaded at setup time — none are redistributed with this repository. See `public/assets/CREDITS.txt` (generated) and [Credits](#credits).

## Quick start

```bash
npm install
npm run fetch-assets     # downloads the resource pack, sounds, data files (~450 MB, one time)
npm run dev              # http://localhost:5173
```

`npm run fetch-assets` accepts `--no-music` (skip ~260 MB of music) and `--no-sounds`.

`npm run build` produces a static site in `dist/` (serve it from any static host; workers and IndexedDB saves work out of the box).

## Multiplayer

VoxeLand ships a small backend (`server/index.mjs`, Node + `ws`) that serves the built game, relays multiplayer
traffic and keeps one **persistent public world**.

```bash
npm run build
npm run server           # http://localhost:8080  (game + relay on /ws + public world)
```

- **VoxeLand Public Server** — a backend-owned world that is always in the Multiplayer list. Its seed, time,
  weather, modified chunks and per-player inventories live on the backend. Player records use a stable local
  identity instead of the current coordinator or display name, so reconnecting restores the correct inventory.
- **Share World** (pause menu) publishes your own world through a server as **Public** (anyone may join) or
  **Private** (a password is required; the field only appears when you pick Private).
- **Direct Connection / Add Server Address** takes an IP, `host:port`, or a `ws(s)://` URL (optionally `#serverId`),
  so you can play on anyone else's VoxeLand backend. Added addresses are queried alongside your own server, so
  their worlds show up in the same list.
- Guests run their own player physics and inventory; the host runs player-created worlds (blocks, mobs, items,
  time, weather, containers, boats). Guest player data is saved with the world under a stable player identity. Dimension travel is
  host-only for now; Tab shows everyone online.

Server environment variables: `PORT`, `DATA_DIR`, `PUBLIC_SEED`, `PUBLIC_NAME`, `PUBLIC_MOTD`, `PUBLIC_GAMEMODE`,
`PUBLIC_DIFFICULTY`, `PUBLIC_MAX_PLAYERS`, `PUBLIC_MAX_CHUNKS`.

While the host's tab is in the background a worker timer keeps the world ticking at 20 TPS.

## Railway deployment

Connect this repository to a Railway service and deploy it. `railway.json` fetches the git-ignored game assets,
builds, and starts `server/index.mjs` on Railway's `PORT`. Everyone who opens the deployed URL sees the same
public world in Multiplayer, and can share their own worlds through it. Attach a volume at `DATA_DIR` if you want
the public world to survive redeploys.

The full asset download is roughly 450 MB and makes the first build relatively slow.

**Browsers:** Chrome / Edge / Firefox (desktop). Safari lacks Ogg Vorbis decoding for Web Audio, so sounds are silent there.

## Controls (rebindable in Options → Controls)

| Action | Key |
|---|---|
| Move / jump / sneak / sprint | `W A S D` / `Space` / `Shift` / `Ctrl` (or double-tap `W`) |
| Break / place / pick block | Left click / Right click / Middle click |
| Inventory / drop / swap hands | `E` / `Q` / `F` |
| Hotbar | `1`–`9`, mouse wheel |
| Chat / command | `T` / `/` |
| Fly (creative) | double-tap `Space` |
| Perspective / debug / hide GUI / screenshot / fullscreen | `F5` / `F3` / `F1` / `F2` / `F11` |
| Pause | `Esc` |

## What's implemented

**World**
- Infinite worlds, 384-block height (-64..320), 16³ sections, persistent (IndexedDB) with multiple saves, seeds, difficulty, game modes and cheats toggle.
- Overworld generation: multi-noise climate (temperature / humidity / continentalness / erosion / weirdness → peaks & valleys), 50+ biomes incl. mountains, rivers, oceans, beaches, swamps, badlands strata, cherry groves, pale gardens; cheese & spaghetti caves, ravines, lava below -54, deepslate, all 1.18+ ore distributions, bedrock. Trees for every wood type (oak, fancy oak, birch, spruce, pine, mega spruce/pine, jungle + mega jungle + bushes, acacia, dark oak, pale oak, cherry, mangrove, huge mushrooms, crimson/warped fungi, chorus), flowers, grass, crops, cacti, sugar cane, kelp, seagrass, coral, ice spikes, lily pads, bamboo, desert wells, snow & ice.
- The Nether (five biomes, lava sea, glowstone, fungi forests, basalt deltas, soul sand valleys, nether ores) and The End (central island, obsidian pillars, exit portal, outer chorus islands). Nether portals (build & light with flint and steel, 1:8 coordinate scaling) and end portals (eyes of ender in frames).
- Vanilla sky / block light propagation, smooth lighting + ambient occlusion, day/night cycle with sun, moon phases, stars, sunrise glow, biome sky/fog/grass/foliage/water colours from the colormaps, fog under water/lava, clouds, rain, snow, thunderstorms and lightning.
- Block ticking: water & lava flow (with infinite sources, obsidian/cobblestone/stone), gravity blocks, fire spread & burning, crop / sapling / sugar cane / cactus / kelp / bamboo / vine / mushroom / sweet berry / cocoa / nether wart / amethyst growth, grass & mycelium spread, leaf decay, farmland moisture, ice & snow melting, copper oxidation, bone meal.

**Blocks & items**
- All blocks render from the vanilla models (stairs, slabs, fences, walls, panes, doors, trapdoors, beds, signs, rails, torches, redstone components, crops …) plus custom meshes for chests, shulker boxes, banners, heads, decorated pots, end portals and fluids.
- Vanilla placement rules (facing, halves, hinges, stairs shapes, fence/wall/pane connections, waterlogging, double blocks, slab merging, chest joining, stackable layers/candles/pickles/eggs).
- Interactions: doors, trapdoors, gates, levers, buttons, pressure plates, repeaters, comparators, note blocks (all instruments), jukeboxes + music discs, cakes, flower pots, composters, cauldrons, bells, beds (sleeping skips the night, sets spawn), campfires, berry bushes, dragon eggs, respawn anchors.
- Containers & workstations with vanilla GUIs: survival inventory (with 3D player preview), creative inventory (tabs, search, scrolling), crafting table (all shaped/shapeless recipes incl. tag ingredients & repair), furnace / blast furnace / smoker (fuel table, XP), chests / double chests / barrels / shulker boxes / ender chests, hoppers (item transfer), dispensers & droppers (arrows, projectiles, buckets, fire, bone meal, spawn eggs), stonecutter, anvil (repair, combine, rename, costs), enchanting table (bookshelf power, lapis), smithing table (netherite upgrades, trims), grindstone, brewing stand (all base potions, splash/lingering, redstone/glowstone), villager trading (basic).
- Full slot interaction: click/right-click, shift-click quick move, drag distribution, number-key swaps, double-click collect, drop, tooltips with enchantments/durability/attributes.
- Tools & combat: hardness/tool-tier mining with cracking overlay, item durability + Unbreaking, efficiency, silk touch & fortune via the real loot tables, attack cooldowns, criticals, sweeping edge, knockback, fire aspect, bows (charge, power/punch/flame/infinity), crossbows, tridents, snowballs/eggs/ender pearls/splash potions/XP bottles, shields (held), armour values + toughness + protection enchantments, hunger/saturation/exhaustion, natural regeneration, XP orbs & levels, potion effects, fall/drown/fire/lava/cactus/starvation damage, death screen & respawn at bed.

**Redstone**
- Power model with weak/strong signals, redstone dust (levels, diagonal connections), torches (inversion, burnout-free), levers, buttons (with timings), pressure plates (weighted too), repeaters (delay, locking), comparators (compare/subtract, container reading), observers, redstone lamps, doors/trapdoors/gates, pistons & sticky pistons (push up to 12 blocks, pull), dispensers/droppers, note blocks, TNT (with chained explosions), copper bulbs, hoppers lock, tripwire hooks, target blocks, daylight detectors, lightning rods, bells.

**Entities**
- 90+ mob definitions with vanilla stats, box models and textures: zombies (& husk/drowned/villager), skeletons (& stray/bogged/wither), creepers (charged by lightning), spiders, endermen (stare aggro, teleport), witches, slimes & magma cubes (splitting), phantoms (after 3 sleepless days), ghasts, blazes, piglins, hoglins, striders, wolves (taming, sitting, following, defending), cats/ocelots, foxes, pigs, cows/mooshrooms (milking, shearing), sheep (shearing, dyeing, grass eating, wool regrowth), chickens (eggs), rabbits, horses, llamas, goats, pandas, polar bears, bees, turtles (egg hatching), frogs, armadillos, camels, sniffers, axolotls, squid/glow squid, fish, dolphins, guardians, bats, villagers, iron golems & snow golems (buildable), pillagers/vindicators/evokers, silverfish, and more.
- AI: wandering with cliff/lava avoidance, hostile targeting & pathing with jumping, ranged attacks (arrows, potions, fireballs, snowballs), creeper fuse, panic/fleeing, tempting with food, breeding with babies that grow up, daylight burning, natural spawning by biome/light/category caps, despawning, spawners.
- Item entities (merging, pickup, despawn), XP orbs, arrows (stick in blocks, pickup), falling sand/gravel/anvils/concrete powder, primed TNT, projectiles.

**Presentation**
- Vanilla HUD: hotbar with selection & offhand, hearts (poison/wither/absorption/hardcore variants), armour, hunger, air bubbles, XP bar, crosshair + attack indicator, effect icons, action bar, chat, subtitles, F3 debug screen, title/pause/options/controls/world screens, panorama title with splash text, vignette, underwater/fire/portal/pumpkin/spyglass overlays, screenshots.
- Vanilla font renderer (ascii/accented/non-latin providers, `§` formatting), sounds for every action with positional audio, background music & records, ambient cave / underwater / rain loops.
- Particles (block cracks, smoke, flames, crits, hearts, notes, portals, splash, bubbles, explosions, sweep, campfire smoke, enchant glyphs, rain splashes).
- Chat commands: `/gamemode /time /tp /give /weather /difficulty /kill /seed /clear /effect /xp /summon /setblock /fill /gamerule /spawnpoint /locate /enchant /say`.
- **Multiplayer:** a persistent public world on the backend plus public/private (password) worlds you share yourself, tab list, chat & commands relayed, container sync, boats and mobs mirrored.
- **Bosses:** the Ender Dragon (crystals heal it, circling / strafing fireballs / perching + breath, exit portal & dragon egg on death) and the Wither (spawn charge, three heads shooting skulls, block breaking, armoured phase, nether star).
- **Boats & rafts:** vanilla boat physics, two passengers, chest boats, rowing animation.
- **Settings:** every vanilla options screen (Video, Music & Sounds, Controls/Mouse/Key Binds, Chat, Skin Customization, Accessibility, Language) with working options (simulation distance, smooth lighting, mipmaps, clouds fast/fancy, biome blend, FOV/distortion effects, damage tilt, particles, main hand, skin, chat scale/width/opacity, toggle sneak/sprint, …).
- **Recipe book** in the inventory and crafting table, command suggestions with tab completion and vanilla syntax (`/give @s diamond 3`, selectors, relative coordinates).

## Performance notes

Chunk generation and meshing run in Web Workers (pool sized to your CPU). Each 16³ section is one draw call per render layer; frustum culling, alpha-weighted mipmaps and nearest-neighbour filtering match the vanilla look. Default render distance is 10 chunks; raise it in Options if your machine allows.

## Not (yet) implemented

Structures (villages, strongholds, fortresses, temples, ancient cities), villager professions/real trades, maps,
books, banner patterns, minecarts, elytra flight, fishing, advancements & statistics, guest dimension travel in
multiplayer, resource-pack switching at runtime.

## Credits

- **Minecraft** — © Mojang AB / Microsoft. Textures, models, blockstates, fonts, GUI sprites, language files, sounds, recipes, loot tables and tags are the vanilla game assets, used under the [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines). They are downloaded to `public/assets/` by `scripts/fetch-assets.mjs` and are never committed or redistributed.
- **Default Template Resource Pack (Vanilla Minecraft)** by *Truyty* on CurseForge — the unmodified vanilla asset extraction used as this project's resource pack: <https://www.curseforge.com/minecraft/texture-packs/default-template-resource-pack-vanilla-minecraft>
- **Vanilla sounds** — fetched from Mojang's official asset index (`resources.download.minecraft.net`), the same files the Minecraft Launcher downloads.
- **minecraft-data** by PrismarineJS (MIT) — block/item/entity/biome/food/tint metadata and collision shapes: <https://github.com/PrismarineJS/minecraft-data>
- **Minecraft Wiki** — reference for game mechanics: <https://minecraft.wiki>
- VoxeLand code: MIT (see `LICENSE`).
