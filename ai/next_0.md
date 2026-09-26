# Next 0: what plan 0 did, and what comes next

This summarises the implementation of `ai/plan_0.md` (answering `ai/prompt_0.md`), measured on 2026-09-26.

## 1. The flicker

**Cause (confirmed).**

- When adaptive quality changed level, `Game.frame()` resized the canvas *after* the frame had been drawn.
- Setting `canvas.width` wipes the canvas, and because it has no alpha the wiped canvas is opaque black. The browser
  showed that blank frame.
- The controller judged the rAF interval, not load. At 60 Hz a p95 of about 24 ms (the odd missed vsync) was over its
  22 ms budget, so it stepped down every 1.5–2 s, blinking each time.
- A Playwright check showed that the old order (render, then resize) leaves a uniform canvas.

**Fix.**

- `src/game.ts`: window resizes and level changes set `pendingResize`. It is applied at the start of the next frame,
  before `render()`.
- `CanvasRenderer.resize()` returns early when the pixel size and DPR are unchanged. On a DPR 1 display, no quality
  change resizes at all.
- `src/render/quality.ts`:
  - It records frame work time as well as the interval.
  - A step down needs an interval p95 over 22 ms **and** either a median interval over 20 ms (the frame rate is low,
    whether GPU or CPU bound) or work p95 over 60 % of the median interval.
  - A step up needs a vsync-bound median (≤ 17.5 ms) and work p95 under 35 % of it, for three windows.
  - The first 2 s are ignored (start-up).
  - After a down → up → down flip-flop the level is locked: it only steps down again for really slow frames (p95 over
    33 ms and median over 20 ms).
  - Stepping down stays one level per window, so an overloaded device recovers as fast as before. An early version held
    each level for 5 s, which left the rainbow bench scene stuck at level 4. That hold was removed.
- The debug panel (`?debug=1`) logs quality changes (with dt p50/p95 and work p95), resizes and static layer redraws
  with their reason (`StaticLayer.lastReason`: invalid / style / size / zoom / move / turn). It also shows level
  changes per minute and whether the level is locked.

**Still to explain.** With the old code, a 60 Hz display can only step down in quality, so the blinks should stop at
level 6 after about 10 s. You saw them as ongoing, and on the test machine the old code went 0 → 1 once and then
stayed. If you still see anything flicker, the debug panel's log will show whether it is a quality change, a resize or
a layer redraw.

## 2. Country flags

- **Atlas.**
  - `scripts/flags-atlas.ts` (`npm run flags`) uses system Chrome to rasterise all 249 ISO flags from `flag-icons`
    (MIT, a new dev dependency).
  - Output: 64×48 cells, 16 per row, in `src/assets/flags.webp` (98 KB), plus the code index
    `src/assets/flagIndex.ts`. Both are committed.
- **Flags module.**
  - `src/render/canvas/flags.ts` is a lazy chunk (1.6 KB gzip), loaded in idle time after start-up.
  - It decodes the atlas, assigns NPC countries, and draws flags next to cell names (key outline, dropped at fx 2) and
    as CSS backgrounds in leaderboard rows.
  - Resident phages have no flag.
- **NPC countries.**
  - `src/geo/countries.ts` holds the 74 most populous countries (UN WPP 2024, 2025 estimates). The rest of the world
    population is spread evenly over the other flags.
  - The pick is `hash01(seed, id, SALT)`, not `world.rng`, so seeded worlds are unchanged.
  - An NPC keeps its country when it respawns.
- **Player country.**
  - `src/geo/locate.ts` is a lazy chunk (0.5 KB gzip).
  - Order: `/cdn-cgi/trace` → `api.country.is` → `get.geojs.io`, each with a 2.5 s timeout, then the region of the
    browser language.
  - `XX` and `T1` are rejected.
  - The result is cached in `localStorage` (`cell.country`) for 7 days. A result from the language region is not
    cached.
- `?flags=0` turns flags off; `?geo=0` skips the lookup.

## 3. GitHub link

- "Fork me on GitHub" with an inline GitHub mark, in the menu panel under the help lines, pointing to
  `https://github.com/boomgogo/cell`.
- It opens in a new tab; the nick field keeps its focus.
- There is no Esc pause screen, as decided.

## 4. Measured

Measured on this machine: Intel HD 630 (ANGLE/EGL), headless Chrome. This is a different GPU from `summary.md` §8. The
HEAD baseline below was measured on the same machine.

- **Initial load:** 49.9 KB gzip (48.6 KB before). The HTML/CSS for the link and flags adds 0.5 KB, and the quality
  and wiring code about 0.8 KB. Budget 60 KB.
- **Load to an interactive menu, Slow 4G, 4× CPU:** 1.42–1.55 s. HEAD was 1.44–1.56 s.
- **Render, 4× CPU, frame p50 / p95 (ms) and final quality level:**

  | Scene | HEAD | Now |
  |---|---|---|
  | plains desktop | 16.2 / 30.1, L2 | 16.1 / 30.1, L1 |
  | plains phone | 16.3 / 29.8, L2 | 16.4 / 29.5, L0 |
  | maze desktop | 16.5 / 30.2, L2 | 16.3 / 32.9, L2 |
  | maze phone | 16.7 / 29.1, L1 | 16.8 / 29.0, L0 |
  | rainbow desktop | 14.5 / 36.6, L6 | 18.1–23.5 / 37–108, L6 |
  | rainbow phone | 14.7 / 34.1, L3 | 14.0–15.5 / 35–48, L3–6 |

  - The rainbow scene varies a lot from run to run with its explosion chains.
  - A run with `flags=0` was as slow as the slowest run with flags, so the flags are not the cost.
  - Smooth scenes now keep better quality: level 0–1 instead of 1–2.
- **Tests:** 134 of 135 unit tests pass.
  - New: `quality.test.ts` (7) and `geo.test.ts` (9).
  - `ai.test.ts` › "plains: an r-450 grazer … covers more than 3 r" times out at about 5.1 s against the 5 s limit. It
    fails the same way on a clean HEAD checkout on this machine; it is not caused by this change.
- **e2e:** 14 of 14 pass.
  - New in `flags.spec.ts`: the player flag from a stubbed trace, NPC and resident countries, leaderboard flags, the
    all-lookups-fail path, the GitHub link, and no blank frame across quality changes.

## 5. Next

1. **Check on your machine.** Chrome at 60 Hz without `?quality=0`: no blink over a couple of minutes, in the menu
   and while playing. If anything still flickers, open `?debug=1` and read the event log.
2. **Check `/cdn-cgi/trace` after deploy.** Confirm it answers on `*.workers.dev` (or your custom domain) with a
   `loc=` line. If it doesn't, the fallbacks take over, and those send the IP to a third party.
3. **The NPC test timeout.** Give the slow `ai.test.ts` exploring tests a longer timeout (for example 15 s), or make
   them lighter.
4. **Static layer pop (H2 in plan 0), if it is visible.** While moving, the cached floor and walls snap on each
   redraw (up to 2 % scale). The options are a whole-pixel blit, a crossfade on redraw, or a lower zoom threshold.
5. **More ideas for the multiplayer feel:**
   - re-roll an NPC's name and country on respawn ("a new player joined"),
   - names that match the country,
   - a country toast when the leader changes.
6. **Open items from `summary.md` §9 still stand:** the bundle is over the 40 KB target, there has been no real-device
   test, and some NPCs still get stuck.
