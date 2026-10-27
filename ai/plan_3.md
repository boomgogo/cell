# Plan 3: p3p2 0.2.0, with p3p2's own button and panel

This plan answers `ai/prompt_3.md`:
1. update `@p3p2/client` to 0.2.0;
2. say why Cell doesn't use p3p2's logo and box as they come, and if nothing stops it, use them;
3. keep **Play with friends** on the menu, and make it open the same box.

Nothing here is implemented yet.

## How I read the prompt

- **"The p3p2 client logo and box"** are the two parts of p3p2's built-in UI (`ui` in `new P3P2(...)`):
  - the **logo** is the multiplayer button in a corner of the screen. It shows the p3p2 mark (three players), which
    is new in 0.2; 0.1.1's button showed 👥. Cell turns it off with `ui: { button: false }`.
  - the **box** is the panel (`<p3p2-panel>`), with *Join?*, the invite link and QR code, who is here, and chat. Cell
    hides it outside a room (one CSS rule in `index.html`), and asks *Join?* and hosts from its own menu
    (`src/ui/friends.ts`).
- **"Use what comes with the p3p2 client"** means the button and the panel as p3p2 draws them and as they behave. Cell
  only decides where the button sits and moves its own HUD out of the way.
- **"Play with friends … should open the same p3p2 client box"**: the menu's button calls `p3p2.open()`, in a room
  and out of one. The button in the corner opens the same panel.

## What I checked while planning

| | Found |
|---|---|
| npm | `@p3p2/client` 0.2.0 came out on 2026-10-26, and 0.1.2 on 2026-10-23. Cell locks 0.1.1, and `^0.1.1` never reaches 0.2 (for 0.x, a caret stays inside the minor version). |
| Release notes and "From 0.1 to 0.2" (`docs/integrate.md` at v0.2.0) | `p3p2.host()`, `room.isMod`, `room.kick()`, `room.end()` and the error codes `room-url` and `room` are gone. Everyone, the room's owner too, joins through the room's invite link. The owner gets that link in the server's portal, where the room has it from the start; **Open** on the room's page opens the game with it. The owner removes players and ends the game in the portal. `Smooth` now defaults to `coast: 0`. The new error codes are `hidden` (a front-page link whose last characters are left out) and `name` (a name somebody in the room already has). The protocol is still version 1, and nothing on the wire changed. |
| What Cell uses of that | Only `p3p2.host()` (`src/ui/friends.ts:65`). Nothing calls `isMod`, `kick`, `end` or `Smooth`, and no code checks the `room-url` or `room` error codes (the menu shows `err.message`). `Net`, `wire` and `predict` don't change. |
| Sizes, gzip -9 of the published files | Entry 1.91 → 1.97 KB; p3p2-core 8.90 → 8.81 KB; panel 5.27 → 6.29 KB; QR 2.59 KB, unchanged. |
| The panel in 0.2.0 (read from the package's source maps) | **Outside a room:** "Multiplayer – Powered by p3p2", "Share one small p3p2 relay server. Already have one? Open the invite link from the server. No server yet? p3p2.me says how to get one." **Join?:** the room, who hosts and how many are playing. Then *The last N characters* (only for a front-page link), *Your name* (at most 24, filled in with p3p2's remembered name `p3p2:name`, or the `name` given to `join`), and **Join** / **Play alone**. **Play alone** removes `?room=` from the address. When a room ends, the panel opens and says why. Keys typed in the panel don't reach the game. |
| The button in 0.2.0 | `position: fixed` at 12 px from the corner's two edges, set inline (`corner`, default top-right), with z-index 2147483000. It is 34 px tall and 42 px wide when alone, about 57 px with a member count. The mark is gray when alone, teal and pulsing while the room is live. A red unread-chat badge sits 8 px past the button's top-right corner. The button hides while the panel is open, and the panel opens from the same corner. |
| Servers | hub.p3p2.me now works the 0.2 way: create a room, press **Open**, and the game asks *Join?*. A 0.2 server still takes 0.1 clients, so the Cell deployed today keeps working until this change ships. |
| The p3p2 checkout for tests | `scripts/p3p2.ts` looks in `~/Repos/p3p2` (`/home/p1/Repos/p3p2`), which doesn't exist on this machine now. The checkout is beside Cell's, at `../p3p2`, at `ac08884` (0.1.1). So today `npm run e2e` skips every multiplayer test. In 0.2's portal, a new room comes with its invite link, the owner removes a player with **Kick**, and the login page is `/login`, because the front page can list rooms (from p3p2's own `e2e/tests/helpers.ts` at v0.2.0). |
| Names | Cell's name field takes 15 characters and doesn't remember them. A p3p2 name takes 24 letters and digits of any language, spaces and `. - _ '`. p3p2 remembers it per site, and a room refuses a name one of its members has, ignoring capitals. |
| The corners today | Top left: the minimap and mute button (arcade). Top right: the leaderboard (240 px wide, 168 on a phone), `pointer-events: none`. Bottom left: the score and the arcade HUD. Bottom right: the version, plus Split and W while playing on touch. |

## The answer: why they weren't used as they come

| What | Why plan 2 did it | In 0.2 |
|---|---|---|
| **No button** (`button: false`) | Every corner was taken (plan 2, "The corners"), so the menu's own button opened the panel. | The corners are still taken, but that is a layout problem, and leaving the button out has a cost. The menu is hidden during play, so **a player can't open the panel while playing**: no chat, no list of who is here, no invite link to pass on, only between lives. 0.2's live mark and unread-chat badge sit on that button, and they matter most during play. **No reason left. Use it (§2).** |
| **The panel hidden outside a room; the menu hosts and asks *Join?*** | 0.1.1's panel was a hosting form, with a room URL and **a name field of its own**, and its *Join?* had one too. After plan 2's report you chose "one name, the menu's", so the menu did both through the API, and the panel was hidden outside a room so its own form couldn't pop up. | Hosting is gone (`p3p2.host()`), so the menu's room URL form has to go either way. Outside a room, the panel now explains what multiplayer needs and links p3p2.me. Its *Join?* also asks for the characters a front-page link leaves out, and for another name when the room already has that one. Cell's own *Join?* would have to rebuild both. One name still holds: the panel's field starts with the name Cell gives it, and once in, the menu takes the room's name and locks it, as it does now. **No reason left. Use it (§3).** |
| **No chat key** (`chatKey: false`) | "Enter plays." | p3p2's chat key ignores keys typed into a field, so Enter in the menu's name field still plays. During play Enter does nothing in Cell. **No reason left.** Restore p3p2's default (§3, open question 3). |

## 1. The client to 0.2.0

- `npm install @p3p2/client@^0.2.0`: `package.json` and the lockfile.
- Remove the one use of `host()` (§3). `tsc` finds nothing else.
- `Net`, `wire.ts`, `predict.ts` and `rules.ts` don't change. `tests/unit/net.test.ts` runs as it is, through its
  in-memory room.
- Update the comments that talk about room URLs and hosting from the menu: `src/main.ts`, `src/ui/friends.ts`,
  `src/ui/hud.ts`, and the header of `scripts/p3p2.ts`.

## 2. p3p2's button, as it comes

- **Options:** `new P3P2({ game: { id: 'cell', version: __BUILD__ } })`, with no `button: false` and no `corner`.
  The button sits in p3p2's default corner, top-right.
- **Why top-right.** Every corner holds something, so whichever corner p3p2 gets, something of Cell's moves:

  | Corner | What would move |
  |---|---|
  | **Top right (p3p2's default)** | **The leaderboard moves down 42 px, under the button.** It takes no input, and the panel opens over it while it's open. |
  | Top left | The minimap, mute button and, on a phone, the district banner all move down. The minimap takes taps. |
  | Bottom right | Free on a desktop, but Split and W sit there on touch. The corner can't depend on touch: `corner` is fixed when p3p2 starts, and a laptop can have both. |
  | Bottom left | The score and the arcade HUD move up, into the play area above them. |

- **The leaderboard:** `top: calc(max(12px, env(safe-area-inset-top)) + 42px)`. That is the 34 px button and an
  8 px gap, at every width.
- **The safe area.** The page uses `viewport-fit=cover`, and p3p2 places the button 12 px from the screen's edge. On a
  phone on its side, that puts it under a notch or a rounded corner. One CSS rule gives the button the same inset as
  Cell's HUD:
  `p3p2-panel { top: max(12px, env(safe-area-inset-top)) !important; right: max(12px, env(safe-area-inset-right)) !important; }`.
  It moves only the button's position, not the button. It is noted for p3p2 in `next_3.md`, since every game with
  `viewport-fit=cover` needs it.
- **When it shows:** on the menu and during play, alone and in a room, as p3p2 intends. Alone it is gray and opens
  the panel that explains multiplayer. In a room it is teal, shows how many are here, and has the unread-chat badge.
- **A phone on its side (740×360).** Before any change, measure whether the leaderboard already reaches Split and W
  there. By its CSS it is about 270 px tall, against Split's top at about 256 px. If moving it down makes it cover
  them where it didn't before, then under 480 px of height the leaderboard shows the top 5 and your own row, not the
  top 10. Decide this from the measurement, and record it in `next_3.md`.
- **The menu.** The button sits over the menu's backdrop. On a 320 px screen it may cover the edge of the menu panel's
  top-right corner. The e2e test checks that it covers none of the menu's controls.

## 3. p3p2's panel, as it comes; Play with friends opens it

**Removed:**
- `body:not(.in-room) p3p2-panel { display: none; }`;
- the hosting form: `#host-form`, `#room-url`, **Create the invite link** and `#host-status`, along with
  `ROOM_URL_KEY` and its storage;
- the menu's *Join?*: `#invite`, `#alone`, PLAY reading Join, `Game.invite`, `Hud.setInvite`, and the `peek` call;
- the line "Hosting? Get a room URL at p3p2.me", since the panel now says the same, with the link (open question 2).

**The menu:**
- **Play with friends** calls `p3p2.open()`, in a room and out of one. Its label stays "Play with friends", and
  "Friends · 3" in a room, as plan 2 chose.
- The room line under the links stays. It is Cell's own information: "In ‹room› · 2 players · Ada runs this world",
  or why the room ended.

**A page opened from an invite.** `friends.ts` calls `p3p2.start()` in place of `resume()` plus its own *Join?*:
- it comes back into the room after a reload, or else shows the panel's *Join?*;
- the panel's name field starts with p3p2's remembered name. The menu's field is empty at that point, because Cell
  doesn't remember names, so there is nothing to pass to `join`;
- **Play alone** in the panel removes `?room=` from the address, so a reload doesn't ask again. That is p3p2's own
  behaviour, and the code Cell had for it goes.

**One name:**
- once in a room, the menu's field takes `room.self.name` and becomes read-only, as it does now. The colony, the
  panel's member list and chat show one name;
- whatever was typed in the panel is that name. When the room ends, the field is editable again;
- p3p2 allows 24 characters and Cell's colonies 15. A longer name shows its first 15 characters on the colony and in
  full in the panel (open question 6).

**Joining in the middle of a game.** The panel's *Join?* stays open if the player presses PLAY on the menu instead,
and they can press **Join** later, with a colony alive.
- If the page is the room's first, it becomes the host, and its world becomes the room's world. Play goes on.
- If the page joins as a guest, today's `Net.becomeGuest` removes the colony without a death, so the game stays
  "playing" with no cells and no menu.
- **The fix:** a guest's page that enters a room while playing goes back to the menu, which shows the room line, and
  PLAY puts the colony into the host's world. This is a few lines in `becomeGuest`, using the existing
  `Game.refused` path, or a sibling of it with no message.
- The same check covers entering a room from the death screen.

**Chat by Enter** (p3p2's default `chatKey`, open question 3):
- in a room during play, Enter opens chat, and sending or Esc gives the keys back to the game;
- the panel stops keys from reaching the game while typing, so W and Space typed in chat don't eject or split;
- on the menu, Enter in the name field still plays.

**When a room ends,** the panel opens and gives the reason ("You were removed from the room."), and the menu's room
line says it too.

## 4. Tests

**Unit.** No changes: `npm test` (172) must pass as it is.

**The fixture** (`tests/e2e/p3p2.ts`) follows p3p2 0.2's own helpers:
- `createRoom(browser, server, name, { players?, front? })` logs in at `/login`, creates the room, and returns
  `{ invite, portal, close }`. The portal page stays open for kicking a player;
- `host(page, invite, name)` opens the invite and answers the panel's *Join?* with the name. That page is first in,
  so it hosts;
- `accept(page, name)` fills *Your name* in the panel and clicks **Join**;
- `kick(owner, name)` presses **Kick** on the room's page in the portal;
- `through(invite, server, proxy)` sends an invite link through the lag proxy;
- `P3P2_DIR` looks in `~/Repos/p3p2` first, then in the checkout beside Cell's (`../p3p2`), which is where it is
  on this machine.

**`friends.spec.ts`:**

| Test | Change |
|---|---|
| Alone | Unchanged without a click: no request to a server, no WebSocket, no room code. New: clicking p3p2's button opens the panel with "Open the invite link from the server" and the p3p2.me link. The panel and core chunks load; `Net` doesn't, and still nothing asks a server anything. |
| One name → **the panel** | Bob opens the invite. The panel asks "Join Names on 127.0.0.1:…? Hosted by Ada · 1 player". **Play alone** plays alone, and the address loses `?room=`. Cat joins with no name: her menu says "Player N", read-only. Dan types "ada": the panel says the room has that name, and "Dan" joins. The owner kicks Cat in the portal: Cat's panel opens with "You were removed from the room.", her room line says the same, and her name field is editable again. |
| A front-page link (new) | A room on the server's front page with the last 4 characters left out. The panel asks for them; wrong ones get "Those aren't the right characters.", and the right ones join. |
| Joining mid-game (new) | Opened from an invite, PLAY first, then **Join** in the panel as a guest. The menu comes back with the room line, and PLAY puts the colony into the host's world. |
| Chat during play (new) | Enter opens chat. Typing "w w" ejects nothing (the mass is unchanged). Enter sends. The other page's button shows the badge "1", and its panel shows the line. On the menu, Enter still plays. |
| A phone | Also: tapping p3p2's button opens the panel, which fits the screen. |
| The rest (two players, the host leaving, a reload, a bad connection, rules, a full world) | Through the new `createRoom`/`host`/`accept`. Nothing else changes. |

**`play.spec.ts`:**
- **The button's place (new).** At 1280×800, 412×915, 320×640 and 740×360, on the menu and during play (touch on the
  phones), the button overlaps none of the leaderboard, minimap, mute button, banner, score, arcade HUD, touch
  buttons or version. On the menu it covers none of the controls, and the panel, opened, fits the screen.
- The version test adds the button to the elements the version must not cover.
- "Menu links": the p3p2.me check moves into the panel, opened by **Play with friends**.
- "The menu fits 320 px": `#room-url` and `#create` drop out of the list.

**`engines.spec.ts`** uses the new helpers. It stays opt-in.

## 5. Measured before and after

- **Before any change:** `npm run size`, `npm run bench` load (Slow 4G, 4× CPU), the seed-70 dry run's per-second
  hashes, and screenshots of the HUD at the four viewports. Record all of them in the session's scratchpad.
- **Size:** initial load was 54.8 KB gzip. The entry grows by about 0.06 KB, and `friends.ts` and `index.html`
  shrink. Expect about 54.5 KB, against a 60 KB budget.
- **Load:** within 5 % of plan 2's 1,396–1,480 ms.
- **Solo play:** the same 303 hashes. The button lives in the DOM, outside the canvas and the sim.
- **Recordings** (`npm run record`) would now show the gray button, with the leaderboard lower. Default: the
  recorder hides the button and puts the leaderboard back at the top, with two CSS rules in
  `scripts/record/page.ts`, so new recordings look like the old ones (open question 5).

## 6. Documents

- **`README.md`, "Playing with friends":**
  - hosting: create a room in a p3p2 server's portal (hub.p3p2.me or your own), with `https://c0.muon.day/` as its
    game URL, press **Open**, answer *Join?*, and send the link from the panel;
  - joining: the panel's *Join?*;
  - one name; the button in the corner;
  - the local server: press **Open** on the room's page;
  - the e2e line.
- **`ai/summary.md`:** §1 (dependency), §3 (friends: the menu and the panel), §5 (the menu), §6 (tools).
- **`ai/next_3.md`:** what was built and measured, and the notes for p3p2 (the safe-area inset).

## Files

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `@p3p2/client` `^0.2.0` |
| `src/main.ts` | The `P3P2` options: the button and chat key as they come |
| `src/ui/friends.ts` | `p3p2.start()`; Play with friends calls `open()`; one name. Hosting, the menu's *Join?* and the room URL storage go. |
| `src/ui/hud.ts` | The invite, Play alone and hosting form elements, and `setInvite`, go |
| `src/game.ts` | `invite` goes; a way back to the menu for a guest that enters a room mid-game |
| `src/net/Net.ts` | `becomeGuest` while playing → the menu |
| `index.html` | The hosting form, *Join?* parts and p3p2.me line go; the panel shows outside a room; the button's safe-area inset; the leaderboard under the button |
| `scripts/p3p2.ts` | `P3P2_DIR` falls back to `../p3p2`; header text for 0.2 |
| `scripts/record/page.ts` | Hides the button in recordings (open question 5) |
| `tests/e2e/p3p2.ts`, `friends.spec.ts`, `play.spec.ts`, `engines.spec.ts` | §4 |
| `README.md`, `ai/summary.md`, `ai/next_3.md` | §6 |

## Open questions (each has a default, so work can go on)

1. **The button's corner.** **Default: top-right, p3p2's default, with the leaderboard moved down 42 px under it.**
   The alternatives are in §2.
2. **The p3p2.me line on the menu** ("Hosting? Get a room URL at p3p2.me"). **Default: remove it.** Play with
   friends opens the panel, which says the same with the link, and "room URL" is wrong for 0.2 anyway. The other
   choice is a reworded line, "Need a server? p3p2.me".
3. **Enter for chat in a room.** **Default: p3p2's default, on.** Enter in the menu's name field still plays.
4. **The p3p2 checkout for tests** (`../p3p2`, at `ac08884`, on `main` with a clean tree). **Default:
   `git pull --ff-only` there, then `npm ci --workspace server`.** That changes another repository of yours, so say
   if you'd rather have a separate clone at `v0.2.0` (for example under `p3p2_test_repos/`). Tests use an in-memory
   database, so 0.2's database change doesn't matter to them. A server started with `npm run p3p2 -- --data …` on a
   0.1 database can't go back to 0.1 afterwards.
5. **The button in recordings.** **Default: hidden, with the leaderboard back at the top,** so recordings of solo
   play look as they did.
6. **Names longer than 15.** **Default: colonies keep 15 characters**, since the leaderboard is narrow. The panel
   shows the whole name. The other choice is raising Cell's limit to p3p2's 24.

## Not in this plan

- Deploying, and trying it with a real friend through hub.p3p2.me (`next_2.md`, item 1), which is yours to do.
  After the deploy, the room's game URL must be `https://c0.muon.day/`. Players on the old build can't join a room
  with players on the new one until they reload, because the version is the commit.
- The rest of `next_2.md`: a cheaper world around extra players, a smaller save, WebKit, and a guest's own splits
  and ejects.
