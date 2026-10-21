# Cell
**Play at <https://c0.muon.day/>**

Bacteria eating bacteria on a sphere: a browser game against NPC colonies, alone or with a friend. Eat pellets and smaller cells,
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
[Country flags](#country-flags)). The menu links to this repository and to more games on [Muon.Day](https://muon.day).
The bottom-right corner shows the build's version: `v.` and the first 4 characters of the commit it was built from
(`v.dev` on the dev server).

Up to eight players can share one world through a [p3p2](https://p3p2.me) server: see [Playing with friends](#playing-with-friends).

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
| `npm test` | Unit tests (Vitest): sphere math, rules, mechanics, virus pop pieces, lap test, NPC arena smoke test, big NPCs keep exploring, leaderboard rows, ink palette contrast and resident inks, jelly membrane, maze generator/walls, maze food and rainbow spores, rainbow explosions, packing (escape field, overgrown cells get out), path flood + resident phages, home/lap cues, adaptive quality (no flip-flopping at 60/120/144 Hz), NPC countries by population, the country lookup chain, arcade points (own cells merging back score nothing), the autoplayer (it sees only the screen, flees, chases, splits only when safe, moves like a hand, plays the same game twice) |
| `npm run e2e` | Playwright e2e (menu → play → eaten → respawn, arcade HUD, paper floor in and out of mazes, a rainbow explosion, the press stock, country flags with a stubbed Cloudflare trace, the GitHub and Muon.Day links, the menu on small screens, the version label, no blank frame on a quality change) on desktop + phone viewports for the `arcade` and `base` presets, using system Chrome. With a p3p2 checkout, also friends in one world through a local server: one world, starting near a friend, eating and being eaten, the host leaving, a reload, a bad connection, a phone, a full world, the room's rules |
| `npm run e2e:engines` | Chrome, Firefox and WebKit in one room, with the same mazes tile for tile (Playwright's own Firefox and WebKit: `npx playwright install firefox webkit`; WebKit on Linux also needs `sudo npx playwright install-deps webkit`) |
| `npm run p3p2` | A local p3p2 server for trying friends on one machine (see [Playing with friends](#playing-with-friends)) |
| `npm run flags` | Rebuild the flag atlas (`src/assets/flags.webp` + `flagIndex.ts`) from `flag-icons` with system Chrome; the output is committed |
| `npm run size` | Initial-load gzip budget check (run after `build`) |
| `npm run bench` | Load time (Slow 4G) + render frame times on the local GPU for the `plains`, `maze` and `rainbow` scenes, `--cpu 4` for a low-end proxy, `--scene maze` for one scene, `--zones 2` for a room's host with players in two districts (run after `build`) |
| `npm run autoplay` | The autoplayer in Node, faster than real time (see [Autoplay and recordings](#autoplay-and-recordings)): `-- run --seed 3`, `-- batch --seeds 1-200` (statistics; `--driver npc` for the NPC-brain baseline), `-- tune --seeds 1-200 --holdout 1001-1200` (tune the brain for its mass at 5:00) |
| `npm run record` | Plays the built game in Chrome with the autoplayer and records it frame by frame: `-- dry`, `-- search`, `-- pilot`, `-- youtube`, `-- watch` (run after `build`) |
| `npm run cut` | The finished videos and their text from the recordings: `-- youtube`, `-- short --seed N`, `-- x` |
| `npm run arena` | Headless NPC arena, per-personality stats and exploration (30 s windows per radius bucket: share of windows where a cell ended less than 3 r from its start, and turn-rounds per think): `-- --minutes 10 --R 4000 --seed 1`; `-- --preset arcade` adds mazes, resident phages, rainbow spore, explosion and packing metrics (R 16000); `-- --cfg botTurnCost=0.2` overrides numeric config for tuning; `-- --observers 8` simulates in full around 8 districts, as a room's host would |

## Autoplay and recordings

The autoplayer plays the real game the way a person does, for making videos:

- **It sees only the screen.** Its brain (`scripts/autoplay/brain.ts`) gets a snapshot of what a player sees
  (`snapshot.ts`): the cells and food on screen, the minimap's spores, the leaderboard. It knows the mazes, which are the
  same every game, and remembers what it saw a moment ago. It never reads off-screen cells, NPC minds or the world's
  random numbers.
- **It plays to be as big as possible at the end of 5 minutes**, and a death throws the run away: it weighs every
  heading by the mass it would gain against the mass it would risk, splits onto prey only when nothing could eat the
  halves, and times rainbow spores for when big cells are near. All its numbers are in `BrainParams`, tuned with
  `npm run autoplay -- tune`.
- **It moves like a hand** (`hands.ts`): a 150–260 ms reaction, Fitts's-law reaches that swing around the cell, smooth
  pursuit with a little tremor, Space held 60–110 ms and at most about five presses a second; on a phone, one thumb
  drags and the other taps Split. Input goes to Chrome as real mouse, keyboard and touch events.

`npm run record` plays the built site in headless Chrome on the GPU and owns the page's clock: every frame is drawn in
full, captured and piped to ffmpeg (x264, BT.709), and the sound is rendered offline in step with the frames. A dry run
(no capture, no rendering) predicts the run; a recording replays the same seed and must match the dry run's state hash
every second. Recordings are big: `--out` points the output at another drive (it must exist), and the default
`recordings/` is ignored by git.

```sh
npm run build
npm run autoplay -- tune --out /path/to/recordings/tune         # tuned parameters → tune/params.json
npm run record -- search --seeds 1-200 --out /path/to/recordings
npm run record -- youtube --seed 42 --out /path/to/recordings   # the 5-minute master, checked against its dry run
npm run cut -- youtube --out /path/to/recordings                # youtube.txt, chapters, thumbnails
npm run record -- search --profile short --seeds 1-100 --out /path/to/recordings
npm run cut -- short --seed 17 --out /path/to/recordings        # the Short, re-recorded by touch from its dry run
npm run cut -- x --out /path/to/recordings                      # a 16:9 cut for X
npm run record -- watch --seed 42                               # see it play, in a window, in real time
```

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

## Playing with friends

Through [p3p2](https://p3p2.me) (`@p3p2/client`): rooms, invite links and chat through a small server of your own. Alone,
the game is what it was: the page loads p3p2's 2 KB entry and asks no server anything. The room's code loads when a room
is opened.

- **Hosting.** You need a room URL from a p3p2 server. [p3p2.me](https://p3p2.me) explains both ways to get one: its
  hub makes a free temporary server (one room, up to 5 people, for an hour), or you can run your own. The room's game
  URL is the address you play at (`https://c0.muon.day/`). Type your name, press **Play with friends**, paste the
  room URL, press **Create the invite link** and send the link.
- **Joining.** Whoever opens the invite is asked on the menu, *Join ‹room›?*, and joins with the name they typed
  there (or plays alone). They start by looking where the host looks, and PLAY puts their colony near a friend.
- **One name.** The name on the menu is the one the room knows, in p3p2's panel and chat too. p3p2 has no renaming,
  so in a room the name can't be changed until the room is over. The panel (invite link, QR code, who is here, chat)
  shows only in a room: press **Friends**.
- **One world, on the host's page.** The host's page runs the world, in full around every player. Each guest's page
  draws what the host sends it, 12.5 times a second, and sends where it steers 25 times a second.
- **A guest's own cells answer the mouse at once.** A guest's page moves its own cells itself, with the world's own
  movement and walls, and the host's views put them right (client-side prediction). Through 90 ms each way they
  answer in about 50 ms instead of about half a second. Eating, splits and everything else are still the host's, a round
  trip later; the pellets under a guest's cells go at once, and come back if the host never took them.
- **Eight players at once, and anyone can watch.** The host's cost grows with how far apart the players are. On a
  low-end device (4× CPU throttling), eight in eight districts take the host's frame from 30 ms to about 41 ms: the
  world keeps real time, at a lower frame rate. Friends who stay together cost about what one player costs; see
  `MAX_PLAYERS` in `src/net/Net.ts`. Anyone else in the room watches a friend who plays, and can play once a place is
  free. A hub room takes 5 people; a server of your own takes 16 by default.
- **When the host goes**, the next player carries the world on from the host's last save (every 5 s), with new
  food. A reload comes back to the room, and PLAY gives your colony back.
- **One set of rules.** The first page in a room sets its rules (`?preset=`, `mapSeed`, `sphereRadius` and the
  like). A page opened with other rules reloads into the room's. Builds of different commits are kept in different
  rooms.

A p3p2 server sees the addresses of the players in a room, and only once a room is opened.

### Trying it on one machine

The server is one Node.js process (no Docker needed), started from a checkout of
[doublependu/p3p2](https://github.com/doublependu/p3p2):

```sh
git clone https://github.com/doublependu/p3p2 ~/Repos/p3p2 && (cd ~/Repos/p3p2 && npm ci --workspace server)
npm run p3p2                 # a server on port 8080, its database in memory; prints the portal and its password
npm run dev -- --host        # the game on this machine's LAN address
```

In the portal, create a room for `http://<LAN address>:5173/`. Paste its room URL into **Play with friends**, and
open the invite in another browser or profile (two tabs of one profile are one player), or on a phone on the same
Wi-Fi. `P3P2_DIR` points at another checkout. `npm run p3p2` also prints how to put p3p2's lag proxy in between.

`npm run e2e` starts a server like this for each multiplayer test; without a checkout those tests are skipped.

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
| `bench` | `?bench=1&seconds=30&mass=20000&scene=maze&zones=2` | Autopiloted perf run (`plains`, `maze` or `rainbow` scene; `zones=N` simulates in full around N districts, as a room's host would); results in `window.__bench` |
| `manual` | `?manual=1` | No rAF loop; drive frames with `__game.advance(ms)` (automation) |
| `room` | `?room=…` | A p3p2 invite: the page asks *Join?* (p3p2 builds these links) |

## Layout

- `src/sphere` — unit-sphere math, tangent frames + azimuthal equidistant projection, 3D hash grid, icosahedral lattice
- `src/maze` — 12-region layout, seeded symmetric maze generator, district charts with exact great-circle walls (collision, clearance, escape radius, reachability labels, outlines), path flood / A*
- `src/sim` — DOM-free simulation (25 Hz ticks): world, rules, cells, food (pellets, rainbow spores — `POWER` food in the code), species, active/dormant population, packing in mazes, arcade rules (maze food spots and regrowth, spore respawn, rainbow explosions)
- `src/ai` — NPC controller (context steering with a turning cost, wander goals and a progress detector so big NPCs keep exploring; personalities, maze routing), resident phages (`ghost.ts`), population
- `src/render` — sphere camera (district alignment), Canvas 2D renderer (background patterns, cached static layer with walls/borders/emblems, pellets, spore orbs, jelly membranes, rainbow cells, explosion effects, fading eaten cells, lazy country flags), adaptive quality
- `src/geo` — NPC countries by population, the player's country lookup
- `src/net` — friends in one world through p3p2: the host's world and what it tells each guest, a guest's page drawing it, the save a new host carries on from (`Net.ts`), a guest's own cells moved on its page (`predict.ts`), bytes on the wire (`wire.ts`), the room's rules (`rules.ts`)
- `src/assets` — the generated flag atlas and its index
- `src/input`, `src/ui`, `src/game.ts` — input, HUD/menu, arcade HUD (minimap, banner, home arrow), home/lap tracker, lazy sound, game loop
- `ai/summary.md` — how the game is built and why, measured budgets, and open items

## Initial setup

```bash
npm create vite@latest . -- --template vanilla-ts
claude --dangerously-skip-permissions
```


