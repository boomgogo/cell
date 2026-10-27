# Next 3: what plan 3 built, what it found, and what comes next

Implements `ai/plan_3.md`:
- `@p3p2/client` 0.2.0;
- p3p2's button and panel as they come;
- **Play with friends** opens the same panel.

Every open question took its default. Nothing was committed, deployed or tried with a real friend; those are yours to
do.

## What there is

- **p3p2's button**, with p3p2's mark, in its top-right corner, 12 px in. It is gray alone, and teal in a room with
  how many are here and a red badge for unread chat. It is there on the menu and during play, so a player can chat,
  see who is here and copy the invite link mid-game.
  - The leaderboard sits 42 px lower, under the button.
  - One CSS rule gives the button the HUD's safe-area inset (`index.html`).
- **p3p2's panel**, opened by the button or by **Play with friends**.
  - Outside a room it says what playing with friends takes, with the p3p2.me link. The menu's own p3p2.me line is
    gone.
  - A page opened from an invite gets the panel's *Join?* (`p3p2.start()`), which also asks for the characters a
    front-page link leaves out, and for another name when the room has that one. **Play alone** takes `?room=` out
    of the address.
  - In a room it has the invite link and QR code, who is here, and chat. During play, Enter opens the chat; Enter in
    the menu's name field still plays.
- **Gone:**
  - the room URL form and **Create the invite link**, because 0.2 has no `p3p2.host()`;
  - the menu's own *Join?*, Play alone, PLAY reading Join;
  - `Game.invite` and `Hud.setInvite`;
  - the CSS that hid the panel outside a room.

  `src/ui/friends.ts` is 26 lines, down from 136.
- **One name.** The name given in *Join?* goes on the menu, read-only in the room as before, and on the colony (its
  first 15 characters; p3p2 allows 24).
- **Hosting now** means creating a room in a p3p2 server's portal, pressing **Open** on its page, and answering
  *Join?*. The first one in runs the world. The owner removes players, or ends the game, on the room's page.
- **Recordings** hide the button and keep the leaderboard at the top: two CSS rules in `scripts/record/page.ts`, in
  dry runs too.
- **The p3p2 checkout.** When I went to update `../p3p2`, it was already at `5a90f83` (v0.2.0 released), on `main`,
  clean. I only ran `npm ci --workspace server`.
  - `scripts/p3p2.ts` now looks in `P3P2_DIR`, then `~/Repos/p3p2`, then `../p3p2`.
  - `~/Repos/p3p2` doesn't exist on this machine (`$HOME` is `/home/p1`). So before this change, `npm run e2e`
    silently skipped every multiplayer test.

## Found and fixed

1. **Two quick Enters in the name field started two games.** This was already there before plan 3: the HEAD build
   does it too.
   - The browser moves focus off a field that has just been hidden only at its next rendering step. Until then,
     a second Enter still reaches the field and submits the form again.
   - In a room, the same thing swallowed the chat key.
   - `Hud.hideMenu` now takes the focus out of the name field.
   - e2e test: "Enter twice in the name field plays once".
2. **Joining as a guest in the middle of a game left the page "playing" with no cells and no menu.** That couldn't
   happen before, because a room could only be opened from the menu. Now the panel's *Join?* stays up if the player
   presses PLAY instead.
   - `Net.roles` calls `Game.joined()` on a page's first role decision when it comes in as a guest, and the menu
     comes back, in the room.
   - A host that becomes a guest (its page went to the background) plays on.
   - Unit test and e2e test.
3. **On a phone on its side (740×360) the leaderboard already overlapped Split and W**, by 24 px (it ended at
   y 280, the buttons start at 256). Moving it down would have made that 66 px. Under 480 px of height it now shows
   the top 5 and your own row, and ends at y 225, 31 px clear.
4. **A flaky e2e test, "arcade: menu → play → eaten".** It failed 1 run in 36 on HEAD, and 5 in 54 with this
   change.
   - After the rainbow explosion, the test switches the player's rainbow off next to the NPC's pieces, which
     sometimes eat the player before the test drops its big NPC on it, so the drop step read a dead player's cell.
   - That step now takes "already eaten" as eaten. 30 of 30 runs pass.

**Not fixed (it was like this before).** At 320 px wide, the district banner (on phones, under the minimap) sits partly
under the leaderboard: 40 px of its width, before and now.

No p3p2 bug was found, and p3p2 is unchanged. One note for p3p2: a page with `viewport-fit=cover` needs the button
inset by `env(safe-area-inset-*)`. p3p2 sets `top`/`right: 12px` inline, so a game has to override them with
`!important`.

## Measured

| | Before | After |
|---|---|---|
| Initial load, gzip (`npm run size`) | 54.8 KB | **53.9 KB** (budget 60) |
| Load to an interactive menu, Slow 4G, 4× CPU | 1,521 / 1,388 / 1,424 ms | 1,525 / 1,403 / 1,420 ms |
| Solo dry run, seed 70, per-second state hashes | | **303 of 303 the same**, same end (mass 2,503, 37,545 points) |
| Lazy chunks (Vite gzip) | panel 4.9 KB, core 8.1 KB | panel 5.9 KB, core 8.0 KB |

- The panel and core chunks now load when the button or **Play with friends** is first pressed, or on a page opened
  from an invite. Still no server is asked anything until a room is joined, and `Net` loads only in a room (the
  "alone" test).
- **HUD boxes** (the session's scratchpad, `before/hud` and `after/hud`): the button is 42×34 px at (w − 54, 12) on
  1280×800, 412×915, 320×640 and 740×360. On the menu it covers no control, and in play nothing of the HUD.
- **What hosting sends** (`friends.spec.ts`, the full world, 8 guests, nine pages on this laptop): views
  2.8 KB/s per guest, host upload 29.6 KB/s, a save of 74.4 KB packed to 35.0 KB. The same as plan 2.

## Tests

- **`npm test`:** 173 of 173. New: a page playing alone that comes in first hosts and plays on. As a guest it goes
  back to the menu, and PLAY puts it in the host's world. A host that becomes a guest plays on.
- **`npm run e2e`:** 35 passed and 13 skipped. The skipped ones are the 12 multiplayer tests and the button test,
  which make their own phones, so they skip themselves in the phone project.
  - The fixture (`tests/e2e/p3p2.ts`) follows p3p2 0.2's own helpers:
    - `createRoom` returns the owner's portal page and the invite;
    - `host` opens the invite on the page, keeping its own parameters, and answers *Join?*;
    - `accept` answers the panel's *Join?*;
    - `kick` removes a player in the portal;
    - `onFrontPage` and `through` cover front-page links and the lag proxy.
  - New or rewritten:
    - **the panel's *Join?*:** Play alone; no name gives "Player N"; "ada" is refused while Ada is in, then Dan
      joins; kicked in the portal, the panel and the menu both say so;
    - **a front-page link:** wrong characters are refused, the right ones (in capitals) join;
    - **joining mid-game;**
    - **chat during play:** Enter opens it, "w w hello" neither ejects nor splits, the other page gets the badge
      and the line;
    - **the button's place** at four sizes, on the menu and in play, with the panel fitting;
    - **Enter twice;**
    - "alone" also opens the panel by the button;
    - the phone opens it by the button too.
- **`npm run e2e:engines`:** passed with Chrome and Firefox in one room. WebKit still can't launch without its system
  libraries.

## Not verified

- Real people on real devices, through hub.p3p2.me, from the deployed site. The hub works the 0.2 way: create a
  room, **Open**, *Join?*. The room's game URL must be `https://c0.muon.day/`.
- How p3p2's dark button looks on the paper stock, judged by eye. Screenshots are in the session's scratchpad
  (`after/hud`).
- A real recording with the button hidden. Only the dry run was run, and it matched every hash.
- WebKit.

## What to work on next

1. **Deploy, then play with a friend** through hub.p3p2.me: **Open** from the portal, *Join?* in the panel, a
   phone, chat by Enter, the host leaving.
2. **The banner under the leaderboard at 320 px.** It was there before: on phones the banner could sit under the
   minimap's right edge instead, or the leaderboard could narrow.
3. From `next_2.md`:
   - a cheaper world around extra players;
   - a smaller save;
   - WebKit (`sudo npx playwright install-deps webkit`);
   - a guest's own splits and ejects at once.
