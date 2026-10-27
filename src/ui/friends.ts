// The menu's half of playing with friends. p3p2's panel does the rest as it comes: its Join? for a page opened from an
// invite link (with the characters a front-page link leaves out, and another name when the room has that one), the
// invite link and QR code, who is here, and chat. Outside a room it says what playing with friends takes, with a link
// to p3p2.me. One name: in a room the menu's is the room's, and read-only, since p3p2 has no renaming.
import type { P3P2 } from '@p3p2/client';
import type { Game } from '../game.ts';

export function mountFriends(game: Game, p3p2: P3P2): void {
  const hud = game.hud;

  // "Play with friends": the same panel as p3p2's button, in a room and out of one.
  hud.friends.addEventListener('click', () => void p3p2.open());

  p3p2.on('room', (room) => {
    hud.nick.value = room.self.name.slice(0, 15);
    hud.nick.readOnly = true;
    hud.nick.title = 'Your name in this room';
  });
  p3p2.on('leave', () => {
    hud.nick.readOnly = false;
    hud.nick.title = '';
  });

  // Back into the room after a reload, without asking; else the panel's Join? for the invite in the address, if any.
  void p3p2.start().catch(() => null);
}
