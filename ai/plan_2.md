# Plan 2: friends in one world (p3p2), a Muon.Day link, and the version on screen

This plan answers `ai/prompt_2.md`:
1. multiplayer through a p3p2 server, with `@p3p2/client` from npm, and a link to p3p2.me for the player who sets up
   the room;
2. a "more games on Muon.Day" link on the loading page and the pause screen;
3. the build's version, `v.<first 4 characters of the deployed commit>`, in an unused corner.

Nothing here is implemented yet.

## How I read the prompt

- **Multiplayer, "use this as a reference".** `~/Repos/p3p2_test_repos/cell` is a fork of Cell at `itr 0`, on a
  branch `p3p2`. Multiplayer was built and tested there in October; see its `ai/p3p2_plan.md` and
  `ai/p3p2_next.md`. This plan brings that work onto today's `main` instead of designing it again. Then it fixes what
  the fork left open, and what plan 1 changed underneath it. The fork's reasons for running one world on the host's
  page still hold (§1.2).
- **"Player 1"** is whoever sets up the room. They need a room URL from a p3p2 server before anything else, so the
  p3p2.me link sits next to the button that opens the multiplayer panel.
- **"Loading page and pause screen".** Cell has one overlay: the menu.
  - It is in `index.html`, so it is the first thing painted while the script loads. Once the script runs, the
    attract-mode world plays behind it.
  - It comes back after every death.
  - There is no pause screen. Plan 0's Q&A dropped the Esc pause, and a shared world can't pause anyway.

  So the link goes on the menu, which serves as both screens (open question 1).
- **"The deployed git commit"** is the commit the build was made from. Cloudflare's git builds set
  `WORKERS_CI_COMMIT_SHA`, and a local `npm run deploy` reads `git rev-parse HEAD`. Bubbler already does this
  (`~/Repos/bubbler/vite.config.js`, `#ver` at the bottom right), and Cell will do it the same way.
- **"If needed, create a local server for testing".** It is needed. The fork's multiplayer tests lived in p3p2's own
  e2e suite (`e2e/tests/games/cell.spec.ts`), and that file isn't in the public p3p2 repository. Cell gets its own
  tests, against a server started from a p3p2 checkout.
- **p3p2 itself is not changed here.** A p3p2 bug found along the way goes into `next_2.md`, for the p3p2
  repository.

## What I checked while planning

| | Found |
|---|---|
| `@p3p2/client` on npm | 0.1.1 (latest), MIT, no dependencies. The entry is 1.9 KB gzip on every visit; the room client (8.9 KB), panel (5.3 KB) and QR code (2.6 KB) load when a room is opened. It has everything the fork used: `sendEach`, `room.limits`, `host-change`, `member-state`. |
| The fork's history | It branched at `de0cb37` (itr 0). `1c087bf` is the maze shuffle fix, which `main` has had since plan 1 (bug 3). `176ad3c` is the multiplayer work: `src/net/Net.ts` and `wire.ts` (1,250 lines) plus about 200 lines in game files. Then come three client bumps of a vendored `vendor/p3p2-client.tar.gz` (version 0.0.0). |
| A trial port, in a scratch clone (not this checkout) | `176ad3c` applies to `main` with no conflicts. With the npm client, `tsc` has **one error**: the `eat` event that `Net` decodes lacks `preyOrg`, which plan 1 added. With a stub for it: 156 of 156 unit tests pass, and the initial load is **52.9 KB gzip** (50.3 KB today; budget 60 KB). The lazy chunks are Net 6.7 KB, p3p2-core 8.1 KB, panel 4.9 KB, QR 2.0 KB. |
| A server without Docker | Docker isn't installed here. A p3p2 checkout needs only `npm ci --workspace server` (9 packages, 9 s). Then `node server/src/main.ts`, with `P3P2_DATA_DIR=:memory:`, `P3P2_OWNER_PASSWORD`, `P3P2_PORT` and `P3P2_PUBLIC_URL`, serves the portal on Node 24. |
| Playwright browsers | Only the system Chrome; Playwright's Firefox and WebKit are not installed (open question 3). |
| p3p2.me | Its docs for players, game developers and server owners. Rooms are made in a server's portal. **hub.p3p2.me** makes a free temporary server: one room of up to 5 players, for up to 60 minutes, with no sign-in. |
| muon.day | Lists Cell ("Big cell eats small cell, on a sphere", c0.muon.day), with Bubbler, Ink Raid and country road. |
| The corners | Top left: the minimap and mute button (arcade). Top right: the leaderboard. Bottom left: the score box and the arcade HUD. **Bottom right: free on desktop.** On touch it holds Split and W while playing, 16 px from the edges. |

## 1. Friends in one world

### 1.1 How it works (the fork's design, kept)

| What | Alone | In a room |
|---|---|---|
| The world (colonies, food, viruses, mazes, phages) | The page | **The host's page.** The zone simulated in full (8,000 units) is kept around every player (`World.observers`), not only around the host's camera. |
| What a player wants (pointer, splits, ejects) | The page | Sent to the host 20 times a second (`in`), and at once for a split or an eject |
| What a player sees | The world | **What the host sends that player**, 12.5 times a second (`v`): the cells and food within sight, and what happened there. It goes out in one `room.sendEach`, which the server counts once, whatever the number of guests. |
| The mazes | Built from `mapSeed` | Built from `mapSeed` on every page, the same everywhere since plan 1 |
| The leaderboard | The page's active zone | The host's, once a second |
| Score, trail, home arrow, sounds | The page | The page, from what it is sent |
| The host goes | | The next player builds the world from the host's last save (`sv`, every 5 s, packed and sent in parts) and carries on. Food is grown again from the seed. |

The fork's decisions stand:
- each player gets a random hue and has their name on their cells;
- being eaten works as it does alone: back to the menu, and PLAY puts you back in the same world;
- the leaderboard lists everybody near any player;
- there is no pause;
- at most eight players (open question 2).

An ordinary visit loads the 1.9 KB entry and asks no server anything.

### 1.2 Why not every page running the same simulation

- `Math.sin` and `Math.cos` differ in the last bit between engines. Plan 1 measured it between Chrome 155 and Node 24,
  and runs part within a second.
- Each page builds the districts in its own idle time, nearest first, and the food grows from what has been built. Two
  pages differ from the first second.
- The state (about 87,000 pellets and 850 organisms) is too big to send round to bring pages back in line.

### 1.3 A local server for testing

- **Clone** `https://github.com/doublependu/p3p2` to `~/Repos/p3p2`, outside this repository (open question 4), then
  run `npm ci --workspace server` there. `P3P2_DIR` points elsewhere.
- **`npm run p3p2`** (`scripts/p3p2.ts`) starts `node $P3P2_DIR/server/src/main.ts` with:
  - an in-memory database and a fixed owner password;
  - port 8080;
  - `P3P2_PUBLIC_URL` on this machine's LAN address, so a phone on the Wi-Fi can join.

  It prints the portal URL and the password.
- **A Playwright fixture** (`tests/e2e/p3p2.ts`) starts one server per worker on its own port (18200 + worker index),
  as p3p2's own tests do. Its helpers are ported from p3p2's `e2e/tests/helpers.ts`:
  - `createRoom`: through the portal's labelled fields;
  - `host`, `join` and `accept`: through the panel.

  Without a checkout, the multiplayer specs are skipped with a message, and the rest of `npm run e2e` runs as before.
- **The lag proxy** is p3p2's `e2e/tools/lag-proxy.ts`, run from the checkout: 150 ms each way, and cut on demand.

### 1.4 Port the fork onto `main`

- **The patch.** Bring in `git -C ~/Repos/p3p2_test_repos/cell diff 1c087bf 176ad3c`, without `vendor/`, `ai/` and
  the lockfile. Apply it with `git apply --3way` to the working tree; nothing is committed. Starting at `1c087bf`
  leaves out the maze fix that `main` already has.
- **What it brings:**
  - `src/net/Net.ts`: the host's side and the guest's side;
  - `src/net/wire.ts`: bytes and deflate;
  - in `Game`: the `GameNet` hooks, `newWorld`, `replaceWorld`, `placed`, `takeEvents` and `spawnPoint`, so that a
    new player isn't spawned on top of another;
  - in `World`: `observers`, `clearCells`, `putCell`, `dropCell`, `reindex` and `idFloor`;
  - `FoodStore.gen` (a counter for each food slot, so the host can tell a guest that a pellet is new);
  - `BotController.phase`, now public;
  - in `main.ts`: `new P3P2(...)`, `Net` lazy-loaded on the first `room` event, and `window.__net` for tests;
  - in `index.html`: the button that opens the panel.
- **The client from npm.** `npm install @p3p2/client` (0.1.1) goes in `dependencies`, in place of
  `file:vendor/p3p2-client.tar.gz`.
- **Vite config.** Add `optimizeDeps: { exclude: ['@p3p2/client'] }`; otherwise the dev server hands the whole
  library to every visitor.
- **The panel options.** `ui: { button: false, chatKey: false }`. Every corner is taken, so the menu's own button
  opens the panel, and Enter keeps submitting the name form.
- **`game.version`** is the build's commit, from §3, in place of the fork's `Date.now()`.

### 1.5 What plan 1 changed underneath the fork

1. **Own merges paid as kills, again.** Since plan 1, an `eat` event carries `preyOrg`, so merging your own cells pays
   nothing (`src/ui/points.ts`). `Net`'s wire format drops that field, which is the one type error.
   - The fix: carry it, mapped like the other organism ids, so the guest's own colony becomes its local player. A
     guest's merges then pay nothing either.
   - Unit test.
2. **Friends would start far apart.**
   - In the fork, every page started in district 1, Cherry Commons, through the `Number(null)` bug that plan 1 fixed.
     So friends always started in the same maze, by accident.
   - Now each page's world seed picks its own start district. The host spawns a guest's colony "near where its page
     looks", which is a random district, up to about 17,700 units from the host: a lap is 100,531.
   - The fix: a guest that comes in looks where the host looks. The first view to a fresh guest carries the host's
     camera centre, and the guest's camera jumps there, so PLAY starts the guest in the host's district or the nearest
     one. It still won't land on top of a player, and not where something big is close (`spawnPoint`'s checks).
   - Open question 6.
3. **Sim changes from plan 1** (`openingAhead` and `slideTo` at corridor openings, the stable maze shuffle) run on the
   host. Nothing to carry over.
4. **The frame loop.** `Game.frame` moves its world step into `takeEvents`, and draws a guest's frame from `Net`. The
   Node harness (`scripts/autoplay/sim.ts`) mirrors the solo path. §1.10 proves the solo path is unchanged.

### 1.6 What the fork left open

- **The room's rules.**
  - A guest whose page has other rules would draw mazes the host doesn't simulate, or a sphere of another size. That
    covers `?preset=`, `mapSeed`, `sphereRadius`, `maze` and `difficulty`.
  - The first page to come in offers its rules (`room.offer('rules', …)`). A page whose rules differ reloads with
    the room's parameters, as p3p2's docs advise.
- **The player cap.**
  - The fork chose eight but nothing enforced it.
  - The host refuses a PLAY when eight colonies are alive. The guest's menu then says "This world is full: 8
    playing", and the guest can still watch.
  - The number is set by the measurement in §1.8.
- **Spores on a guest's minimap** came from the guest's own maze state, not the host's. The host now sends a bitmap
  of live spores once a second: 12 districts × 12 spots, 18 bytes.
- **A guest in the background** kept steering towards where its pointer last was. Now, when a member is not `here`
  (`member-state`), the host holds that colony's target on its own centre.
- **The host's save** was 78 KB raw and 37 KB packed in the fork, sent in two parts under the server's 64 KB frame.
  Measure it again on today's world, and split it by `room.limits.maxFrameBytes`, not a constant.

### 1.7 The menu

```
            CELL
 bacteria eat bacteria — on a sphere
 [ Rad                          ]
 [            Play              ]
 [       Play with friends      ]     ← opens p3p2's panel; in a room: "Friends · 3"
 Hosting? Get a room URL at p3p2.me   ← new tab
 Steer with mouse or finger · Space split · W eject
 Rainbow spores in the mazes let you explode bigger cells · find your way home
 Fork me on GitHub · More games on Muon.Day       (§2)
 Eaten by … · 12,340 points · peak mass 916
```

- **"Play with friends"** is a `type="button"`, so Enter in the name field still plays. It is styled like the fork's
  `#friends`, as a paper button under the coral Play.
- **The p3p2.me line** is for player 1. The panel asks for a room URL and says nothing about where to get one;
  p3p2.me explains both routes, the free hub and running your own server.
- **In a room**, the button shows how many are here. The panel lists who they are and has the chat.
- **On a phone**, the panel sits in p3p2's default top-right corner, over the leaderboard, and fits a 412 px screen.
  The Split and W buttons are hidden on the menu.

### 1.8 What the host costs

The host's page runs the world for everybody, and the spec includes entry-level phones.
- **Node:** `npm run arena -- --preset arcade --observers N` (a new flag) moves N zone centres around the sphere, each
  in a different district. It reports the tick time, average and p95, for N = 1, 2, 4 and 8. Today's figure for one
  zone is 0.69 ms on average, 1.15 ms at p95.
- **Chrome:** the eight-player e2e test, with the host at 4× CPU throttling. `__net().status()` reports:
  - the tick time and the frame p95;
  - the view bytes per guest per second, and the host's total upload;
  - the save size, raw and packed.
- **Targets:**
  - the host's frame p95 is at most 33 ms at 4× CPU (the low-end proxy from `ai/summary.md`), with the cap reached;
  - a guest's frame p95 is no worse than solo play.
- **If it misses,** the cap comes down until it holds. The fork's "say less to far guests" (a lower view rate for
  guests whose view holds nothing that moves) is the next lever.
- p3p2 picks the host (the first to join, then the longest here), so Cell can't steer the role to the strongest
  device.

### 1.9 Tests

**Unit** (`tests/unit/net.test.ts`, no server):
- Writer and Reader round trip.
- A view of a small world, applied to a guest world, gives the same cells and food.
- A saved and restored world is the same: organisms, cells, ids and tick.
- `RemoteController` counts splits and ejects across the 16-bit wrap.
- `preyOrg` is mapped, so a guest's merge pays 0.
- A differing rules value asks for a reload.

**E2E** (`tests/e2e/friends.spec.ts`, against the fixture's server; each player is its own browser context):

| Test | What it checks |
|---|---|
| Alone | No request to a p3p2 server, and the `Net` and p3p2-core chunks are never loaded. The Friends button opens the panel. |
| Two players | One world: the guest draws the host's cells and food, each where the host has it, within a tolerance and polled. The guest steers its colony. |
| Starting together | The guest's colony starts in the host's district |
| Eating | The guest's pellets score on its own page, and its merges pay nothing. Eaten by the host, the guest's menu says "Eaten by ‹host›", and PLAY puts it back. |
| The host leaves | The next player carries on from the save, with its colony where it was. A third player goes on in that world. |
| A reload | A guest's reload comes back to the room, and PLAY gives the same colony back |
| A bad connection | Through the lag proxy, 150 ms each way and one cut: the guest still steers in the host's world |
| A phone | In by the invite; the panel by touch, and it fits; PLAY by touch; a finger steers |
| Full | The ninth PLAY is refused, with the message on the menu |
| Rules | A guest opened with `?preset=base` is reloaded into the room's rules |
| Eight players | The cost figures of §1.8, printed and saved to `test-results/` |

A test with Chrome, Firefox and WebKit in one room, comparing the districts tile by tile, needs Playwright's own
Firefox and WebKit (open question 3). It is an opt-in project, outside the default `npm run e2e`.

### 1.10 Solo play is unchanged

- **Hashes.**
  - Before any change, record `npm run record -- dry --seed 70` from today's build into the scratch folder. The
    recordings drive isn't mounted, so its `run.json` can't be used.
  - After all the changes, run it again. The per-second state hashes must be identical.
  - That proves a solo game in the browser is the same game, p3p2's entry and the new frame loop included.
- **Tests.** `npm test` and `npm run e2e` (the existing 14) pass.
- **Load.** `npm run size` stays at most 60 KB (expect about 53 KB). `npm run bench` load on Slow 4G stays within 5 %
  of today's 1.39–1.42 s at 4× CPU.
  - The trial build split `vec3` into a 0.7 KB chunk of its own, on the critical path. If the bench shows it costing a
    round trip, keep it in the main chunk.

## 2. "More games on Muon.Day"

- **The link** goes in `index.html`, in the row with "Fork me on GitHub": `Fork me on GitHub · More games on
  Muon.Day`, linking to `https://muon.day`.
  - The row wraps on a narrow panel.
  - It is styled like the fork link, with its own ink underline (amber).
  - It opens in a new tab (`target="_blank" rel="noopener"`), so a click loses neither the game nor a room.
- **Where it shows.** It is static HTML, so it shows at first paint, before any script runs, which makes it the loading
  page's link. The menu comes back after every death, so it is also there between games.
- **E2E:**
  - it is on the menu at load and after a death, with its `href` and `target`;
  - the panel has no horizontal overflow at 320 px wide.

## 3. The version in a corner

- **The number.** `vite.config.ts` reads the commit: `WORKERS_CI_COMMIT_SHA`, then `git rev-parse HEAD`, then
  nothing.
  - The label is `v.` plus the first 4 characters, for example `v.7914`.
  - On the dev server, or with no git, it is `v.dev`.
- **On screen without JS.** A `transformIndexHtml` step fills `%APP_VERSION%` in `<div id="ver">`, so the version is
  there at first paint. `index.html` revalidates on every load (`public/_headers`), so a new deploy shows its own
  version straight away.
- **For p3p2,** `define: { __BUILD__ }` gives `game.version`:
  - the first 12 characters of the commit;
  - with `-<build time>` added when the working tree has uncommitted changes, so two different local builds of one
    commit don't share a room;
  - at most 32 characters, as p3p2 requires.

  The build also prints a warning when the tree has uncommitted changes. The label still shows the commit, which
  isn't exactly what was built (open question 7).
- **Where.** At the bottom right:
  - `right: max(6px, safe-area)`, `bottom: max(3px, safe-area)`;
  - 10 px monospace in the key colour at about 45 % opacity, with `pointer-events: none`;
  - above the menu, so it shows there too.

  On touch, during play, it sits in the 16 px strip under the Split and W buttons.
- **E2E:**
  - the text is `v.` plus the first 4 characters of `git rev-parse HEAD` on the test build;
  - it overlaps none of the leaderboard, score box, arcade HUD, minimap, mute button or touch buttons, on the
    desktop and phone projects.

## Build order

| Step | What | Why here |
|---|---|---|
| 0 | Baselines on today's `main`: the seed-70 dry-run hashes, `npm run size`, `npm run bench` | §1.10 compares against them |
| 1 | The version (§3) | p3p2's `game.version` uses it |
| 2 | The Muon.Day link (§2) | Small and independent |
| 3 | The p3p2 checkout, `npm run p3p2`, the Playwright fixture (§1.3) | Every later step is tried against it |
| 4 | The port and the npm client (§1.4) | |
| 5 | What plan 1 changed underneath the fork (§1.5) and what the fork left open (§1.6) | |
| 6 | The menu (§1.7) | |
| 7 | Unit and e2e tests (§1.9) | |
| 8 | The host's cost; set the cap (§1.8) | Needs the eight-player test |
| 9 | Solo play unchanged (§1.10) | Last, over everything |
| 10 | Docs: the README (Friends: how to host, the hub, a local server, the links, the version); `ai/summary.md` (§1 is no longer single-player only; tools; a history row; measurements); `ai/next_2.md` | |

## Done when

- Two browsers on a local server share one world: the guest steers, eats and is eaten, and PLAYs again. The host
  leaving, a reload, a bad connection, a phone, a full room and differing rules all pass in `friends.spec.ts`.
- Friends start in the same district.
- Solo play is the same game: identical dry-run hashes for seed 70, no p3p2 request and no room code loaded, 156+ unit
  tests and 14 e2e tests passing, size at most 60 KB, and the bench load within 5 %.
- At the cap, the host's frame p95 is at most 33 ms at 4× CPU.
- The menu has Play with friends, the p3p2.me line and the Muon.Day link, at load and after a death, and fits a
  320 px screen.
- `v.xxxx` sits at the bottom right and matches the commit, with `v.dev` on the dev server.
- `npm run typecheck`, `npm test` and `npm run e2e` pass, and the docs are updated.

## Risks

- **A phone as the host** runs the world for up to eight players. §1.8 measures it, and the cap follows. Nobody has
  tried a real entry-level phone (it's still an open item in `ai/summary.md`).
- **The host's upload** on mobile data: views to seven guests 12.5 times a second, plus a save every 5 s. Measured,
  not yet bounded.
- **Steering as a guest** happens a round trip, plus up to 80 ms, after the mouse, with no prediction (as in the fork).
  You will have to judge it by playing (open question 8).
- **When the host goes,** the world jumps back by up to 5 s and the food is new.
- **The hub** gives one room of at most 5 players, for 60 minutes, and whoever runs it can read the traffic.
  Anything lasting needs a server of your own, which p3p2.me explains.
- **https.** c0.muon.day is served over https, so the p3p2 server must be too (wss), or the panel says `mixed`. Local
  tests are http on both sides.
- **The room's game URL.**
  - A room has to list `https://c0.muon.day` as its game URL, and a LAN address for local tries. Any other address is
    refused with `origin`.
  - Every deploy changes `game.version`, so after one, a player on the old build can't join a room of the new build
    until they reload.
- **Mazes across engines.** Plan 1 fixed the shuffle and checked Chrome against Node only. A guest whose browser built
  other mazes would see cells pass through walls. The opt-in engines test covers it.
- **Recordings.** New recordings will show the version label; one CSS rule in the recorder hides it.

## Files

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `@p3p2/client` ^0.1.1 in `dependencies`; `p3p2` script |
| `vite.config.ts` | The commit and version, `%APP_VERSION%`, `__BUILD__`, `optimizeDeps.exclude` |
| `index.html` | `#ver`; Play with friends; the p3p2.me line; the Muon.Day link; their styles |
| `src/build.d.ts` | `__BUILD__` |
| `src/main.ts` | `P3P2`, `Net` loaded lazily, `window.__net` |
| `src/net/Net.ts`, `src/net/wire.ts` | From the fork, plus §1.5 and §1.6 |
| `src/game.ts` | `GameNet` hooks, `newWorld`, `replaceWorld`, `placed`, `takeEvents`, `spawnPoint`; the room status on the menu |
| `src/sim/world.ts`, `src/sim/food.ts`, `src/ai/bot.ts` | From the fork |
| `src/ui/hud.ts` | The Friends button's text, the "full" message |
| `scripts/arena.ts` | `--observers N` |
| `scripts/p3p2.ts` | A local p3p2 server from `P3P2_DIR` |
| `tests/unit/net.test.ts` | New |
| `tests/e2e/p3p2.ts`, `tests/e2e/friends.spec.ts` | Server fixture, helpers, multiplayer specs |
| `tests/e2e/play.spec.ts` | The Muon.Day link and the version label |
| `playwright.config.ts` | The opt-in engines project |
| `README.md`, `ai/summary.md`, `ai/next_2.md` | Docs |

## Open questions (the default I'll use if you don't say otherwise)

1. **A pause screen?** Cell has none: Esc pause was dropped in plan 0, and a shared world can't pause. The menu is
   both the loading page and the screen between games, so it gets the link. **Default: no new pause screen.**
2. **How many players?** **Default: 8**, as the fork chose, lowered if the host's cost misses (§1.8). The hub's free
   servers take 5 anyway.
3. **Install Playwright's Firefox and WebKit** (`npx playwright install firefox webkit`, a few hundred MB under
   `~/.cache/ms-playwright`) for the cross-engine maze test? This kind of bug has already hit Cell once. **Default:
   yes, as an opt-in project.**
4. **Where to put the p3p2 checkout?** **Default: `~/Repos/p3p2`**, next to the other repos; `P3P2_DIR` overrides
   it.
5. **The button's label.** **Default: "Play with friends"** (the fork had "Friends"), with "Friends · 3" in a room.
6. **Where a guest starts.** **Default: where the host is looking, in the host's district.** The alternative is a
   start district the whole room shares, from the room's rules value.
7. **Builds with uncommitted changes.** **Default: the label stays `v.xxxx` and the build prints a warning.** A marker
   such as `v.7914*` would break the template.
8. **Prediction for a guest's own cells** (moving them before the host confirms) is not in the fork, and not planned
   here. **Default: judge the feel by playing first.**
