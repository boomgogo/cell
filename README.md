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
| `npm test` | Unit tests (Vitest): sphere math, rules, mechanics, virus pop pieces, lap test, NPC arena smoke test, big NPCs keep exploring, leaderboard rows, ink palette contrast and resident inks, jelly membrane, maze generator/walls, maze food and rainbow spores, rainbow explosions, packing (escape field, overgrown cells get out), path flood + resident phages, home/lap cues |
| `npm run e2e` | Playwright e2e (menu → play → eaten → respawn, arcade HUD, paper floor in and out of mazes, a rainbow explosion, the press stock) on desktop + phone viewports for the `arcade` and `base` presets, using system Chrome |
| `npm run size` | Initial-load gzip budget check (run after `build`) |
| `npm run bench` | Load time (Slow 4G) + render frame times on the local GPU for the `plains`, `maze` and `rainbow` scenes, `--cpu 4` for a low-end proxy, `--scene maze` for one scene (run after `build`) |
| `npm run arena` | Headless NPC arena, per-personality stats and exploration (30 s windows per radius bucket: share of windows where a cell ended less than 3 r from its start, and turn-rounds per think): `-- --minutes 10 --R 4000 --seed 1`; `-- --preset arcade` adds mazes, resident phages, rainbow spore, explosion and packing metrics (R 16000); `-- --cfg botTurnCost=0.2` overrides numeric config for tuning |

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
| `bench` | `?bench=1&seconds=30&mass=20000&scene=maze` | Autopiloted perf run (`plains`, `maze` or `rainbow` scene); results in `window.__bench` |
| `manual` | `?manual=1` | No rAF loop; drive frames with `__game.advance(ms)` (automation) |

## Layout

- `src/sphere` — unit-sphere math, tangent frames + azimuthal equidistant projection, 3D hash grid, icosahedral lattice
- `src/maze` — 12-region layout, seeded symmetric maze generator, district charts with exact great-circle walls (collision, clearance, escape radius, reachability labels, outlines), path flood / A*
- `src/sim` — DOM-free simulation (25 Hz ticks): world, rules, cells, food (pellets, rainbow spores — `POWER` food in the code), species, active/dormant population, packing in mazes, arcade rules (maze food spots and regrowth, spore respawn, rainbow explosions)
- `src/ai` — NPC controller (context steering with a turning cost, wander goals and a progress detector so big NPCs keep exploring; personalities, maze routing), resident phages (`ghost.ts`), population
- `src/render` — sphere camera (district alignment), Canvas 2D renderer (background patterns, cached static layer with walls/borders/emblems, pellets, spore orbs, jelly membranes, rainbow cells, explosion effects, fading eaten cells), adaptive quality
- `src/input`, `src/ui`, `src/game.ts` — input, HUD/menu, arcade HUD (minimap, banner, home arrow), home/lap tracker, lazy sound, game loop
- `ai/summary.md` — how the game is built and why, measured budgets, and open items

## Initial setup

```bash
npm create vite@latest . -- --template vanilla-ts
claude --dangerously-skip-permissions
```

## License

MIT — see `LICENSE`.
