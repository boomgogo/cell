# Next 1: what plan 1 built, what it found, and what comes next

Implements `ai/plan_1.md`:
- an autoplayer that plays the real game the way a person does, tuned for its size at 5:00;
- a frame-exact recorder;
- three videos;
- bug fixes along the way.

Nothing was uploaded or deployed; that is yours to do.

**Deploy before you post.** Making the videos found two game bugs that change how the game starts (below). The videos
show the fixed game, and c0.muon.day doesn't have it yet.

## The videos

All in `/run/media/p1/DRIVE2/cell/`.

| File | What | Format |
|---|---|---|
| `youtube/cell-youtube.mp4` | Desktop seed 70, the best of 150 dry runs, in one take. Mass 10 → 2,503 at 5:00 with 37,545 points. Its peak was 3,554 at 2:00, after a rainbow explosion of a 3,162-mass cell; #1 from 1:53, #2 at the end. | 2560×1440, 60 fps, H.264 High, AAC, 5:15.9, 1.32 GB; −14 LUFS, −6.4 dBTP |
| `youtube/youtube.txt` | Titles; a description (says it's the bot, gives the peak); 6 chapters (start, mass 100, mass 250, out of the maze, #1, 5:00); how to play; tags | |
| `youtube/thumb-*.jpg`, `thumbs.txt`, `contact.jpg` | Stills to pick a thumbnail from (the final cell, explosions, the start), and a sheet every 15 s | 1280×720 |
| `short/cell-short.mp4`, `short.txt` | Phone seed 15, the best of 45 phone runs, played by touch: mass 10 → 3,572 at 5:00, #1 (peak 4,084). The final size first, then 7 pieces from the start to the end. | 1080×1920, 60 fps, 41.8 s, 65 MB; −14.1 LUFS, −6.4 dBTP |
| `short/contact.jpg`, `safe-zones.jpg` | A sheet every 3 s; Shorts' overlays drawn over a still | |
| `x/cell-x.mp4`, `x.txt` | Cut from the master: the final size, the start, four moments, the end card | 1920×1080, 60 fps, 37.5 s, 69.9 MB; −14 LUFS, −6.4 dBTP; post 216 of 280 characters |

**How each video runs:**
- **YouTube.** It opens with a 1 s fade-in on the menu. The cursor types "Rad" and presses Play, and a 5:00 countdown
  runs. It ends with a 3 s hold, an 8 s end card ("Mass 2,503 in 5 minutes · 37,545 points · Play free at
  c0.muon.day") and a 1 s fade.
- **The Short** has a band above the game ("CELL", "Play free at c0.muon.day") and one below
  ("mass 10 → 3,572 in 5 minutes"). The link sits clear of Shorts' overlays; Shorts' buttons cover the game's Split
  button.

**The master's checks** (`youtube/run.json`):
- It matched its dry run every second (303 s of hashes).
- 18,941 frames had the camera moving; none was repeated.
- Sound clock drift: 1.3 ms. Chomps start a median 6 ms after their frame (38 checked), within a frame.
- Toasts stayed up their time to within a frame: "GO!" 1,400 ms, "RAINBOW!" 900–917 ms, "RUN!" 1,200–1,217 ms.
- 209.5 ms a frame (screenshots 188 ms; the two searches shared the machine): about 66 minutes for the master.

**The Short's replay** matched its phone dry run (302 s). 2,487 frames had the camera moving; none was repeated.

**The searches** (dry runs, in `search/`):

| | Desktop, seeds 1–150 | Phone, 45 of seeds 1–48 |
|---|---|---|
| Alive at 5:00 | 89 (59 %) | 34 (76 %) |
| Median mass at 5:00, alive runs | 440 | 486 |
| Best | 70 (2,503), 19 (2,156, #1, chain of 4), 39 (1,888) | 15 (3,572, #1), 31 (1,970), 42 (1,598) |

The phone search lost 3 seeds to touch cancellations, which led to the touch fixes below, and was then cut short by
the power failure.

**Also on the drive:**
- `search/` holds the dry runs, with `desktop.json` and `short.json`.
- `tune/` holds `tune.log`, `params.json` (the defaults) and the held-out and fixed-game statistics.
- `check/` holds earlier tries: the pilot and the searches from before the district fix, the phone runs from before
  the touch fixes, and test Shorts. All can be deleted.
- `youtube/video.mp4` and `video.wav` are the silent master and its sound; `cell-youtube.mp4` is the muxed file. Both
  can go after uploading.
- After the power failure the drive was remounted, and all three videos were decoded end to end without an error.


## Bugs found and fixed

1. **Merging your own cells scored as a kill.**
   - Own pieces merge through `World.consumeCell`, which emits an `eat` event, and `Game.handleEvents` paid 10 × their
     mass. A split at mass 1 000 merged back for +4 578 points; re-merging after a virus pop or an explosion paid too.
   - The fix: `eat` events now carry the prey's owner (`preyOrg`). The points live in a small DOM-free
     `src/ui/points.ts`, which pays nothing when the prey was yours. `Game` and the Node harness both use it.
   - Tests: `tests/unit/points.test.ts`.
2. **Every game started in district 1 (Cherry Commons).**
   - `Number(params.get('district'))` is 0 when there is no `?district=` (`Number(null)`), so the start district was
     never the random one the code meant to pick.
   - Now the world seed picks it (`src/game.ts`).
3. **Mazes differed between browsers.**
   - The generator sorted the pocket squares with a random comparator (`rng() − 0.5` inside `sort`). The number of
     random draws then depends on the engine's sort, so the same `mapSeed` gave different mazes in Chrome and in Node,
     9 of 12 districts, and surely in Firefox and Safari too.
   - Now it shuffles with the rng, then sorts stably (`src/maze/generate.ts`). Every district now comes out the same in
     Node and in Chrome.
   - **The mazes players see change with this deploy:** the layout is new, though built by the same rules.
4. **Corner assist held a cell against a wall's corner.**
   - The new layout has a two-tile corridor that goes on as a one-tile one at its side. The packing tests caught a
     cell of r 68 (just under the way out) stuck there for 60 s.
   - The assist centred the cell on the wide corridor's centre line and snapped any heading within 60° of the axis,
     so even a player steering at the opening was held at the corner.
   - Now, when the wall ahead is within reach and the corridor narrows to an opening off our line, the cell slides onto
     the opening's line first (`World.openingAhead` / `slideTo` in `src/sim/world.ts`).
   - Test: "a cell nearly as wide as a fine corridor gets from a two-tile corridor into the one-tile one at its side"
     in `pack.test.ts`.
5. **Flaky timing tests.** Wall-clock assertions failed when test files shared the CPU:
   - `maze.test.ts` (40.5 ms against 40) and `pack.test.ts` (5.5 ms against 5) now have about 3× margins;
   - the heavy arena tests in `ai.test.ts` and `pack.test.ts` have longer timeouts.

   `npm run bench` remains the real speed measure.

## Gameplay changes

- **The arcade Score box reads "Mass 916"**: the points are the score there, and the video's headline is the mass.
  `base` keeps "Score".
- **The death card shows the run's points:** "Eaten by X · 12,340 points · peak mass 916".
- **No NPC or rule tuning.**
  - The arena now splits its stuck windows into maze and plains (a new column).
  - Over three seeds the NPCs' stuck share was 0–15 % per size bucket, on small samples, and "stuck" also counts NPCs
    grazing in place. Nothing in it was clearly a fault, so the NPC brain is unchanged.
- **A finding, not changed: the start is hard for new players.**
  - A player steered by the NPC brain (the old `autopilot()`) dies within 30 s in 31 of 96 games; median life 42 s.
    Most deaths come between 10 and 60 s, to NPCs in the start maze. A mass-10 cell is slower than a T4 phage, and the
    maze lure brings small NPCs in.
  - A 3-second spawn shield wouldn't help (deaths come later). Possible changes: spawn on the plains side of a gate, or
    phages that ignore a newcomer for its first 15–20 s.

## The autoplayer

`scripts/autoplay/`:
- **`snapshot.ts`:** what a player sees. Built by one function in the page and in Node.
- **`brain.ts`:** the decisions, with all their numbers in `BrainParams`.
- **`hands.ts`:** mouse, keys and touch, like a person.
- **`sim.ts`:** the Node harness, mirroring `Game.frame`.

Plus `scripts/autoplay.ts` (run, batch, tune) and tests in `tests/unit/autoplay.test.ts` (14).

**What made it work:**
- **Threats through corridors.**
  - The brain first decided whether a threat could reach it from the corridor labels of its own tile. A big cell in an
    avenue eats a small one at the mouth of a fine corridor, and was ignored: risk 0 at edge distance 0.
  - Checking whether any tile within the threat's eating reach shares its corridor component took survival from 33 %
    to 75 % alive at 5:00.
- **Corridor-aware fleeing.** In a maze interior, the candidates are the corridor directions out of our tile. Each is
  scored by the safest tile it leads to within 3 s: when we'd arrive there, against how close each threat could be by
  then.
- **Hands that swing around the cell.** A straight cursor move to the other side crosses the cell, where it slows
  down; reversals now arc around it.
- **Tried and dropped:** remembering big cells for spore timing, and hunting remembered big cells while rainbow. Both
  lowered the best-10 % mean (1 176 against 1 933 on 96 seeds), so both are off by default (`sporeMem`, `hunt`).

**Tuning** (`npm run autoplay -- tune`): coordinate search on 120 seeds; a change is kept only if it raises the best-10 %
mean by 5 % while 70 % live to 5:00.
- Pass 1 kept one change, `sporeBig` 0.15 → 0.075 (2 126 against 1 929). On 200 held-out seeds it lost to the defaults
  (1 588 against 1 861, alive 72 % against 71 %): noise. The defaults stand.
- Pass 2 found nothing. The runs are chaotic: neighbouring values of one parameter scored anywhere from 917 to 1 768.

**Against the baseline, held-out seeds, Node harness:**

| Seeds 1001–1200 (before the maze fix) | alive at 5:00 | median mass at 5:00 | best-10 % mean | reached #1 |
|---|---|---|---|---|
| autoplayer | 71 % | 385 | 1 861 | 9 % |
| NPC hunter (hard), as `autopilot()` | 2 % | 0 | 594 | 2 % |

| Seeds 1001–1100 (fixed game) | alive at 5:00 | median mass at 5:00 | best-10 % mean | best |
|---|---|---|---|---|
| autoplayer | 64 % | 333 | 2 212 | 5 704 |
| NPC hunter (hard) | 1 % | 0 | 179 | 1 792 |

- The plan's targets were at least 70 % alive and 3× the baseline. On the fixed game it is 64 % alive (phage deaths
  rose with the new mazes) and 12× the baseline.
- Splits per run are still about 0: prey keeps out of a split's reach because NPCs flee from about 4 radii. The best
  runs grow by rainbow chains on big NPCs and by eating mass-400 phages.

**Browser against harness:**
- On seeds 1–12, before the fixes, the browser had 8 of 12 alive and the harness 9 of 12.
- The bigger search then showed the browser behind (55 % alive against 71 %). Tracing it found bugs 2 and 3: the
  browser always started in Cherry Commons, with different mazes.
- After the fixes a browser game and a harness game start identically: same mazes, food, cells and spawn point.
  `Math.sin` and `Math.cos` differ in the last bit between Chrome 155's V8 and Node 24's, so they part within the
  first second. That is why a recording is checked against a browser dry run, not against the harness.

## The recorder

`scripts/record.ts`, `scripts/record/page.ts` (injected), `ffmpeg.ts`, `chapters.ts`; `scripts/cut.ts`.

- **The clock.** The recorder owns the page's clock: time, timers, idle callbacks, animation frames, CSS animations,
  `Math.random`, and the sound, rendered offline in step with the frames.
- **Real input.** Mouse, keyboard and touch go over CDP, with a handshake: each step waits until the page has seen the
  input.
  - Chrome holds continuous moves for its next real-time frame, about 16 ms each, so moves go only on frames where the
    game will read the pointer (its 25 Hz ticks). The drawn cursor follows the hand every frame.
  - **Touch, learned the hard way:**
    - CDP's `touchEnd` lists the fingers that lift. A `touchMove` without a finger doesn't lift it.
    - Chrome sends no DOM `touchmove` to a `touch-action: none` canvas with passive listeners, but every
      `pointermove` arrives, so the handshake watches touch pointer events.
    - Chrome cancels a touch dragged along the screen's edge, or one that comes down outside it. The thumb now keeps
      24 px from the edges and lands on the screen, with a small contact area (a wide one let Chrome's touch
      adjustment pick the nearby W button), and 24 px clear of the buttons.
    - If Chrome cancels a touch anyway, the recorder lifts the thumb and the hand puts it down again: it logs
      `touch-cancelled` instead of waiting.
    - Seeds 26 and 27, which hung before, now play to the end with no cancelled touches and no waits that time out.
    - **The Short was made before these fixes.** Its run had no handshake timeouts and its replay matched, so it is
      valid as it is. With the current hands, `npm run cut -- short --seed 15` would play a different run.
      `short/run.json` is its record.
- **Dry runs** (no rendering, muted) predict a run at about 8–14 ms a frame. Recordings must match their dry run's
  state hash every second.
- **Checks saved in each `run.json`:** time per frame, frames identical while the camera moved, sound clock drift,
  how long each toast stayed up, and chomp sync.
- **The countdown and the end card** are recording-only overlays in the HUD's style.

**The pilot** (90 s of seed 1, recorded before the district fix; in `check/before-district-fix/pilot/`):
- It matched its dry run (59 s); 0 of 3,812 moving frames were repeated.
- Sound clock drift 1.3 ms; chomp sync 7 ms; "GO!" up for 1.4 s.
- About 40 Mbit/s at 1440p.
- Screenshots took 216 ms a frame with tuning running alongside (40 ms in the idle probe).

The master carries the same checks, so there was no second pilot.

## Not verified

- **How it sounds.** Loudness and peaks are measured, but nobody has listened. The game's sound is chomps over
  silence: −14 LUFS means the chomps are loud. If that's tiring, a −16 LUFS target in `encodeAudio`, and
  `npm run cut`/`mux` redo the sound without re-recording.
- How the videos look after YouTube and X process them, and on a phone with Shorts' buttons over them.
- Whether the bot reads as a person to a viewer.

## Checks

- **Tests.** `npm test`: 156 of 156. `npm run e2e`: 14 of 14.
- **Size.** Initial load 50.3 KB gzip (49.9 KB before), inside the 60 KB budget.
- **`npm run bench`** (4× CPU, Intel HD 630, the same machine as `next_0.md`):
  - Load to an interactive menu on Slow 4G: 1.39–1.42 s (it was 1.42–1.55 s).
  - Render, p50 / p95 (ms) and the final quality level:

    | Scene | next_0 | Now |
    |---|---|---|
    | plains desktop | 16.1 / 30.1, L1 | 16.5 / 28.8, L1 |
    | plains phone | 16.4 / 29.5, L0 | 16.7 / 28.2, L0 |
    | maze desktop | 16.3 / 32.9, L2 | 16.5 / 28.8, L0 |
    | maze phone | 16.8 / 29.0, L0 | 16.7 / 28.9, L0 |
    | rainbow desktop | 18.1–23.5 / 37–108, L6 | 21.6 / 48.1, L6 |
    | rainbow phone | 14.0–15.5 / 35–48, L3–6 | 15.9 / 32.7, L5 |

    The rainbow scene varies from run to run with its explosion chains, as before.

## What to work on next

1. **Deploy, then upload.** `youtube.txt`, `short.txt` and `x.txt` hold the text. The maze layout changes with this
   deploy, which is also what the videos show.
2. **The start for new players** (see the finding above): spawn by a gate on the plains side, or phages that leave a
   newcomer alone for a few seconds.
3. **Splits.** NPC prey flees beyond a split's reach. A split onto prey cornered against a wall or a virus, or a
   double split, would show more of the game in videos.
4. **Survival with the new mazes** fell from 71 % to 64 % alive at 5:00, with more phage deaths. Phage-aware routing
   from the spawn would win it back.
5. **Big cells fade.** The master's cell peaked at 3,554 at 2:00 and decayed to 2,503 by 5:00. Little on the plains
   feeds a cell that size, so the brain only grazes. A late game that hunts big NPCs (or a gentler decay above a size)
   would make long runs climb instead of fade.
