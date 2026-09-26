# Cell
Bacteria eating bacteria on a sphere: a single-player browser game against NPC colonies. Eat pellets and smaller cells,
split to catch prey, eject mass, and avoid bigger cells and viruses. The world is a sphere, so there are no edges and you
can walk all the way round it.

The default `arcade` preset adds twelve maze districts, one in each region of the sphere. They have food in corridor
lines, rainbow spores and four resident phages per district, plus landmarks that make places recognizable (region inks,
names, junction emblems, a globe minimap and a home arrow). `?preset=base` is the open sphere with the base rules and no
mazes.

It looks like a risograph print: twelve flat spot inks on off-white paper, one dark key outline on every cell and wall,
square pellets, a paper grain, and wall inks printed slightly out of register. Every region has its own ink. Inks that
can meet at a region border stay apart for colour-blind players too, and the junction emblems also show the region
numbers, so colour isn't the only cue. `?theme=press` prints the same inks on dark stock.

A rainbow spore turns a cell rainbow for 8 s. A rainbow cell explodes any bigger cell it touches into pieces that still
belong to their owner (like a virus pop), and eats any smaller cell. NPCs use rainbow spores by the same rules as you.

A cell in a maze is never bigger than the widest way out from where it is. Mass it eats beyond that is **packed**: the
cell keeps its size, a halftone band grows inside its rim, and the mass still counts (score, being eaten, explosions,
decay). Once the way out is wide enough, the packed mass comes back as a quick swell. So a cell that outgrows a narrow
corridor can always get out. The same rule applies to you and to NPCs.

Every colony carries a country flag next to its name and in the leaderboard, so the world feels like players from
around the globe. NPC countries are picked by world population. Your own comes from your connection's country (see
[Country flags](#country-flags)). The menu links to this repository.

`ai/summary.md` describes how the game is built, the design decisions behind it, and what is still open.

## Setup and run

```bash
npm install
npm run dev
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build into `dist/` (static site) |
| `npm run preview` | Serve `dist/` |
| `npm run preview:cf` | Build, then serve `dist/` through the local Cloudflare runtime (`wrangler dev`) |
| `npm run deploy` | Build, then deploy to Cloudflare Workers (`wrangler deploy`) |
| `npm test` | Unit tests (Vitest): sphere math, rules, mechanics, virus pop pieces, lap test, NPC arena smoke test, big NPCs keep exploring, leaderboard rows, ink palette contrast and resident inks, jelly membrane, maze generator/walls, maze food and rainbow spores, rainbow explosions, packing (escape field, overgrown cells get out), path flood + resident phages, home/lap cues, adaptive quality (no flip-flopping at 60/120/144 Hz), NPC countries by population, the country lookup chain |
| `npm run e2e` | Playwright e2e (menu → play → eaten → respawn, arcade HUD, paper floor in and out of mazes, a rainbow explosion, the press stock, country flags with a stubbed Cloudflare trace, the GitHub link, no blank frame on a quality change) on desktop + phone viewports for the `arcade` and `base` presets, using system Chrome |
| `npm run flags` | Rebuild the flag atlas (`src/assets/flags.webp` + `flagIndex.ts`) from `flag-icons` with system Chrome; the output is committed |
| `npm run size` | Initial-load gzip budget check (run after `build`) |
| `npm run bench` | Load time (Slow 4G) + render frame times on the local GPU for the `plains`, `maze` and `rainbow` scenes, `--cpu 4` for a low-end proxy, `--scene maze` for one scene (run after `build`) |
| `npm run arena` | Headless NPC arena, per-personality stats and exploration (30 s windows per radius bucket: share of windows where a cell ended less than 3 r from its start, and turn-rounds per think): `-- --minutes 10 --R 4000 --seed 1`; `-- --preset arcade` adds mazes, resident phages, rainbow spore, explosion and packing metrics (R 16000); `-- --cfg botTurnCost=0.2` overrides numeric config for tuning |

## Deploy (Cloudflare)

The build is a static site served by a Cloudflare Worker with static assets (no Worker script); see `wrangler.jsonc`.

```sh
npx wrangler login   # once
npm run deploy       # builds, then uploads dist/ to https://cell.<your-subdomain>.workers.dev
```

`public/_headers` is copied into `dist/` and sets caching: hashed files under `/assets/` are cached for a year as
immutable, `index.html` revalidates on every load so new deploys show up straight away. For a custom domain add a
`routes` entry to `wrangler.jsonc` or attach the domain in the Cloudflare dashboard. For CI, set `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` and run `npm run deploy`.

## Country flags

Flags are one WebP atlas (about 100 KB) of every ISO 3166-1 flag from [flag-icons](https://github.com/lipis/flag-icons)
(MIT), loaded lazily after the game is interactive. Canvas text can't draw flags on Windows (no flag emoji), hence the
atlas. Resident phages have no flag.

Your country is looked up once in idle time and cached for a week, trying in order:

1. `/cdn-cgi/trace` on the same origin (Cloudflare's `loc=`; nothing leaves Cloudflare),
2. [country.is](https://country.is) and then [geojs.io](https://www.geojs.io), third-party services that see the
   visitor's IP address (only asked when step 1 fails, e.g. in local dev),
3. the region of the browser language (`en-AU` → AU).

`?geo=0` skips the lookup and `?flags=0` turns flags off.

## URL parameters

| Param | Example | Effect |
|---|---|---|
| `debug` | `?debug=1` | Debug panel: paper/press stock, NPC goals and actions overlay, background pattern, zoom override, membrane toggles, sphere radius, maze toggles (camera alignment, corner assist, maze zoom), teleport, rainbow, "big NPC here", "feed +50", escape radius overlay, live stats |
| `preset` | `?preset=base` | Config preset: `arcade` (default: mazes, rainbow spores, resident phages), `base` (the base rules on an open sphere) or `tuned` (single-player tuning, no mazes) |
| `theme` | `?theme=press` | `paper` (default) or `press` (dark stock, inverted key). `light`, `dark` and `arcade` are old aliases |
| `maze` | `?maze=0` | Turn maze districts off in the arcade preset |
| `mapSeed` | `?mapSeed=2` | Region/district layout seed (default 1: the same mazes every game) |
| `district` | `?district=3` | Start (attract mode and first spawn) at district 0–11 |
| `align` | `?align=0` | Don't rotate the camera to a district's "up" |
| `cornerAssist` | `?cornerAssist=0` | Corner assist strength in corridors (0–1, default 0.5) |
| `trail` | `?trail=0` | Hide the slime trail |
| `mute` | `?mute=1` | Start muted (also the ♪ button or M) |
| `sphereRadius` | `?sphereRadius=8000` | Sphere radius in world units (default 16000; mazes need ≥ ~16000) |
| `bg` | `?bg=cube` | Background: `dots` (default), `hex`, `cube`, `none` |
| `seed` | `?seed=42` | Deterministic world |
| `difficulty` | `?difficulty=hard` | NPC difficulty: `easy`, `normal`, `hard` |
| `quality` | `?quality=3` | Fix the render quality level 0–6 (disables adaptive quality) |
| `geo` | `?geo=0` | Don't look up the player's country (no network requests for it) |
| `flags` | `?flags=0` | No country flags |
| `bench` | `?bench=1&seconds=30&mass=20000&scene=maze` | Autopiloted perf run (`plains`, `maze` or `rainbow` scene); results in `window.__bench` |
| `manual` | `?manual=1` | No rAF loop; drive frames with `__game.advance(ms)` (automation) |

## Layout

- `src/sphere` — unit-sphere math, tangent frames + azimuthal equidistant projection, 3D hash grid, icosahedral lattice
- `src/maze` — 12-region layout, seeded symmetric maze generator, district charts with exact great-circle walls (collision, clearance, escape radius, reachability labels, outlines), path flood / A*
- `src/sim` — DOM-free simulation (25 Hz ticks): world, rules, cells, food (pellets, rainbow spores — `POWER` food in the code), species, active/dormant population, packing in mazes, arcade rules (maze food spots and regrowth, spore respawn, rainbow explosions)
- `src/ai` — NPC controller (context steering with a turning cost, wander goals and a progress detector so big NPCs keep exploring; personalities, maze routing), resident phages (`ghost.ts`), population
- `src/render` — sphere camera (district alignment), Canvas 2D renderer (background patterns, cached static layer with walls/borders/emblems, pellets, spore orbs, jelly membranes, rainbow cells, explosion effects, fading eaten cells, lazy country flags), adaptive quality
- `src/geo` — NPC countries by population, the player's country lookup
- `src/assets` — the generated flag atlas and its index
- `src/input`, `src/ui`, `src/game.ts` — input, HUD/menu, arcade HUD (minimap, banner, home arrow), home/lap tracker, lazy sound, game loop
- `ai/summary.md` — how the game is built and why, measured budgets, and open items

## Initial setup

```bash
npm create vite@latest . -- --template vanilla-ts
claude --dangerously-skip-permissions
```


