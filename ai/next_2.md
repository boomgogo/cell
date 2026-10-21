# Next 2: what plan 2 built, what it found, and what comes next

Implements `ai/plan_2.md`:
- friends in one world through a p3p2 server, with `@p3p2/client` 0.1.1 from npm;
- "More games on Muon.Day" on the menu;
- the build's version in the bottom-right corner.

Nothing was committed, deployed or tried with a real friend; those are yours to do.

## What there is

- **Play with friends** on the menu asks for a room URL, and **Create the invite link** hosts with the menu's name
  (below). Under it, "Hosting? Get a room URL at p3p2.me" tells player 1 where a room comes from. In a room, the
  button reads "Friends · 2" and opens p3p2's panel, and a line under the links says
  "In ‹room› · 2 players · Ada runs this world".
- **One world, on the host's page**, as the p3p2 fork (`~/Repos/p3p2_test_repos/cell`, branch `p3p2`) built it.
  - The host's page simulates in full around every player.
  - Guests' pages draw the host's views and send their steering.
  - A save every 5 s lets the next player carry on when the host goes.
  - The fork's commit applied to `main` without conflicts; then come the changes below.
- **At most eight play at once** (below). Anyone else in the room watches a friend who plays, and can play once a
  place is free. A colony whose player is away (a closed page keeps its place for 30 s) holds no place.
- **Friends start together.** A newcomer's page looks where the host looks, and PLAY puts the colony near a friend: in
  a maze, on the free corridor spot nearest them.
- **One set of rules a room.** The first page offers its rules (`src/net/rules.ts`), and a page with other rules
  (`?preset=base`, another `mapSeed`, …) reloads into the room's.
- **The version.**
  - The corner shows `v.` and the first 4 characters of the commit: `WORKERS_CI_COMMIT_SHA` on a Cloudflare git
    build, else `git rev-parse HEAD`, and `v.dev` on the dev server (`scripts/version.ts`).
  - It is in the HTML, so it is there at first paint.
  - The same commit (12 characters) is p3p2's `game.version`, so different builds don't share a room.
  - A build from a tree with uncommitted changes prints a warning, and gives p3p2 a version of its own.
- **The links.** "Fork me on GitHub · More games on Muon.Day" sit on the menu, the loading page and the screen after
  each death. There is no pause screen, as decided in plan 0 (open question 1).

## After the report

You chose two changes.

- **Eight players** (`MAX_PLAYERS`), measured below.
- **One name, the menu's** (`src/ui/friends.ts`). p3p2's panel asks for a name of its own when hosting and in its
  "Join?", and 0.1.1 has no way to leave that field out, so the menu does both, through p3p2's API, as p3p2's rally
  example does:
  - hosting: the room URL on the menu, then `p3p2.host(url, { name })`; the panel opens with the invite link;
  - an invite: `p3p2.peek()` for "Join ‹room› on ‹server›? Hosted by Ada · 1 player" on the menu, where PLAY reads
    Join (Enter too) and Play alone is under it; then `p3p2.join(invite, { ask: false, name })`;
  - with no name, the room's ("Player 3") goes on the menu;
  - in a room the field is read-only (p3p2 has no renaming), so colonies, the panel and chat show one name;
  - the panel shows only in a room (one CSS rule), so it no longer pops up with its own form when a room ends; the
    menu's room line says why ("You were removed from the room.").

  The panel's check of a room URL as it is typed is gone: a bad one is reported when **Create the invite link** is
  pressed. Initial load 54.7 KB gzip (53.6 before).
- **The rainbow at quality 5–6.** You saw a rainbow cell flash random colours. That was not new in plan 2: with
  minimal effects (levels 5–6, when a page is slow) the spinning wheel gave way to a single colour that stepped
  through all 12 inks, navy and plum among them, at a different point on each cell. It now steps through seven rainbow
  inks in wheel order (red, orange, amber, green, emerald, cornflower, purple: the wheel's six and orange), 0.4 s each,
  the same on every rainbow cell and spore at once. Levels 0–4 are unchanged.

## Found and fixed

1. **A guest's own merges paid as kills.** Plan 1 put `preyOrg` on `eat` events, and the fork's wire format
   dropped it. It is carried now, mapped like the other organism ids.
2. **Friends started up to a district apart.** In the fork every page started in Cherry Commons, through the
   `Number(null)` bug plan 1 fixed. With each page's seed picking its own district, two friends started up to
   17,700 units apart, and within a district up to 7,600.
3. **Other players weren't listed as players on a guest's page.** A colony first seen on the leaderboard was made
   there as an NPC, before its own description came. Leaderboard rows now say whether each is a player.
4. **A guest's minimap showed its own page's spores**, not the host's. The host now sends a mask of live spores.
5. **A guest in the background kept steering** to where its pointer last was. Its colony now holds still while the
   page is away.
6. **The menu overflowed a 320 px screen** (347 px wide; this was there before plan 2). It was also cut off on a phone
   on its side. The panel now counts its padding in its width, and the menu scrolls when the panel doesn't fit.

No p3p2 bug was found; p3p2 is unchanged.

## What hosting costs

The plan's target was a frame p95 of at most 33 ms at 4× CPU throttling, with the most players a room allows, in
different districts. The fork's eight missed it, so the cap first came down to two (open question 2). After the
report you chose eight: spread over eight districts they cost a low-end host about 41 ms a frame, and the world keeps
real time.

`npm run bench -- --only render --scene maze --cpu 4 --zones N` (new). It runs the host's page alone, simulating in
full around N district start tiles, on the i7-7700HQ / HD 630 laptop, frame p95 in ms:

| Zones | 4× desktop | 4× phone | 1× desktop | 1× phone |
|---|---|---|---|---|
| 1 (alone) | 29.6–30.1 | 28.5–29.1 | 25.6 | 27.2 |
| 2 | 31.5–32.7 | 31.2–32.1 | 28.6 | 28.7 |
| 3 | 32.7–34.3 | 32.3–33.8 | | |
| 4 | 36.1–36.5 | 35.2–35.8 | 31.0 | 30.9 |
| 6 | 39.0 | 36.8 | 33.5 | 33.7 |
| 8 | 40.9 | 40.3 | 34.3 | 35.6 |

- At 8 zones and 4× the tick p95 is 29–30 ms, under the 40 ms tick, so the world keeps real time. Adaptive quality
  drops to level 3–4.
- The cost follows the zones, not the players: friends who play together cost about what one player costs.
- **Node** (`npm run arena -- --preset arcade --observers N`, 3 min): tick average and p95 of 1.15 and 1.78 ms for
  one zone; 1.74 and 2.66 for two; 2.48 and 3.84 for four; 4.49 and 6.69 for eight. Chrome's step is about
  2–2.5× Node's on this machine, alone too.
- **Measuring in the e2e test was dropped.** Nine Chrome pages on a 4-core laptop measured each other: the host's step
  came out at 44 ms. Freezing the guests' pages didn't separate them, and the bench does.
- **Bytes** (`friends.spec.ts`, `test-results/friends-cost.json`): views of 2.2 KB/s per guest at 12.5 a second. The
  host sends 11.5 KB/s with two guests, mostly the save: 74.5 KB, packed to 35 KB, every 5 s to everybody. With eight
  guests, all near the host, views are 4–10 KB/s each and the host sends 37–90 KB/s over four runs, at most about a
  third of what a p3p2 server lets one member send (256 KB/s).
- **Room size.** A hub room takes 5 people, so eight players need a server of your own (16 a room by default).

## Solo play is unchanged

- **Hashes.** The seed-70 dry run on the final build matches the one from before any change, all 303 per-second state
  hashes, with the same end (mass 2,503, 37,545 points). Recordings and the autoplay harness are unaffected.
- **Size.** Initial load is 54.7 KB gzip (50.3 KB before plan 2; budget 60 KB). The p3p2 entry is 1.9 KB. The room code loads
  only in a room: Net 8.0 KB, p3p2-core 8.1 KB, panel 4.9 KB, QR 2.0 KB. `vec3` is now a 0.7 KB chunk of its own,
  preloaded.
- **Load** on Slow 4G at 4× CPU: 1,396–1,480 ms over two runs, against 1,389–1,424 ms before. The median is 3.7 %
  slower, inside the plan's 5 %.
- **An ordinary visit** sends no request to any p3p2 server, opens no WebSocket, and loads no room code (the "alone"
  test).

## Tests

- **`npm test`:** 169 of 169. New in `tests/unit/net.test.ts`, which runs a host and guests in Node through an
  in-memory room:
  - wire round trip;
  - the rules;
  - a guest drawing the host's world, starting in its district, and steering;
  - starting near a playing host;
  - own merges paying nothing;
  - the next player carrying on from the save;
  - the cap, held colonies, and a colony that is away holding no place.

  `tests/unit/version.test.ts` covers the version.
- **`npm run e2e`:** 29 passed. The 9 multiplayer tests run in the desktop project only.
  - Multiplayer, through a local server for each test (`tests/e2e/friends.spec.ts`): alone; two players; one name
    (hosting and joining by the menu's, Play alone, no name, a bad room URL, removed from the room); the host
    leaves; a reload; 150 ms each way and a cut; a phone by touch; the rules; a full world of eight. The full world
    checks a view every two of the host's ticks, not 12.5 a second: with nine pages beside the other tests on this
    laptop, the host's world itself ran at 19 ticks a second.
  - New in `play.spec.ts`: the links at load and after a death; the menu at 320 px and on a phone on its side, with
    the room URL field open; the version, matching the commit and covering nothing.
- **`npm run e2e:engines`** (opt-in): Chrome and Firefox 155 build the same twelve districts tile for tile, and the
  Firefox guest draws the host's world. WebKit needs `sudo npx playwright install-deps webkit` (libevent, libavif,
  libmanette); until then the test notes it and goes on without it.
- **Set up on this machine:**
  - a p3p2 checkout at `~/Repos/p3p2` (commit ac08884, `npm ci --workspace server`) for `npm run p3p2` and the tests;
  - Playwright's Firefox and WebKit in `~/.cache/ms-playwright`.

## Not verified

- **How steering feels as a guest.** A guest's cells move a round trip after the mouse, with no prediction.
- Two real people, on real devices, through hub.p3p2.me or a server of yours over https/wss, from the deployed site.
  The room's game URL must be `https://c0.muon.day/`.
- WebKit (Safari's engine).
- How the version label looks in a new recording. One CSS rule in the recorder hides it if you'd rather.

## What to work on next

1. **Deploy, then play with a friend** through hub.p3p2.me: hosting, joining by the link, a phone, the host leaving.
2. **A cheaper world around extra players.** Eight far apart cost a low-end host about 41 ms a frame against 33 ms:
   think less often, or simulate a smaller zone around a guest's colony than around the host's camera.
3. **The save is most of what a host sends.** Sending it less often, or only what changed, would cut the host's
   upload about in half.
4. **WebKit:** install its libraries and run `npm run e2e:engines`.
5. **Prediction for a guest's own cells**, if steering feels late.
