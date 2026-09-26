# Plan 0: fix the render flicker, add country flags, add a GitHub link

This plan answers `ai/prompt_0.md`, including its Q&A. It starts from the state in `ai/summary.md` (the public
release, 2026-09-24). Nothing here is implemented yet.

Work order: **1 → 2 → 3**. The flicker fix comes first, because the flags add to the same draw path.

What the Q&A settled:

- **Flicker.** You see it in Chrome on a 60 Hz display, and `?quality=0` fixes it. `?quality=0` turns adaptive quality
  off, so the cause is in adaptive quality (H1 below). This is confirmed.
- **Backup geo services.** country.is and then geojs.io are approved.
- **GitHub link.** It goes to `https://github.com/boomgogo/cell`, on the player name / Play overlay only.
- **No Esc pause screen.** It is not being built.

---

## 1. Issue: the render flickers every 1–2 seconds

### 1.1 Cause

The cause is in adaptive quality (`src/render/quality.ts`, `src/game.ts`).

**Why the screen blinks:**

- `Game.frame()` (`src/game.ts:370`) calls `this.resize()` whenever `QualityController.record()` changes the level.
- It does this *after* `renderer.render()` in the same rAF callback.
- `CanvasRenderer.resize()` sets `canvas.width/height`. That wipes the canvas, and because the context is
  `alpha: false` the wiped canvas is opaque black. The browser then shows that blank frame.
- The resize also calls `layer.invalidate()`, so the next frame redraws the whole static layer, which is a slow frame.
- It resizes on **every** level change, even when the device pixel ratio does not change:
  - Level 0 → 1 only turns the grain off.
  - Levels 3–6 all use DPR 1.
  - On a DPR 1 desktop display, no level change needs a resize at all.

**Why it happens every 1–2 s:**

- `record()` decides every 120 frames or every 1.5 s. At 60 Hz that is about every 1.5–2 s.
- It measures the **rAF interval (`dt`)**, not the work done in the frame. At 60 Hz, a p95 above the 22 ms budget
  only means that more than 5 % of frames missed vsync. `summary.md` §8 measured a p95 of about 24 ms in every scene,
  even at 1× CPU.
- So the controller keeps judging a smooth game as overloaded. The slow frame after each resize (the static layer
  redraw) adds to the next window's p95.

**Still to explain:** how it keeps going.

- By the code, a 60 Hz display can only step *up*. Stepping down needs a p95 under 14 ms, which a 60 Hz display can't
  reach. So the blinking should stop at level 6 after about 10 s.
- You describe it as ongoing. So something is resetting or cycling the level, or the steps last longer than I expect.
- The event log in §1.2 is meant to show which. The fix in §1.3 removes the blink either way.

### 1.2 Instrumentation (debug only, under `?debug=1`)

- Add a ring buffer of frame events: `dt`, the frame's work ms, quality level changes, `resize()` calls, and static
  layer redraws with their reason (move / zoom / turn / style / size).
- Show the last few events, and a count of level changes per minute, in the debug panel's live stats.
- This goes in the lazy debug chunk, so the initial bundle does not grow.
- Use it once before the fix, to explain why the blinking keeps going, and once after, to check that there are no
  resizes and the level stays still.

### 1.3 Fix

- **Never clear the canvas outside a render.**
  - `record()` only sets a `pendingResize` flag.
  - `frame()` applies it at the start of the next frame, *before* `render()`, so the wiped canvas is always painted
    over before it is shown.
- **Only resize when the device pixel size really changes.** `renderer.resize()` compares the new `dpr` with the
  current one and returns early when it is the same.
  - Grain, points, dents, membranes and fx changes need no resize and no layer invalidate.
  - The grid on/off change already goes through the layer's style key.
- **Measure load, not vsync.**
  - Record the frame's work time (`performance.now()` around `frame()`) alongside `dt`.
  - Estimate the display interval as the median `dt`.
  - Step down only when work p95 is over about 75 % of the interval **and** `dt` p95 is over budget.
  - Step up only when work p95 is under about 40 % of the interval.
  - The thresholds then work at any refresh rate: 60, 120 or 144 Hz.
- **Hysteresis and cool-down.**
  - After any change, hold the level for at least 5 s.
  - After a down → up → down flip-flop, lock the level for the session. It can still step down if frames get really
    slow, for example past 33 ms p95.
- Keep `?quality=N` and the debug "adaptive quality" toggle working as they do today.

Not in this fix: the static layer "pop" on redraw and the other small steps found while reading the code. `?quality=0`
removed the flicker you saw, so those are not it. If the layer still looks jumpy while moving after the fix, it becomes
a follow-up. The options are snapping the layer blit to whole pixels, crossfading on redraw, and a lower zoom
threshold.

### 1.4 Tests

- **Unit (`tests/unit/quality.test.ts`, new).**
  - Feed the controller synthetic `dt` and work sequences for 60, 120 and 144 Hz, with vsync jitter (5 % of frames
    doubled) and light work.
  - Assert that it stays at level 0–1 and never flip-flops.
  - A really overloaded device (work 30 ms at 60 Hz) must still step down within 2 windows.
- **e2e.**
  - In `?manual=1`, force a quality change, then call `advance()`.
  - Check that the canvas is never uniformly black.
  - Check that the canvas backing size is unchanged when the DPR cap does not change.
- **Bench.** Re-run `npm run bench` and `npm run bench -- --cpu 4`. Frame p95 must not regress. The final quality level
  at 1× CPU should now stay at 0–1 instead of climbing.
- **By hand.** Chrome at 60 Hz, default settings (adaptive on): no blink over 2 minutes in the menu and while playing.

---

## 2. Feature: country flags (a "false sense of multiplayer")

### 2.1 Behaviour

- Every NPC colony and the player get a country (ISO 3166-1 alpha-2 code) and a small flat flag.
- **Resident phages get no flag.** They are the maze monsters, not "players". See Q1.
- The flag is drawn **next to the cell's name label**: to its left, vertically centred, with its height equal to the
  name's cap height. It appears wherever a name is drawn today, so each named cell of a split organism has one.
- Cells too small to show a name show no flag.
- Riso look: flat flag colours with a thin key outline, like the other printed elements.
- The flag also shows in the leaderboard rows, before the name (tiny inline images from the same atlas). This is
  optional; see Q2.

### 2.2 Choosing NPC countries

- A static table lists ISO code → population in millions, using UN World Population Prospects estimates.
- It covers about the 60 most populous countries (about 90 % of world population). The rest go into one "other" bucket
  that picks uniformly from the remaining ISO codes, so a rare Iceland or Fiji still turns up.
- The pick is weighted by population: India and China about 17 % each, the US about 4 %, and so on.
- **Determinism.** The pick uses `hash01(worldSeed, org.id, SALT)` (`src/core/rng.ts`), not `world.rng`. Taking values
  from `world.rng` would shift every later draw, which would change seeded worlds, arena results and e2e seeds.
  - The country is presentation only, so the sim never reads it.
  - `Organism` gets a `country: string` field (`''` means none).
- **Respawn.** An NPC keeps its name when it respawns, so it keeps its country too. See Q3.

### 2.3 The player's country

`src/geo/locate.ts` exports `locateCountry(): Promise<string | null>`. Each step has a 2.5 s timeout
(`AbortController`) and moves on when it fails:

1. **`/cdn-cgi/trace`**
   - It is same-origin on Cloudflare, so there is no CORS or third party. It returns lines such as `loc=AU`.
   - Parse the `loc=` line.
   - Reject `XX` (unknown) and `T1` (Tor).
   - Check during implementation that it answers on `*.workers.dev` as well as on a custom domain.
2. **`https://api.country.is/`** returns `{ ip, country }` and allows cross-origin requests.
3. **`https://get.geojs.io/v1/ip/country`** returns the code as plain text and allows cross-origin requests.
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

Privacy: steps 2 and 3 send the visitor's IP to a third party, and only run when step 1 fails. The README gets a short
note saying so. `?geo=0` skips all lookups; tests use it too.

### 2.4 Flag graphics

Canvas text can't be relied on for flags: **Windows has no flag emoji**, so 🇦🇺 draws as the letters "AU".

- **Build a flag atlas once, from `flag-icons`** (MIT, flat 4:3 SVGs).
  - A script, `scripts/flags-atlas.ts`, uses Playwright's Chrome (already a dev dependency) to rasterise every flag.
  - Output: 48×36 px cells in a single WebP, which decodes in every target browser, plus a code → slot index.
  - The atlas and index are committed under `src/assets/`, so builds don't depend on the script.
  - Budget: ≤ 120 KB. If it goes over, include only the table's countries plus "other".
- **Load it lazily.** A lazy module, `src/render/canvas/flags.ts`, is loaded after the first frame, like the minimap.
  - It holds the atlas URL (Vite hashes it, so `_headers` caches it as immutable), the country table and the picker.
  - When it lands, countries are assigned to all organisms. The hash keeps that deterministic whenever it runs.
  - The initial bundle grows only by the `import()` call and the `country` field, so it stays inside the 60 KB budget.
    `npm run size` checks this.
- **Draw it in `CanvasRenderer.drawText`** with one `drawImage` from the atlas per labelled cell.
  - It is scaled to the name height, capped at about 28 CSS px, and outlined with one `strokeRect` in key colour.
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

## 3. Feature: "Fork me on GitHub" link on the player name / Play overlay

- **Where:** only in the menu panel (`#menu .panel` in `index.html`), which holds the nick field and Play. It goes under
  the help lines.
  - The menu is shown at start and after death, so the link is there both times.
- **What:** a small inline link with an inline SVG GitHub mark and the text **Fork me on GitHub**, pointing to
  `https://github.com/boomgogo/cell`. It uses key colour and a flat ink underline, in riso style.
  - It is not the classic corner ribbon: that would overlap the leaderboard at top right and the minimap at top left.
- **Behaviour:**
  - It opens in a new tab (`target="_blank" rel="noopener"`), so the game is not lost.
  - The nick field keeps its focus when the menu opens.
  - Tab order is nick → Play → link.
  - Clicking the link must not submit the form or start a game.
- **Cost:** no network requests, and under 1 KB of HTML, CSS and inline SVG.
- **Tests (e2e):** the link is visible in the menu on desktop and phone viewports, with the right `href` and
  `target`. It is visible again in the menu after death.

---

## 4. Docs and wrap-up

- **README:**
  - the new URL parameter `?geo=0`,
  - where flags come from, with the privacy note,
  - the `flag-icons` attribution (MIT, compatible with the GPL-3.0 licence),
  - the adaptive-quality change.
- **`ai/summary.md` §3:** update the adaptive-quality bullet to say it measures work time and resizes only on a DPR
  change.
- **Run:**
  - `npm test`
  - `npm run e2e`
  - `npm run build && npm run size`
  - `npm run bench`
  - `npm run bench -- --cpu 4`
- **Write `ai/next_0.md`:** what was done, measured numbers, and what's next.

## 5. Open questions (the Q&A did not cover these; the proposals are what I will do unless told otherwise)

- **Q1.** Should resident phages (T4, Lambda, Phi, Mu) have flags? The proposal is no: they are the maze monsters.
- **Q2.** Should flags also appear in the leaderboard? The proposal is yes: it makes the "multiplayer" feel stronger
  for little cost.
- **Q3.** Should an NPC get a new name and country when it respawns, to look like a new player joining? The proposal
  is no for now. It keeps names stable and the sim unchanged.
