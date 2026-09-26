# Plan 0: fix the render flicker, add country flags, add a GitHub link

This plan answers `ai/prompt_0.md`. It starts from the state in `ai/summary.md` (the public release, 2026-09-24).
Nothing here is implemented yet.

Work order: **1 → 2 → 3**. The flicker fix comes first, because the flags add to the same draw path and the
flicker would hide any regressions they cause.

---

## 1. Issue: the render flickers every 1–2 seconds

### 1.1 What the code does now

I read the code and found three likely causes, most likely first. None has been confirmed in a browser yet.

**H1. Adaptive quality clears the visible canvas (most likely).**

- `Game.frame()` (`src/game.ts:370`) calls `this.resize()` whenever `QualityController.record()` changes the level.
  It does this *after* `renderer.render()` in the same rAF callback.
- `CanvasRenderer.resize()` sets `canvas.width/height`. That wipes the canvas, and because the context is
  `alpha: false` the wiped canvas is opaque black. The browser then shows that blank frame, so the screen blinks. The
  resize also calls `layer.invalidate()`, so the next frame redraws the static layer as well.
- It resizes on every level change, even when `dprCap` is unchanged (0↔1 only toggles grain; 3↔4↔5↔6 keep DPR 1).
- `record()` decides every 120 frames or every 1.5 s. That matches "every 1–2 s".
- It measures the **rAF interval (`dt`)**, not the work done in the frame. This makes it fire too often:
  - **60 Hz display.** `summary.md` §8 measured a p95 of about 24 ms in every scene, even at 1× CPU, because a few
    frames miss vsync. That is over the 22 ms budget, so the level climbs 0 → 6, blinking at each step. At level 6 the
    grid is turned off as well.
  - **120/144 Hz display.** The p95 drops below 14 ms, so the level steps down after 3 windows. A slower window then
    pushes it back up. It never settles, and it blinks each time.

**H2. The cached static layer jumps when it is redrawn.**

- Between redraws, `StaticLayer.draw()` (`src/render/canvas/staticLayer.ts`) reuses the layer by moving, rotating and
  scaling it. It redraws when:
  - the camera has moved about 20 % of the screen,
  - the zoom has changed by more than 2 %, or
  - the camera has turned more than 0.06 rad.
- While you move or grow, one of these happens every 1–2 s.
- At each redraw:
  - The content jumps by up to 2 % scale. That is about 10–20 px at the edge of a 1080p screen.
  - It also jumps by the gap between the moved layer and a true re-projection. This gap is bigger when zoomed out in
    mazes.
  - The dot grid and wall tubes go from resampled (soft) back to crisp. The transform uses sub-pixel offsets and
    rotation, so they are soft between redraws.
- On the opaque dot grid, this reads as a periodic shimmer or pop.

**H3. Smaller steps that can look like flicker.**

- The floor colour near region borders changes in 1/20 steps (`floorAt`).
- Name sprites change size in 2 px steps (`textSprite`).
- The grid lattice doubles its spacing at zoom thresholds (`levelSpacing`).
- These are rare and small, so they are probably not "every 1–2 s", but they get checked in the same pass.

### 1.2 Confirm before fixing

1. **Quick check by you (open question Q1).** Load the game with `?quality=0`, which turns off adaptive quality. If
   the blink goes away, H1 is confirmed. If a softer "jump" of the floor and walls remains while moving, that is H2.
   Please also note:
   - your display's refresh rate and browser,
   - whether it happens in the menu (attract mode) or only while playing,
   - whether it is a full-screen blink or the background jumping.
2. **Instrumentation (debug only, under `?debug=1`).**
   - Add a ring buffer of frame events: `dt`, work ms, quality level changes, `resize()` calls, and static layer
     redraws with their reason (move / zoom / turn / style / size).
   - Show the last few events in the debug panel's live stats.
   - This goes in the lazy debug chunk, so the initial bundle does not grow.
3. **Automated repro.**
   - A Playwright script (`scripts/flicker.ts`, run like `bench`) records a CDP screencast
     (`Page.startScreencast`) for 20 s in the `plains` and `maze` scenes.
   - It flags frames whose mean luminance drops sharply against their neighbours (blank frames), and frames with a
     large global pixel shift (layer pops).
   - It logs each flagged frame next to the frame event log.

### 1.3 Fix

For H1 (expected to be the main fix):

- **Never clear the canvas outside a render.** `record()` only sets a `pendingResize` flag. `frame()` applies it at
  the start of the next frame, *before* `render()`, so the wiped canvas is always painted over before it is shown.
- **Only resize when the device pixel size really changes.** `renderer.resize()` compares the new `dpr` with the
  current one. Grain, points, dents, membranes and fx changes need no resize and no layer invalidate. The grid on/off
  change goes through the layer's style key, which it already does.
- **Measure load, not vsync.**
  - Record the frame's work time (`performance.now()` around `frame()`) alongside `dt`.
  - Estimate the display interval as the median `dt`.
  - Step down only when work p95 is over about 75 % of the interval **and** `dt` p95 is over budget.
  - Step up only when work p95 is under about 40 % of the interval.
  - The 22 ms and 14 ms figures stop depending on the refresh rate.
- **Hysteresis and cool-down.**
  - After any change, hold the level for at least 5 s.
  - After a down → up → down flip-flop, lock the level for the session. It can still step down if frames get really
    slow, for example past 33 ms p95.
- Keep `?quality=N` and the debug toggle working as they do today.

For H2, only if step 1.2 shows it is visible:

- **Snap the layer blit to whole device pixels** when angle = 0 and scale = 1, so there is no sub-pixel blur between
  redraws.
- **Crossfade.** On a redraw, draw the old layer at the old transform and fade in the new one over about 120 ms. This
  needs a second offscreen canvas (double buffer). It costs about 1.5× screen pixels of memory. On phones, only do it
  at quality ≤ 2.
- **Lower the zoom threshold** from 2 % to 1 %, checking redraw cost with `lastDrawMs` in `bench`.

For H3: leave it unless the repro shows it.

### 1.4 Tests

- **Unit (`tests/unit/quality.test.ts`, new).**
  - Feed the controller synthetic `dt` and work sequences for 60, 120 and 144 Hz, with vsync jitter (5 % of frames
    doubled).
  - Assert that it settles with at most 1 level change after warm-up and never flip-flops.
  - A really overloaded device (work 30 ms at 60 Hz) must still step down within 2 windows.
- **e2e.** In `?manual=1`, force a quality change (`__game.quality.level`/`apply` plus the pending resize). After
  each `advance()`, check that the canvas is not uniformly black.
- **Bench.** Re-run `npm run bench` and `-- --cpu 4`. Frame p95 must not regress, and the final quality level at 1×
  CPU should now stay at 0–1 instead of climbing.

---

## 2. Feature: country flags (a "false sense of multiplayer")

### 2.1 Behaviour

- Every NPC colony and the player get a country (ISO 3166-1 alpha-2 code) and a small flat flag.
- **Resident phages get no flag.** They are the maze monsters, not "players". See Q3.
- The flag is drawn **next to the cell's name label**: to its left, vertically centred, with its height equal to the
  name's cap height. It appears wherever a name is drawn today, so each named cell of a split organism has one.
- Cells too small to show a name show no flag.
- Riso look: flat flag colours with a thin key outline, like the other printed elements.
- The flag also shows in the leaderboard rows, before the name (tiny inline images from the same atlas). This is
  optional; see Q4.

### 2.2 Choosing NPC countries

- A static table, `src/geo/countries.ts`, lists ISO code → population in millions, using UN World Population
  Prospects estimates.
- It covers about the 60 most populous countries (about 90 % of world population). The rest go into one "other" bucket
  that picks uniformly from the remaining ISO codes, so a rare Iceland or Fiji still turns up.
- The pick is weighted by population: India and China about 17 % each, the US about 4 %, and so on.
- **Determinism.** The pick uses `hash01(worldSeed, org.id, SALT)`, not `world.rng`. Taking values from `world.rng`
  would shift every later draw, which would change seeded worlds, arena results and e2e seeds.
  - The country is presentation only, so the sim never reads it.
  - `Organism` gets a `country: string` field (`''` means none).
- **Respawn.** An NPC keeps its name when it respawns, so it keeps its country too. Re-rolling both on respawn to look
  like "a new player joined" is possible; see Q5.

### 2.3 The player's country

`src/geo/locate.ts` exports `locateCountry(): Promise<string | null>`. Each step has a 2.5 s timeout
(`AbortController`) and moves on when it fails:

1. **`/cdn-cgi/trace`**
   - It is same-origin on Cloudflare, so there is no CORS or third party. It returns lines such as `loc=AU`.
   - Parse the `loc=` line.
   - Reject `XX` (unknown) and `T1` (Tor).
   - Check during implementation that it answers on `*.workers.dev` as well as on a custom domain.
2. **`https://api.country.is/`**
   - Free, open source, allows cross-origin requests, returns `{ ip, country }`.
3. **`https://get.geojs.io/v1/ip/country`**
   - Free, allows cross-origin requests, returns the code as plain text.
   - Note that **ipify.org only returns the IP address, not a country**, so it can't be a fallback on its own. It would
     need a second geo lookup. I suggest country.is and geojs instead; see Q2.
4. **Offline fallback**
   - The region of `navigator.language` (`en-AU` → `AU`), if it has one.
   - Otherwise no flag.

Caching and timing:

- The result is cached in `localStorage` (`cell.country`, with a timestamp, for 7 days) through the existing
  `readStore`/`writeStore`, so repeat visits make no request.
- It starts **after the first frame, in idle time**. It never blocks the menu or Play, so the load budget is not
  touched.
- If it resolves after Play, the flag just appears.
- In `npm run dev` and `wrangler dev`, `/cdn-cgi/trace` is probably missing, which exercises the fallbacks.

Privacy: steps 2 and 3 send the visitor's IP to a third party. The README gets a short note saying so, and only runs
them when step 1 fails. They can be turned off with `?geo=0`, which is also used in tests.

### 2.4 Flag graphics

Canvas text can't be relied on for flags: **Windows has no flag emoji**, so 🇦🇺 draws as the letters "AU".

- **Build a flag atlas once, from `flag-icons`** (MIT, flat 4:3 SVGs).
  - A script, `scripts/flags-atlas.ts`, uses Playwright's Chrome (already a dev dependency) to rasterise every flag.
  - Output: 48×36 px cells, a single WebP (PNG fallback not needed: WebP decodes in every target browser), plus a
    code → slot index.
  - The atlas and index are committed under `src/assets/`, so builds don't depend on the script.
  - Budget: ≤ 120 KB. If it goes over, include only the table's countries plus "other".
- **Load it lazily.** A lazy module, `src/render/canvas/flags.ts`, is loaded after the first frame, like the minimap.
  It holds the atlas URL (Vite hashes it, so `_headers` caches it as immutable), the country table and the picker.
  When it lands, countries are assigned to all organisms. The hash keeps that deterministic whenever it runs.
  - The initial bundle grows only by the `import()` call and the `country` field, so it stays inside the 60 KB budget.
    `npm run size` checks this.
- **Draw it in `drawText`** with one `drawImage` from the atlas per labelled cell. It is scaled to the name height,
  capped at about 28 CSS px, and outlined with one `strokeRect` in key colour.
  - It draws nothing until the atlas has decoded.
  - At quality ≥ 5, skip the outline.
  - Cost: at most a few dozen extra `drawImage` calls per frame. Check it with `bench`.

### 2.5 Tests

- **Unit.**
  - The weighted picker: over 100 k hashed picks, the shares are within ±1 % of population shares, and the same inputs
    always give the same pick.
  - The trace parser (`loc=`, `XX`, `T1`, junk).
  - `locateCountry` with mocked `fetch`: the order of fallbacks, timeouts, the cache hit, and `?geo=0`.
- **e2e.**
  - Use `page.route` to stub `/cdn-cgi/trace` with `loc=NZ` and block the third-party hosts. Check that
    `__game.human.country === 'NZ'` after Play, and that most NPCs have a non-empty country.
  - A second run with every lookup failing still plays normally.

---

## 3. Feature: "Fork me on GitHub" link, and an Esc pause overlay

### 3.1 The pause overlay (new)

The prompt mentions an "ESC pause overlay", but none exists yet. Esc does nothing today. So this plan adds one; see
Q6.

- **Esc** while playing opens a pause panel. Esc again, or a **Resume** button, closes it.
- The panel uses the same `.panel` style as the menu: "Paused", Resume, a "Quit to menu" link, and the GitHub link.
- **Pausing:**
  - `frame()` skips sim steps and keeps `acc` at 0.
  - The renderer keeps drawing the frozen world, with membranes still wobbling, so the screen stays alive.
  - Queued split/eject input is dropped on resume.
  - The sound's rainbow loop is suspended through `Sfx`.
  - Leaving the tab while playing pauses too (`visibilitychange`). That stops the 250 ms `dt` clamp from moving the
    sim forward behind the player's back.
- **Touch devices have no Esc.** A small ⏸ button goes next to the mute button while playing. It uses the same style
  as `#mute`.
- **Quit to menu** returns to the menu as if eaten, but with no death message.

### 3.2 The link

- The target is `https://github.com/boomgogo/cell`, taken from `git remote`. See Q7.
- It goes in two places:
  - the menu panel (the "player name" panel), under the help lines,
  - the pause panel.
- It is a small inline link with an inline SVG GitHub mark and the text **Fork me on GitHub**. It uses key colour and
  a flat ink underline, in riso style.
  - It is not the classic corner ribbon: that would overlap the leaderboard at top right and the minimap at top left.
- It opens in a new tab (`target="_blank" rel="noopener"`), so the game is not lost.
- The link should not take keyboard focus away from the nick field when the menu opens. Tab order: nick → Play →
  link.
- It adds no network requests and less than 1 KB of HTML and CSS.

### 3.3 Tests

- **e2e.**
  - The link is visible in the menu with the right `href`.
  - Play, then Esc: the pause panel is visible with the link, and `__game.world.tick` does not advance for 1 s.
  - Esc again resumes: the tick advances.
  - On the phone viewport, tapping ⏸ gives the same result.

---

## 4. Docs and wrap-up

- **README:**
  - new URL parameters: `?geo=0`, and `?flags=0` if added,
  - Esc / ⏸ pause,
  - where flags come from, with the privacy note,
  - the `flag-icons` attribution (MIT, compatible with the GPL-3.0 licence).
- **Run** `npm test`, `npm run e2e`, `npm run build && npm run size`, `npm run bench`, and `npm run bench -- --cpu 4`.
- **Write `ai/next_0.md`:** what was done, measured numbers, and what's next.

## 5. Open questions

- **Q1.** Can you try `?quality=0` on the machine where you see the flicker, and tell me the display refresh rate and
  browser? That would confirm H1 before any code changes. Otherwise I will rely on the automated repro in §1.2.
- **Q2.** Backup geo services: is **country.is → geojs.io** OK in place of ipify? ipify only gives the IP, not a
  country.
- **Q3.** Should resident phages (T4, Lambda, Phi, Mu) have flags? The proposal is no.
- **Q4.** Should flags also appear in the leaderboard? The proposal is yes: it makes the "multiplayer" feel stronger
  for little cost.
- **Q5.** Should an NPC get a new name and country when it respawns, to look like a new player joining? The proposal
  is no for now. It keeps names stable and the sim unchanged.
- **Q6.** The pause overlay is new. Is Esc/⏸ pause with Resume and Quit what you had in mind?
- **Q7.** Is `https://github.com/boomgogo/cell` the right URL?
