# bac: project summary

This summarises the design and state of the game up to its public release: what it is, how it is built, why it is built
that way, what was measured, and what is still open. New prompts, plans and summaries in `ai/` build on this file.

## 1. What bac is

A single-player browser game. You are a bacterium on the surface of a sphere, among about 800 NPC colonies.

- **Basic moves.** Eat pellets and smaller cells to grow; bigger cells eat you. Split (Space) to lunge at prey, eject
  mass (W) to feed or bait. Viruses burst cells that are too big.
- **No edges.** The world is a sphere, so there are no borders and you can walk all the way round it.
- **Mazes.** The default `arcade` preset adds twelve maze districts, one per region of the sphere. They have corridor
  food, rainbow spores and resident phages, and landmarks so you know where you are.
- **Look.** Everything is drawn like a risograph print.

It is a static site (Vite + TypeScript, no runtime dependencies) and needs no server.

## 2. Spec and budgets

From the project brief (`CLAUDE.md`):

- **Load.** Initial load, meaning time to user interaction, in 2–3 s on an average connection. 1 s is great; 4 s is the
  absolute maximum. Loading more later is fine.
- **Devices.** It must play well on an average PC from the last 3 years without a dedicated GPU, and on entry-level
  phones and touch devices from the last 3 years.

How the code keeps to that:

| Budget | Check | Last measured |
|---|---|---|
| Initial load ≤ 60 KB gzip (warn above 40 KB) | `npm run size` | See §8 |
| Load to an interactive menu on Slow 4G (150 ms RTT, 1.6 Mbps), cold cache | `npm run bench` | See §8 |
| Frames at 60 fps on an integrated GPU; ≤ 33 ms p95 at 4× CPU throttling as a low-end proxy | `npm run bench -- --cpu 4` | See §8 |
| Sim tick well under the 40 ms tick at full scale | `npm run arena` | See §8 |

What keeps the initial load small:

- **Lazy loading.** The debug panel, bench harness, sound and minimap load later, as lazy chunks.
- **No asset files.** Fonts are the system's, the favicon is inline SVG, and every sound is synthesised.
- **A plain DOM menu.** It is interactive before the game canvas is busy.

## 3. Architecture

| Folder | What lives there |
|---|---|
| `src/sphere` | Unit-sphere vectors, tangent frames and the azimuthal equidistant projection, the 3D hash grid, the icosahedral lattice |
| `src/sim` | The DOM-free simulation: world, rules, cells, food, species, active/dormant population, packing, arcade rules |
| `src/maze` | Region layout, maze generator, district charts and walls, path flood / A* |
| `src/ai` | The NPC controller, personalities, resident phages, population |
| `src/render` | Sphere camera, Canvas 2D renderer, cached static layer, membranes, effects, palette, adaptive quality |
| `src/input`, `src/ui`, `src/game.ts` | Pointer/touch/keyboard input, HUD and menu, minimap, home cues, sound, the game loop |
| `src/config` | Every tunable in one `GameConfig`, in three presets (§4) |

The key decisions, and why:

- **A real sphere, drawn flat.**
  - Positions are unit vectors, and world distance is `R ×` angle (default R = 16 000; one lap is 100 531 units).
  - The camera carries a tangent frame along as it moves and projects around its centre (azimuthal equidistant), so
    cells never distort on screen.
  - The frame is parallel-transported, so "hold one screen direction" really brings you back to the start. The lap
    test checks this to within ~3 units.
- **A fixed 25 Hz simulation, with interpolated rendering.** The sim runs in 40 ms ticks. The renderer interpolates at
  display rate, and the membrane wobble steps at a fixed 60 Hz, so behaviour doesn't depend on frame rate. The sim has
  no DOM, so the same code runs in the browser, in tests and in the Node arena.
- **The active zone.**
  - Only a cap of 8 000 units around the camera, about one screenful of play area in all directions, is simulated in
    full: about 50–60 NPCs.
  - The other ~750 NPCs are dormant. They graze at an expected rate, decay, wander, and settle rare fights statistically.
    They wake up when the zone reaches them.
  - The leaderboard ranks the active zone only: ranking all 804 NPCs put the player at #83–#196.
- **The 3D hash grid over surface points.** A query scans only the buckets the sphere's shell passes through. Bucket
  sizes were tuned by profiling: food 512, small cells 1 024, big cells 4 096.
- **Food is stored as struct-of-arrays.** That covers about 87 000 pellets in `arcade` (73 449 in the plains + 13 727
  maze spots) and 112 595 in `base`, with no per-frame allocations.
- **Canvas 2D, not WebGL.** It is enough for flat inks and keeps the bundle small.
  - Adaptive quality watches the rolling p95 frame time and steps between levels 0 and 6. The order is: grain off →
    lower resolution → fewer membrane points and effects → no contact and wall dents → no jelly and minimal effects →
    grid off.
  - Walls, region borders, the floor grid and junction emblems are drawn into a cached static layer. It is redrawn
    only when the camera has moved or zoomed enough.
- **Lazy maze generation.** Districts are generated in idle time, nearest first (about 10 ms each).

## 4. Rules

### 4.1 Presets
- **`base`** holds the reference rules.
  - Eating needs 1.14× the prey's radius, and the prey must be swallowed to `R − r/3`.
  - Speed is `2.1106 / r^0.449 × 40` units per tick.
  - Split at r ≥ 60, up to 16 cells, with a 30 s merge timer (longer for big cells).
  - Eject costs 20.25 mass and fires a 16-mass pellet.
  - Decay is 0.2 %/s.
  - Viruses burst big cells, and grow and shoot when fed.
  - Densities are set per reference area (2·10⁸ units²) and scaled to the sphere.
- **`tuned`** starts equal to `base`. It is the place for single-player tuning, each override with its reason.
- **`arcade`** is `tuned` plus the mazes. It is the default.

### 4.2 Mazes (arcade)
- **Layout.**
  - Twelve regions sit around the icosahedron's vertices. Each has an ink, a name and a fruit emoji, with a district at
    its centre.
  - The layout comes from `mapSeed` (default 1), not the world seed, so the same mazes appear every game. That helps
    recognition.
- **Districts.**
  - Each is a seeded, left-right symmetric maze on an equiangular gnomonic chart, 70 fine tiles of 140 units (9 800
    units) across.
  - It has a core of pillars around a central pen, corner pockets, coarse corridors, an 8-tile avenue ring and a
    perimeter wall.
  - Corridors come in three width classes (fine, coarse, avenue), so each class admits cells up to a certain size.
- **Walls.**
  - Walls are exact great-circle segments, queried from the tile grid rather than stored as edges.
  - A move may never leave a cell with less wall clearance than before. Without this rule, pushes from two gate corners
    cancelled and let too-wide cells slip through.
  - Fast movement is substepped near walls. Squeezing into a narrow corridor slows a cell.
- **Maze food and spores.**
  - Maze food is an ordinary pellet kept on the corridor lines. Plains and mazes share one food pool with regrowth.
  - Each district has 12 rainbow spore spots (4 in the corner pockets, 4 in coarse corridors, 4 on the avenue). A spore
    respawns 15 s ± 25 % after it is eaten.
- **Rainbow.**
  - A spore makes a cell rainbow for 8 s.
  - A rainbow cell explodes any bigger cell it touches. The pieces stay with their owner: about half are crumbs the
    exploder can eat at once, and the rest are chunks of at most ⅓ of the mass, which can be exploded next.
  - A rainbow cell eats any smaller cell. Fresh pieces have a short grace period.
  - An organism can have up to 48 cells. At that cap a touch knocks the rainbow cell back instead.
- **Resident phages.**
  - Four per district: T4, Lambda, Phi and Mu, in navy, purple, lime and emerald. Two are small (mass 30) and two are
    mid-size (mass 400).
  - They have fixed mass, move ×1.25 faster, never split or eject, don't eat food, and can pass the pen door.
  - They cycle between scatter (to a corner, 7 s) and chase (20 s). Each chases in its own style: straight at the prey,
    ahead of it, flanking, or shying away when close.
  - They flee smaller rainbow cells.
  - They path with A* on their own per-tick budget, and respawn 5 s after being eaten.
- **Packing.**
  - A cell in a maze is never bigger than the widest way out from where it is. Each tile has an escape radius: the
    biggest cell that can travel from it to the open plains, computed by relaxation sweeps (0.6 ms per district).
  - Mass beyond that is packed. It still counts for score, being eaten, explosions and decay, and it comes back at up to
    4 % of radius per tick once there is room.
  - This fixed cells that grew inside a corridor and could never leave.
- **Camera in mazes.** Inside a district the camera zooms out (×0.6, ×0.45 on portrait screens) and turns to the
  district's "up". Corner assist bends a heading within 60° of a corridor into it.

### 4.3 NPCs
- **Steering.** Context steering over 16 directions in the NPC's local chart. Food, prey, threats, viruses and spores
  add interest or danger, and the best slot wins.
  - **Turning costs** a share of the field's peak, so a weak field doesn't flip direction every think.
  - **Pellets matter less to big cells.**
  - **A weak field starts a held wander goal:** a far reachable tile in a district, a far point in the plains.
  - **A progress detector** catches cells that walk a lot and get nowhere. A path-length detector catches cells wedged
    against walls.
- **Actions.** Chase with target leading, split-kill (only when no virus is near the prey), split-escape, and virus
  feeding.
- **Personalities.** Grazer, hunter, survivor, scavenger and trickster, each a weight preset plus a set of allowed
  actions.
- **Difficulties.** Easy, normal and hard change the think rate, aim noise, perception and mistake rate.
- **In and near mazes.** Directions and distances come from a radius-aware path flood (Dijkstra over tiles with enough
  clearance, at most 12 floods per tick). Threats only count when they fit the corridors between them and the NPC. A
  maze lure draws NPCs small enough for a district's corridors into it.

### 4.4 Virus pop
A cell that eats a virus bursts into pieces flying off in random directions (`popPieces` in `rules.ts`).

- With one free slot, it splits in half.
- Otherwise it makes a few shrinking chunks (the first 15–22 % of the cell, each next 45–60 % of the one before), then
  crumbs of three start cells, in every slot that's left.

## 5. Look

- **Twelve spot inks,** addressed by hue. Each region hue is a slot × 30°. Inks that can meet at a region border differ
  by ≥ 15 L\* and stay apart under deuteranopia. The junction emblems also show region numbers, so colour isn't the
  only cue.
- **Two stocks.**
  - **Paper** (`#f7f4ec`) with a dark key (`#241f1c`) is the default.
  - **Press** is dark stock with the key inverted (`?theme=press`).
  - A district's ink is screened lightly over the floor, which carries a dot grid.
- **Cells** are flat ink with a key outline and paper-lettered names. Pellets are flat ink squares, batched per ink.
  Viruses are a green disc with a ring of key notches.
- **Walls and emblems** are a key tube with the region's ink printed 2 px × zoom out of register, drawn on the cached
  layer, so it costs nothing per frame. Packed mass shows as a halftone band inside the rim.
- **Paper grain** is a 128² speck tile at alpha 0.09. It is on only at quality 0 and is the first thing adaptive quality
  drops.
- **The jelly membrane.**
  - Each drawn cell is a ring of points (about one per screen pixel of radius), stepped at 60 Hz as a damped wave:
    tension spreads bumps around the rim, a spring pulls each point back to the true radius, and noise keeps it alive.
    Rainbow cells wobble more.
  - Touching rims dent a little and spring back.
  - Rims are squashed against maze walls.
  - Cells under ~20 px on screen are plain circles.
- **The HUD** is plain DOM with paper panels, key borders and flat offset ink shadows.
  - The leaderboard shows the top 10 plus your own row, each with its mass.
  - The arcade HUD shows points, high score, a rainbow bar, a district banner, toasts, a globe minimap and a home arrow.
- **Sound** is WebAudio oscillators and one noise buffer, loaded on the first Play: chomp, rainbow loop, explosion, and
  swell.

## 6. Tools

- **`npm test`:** Vitest unit tests.
  - Sphere maths, the lap test, rules and mechanics, virus pop pieces, the membrane.
  - Maze generator invariants on 30 seeds, walls, gating and tunnelling.
  - Path flood and residents, maze food and spores, rainbow explosions, packing, home cues, leaderboard rows.
  - Ink contrast and resident inks, an NPC arena smoke test, and "big NPCs keep exploring".
- **`npm run e2e`:** Playwright on the production build with the system Chrome, on desktop and phone viewports, for the
  `arcade` and `base` presets. It covers:
  - menu → play → eaten → play again
  - the arcade HUD
  - the floor inside and outside a maze
  - a rainbow explosion
  - the press stock
- **`npm run arena`:** the headless NPC arena in Node, faster than real time. It reports per-personality outcomes and
  30-second exploration windows per radius bucket. With `--preset arcade` it adds maze, spore, explosion, resident and
  packing metrics. `--cfg key=value` overrides numbers for tuning.
- **`npm run bench`:** load time on Slow 4G, and render frame times on the local GPU for the `plains`, `maze` and
  `rainbow` scenes. `--cpu 4` gives a low-end proxy.
- **`npm run size`:** the initial-load gzip budget.
- **`?debug=1`:** the debug panel. It has stock toggle, background pattern, zoom, membrane toggles, sphere radius and maze
  toggles. It can teleport, turn you rainbow, bring a big NPC or feed +50. It has an escape radius overlay, an NPC goals
  overlay and live stats.
- **Automation.** `?manual=1` with `__game.advance(ms)` gives deterministic frames.

## 7. History

| # | Iteration | What it added or fixed |
|---|---|---|
| 0 | Core game | The sphere, camera and lap test; the sim with split, eject, merge, viruses and decay; jelly membranes; NPCs with personalities and the active/dormant population; touch controls; adaptive quality; size, bench and arena tools |
| 1 | Mazes | Twelve regions and districts, exact great-circle walls, the seeded generator, resident NPCs with path finding, NPC maze routing, region landmarks, home cues, globe minimap, sound |
| 2 | One food and rainbow | The paper floor everywhere; maze food became ordinary pellets on corridor lines; spores and the rainbow state; explosions with pieces that stay with their owner |
| 3 | Packing | Cells can always get out of a maze: the escape field, packed mass, the swell |
| 4 | Leaderboard, NPC exploring, riso | Mass on every leaderboard row; turning cost, food weighting, wander goals and a progress detector so big NPCs stop jittering; the risograph look on both stocks |
| 5 | Public release | Neutral names (`base` preset, per-reference-area densities); the membrane dynamics and the virus pop rewritten as our own implementations; the split, eject, glide and eating code and its config names restructured in our own terms; resident phages with their own names and inks; this summary |

## 8. Measured

Measured at the public release (2026-09-24) with headless Chrome on the local GPU (ANGLE/EGL; this run used an NVIDIA
RTX 3060, earlier iterations an Intel RPL-P integrated GPU with similar frame numbers) and Node for the arena.

- **Initial load:** 48.6 KB gzip, with lazy chunks of 0.8–2.7 KB (debug, bench, audio, minimap). That is inside the
  60 KB budget and over the 40 KB target.
- **Load to an interactive menu, Slow 4G, cold cache:** 0.69–0.73 s at 1× CPU and 1.00–1.05 s at 4× CPU. The spec asks
  for 2–3 s.
- **Render, frame p50 / p95 (ms):**

  | Scene | 1× CPU | 4× CPU |
  |---|---|---|
  | plains, 1080p desktop | 16.7 / 24.0 | 16.7 / 24.5 |
  | plains, 412×915 phone | 16.7 / 23.9 | 16.6 / 24.2 |
  | maze, 1080p desktop | 16.7 / 24.1 | 16.8 / 24.0 |
  | maze, 412×915 phone | 16.6 / 24.5 | 16.7 / 23.7 |
  | rainbow, 1080p desktop | 16.7 / 24.6 | 16.5 / 27.3 |
  | rainbow, 412×915 phone | 16.7 / 26.8 | 16.7 / 27.0 |

  - p50 is vsync-bound.
  - The p95 frame time is about 24 ms in every scene. The 4× CPU budget (≤ 33 ms) is met.
  - Per-frame JS for background, food, cells and drawing is 0.1–1.7 ms each.
- **Sim, Node, 10 min:**
  - `arcade` (R 16 000, 804 NPCs + 48 residents): tick avg 0.69 ms, p95 1.15 ms.
  - `base` (R 4 000, 50 NPCs): tick avg 0.45 ms, p95 0.56 ms.
- **Tests:** 118 unit tests and 6 e2e runs, all passing.

## 9. Open items

- **Look.** Nobody has yet judged the riso look by eye, or compared the new membrane wobble with the old one.
- **Real devices.** No real entry-level phone has been tried. The grain on a tiled mobile GPU is unmeasured.
- **Frame p95** is about 24 ms in every scene, even at 1× CPU (p50 is vsync-bound at 16.7 ms). The 4× CPU budget
  (≤ 33 ms) is met.
- **The bundle** is over the 40 KB target, though inside the 60 KB budget. Lazy-loading the arcade HUD is the next
  saving.
- **NPC exploring, missed targets.**
  - In `arcade`, r 300–400 cells are still stuck in about 18 % of 30-second windows, in coarse-corridor pockets. A wander
    goal from the escape field instead of the capped flood may fix it.
  - In `base`, r 400–600 cells are stuck in 16 % (target ≤ 10 %).
  - The progress detector fires 84–123 times per 10-minute run (target ≤ 25).
- **Fewer NPC fights** since the turning cost (`botTurnCost`, 0.35; 0.15 is in between).
- **Rainbow chains** still reach the 48-cell cap. Ideas: fewer pieces as a victim's cell count grows, and rainbow NPCs
  dropping a target that bounced.
- **UI ideas not done.** Retitle the leaderboard, move the score into the arcade HUD, rework the menu layout.
- **Deploy.** Static hosting with brotli and immutable asset caching has not been set up.
