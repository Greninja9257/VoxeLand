<h1 align="center">VoxeLand<br>
<sub><sup><font color="gray">/ˈvɒk.si.lænd/</font></sup></sub>
</h1>

<br>

<div align="center">

### Minecraft-inspired survival, rebuilt for the browser

A WebGL2 and TypeScript voxel game powered by real Minecraft: Java Edition data and assets.

[Getting started](#getting-started) · [Features](#features) · [Multiplayer](#multiplayer) · [Controls](#controls) · [Limitations](#current-limitations)

</div>

> [!IMPORTANT]
> VoxeLand is an independent project. It is not an official Minecraft product and is not approved by or associated with Mojang Studios or Microsoft. Minecraft assets are downloaded during setup and are not included in this repository.

## About

VoxeLand is a browser-based recreation of Minecraft: Java Edition built without a client-side game engine or runtime framework. Rendering, world generation, simulation, entities, interfaces, and persistence are implemented in TypeScript on top of WebGL2 and browser APIs.

The game is data-driven from Minecraft 26.x resources:

- Block models, blockstates, item definitions, textures, fonts, and interface sprites come from the vanilla resource pack.
- Recipes, loot tables, tags, and sound events come from the Minecraft client data.
- Block, item, biome, entity, collision, and tool metadata come from [PrismarineJS `minecraft-data`](https://github.com/PrismarineJS/minecraft-data).
- Sounds are fetched from Mojang's asset servers.

These resources are processed into browser-friendly atlases and data bundles by the asset fetcher. Generated assets stay untracked under `public/assets/`.

## Getting started

### Requirements

- A current version of Node.js with npm
- A desktop browser with WebGL2 support
- About 450 MB of free space for the complete asset download

Chrome, Edge, and Firefox are supported. Safari cannot decode the Ogg Vorbis audio used by the game, so sound is unavailable there.

### Run locally

```bash
git clone https://github.com/Greninja9257/VoxeLand.git
cd VoxeLand
npm install
npm run fetch-assets
npm run dev
```

Open <http://localhost:5173>.

The asset download only needs to run once. To reduce its size, omit music or all sounds:

```bash
npm run fetch-assets -- --no-music
npm run fetch-assets -- --no-sounds
```

Use `--force` to download and rebuild the generated assets again.

### Production build

```bash
npm run build
npm run preview
```

The static build is written to `dist/`. Single-player worlds use IndexedDB, and the generated site can be served by any static host that preserves the cross-origin headers configured in `vite.config.ts`.

## Features

### Worlds and dimensions

- Infinite, seed-based worlds spanning Y -64 through 319
- More than 50 Overworld biomes, climate-driven terrain, caves, ravines, ores, vegetation, and environmental features
- The Nether and the End, including functional portals and 1:8 Nether coordinate scaling
- Day and night, moon phases, weather, lightning, biome tinting, fog, clouds, smooth lighting, and ambient occlusion
- Persistent local worlds with multiple saves, game modes, difficulty, and optional cheats
- Water and lava flow, fire, gravity, crop growth, leaf decay, copper oxidation, and other block ticks

### Building, crafting, and redstone

- Vanilla block models and placement rules, including connections, waterlogging, multipart blocks, and custom block meshes
- Crafting, furnaces, brewing, enchanting, smithing, anvils, stonecutters, containers, hoppers, and a recipe book
- Survival and creative inventories with familiar slot interactions and tooltips
- Mining tiers, durability, enchantments, loot tables, combat, armour, hunger, experience, potion effects, and respawning
- Redstone dust, torches, repeaters, comparators, observers, pistons, dispensers, TNT, target blocks, and more

### Entities and presentation

- More than 90 mob definitions with spawning, pathing, combat, breeding, taming, and species-specific behaviour
- Item entities, projectiles, experience orbs, falling blocks, boats, and chest boats
- Ender Dragon and Wither boss encounters
- Vanilla-style HUD, menus, inventory screens, fonts, particles, positional audio, music, subtitles, and overlays
- Rebindable controls and extensive video, audio, chat, accessibility, language, and skin settings
- Commands with suggestions and completion, including `/gamemode`, `/give`, `/tp`, `/weather`, `/summon`, and `/fill`

<details>
<summary><strong>Technical highlights</strong></summary>

- Chunk generation and meshing run in a worker pool sized to the available CPU.
- Each 16³ chunk section is grouped by render layer, with frustum culling and alpha-weighted mipmaps.
- Local saves use IndexedDB.
- Player-hosted multiplayer uses WebSockets; the included Node.js backend also maintains a persistent public world.
- A gateway translates between the browser protocol and supported Minecraft Java servers.

</details>

## Multiplayer

VoxeLand includes a small Node.js backend that serves the built game, relays WebSocket traffic, and maintains one persistent public world.

```bash
npm run build
npm run server
```

Open <http://localhost:8080>. The relay is available at `/ws`, and health checks are exposed at `/api/health` and `/healthz`.

Players can:

- Join the backend-owned public world.
- Share a local world publicly or protect it with a password.
- Add another VoxeLand backend using an IP address, `host:port`, or `ws://`/`wss://` URL.
- View connected players with the Tab list and share chat, containers, mobs, and boats.

For player-hosted worlds, the host simulates the world while guests simulate their own movement and inventory. A worker timer keeps hosted worlds ticking while the host tab is in the background. Guest dimension travel is not currently supported.

### Server configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP and WebSocket port | `8080` |
| `DATA_DIR` | Persistent world and authentication data | `.data` |
| `PUBLIC_SEED` | Public-world seed | Random |
| `PUBLIC_NAME` | Public-world display name | `VoxeLand Public Server` |
| `PUBLIC_MOTD` | Public-world message | `Open to everyone · survival` |
| `PUBLIC_GAMEMODE` | Public-world game mode | `survival` |
| `PUBLIC_DIFFICULTY` | Public-world difficulty | `2` |
| `PUBLIC_MAX_PLAYERS` | Public-world player limit | `16` |
| `PUBLIC_MAX_CHUNKS` | Maximum persisted public-world chunks | `2048` |

Attach persistent storage at `DATA_DIR` in production. Without it, public-world progress and authentication data may be lost during redeployment.

### Minecraft Java servers

Direct Connection can reach a Minecraft Java server through the VoxeLand backend. Choose **Minecraft Java**, enter `host` or `host:port`, and select offline/local or Microsoft authentication. The browser does not connect to the Minecraft TCP port directly.

The gateway currently supports login, chunks, movement, teleport reconciliation, block changes, digging and placement, health, time, experience, held slots, chat, respawning, and disconnects. It does not yet provide complete entity and inventory translation, custom registries, modded-server support, or plugin-specific screens.

> [!WARNING]
> Private and loopback destinations are blocked by default to prevent a public deployment from acting as an internal-network proxy. Set `ALLOW_PRIVATE_MINECRAFT=true` only on a trusted server, or use `MINECRAFT_ALLOWED_HOSTS` as a comma-separated allowlist. Microsoft authentication data is stored under `DATA_DIR/auth` and must be treated as account credentials.

## Deploying to Railway

Connect this repository to a Railway service and deploy it. [`railway.json`](railway.json) configures Railway to fetch the untracked assets, build the game, and start the server on Railway's assigned `PORT`.

The first build downloads roughly 450 MB of assets and can take some time. Add a Railway volume mounted at `DATA_DIR` if the public world must survive redeployments.

## Controls

Controls can be rebound under **Options → Controls**.

| Action | Default control |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Jump / sneak / sprint | `Space` / `Shift` / `Ctrl` or double-tap `W` |
| Break / place / pick block | Left / right / middle click |
| Inventory / drop / swap hands | `E` / `Q` / `F` |
| Select hotbar slot | `1`–`9` or mouse wheel |
| Chat / command | `T` / `/` |
| Fly in Creative | Double-tap `Space` |
| Perspective / debug / hide UI | `F5` / `F3` / `F1` |
| Screenshot / fullscreen | `F2` / `F11` |
| Pause | `Esc` |

## Current limitations

VoxeLand is ambitious, but it is not a complete replacement for Minecraft. The following areas are not yet implemented or remain incomplete:

- Generated structures such as villages, strongholds, fortresses, temples, and ancient cities
- Villager professions and complete trading behaviour
- Maps, books, banner patterns, minecarts, elytra flight, and fishing
- Advancements and statistics
- Guest dimension travel in multiplayer
- Runtime resource-pack switching
- Complete compatibility with Minecraft Java entities, inventories, custom registries, mods, and plugins

## Project structure

```text
src/
├── blocks/       Block behaviour, placement, ticking, and redstone
├── entity/       Players, mobs, bosses, boats, and other entities
├── game/         Simulation, input, commands, weather, and interface
├── items/        Item registry, stacks, recipes, and loot
├── net/          VoxeLand and Minecraft Java networking
├── render/       WebGL renderer, meshing, models, shaders, and particles
├── save/         Browser persistence
├── workers/      World-generation and meshing workers
└── world/        Chunks, lighting, dimensions, biomes, and terrain generation

server/           Static host, multiplayer relay, persistent world, and Java gateway
scripts/          Asset download and preprocessing
public/           Title panorama and generated assets
```

Useful commands:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run fetch-assets` | Download and process Minecraft assets |
| `npm run typecheck` | Check the TypeScript project |
| `npm test` | Run backend and Java-gateway tests |
| `npm run build` | Type-check and create the production build |
| `npm run server` | Serve `dist/`, multiplayer, and the public world |

## Credits and licensing

- **Minecraft** — © Mojang AB / Microsoft. Textures, models, blockstates, fonts, interface sprites, language files, sounds, recipes, loot tables, and tags are downloaded during setup and remain the property of their owners. Their use is subject to the [Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines).
- **[Default Template Resource Pack](https://www.curseforge.com/minecraft/texture-packs/default-template-resource-pack-vanilla-minecraft)** by Truyty — the vanilla asset extraction used by the asset pipeline.
- **[PrismarineJS `minecraft-data`](https://github.com/PrismarineJS/minecraft-data)** — block, item, entity, biome, food, tint, and collision metadata, licensed under MIT.
- **[Minecraft Wiki](https://minecraft.wiki/)** — reference material for game mechanics.

VoxeLand source code is available under the [MIT License](LICENSE). That license does not cover Minecraft assets or data downloaded by the setup script.
