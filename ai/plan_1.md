# Plan 1: an autoplayer that plays like a person, three recordings, and gameplay fixes

This plan answers `ai/prompt_1.md`:
- refine the autoplay script so it plays the real game the way a person does;
- tune it to get as big as it can in 5 minutes;
- record a YouTube video of that run (about 5 minutes), a YouTube Short and a video for X;
- improve the gameplay and fix bugs along the way.

Nothing here is implemented yet.

**Decided since the first draft:**
- **The YouTube video is about 5 minutes.**
  - It is one run with 5:00 of play, from Play to the 5-minute mark. With the opening and the end card it runs about
    5:15.
  - The goal is to be **as big as possible at 5:00**. The headline number is the Mass box at the end, and the autoplay
    script is tuned for exactly that (step 3).
- **The play link is `https://c0.muon.day/`.** It goes on the Short's band, the end cards, and every description and
  post. The source link `github.com/boomgogo/cell` goes in the descriptions too.
- **The nickname is "Rad".** It is also the name field's placeholder. A blank field plays as "A stray spore", so the
  hands really type it.

**How I read the prompt.**

- **"The script".** Three scripts touch autoplay today, and none of them can make a video:
  - `Game.autopilot()`, with `src/ui/bench.ts`, puts an NPC brain (`BotController`, a hunter on hard) in charge of the
    player for the render bench. It writes the organism's target directly, bypassing input, and it sees what NPCs see.
  - `scripts/arena.ts` runs the NPC brains in Node, with no screen.
  - `scripts/bench.ts` drives the built game in Chrome, with nothing captured.

  This plan replaces them, for recording, with a player brain:
  - it sees only what is on the screen;
  - it acts through real mouse, keyboard and touch input, at a person's pace;
  - it is tuned in Node for its size at 5:00;
  - the game is recorded frame by frame.

  The pipeline is Bubbler's from its prompt 2 (`tools/record.js`, `record-clock.js`, `human.js`, `cut.js`), ported to
  Cell along with the fixes that Bubbler's recording needed. It changes where a real-time game needs it.
- **"Maximum level and score".** Cell has no levels; the decision above makes the headline **the mass at 5:00**. Shown
  alongside it:
  - the points;
  - the leaderboard rank, and when the run reached #1;
  - the biggest rainbow chain.
- **"Improve gameplay and fix any bug".** The autoplayer doubles as a tireless playtester: hundreds of openings in Node
  and in the browser, with every death, stall and oddity logged.
  - Fixes land **before** the final recordings, so the videos show the game as it will be deployed.
  - One bug is already confirmed (§ "A bug found while planning").
- **"Save recording related files and outputs in /run/media/p1/DRIVE2/cell".**
  - The code goes in the repo under `scripts/`, as Bubbler's did under `tools/`.
  - Everything the recording makes goes on the drive: logs, tuning and search results, raw video and sound, pieces,
    stills, text.
  - Chrome's profile and ffmpeg's temporary files go there too, so the home disk (30 GB free) is untouched.

## The three videos

| | YouTube | YouTube Short | X |
|---|---|---|---|
| Frame | 2560×1440 (16:9), 60 fps (open question 7) | 1080×1920 (9:16), 60 fps | 1920×1080 (16:9), 60 fps (open question 3) |
| Length | 5:00 of play, about 5:15 in all | 45–55 s | 30–45 s |
| What | one continuous run, from the menu to 5:00, played with mouse and keyboard. No cuts. | a 5-minute run played by touch in a phone layout, in highlights (open question 6) | highlights of the growth, cut from the YouTube master |
| Extras | a countdown (open question 5); an end card with the final mass and the link; a description with chapters at growth milestones; thumbnail stills | a title band, and a band with "Play free at c0.muon.day" | ends on the end card with the link; text for the post |

## What the code does today (the facts this plan is built on)

- **The sim is deterministic; the shell isn't yet.**
  - The world uses only its seeded `world.rng`. `Math.random` appears only in the shell and the renderer: the default
    seed, the player's hue, effects and the noise buffer.
  - A browser run also depends on things outside the sim:
    - frame timing, through the fixed-step accumulator and the camera's easing;
    - when the idle-time district builds happen (`onDistrictBuilt` draws from `world.rng`);
    - when pointer events arrive.
  - Owning the page's clock fixes all three (see the approach).
- **The state is far too big to save.** A run can't be paused, serialised and resumed the way Bubbler's turns could:
  there are about 87 000 pellets and 850 organisms, each with a controller and its own state. So:
  - the Node sim can't predict the browser run (a different camera and timing give a different game);
  - a moment can't be re-recorded from a saved state.
- **What there is to eat in 5 minutes** (from the code, and a probe of seed 1 today):
  - **The spawn.** The player starts at mass 10, on the start tile of the nearest district when nothing bigger is near
    (`Game.play`).
  - **Each district holds:**
    - about 1 150 pellets (mass 1 each) on its corridor lines;
    - 12 spores (mass 9, plus 8 s of rainbow);
    - four phages: two of mass 30 and two of 400. They have fixed mass, come back 5 s after being eaten, and flee a
      smaller rainbow cell.
  - **NPCs** start at a median mass of 133. The 90th percentile is 921 and the biggest is 1 483; 179 of 804 are over
    500.
  - **Explosions.** A rainbow cell that touches a bigger one explodes it:
    - about half the pieces are crumbs the exploder can eat at once;
    - the rest are chunks of at most ⅓ of the mass, which can be exploded in turn.

    On paper, a rainbow cell among big NPCs is the fastest way to grow.
  - **Decay** is 0.2 % a second: a cell of mass 5 000 loses 10 mass a second.
  - **Packing** caps a cell's size inside a maze, so growing big means leaving it.
  - **The view** zooms out as the cell grows, so a bigger cell sees more, and the video shows the world shrinking under
    it.
- **Points** (`Game.handleEvents`, `Game.arcadeFrame`), shown in the HUD:

  | Event | Points |
  |---|---|
  | pellet | 10 |
  | rainbow spore | 50 |
  | eating a cell | 10 × its mass |
  | explosion | 200 × 2^min(k, 4), so 200 → 3 200 along a chain |
  | home again (leave 8 000+, come back within 600) | 1 000 |
  | lap ("AROUND THE WORLD!") | 10 000 |

- **A bug found while planning: merging your own cells scores as a kill.**
  - Own pieces merge through `World.consumeCell`, which emits an ordinary `eat` event, and `Game.handleEvents` pays
    10 × mass for it.
  - A probe today: a cell split at mass 1 000 and merged back 44 s later for **+4 578 points**.
  - The same happens when pieces merge after a virus pop or an explosion, so being exploded pays too.
  - The bot now chases mass, not points, but a player can farm this with split/merge loops. The points are on screen in
    every video, so it is fixed first.
- **How long NPC brains live** (`npm run arena -- --preset arcade --minutes 10 --seed 3`, run today):

  | | normal | hard |
  |---|---|---|
  | Average life | 130–152 s | 136–150 s |
  | Average peak mass | 77–110 | 87–110 |
  | Best peak mass | 2 345–3 296 | 2 360–3 001 |

  - The ranges run across the five personalities.
  - An NPC brain driving the player would usually be dead in under three minutes, and small.
  - The new brain has to grow fast without dying: a death before 5:00 throws the run away.
  - NPC exploring is still weak:
    - r 100–400 cells are stuck in 9–15 % of 30-second windows;
    - the progress detector fired 99 times in 10 minutes, against a target of ≤ 25.

    Both show on video as NPCs dithering in corridors.
- **Input.**
  - The cell steers toward the world point under the pointer, sampled at each 25 Hz tick. Speed is full unless the
    pointer is within 32 units of the cell.
  - Space splits toward the pointer and W ejects. On touch, the Split and W buttons are separate elements, so a second
    finger can press them while the first one steers.
  - There is no wheel zoom-out (`wheelZoom` ≥ 1), so a bot can't see more than a player.
  - `window.__game` is exposed in production builds, so no getters need adding.
- **The view.** `viewScale` sizes the view by `max(h/1080, w/1920)`.
  - A 1280×720 CSS window sees the same world as 1920×1080. At device scale 2 the HUD is 1.5× larger relative to the
    frame, which reads better on a phone.
  - A portrait phone sees the same height and less width.
- **Probe today: what a frame costs to record.** Headless Chrome 155 on the Intel HD 630 (ANGLE, GL ES 3.2), the
  current build, an autopiloted mass-300 cell, quality 0:

  | Frame | Game frame | JPEG q95 screenshot | PNG screenshot |
  |---|---|---|---|
  | 2560×1440 (1280×720 CSS at 2×) | 2.5 ms | 40 ms (309 KB) | 49 ms (507 KB) |
  | 1920×1080 (at 1.5×) | 2.3 ms | 36 ms | 52 ms |
  | 1080×1920 (432×768 CSS at 2.5×) | 3.4 ms | 30 ms (126 KB) | 31 ms |

  - Without capture, with one call per frame: 5.5 ms a frame with rendering on and 2.0 ms with rendering off. 600
    frames inside one call take 0.8 ms each.
  - That is about 3× cheaper than Bubbler's WebGL screenshots (112 ms).
  - A 5-minute master is about 20–30 minutes of machine time. At 4K (3× scale) it is about an hour.
- **This machine.**
  - 8 threads, 14 GB of RAM.
  - Node 24.21, ffmpeg 8.0.1 (libx264, AAC), Chrome 155.
  - Home disk: 30 GB free. `/run/media/p1/DRIVE2`: 842 GB free.
- **The live site.** c0.muon.day serves the plan 0 build (flags, the GitHub link).
  - Its `/cdn-cgi/trace` answers with a `loc=` line, so players' flags come from the first-party lookup. That settles
    `next_0.md`'s step 2.
  - It doesn't have this plan's fixes yet. The videos will show the fixed game, so it has to be deployed before
    anything is posted.
- **Fonts.**
  - `system-ui` resolves to Noto Sans, with only Regular and Bold installed, so the HUD's 800 and 900 weights render as
    Bold.
  - The monospace HUD falls back to DejaVu Sans Mono.
  - The region emoji render with Noto Color Emoji.
- **Tests today.** 134 of 135 unit tests pass. The failure is a timing assertion, not a bug: `maze.test.ts` measured an
  average of 40.5 ms per district against a 40 ms limit while the test files ran in parallel. Last session it was
  `ai.test.ts` timing out.

## The approach

### A frame-exact recording, with a recorder-owned clock (ported from Bubbler)

- **The recorder owns the clock.** For each frame it advances the page's clock by exactly 1/60 s, lets the game draw
  that frame, takes a JPEG q95 screenshot at device scale, and pipes it to ffmpeg. Every frame is perfect, however
  long it takes.
- **The injected clock** (`scripts/record/page.ts`, bundled on the fly with Vite's build API and added before the page
  loads) covers:
  - `performance.now`, `Date.now`, `requestAnimationFrame`, the timers and `requestIdleCallback`, so the twelve
    districts build at the same virtual moments every run;
  - a seeded `Math.random`;
  - the sound: `AudioContext` becomes an `OfflineAudioContext` rendered in lockstep, so a chomp is heard on the frame
    it's seen;
  - CSS animations. The HUD has almost none, but the code comes along.
- **Recording-only overlays:**
  - a mouse cursor with a click ripple, or touch dots for the phone (one per finger);
  - a 5:00 countdown in the HUD's style, bottom centre (open question 5);
  - a black fade layer.
- **Recording URL:** `?seed=N&quality=0&geo=0` in a fresh profile, so HI starts at 0, no country is stored and no
  network lookups happen. The lazy chunks (minimap, flags, sound) are waited for before Play, so the first frames
  always show them.

### The dry run is the prediction

Bubbler predicted each run in Node and checked the browser against it. Cell can't do that (see the facts), so the
browser predicts itself:

- **A dry run** plays the same run with:
  - the same clock and the same input path;
  - rendering switched off (`renderer.render` replaced by a no-op from the injected script);
  - sound muted;
  - nothing captured.

  At about 3 ms a frame, a 5-minute run takes about a minute.
- **Hashes.** Every second, the page hashes the tick, the points, the player's cells, every active cell, and the food
  count.
- **The recording** replays the same seed with capture on. Its hashes must match the dry run's every second, and the
  first difference stops it.
- **The pilot checks once** that rendering on or off gives the same hashes.
- **Moments for the Short** are captured from one replay of the phone run:
  - frames outside the chosen windows are stepped without screenshots;
  - each window gets a 3-second warm-up with rendering on, so membranes, effects and the static layer are settled.

### The brain sees a snapshot of the screen

Fairness is built in: the brain runs in Node and gets nothing but a snapshot. `scripts/autoplay/snapshot.ts` builds it
with one DOM-free function that runs in the page (in the injected bundle) and in the Node harness.

**In the snapshot:**
- the camera: centre, screen axes, zoom and size;
- the player's cells, with its mass (the Mass box) and rainbow time left (the bar);
- every cell whose disc touches the screen, with:
  - its kind (cell, virus, ejected blob, phage);
  - its position and radius;
  - its owner, since a colony's cells share a colour and name;
  - whether it is rainbow, and whether it is flickering (under 2 s left);
- pellets and spores on screen;
- the minimap's spores, which the minimap shows for the whole globe;
- the leaderboard rows;
- the home arrow and the lap count;
- the region banner.

**Not in it:**
- anything else off screen;
- dormant NPCs;
- NPC personalities, goals and merge timers;
- other cells' exact rainbow timers;
- `world.rng`.

**What a person could also know:**
- **The mazes.** The brain builds its own `MazeWorld` from `mapSeed`. The mazes are the same in every game by design,
  so a regular player knows them.
- **Motion.** Velocities come from consecutive snapshots.
- **Memory.** A few seconds of memory for threats that leave the screen, and where big NPCs were last seen.
- **The clock.** How much of the 5 minutes is left, as a player racing a clock knows.

### Real input, with a handshake

- **Real input.** Each frame, the hands' events are sent over CDP:
  - `Input.dispatchMouseEvent` and `dispatchKeyEvent`;
  - `dispatchTouchEvent`, with two touch points, for the phone.
- **The handshake.** Chrome may deliver mouse moves on its own frame, after the recorder has already stepped. A late
  event would change the run. So each step first waits until the page has seen every event sent for that frame.
- **Camera turns.** The hands aim in screen space and follow the camera as it turns in mazes, as a person does.

### Where files go

`--out` sets the output folder: `recordings/` by default, which git ignores. The runs for this prompt use
`--out /run/media/p1/DRIVE2/cell`. A missing or read-only folder stops the script, rather than letting it fall back to
the home disk.

```
/run/media/p1/DRIVE2/cell/
  tune/       Node stats per round, the parameter search log, the tuned parameters
  search/     desktop.json, phone.json, logs
  pilot/      90-second trial, checks, stills
  youtube/    cell-youtube.mp4, video.mp4, video.wav, run.json, youtube.txt, thumb-*.jpg, contact.jpg
  short/      cell-short.mp4, pieces, run.json, short.txt
  x/          cell-x.mp4, x.txt
```

## Build order

0. **Groundwork:** scripts, `.gitignore`, the output folder.
1. **Known bugs:** merge scoring, flaky timing tests.
2. **Snapshot, brain and hands,** with unit tests.
3. **The Node harness:** tune the brain for its size at 5:00, and collect gameplay data.
4. **Gameplay review:** fix what the data shows, re-measure the budgets, and re-tune.
5. **The recorder,** with dry runs, hashes and `watch`.
6. **Run search:** desktop and phone.
7. **The pilot** (90 s). It also checks the look for visual bugs.
8. **The YouTube video.**
9. **The Short.**
10. **The X video.**
11. **README, `summary.md`, tests and `ai/next_1.md`.**

---

## Step 0: groundwork

- `package.json`: `autoplay`, `record` and `cut` scripts.
- `.gitignore`: `recordings/`.

## Step 1: known bugs

- **Merge scoring.**
  - The `eat` event gains the prey's owner (`preyOrg`).
  - The arcade points move out of `Game.handleEvents` into a small DOM-free `src/ui/points.ts`, which pays for a cell
    only when its owner is someone else.
  - `Game` uses it, and so does the Node harness, so the harness's points match the game's.
  - Unit tests:
    - split → merge pays nothing;
    - re-merging after a virus pop or an explosion pays nothing;
    - eating a rival or a phage pays 10 × its mass;
    - pellet, spore, explosion chain, home and lap pay as in the table.
  - The code moves, so `npm run size` should not change by more than about 0.1 KB.
- **Flaky timing tests.** A wall-clock assertion doesn't belong in a unit test that shares the CPU:
  - `maze.test.ts` keeps its build-speed check with a 3× margin, and `npm run bench` remains the real measure;
  - the slow `ai.test.ts` exploring tests get a 15 s timeout.

## Step 2: snapshot, brain and hands (`scripts/autoplay/`)

**`snapshot.ts`**: as above. It is pure, and works on a `Game`-like `{ world, camera, human, points, laps, home }`.

**`brain.ts`**: snapshot in, intent out (a heading or target point, split, eject, and the goal it's on). It runs about
10 times a second. Every number it uses lives in one `BrainParams` object, so step 3 can tune them. It works in
layers, safety first:

1. **Stay alive.** A death before 5:00 throws the run away, so this layer always wins.
   - A danger zone grows around every visible cell that can eat us:
     - its radius;
     - plus what it can cover in our reaction time;
     - plus its split lunge, when it can split-kill us. That needs r ≥ 60, and a half still 1.14× our radius; the reach
       comes from `splitBoost` and `boostDivisor`.
   - Also dangerous:
     - viruses, once we're big enough to pop;
     - rainbow cells smaller than us;
     - phages bigger than us.
   - The brain scores 32 headings over a 1–2 s look-ahead of each threat's motion. It split-escapes only when cornered.
2. **Grow fastest.** Each option is weighed as mass gained per second, against its risk.
   - **The opening:** the start district's corridor lines (about 1 150 pellets, quick to sweep while small and fast)
     and its spores.
   - **Rainbow (8 s):**
     - the biggest explodable cells within reach, then the crumbs, then the chunks exploded in turn;
     - the timing: a spore is worth most when big NPCs are near, so the brain remembers where it saw them.
   - **Phages:** Phi and Mu (mass 400), once we're big enough to eat them and still fit the corridors.
   - **Prey in the plains,** chased with lead.
   - **Split-kills** only when they're safe:
     - the target is inside the lunge;
     - the halves stay big enough;
     - no virus is on the line;
     - no threat can reach the halves during the merge time, which the brain tracks for its own cells.
   - **Leaving the maze** before packing caps us. The rest of the run is in the plains, where the big NPCs are.
   - **Pellet density** fills the gaps between bigger chances. Pellets matter less as the cell grows.
3. **The clock.** How the last stretch is played is tuned rather than guessed: whether to take more care, or to take
   one more chance.

There is no journey layer: a lap takes 6–10 minutes, and home returns pay points, not mass.

It reuses the DOM-free pieces: `rules.ts` (eat ratio, speed, split), `Flood` (maze path floods), `Frame` and the
sphere maths. It is seeded, so a run always decides the same way.

**`hands.ts`**: intent in, timed events out. It is pure and seeded per (run, frame), in the spirit of Bubbler's
`human.js`.

- **Reaction.**
  - A new threat or chance is acted on 150–260 ms after it first appears in a snapshot.
  - Decisions don't come faster than a person makes them.
- **The mouse.**
  - The cursor sits along the heading, 140–320 CSS px from the screen centre: farther when cruising, on the prey for a
    split.
  - A change of heading:
    - is a minimum-jerk arc with Fitts's-law timing (0.1 + 0.11 log₂(D/W + 1) s);
    - lands near the target, then corrects onto it.
  - A moving target is followed with about 120 ms of lag, plus a little seeded tremor (≤ 1 px).
- **Keys.**
  - Space is held 60–110 ms.
  - A double split (two presses 90–150 ms apart) is allowed, as experienced players do.
  - W is a tap, and rare.
  - At most about 6 presses a second.
- **The start.**
  - The cursor goes to the name field, clicks, and types "Rad" at 6–9 keys/s with uneven gaps.
  - Then it goes to Play and clicks.
- **The end.** At 5:00 the hand moves the cursor onto the cell, which slows and parks, and lets go. If the cell dies
  first, hands off (and the run isn't used).
- **Touch, for the Short.**
  - One thumb steers by dragging. It sometimes lifts and comes down again, and the cell keeps its course while it's up.
  - The other thumb taps Split (and rarely W): two touch points in one event.

## Step 3: the Node harness, tuned for size at 5:00 (`npm run autoplay -- tune`)

**The harness** (`scripts/autoplay/sim.ts`):
- It runs a `World` with the full NPC population and the player, through the same 60 Hz frame loop as `Game.frame`:
  - fixed steps and camera follow;
  - the spawn rule from `Game.play`;
  - `points.ts`.
- The brain and hands drive the player through a stand-in `Input`, exactly as they will in the browser.
- A 5-minute game is 7 500 ticks, about 10 s in Node. On 8 worker threads, a round of 200 seeds takes about 5 minutes.

**The measure.**
- Each run scores **its mass at 5:00**, or 0 if it died.
- The video shows the best run of the browser search (step 6). So what matters is how big the good runs get, as long
  as enough of them live.
- The tuning objective is therefore **the mean of the best 10 % of runs**, with a floor: at least 70 % of runs alive at
  5:00.
- The best 10 % is steadier than the single best run and less risk-averse than the median.

**The report, per round:**
- alive at 5:00;
- mass at 5:00: median, the best-10 % mean, the best;
- the growth curve: median mass at each minute;
- where the mass came from: pellets, maze lines, spores, explosion crumbs, NPCs eaten, phages;
- points, time to #1, the biggest chain;
- causes of death:
  - eaten by an NPC, by a split lunge or by a phage;
  - popped and then eaten;
  - exploded and then eaten.

**The baseline.** The NPC hunter (hard) driving the player directly, as `autopilot()` does today, in the same harness
and over the same seeds.

**How it is tuned:**
1. **Openings.** A few hand-built strategies, 200 seeds each:
   - sweep the start maze, then leave;
   - leave at once for the plains;
   - spore first, then a rainbow hunt;
   - hunt early.

   The best becomes the starting point.
2. **Coordinate search** over about 12 of the `BrainParams`:
   - the danger margin;
   - the split-kill thresholds (prey size, lunge share, clearance from threats);
   - how far a spore is worth a detour, and the biggest size that still goes into a maze;
   - which cells are worth chasing while rainbow;
   - pellets against prey by size;
   - when to leave the maze;
   - the last-stretch setting.

   The search runs one parameter at a time, trying two other values against the current one.
   - Every candidate plays the same 200 seeds, so seed luck cancels out.
   - A change is kept only if it raises the best-10 % mean and keeps the 70 % floor.
   - A full pass takes about 2 hours, unattended, and repeats until a pass changes nothing.
3. **Held-out check.** The tuned brain and the baseline play 200 seeds the tuning never saw.
4. **The browser agrees.** The desktop dry-run search (step 6) reports the same numbers. A big gap means the harness
   differs from the game. That gets found and fixed before the tune is trusted.

**Never tuned, so the tuning can make the bot smarter but not faster or better informed than a person:**
- the hands' limits: reaction ≥ 150 ms, Fitts's-law reaches, at most about 6 presses a second, cursor speed;
- the snapshot.

**Targets.** At least 70 % alive at 5:00, and a best-10 % mean at least 3× the baseline's. These are targets, not
promises: the video shows whatever the best run reaches.

**Sanity checks on every run:**
- no NaN positions;
- no cell inside a wall;
- no cell over its escape radius after packing;
- no organism over the cell cap;
- mass bookkeeping that adds up.

A failure saves the seed and tick, so the run can be replayed. A few 20-minute runs per round add gameplay data from
beyond the video's 5 minutes.

## Step 4: gameplay review and fixes

The tune runs and the arena show the game from a player's side as well as the NPCs'. Hundreds of openings are a close
look at what a new player meets in their first five minutes.

**Bugs** are fixed as found, each with a test that fails before the fix, and listed in `next_1.md`. Candidates
already known:
- the merge-scoring bug (step 1);
- NPCs dithering in corridors: stuck in 9–15 % of windows for r 100–400, and the progress detector at 99 firings
  against ≤ 25. `summary.md` §9 suggests a wander goal from the escape field instead of the capped flood.
- anything the sanity checks catch.

**Gameplay changes** are small, measured and reversible:
- each one is a config override with its reason, as the presets ask;
- each is checked with the arena and a tune round before and after.

Likely ones, to be decided by the data:
- **The first five minutes:** deaths in the first minute (a phage or a big NPC near the spawn), empty starts, or a
  climb that stalls.
- **Rainbow chains** that hit the 48-cell cap. Today's run reached 35 cells with no knockbacks, so possibly nothing.
- **Unfair-feeling deaths** the logs show, for example lunges from off-screen.

**Two small HUD changes** that help a viewer, and players too:
- In arcade, the Score box reads **"Mass 916"**. Mass is the video's headline number, and two numbers both called
  score (mass and points) confuse a viewer. `base` keeps "Score", and the e2e test that reads it is updated.
- The death card adds the run's points: "Eaten by X · 12 340 points · peak mass 916".

**Not done this round:** bigger changes to how the game feels (new mechanics, rule rewrites). They go into
`next_1.md` as proposals with the data behind them.

**After the changes:**
- `npm test`, `npm run e2e`, `npm run size`, `npm run bench` and `npm run bench -- --cpu 4`;
- the load time, the frame p95 and the initial-load bytes must stay inside the `CLAUDE.md` spec;
- the brain is re-tuned on the changed game: one more coordinate pass from the current parameters.

## Step 5: the recorder (`scripts/record.ts`, `npm run record`)

- **Profiles:**
  - **desktop:** 1280×720 CSS at 2×, giving 2560×1440 (3× for 4K), mouse and keyboard;
  - **phone:** 432×576 CSS at 2.5×, giving 1080×1440 for the Short's middle, touch.
- **Each frame:**
  1. send the hands' events and wait for the handshake;
  2. step the clock: sound first, then timers, then the frame;
  3. on decision frames, the snapshot comes back and goes to the brain;
  4. capture, if on.
- **Encode.**
  - libx264: `-preset slow -crf 16 -profile:v high -pix_fmt yuv420p -g 30 -bf 2`.
  - BT.709 conversion with `setparams` tags (the ffmpeg 8 lesson from Bubbler).
- **Event log** (`run.json`, in frames):
  - Play, and 5:00;
  - mass milestones: 100, 500, 1 000, 2 500, 5 000 and so on;
  - region changes, and entering and leaving a maze;
  - eats (what, how big, mass and points gained), splits, explosions (chain step), rainbow on and off;
  - leaderboard rank changes, especially #1;
  - toasts;
  - death (killer).

  Also the hash and the HUD numbers every second.
- **Modes:**
  - `dry` (no capture);
  - `capture`, which checks against a dry run's hashes;
  - `pieces` (the Short's windows);
  - `watch`: a visible Chrome in real time, with no virtual clock and no capture, the quick way to see the bot play.

## Step 6: run search (`npm run record -- search`)

- **Desktop:** dry runs of 200 seeds, 6 at a time, about 40 minutes.
  - Each run plays 5:00, plus the 3 s hold that ends the video.
  - Ranked by mass at 5:00 among runs alive through the hold, then by peak mass.
- **Phone:** 100 seeds by touch, the same goal, about 20 minutes. Ranked by mass at 5:00, and by the moments the Short
  needs: a rainbow chain, a split-kill, reaching #1.
- **The search's statistics** go next to the Node harness's (step 3, check 4).
- **Is picking a seed cheating?** It is choosing which attempt to publish, as a player shows their best run. Within the
  run, the bot plays fair.

## Step 7: the pilot

Record the first 90 s of the chosen desktop run at final settings, and check:

- **Time:** time per frame, and from it the full render time (x264's speed included). If x264 is the limit,
  `-preset medium`.
- **Determinism:** the capture's hashes equal the dry run's, and rendering on or off gives the same hashes.
- **Motion:** while the camera moves, no two consecutive frames are identical.
- **Sync:** a chomp's sound starts within one frame of its `eat` event.
- **Timing:** the "GO!" toast is up for 1.4 s, and the countdown ticks once a second, each to within a frame.
- **Look:** stills of the cursor, the countdown, fonts, flags, emoji, the HUD and a maze.
- **Visual bugs:** a frame-exact recording shows what play hides, such as the static layer's "pop" on redraw (plan 0's
  H2) or a blank frame. If the pop shows, the fix (a whole-pixel blit or a short crossfade) goes in before the master.

## Step 8: the YouTube video

- **One render of the whole run, about 5:15:**
  - **Opening (about 6 s).** A 1 s fade-in on the menu over attract mode. The cursor types "Rad" and clicks Play, "GO!"
    shows, and the countdown starts at 5:00.
  - **5:00 of play,** no cuts.
  - **Closing.**
    - At 0:00 the cursor parks the cell, and the frame holds for 3 s.
    - Then an 8 s end card over the dimmed last frame: "Mass N in 5 minutes", "#1 on the leaderboard" (when it is),
      and "Play free at c0.muon.day".
    - 8 s leaves room for YouTube's end-screen elements, which need at least 5.
- **Sound.**
  - The game's own effects; the game has no music (open question 4).
  - −14 LUFS with true peak ≤ −1 dBTP after the AAC encode, using Bubbler's measured gain-and-limiter loop.
  - AAC at 384 kbit/s, stereo from the mono mix, muxed without re-encoding the video, `+faststart`.
- **`youtube.txt`:**
  - title options, around the final mass ("From 10 to N mass in 5 minutes");
  - a description: what the game is, the controls, and two links: "Play: https://c0.muon.day/" and
    "Source: https://github.com/boomgogo/cell";
  - that it's the game's own autoplay bot, seeing only the screen, in one take;
  - the final numbers: mass at 5:00, peak mass, points, when it reached #1, the biggest chain;
  - chapters at growth milestones, such as the start, the first rainbow, out of the maze, #1, mass 1 000 and 5:00.
    They follow YouTube's rules: the first at 0:00, at least 3, each at least 10 s;
  - tags.
- **Thumbnails:** 1280×720 stills with no text:
  - the final cell at #1;
  - the best rainbow chain;
  - the mass-10 start, for a before-and-after you can put together.

## Step 9: the Short

- **Pieces from the phone run,** about 5–8 s each, telling the 5 minutes:
  - **hook** (2 s): the final size, with the countdown at 0:00;
  - the start: mass 10, 5:00 to go;
  - the maze lines, then a spore → "RAINBOW!";
  - the best chain;
  - a split-kill;
  - the move to #1;
  - the final mass.
- **Captured in one replay** (see the approach). The sound is sliced from the replay's own offline render.
- **Layout.**
  - The game, 1080×1440, sits under a 170 px title band ("C E L L"), with a 310 px band below: one line on what it is,
    and "Play free at c0.muon.day". This is Bubbler's layout: Shorts' buttons cover the right edge and the caption
    covers the bottom.
  - 0.25 s crossfades, −14 LUFS, 60 s at most.
- **`short.txt`:** a title ("10 to N mass in 5 minutes #shorts") and a description with "Play: https://c0.muon.day/".
- **Check:** Shorts' safe-zone boxes drawn over a still.

## Step 10: the X video

- **Cut from the master,** scaled to 1920×1080. A square crop would cut off the leaderboard, the minimap and the score
  box in the corners.
- **The cut** (30–45 s; X plays muted, so the first seconds carry it):
  - the final size first (2 s);
  - back to the mass-10 start;
  - 3–4 growth moments: a rainbow chain, a split-kill, #1;
  - the final mass;
  - the end card with "Play free at c0.muon.day".
- **Encode:** H.264 High and AAC, inside X's limits (2:20, 512 MB, 60 fps).
- **`x.txt`:** the post, under 280 characters, with the play and source links. X counts each link as 23 characters.

## Step 11: tests, docs, next

- **`tests/unit/autoplay.test.ts` (new):**
  - **Snapshot fairness:** moving a dormant NPC, an off-screen cell or off-screen food, or drawing from `world.rng`,
    leaves the snapshot unchanged. Nothing dormant ever appears in it.
  - **Brain scenarios:**
    - it flees a bigger cell, and a lunge-capable one from farther away;
    - it chases a smaller cell;
    - it never splits next to a virus or with a threat in reach;
    - it goes for a spore when it fits;
    - it leaves a maze before packing;
    - it parks at 5:00.
  - **Hands:**
    - paths start at the cursor and end on the target;
    - reaction and press rates stay within bounds;
    - the same seed gives the same events.
  - **Harness:** the same seed and parameters give the same mass at 5:00.
  - **Points:** as in step 1.
  - **Chapters** follow YouTube's rules.
- **README:**
  - a "Play at https://c0.muon.day/" line at the top;
  - `npm run autoplay` (tune), `npm run record` (with `watch`), `npm run cut` and `--out`;
  - the gameplay changes.

  The deploy section keeps `cell.<your-subdomain>.workers.dev` for forks.
- **`ai/summary.md`:** §4 and §9 for whatever the rules or NPCs changed.
- **`ai/next_1.md`:**
  - what was built;
  - the bugs found and fixed;
  - the gameplay changes with their before and after numbers;
  - the tuning: the opening that won, the parameters, the brain against the baseline on held-out seeds, and Node
    against the browser;
  - the pilot's numbers;
  - the files made;
  - what's next.

## Done when

- `npm test` and `npm run e2e` pass. `npm run size` is unchanged apart from the HUD text changes, and load and frame
  times stay inside the spec.
- No merge, pop or explosion pays points, and every other event pays as in the table.
- **On held-out seeds,** the tuned brain is alive at 5:00 in at least 70 % of runs, and its best-10 % mean mass
  clearly beats the baseline's. The numbers go in `next_1.md`.
- Every recording's hashes match its dry run's, second by second.
- The pilot's checks pass: identical hashes, no frozen frames, sound within a frame, toasts and countdown on time.
- **`ffprobe` confirms each file's format:**
  - YouTube: 2560×1440 (or 3840×2160) at a constant 60 fps, H.264 High, AAC, 5:00 of play and about 5:15 in all;
  - Short: 1080×1920, at most 60 s;
  - X: 1920×1080, at most 2:20 and under 512 MB.
- **Loudness:** every file at −14 ± 1 LUFS, with true peak at or under −1 dBTP.
- **Contact sheets** (every 15 s for YouTube, every 3 s for the short ones) show:
  - the HUD whole;
  - the cursor or touch dots where they should be;
  - flags and emoji drawn;
  - no blank frames.

## Risks

- **The handshake might be slow, or might never see some events.** The fallback dispatches the same events inside the
  page as `PointerEvent`s and key events for both the dry run and the recording. The game reads the same fields, so
  play is unchanged; only the events become synthetic.
- **Rendering off might change the run.** The pilot's check catches it. Then dry runs render too: 5.5 ms a frame
  instead of 2, so a search takes about 2.5× longer.
- **A sprint takes risks, and risky runs die.** Runs that die before 5:00 don't count, so the 70 % floor stays in the
  tuning. If the best runs come out small, `next_1.md` says what held them back.
- **Tuning to the harness.**
  - The Node harness is not the browser, and 200 seeds can be overfitted.
  - The held-out seeds and the browser search's statistics are the checks. The parameters change only when both agree.
- **Gameplay changes could shift the budgets.** Each is measured, and the spec wins.
- **The chomp sound** runs through the whole video. Listen before uploading (open question 4).
- **Not verifiable here:** how YouTube and X process the files, whether the bot reads as a person, and how the mix
  sounds.
- **Deploy before posting.** Uploading and deploying are yours. Every video links to c0.muon.day, so deploy the fixed
  build (`npm run deploy`) before posting: a viewer who follows the link should find the same game, without the
  merge-points bug and with the new HUD.

## Files

| File | Change |
|---|---|
| `src/sim/events.ts`, `src/sim/world.ts` | `eat` events carry the prey's owner |
| `src/ui/points.ts` (new) | arcade points per event, DOM-free; no points for merging your own cells |
| `src/game.ts` | uses `points.ts`; points on the death card |
| `src/ui/hud.ts`, `index.html` | "Mass" in the arcade Score box |
| `src/ai/bot.ts`, `src/config/tuned.ts` | NPC exploring and other fixes and tuning from step 4, as the data shows |
| `tests/unit/maze.test.ts`, `tests/unit/ai.test.ts` | timing margins |
| `tests/unit/points.test.ts`, `tests/unit/autoplay.test.ts` (new) | points, snapshot fairness, brain, hands, harness, chapters |
| `tests/e2e/play.spec.ts` | the Mass label, points on the death card |
| `scripts/autoplay/snapshot.ts`, `brain.ts`, `hands.ts`, `sim.ts` (new) | what a player sees, the player brain and its `BrainParams`, the hands, the Node harness |
| `scripts/autoplay/params.json` (new) | the tuned parameters, written by the tuning and read by the recorder |
| `scripts/autoplay.ts` (new) | `tune`: openings, coordinate search and held-out checks across seeds, in worker threads |
| `scripts/record/page.ts` (new) | injected: clock, timers, seeded random, offline audio, handshake, hashes, snapshot, cursor and touch dots, countdown, fade |
| `scripts/record/ffmpeg.ts` (new) | x264 and BT.709, WAV, loudness, mux (ported) |
| `scripts/record.ts` (new) | dry, capture, pieces, search, pilot, watch |
| `scripts/cut.ts` (new) | YouTube text, chapters, stills and end card; the Short; the X cut |
| `package.json`, `.gitignore`, `README.md`, `ai/summary.md` | scripts, `recordings/`, docs |

Not changing, apart from step 4's measured fixes: the rendering, the look, the load path or anything else a player
downloads.

## Open questions (the default I'll use if you don't say otherwise)

The video length (about 5 minutes, as big as possible at 5:00), the play link (c0.muon.day) and the nickname (Rad) are
decided; see the top.

1. **Saying it's a bot.** Default: yes, in the descriptions ("the game's own autoplay bot, seeing only the screen, one
   take"), not on screen.
2. **The player's flag.** Default: none (`?geo=0`), so the video says nothing about where it was made. The
   alternative is a country you pick, stored in the profile.
3. **X's frame.** Default: 16:9 from the master, so all the HUD shows. The alternatives:
   - 1:1: bigger in the timeline, but it loses the HUD corners;
   - the vertical Short again: no extra work, but the same video twice.
4. **Sound.** Default: the game's own effects only, since there is no music. The alternative is a music bed under them,
   from a track you have the rights to (I won't pick one).
5. **The countdown.** Default: a 5:00 countdown on screen in the HUD's style, recording only, so a viewer sees the race
   against the clock. The alternative is none, with the time only in the title and the end card.
6. **The Short's form.** Default: highlights of the phone run (about 50 s). The alternative is the whole 5 minutes at
   6× speed: continuous growth from tiny to big, but frantic.
7. **Resolution.** Default: 1440p60, about 20–30 minutes to render. At 5 minutes, 4K60 is affordable (about an hour),
   and YouTube gives 4K uploads its best encode at every size.
8. **Gameplay changes.** Default: bug fixes, plus small, measured tuning and the two HUD tweaks, before recording.
   Anything bigger goes into `next_1.md` as a proposal. Say if you want a freer hand, or no rule changes at all.
