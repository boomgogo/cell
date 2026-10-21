// The menu's half of playing with friends: one name, the menu's. p3p2's panel asks for a name of its own, so the menu
// hosts (with a room URL from a p3p2 server's portal) and answers an invite itself, and gives p3p2 the menu's name.
// The panel shows only while the page is in a room (index.html), with what a room has: the invite link and QR code,
// who is here, and chat. In a room the name is the room's: p3p2 has no renaming, so the menu's field is read-only.
import type { Invite, P3P2 } from '@p3p2/client';
import type { Game } from '../game.ts';

/** The room URL last hosted with, for next time. */
const ROOM_URL_KEY = 'cell.room-url';

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the field starts empty next time */
  }
}

/** A server's address as a person reads it: `hub.p3p2.me`. */
function where(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function mountFriends(game: Game, p3p2: P3P2): void {
  const hud = game.hud;
  const name = () => hud.nick.value.trim().slice(0, 15);
  const say = (text: string) => {
    hud.hostStatus.textContent = text;
    hud.hostStatus.hidden = !text;
  };

  // "Play with friends": the room URL to host with. In a room: the panel.
  hud.friends.addEventListener('click', () => {
    if (p3p2.room) {
      void p3p2.open();
      return;
    }
    hud.hostForm.hidden = !hud.hostForm.hidden;
    if (hud.hostForm.hidden) return;
    if (!hud.roomUrl.value) hud.roomUrl.value = readStore(ROOM_URL_KEY) ?? '';
    hud.roomUrl.focus();
  });
  hud.hostForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = hud.roomUrl.value.trim();
    if (!url) {
      say('Paste a room URL from p3p2.me, or from a p3p2 server of your own.');
      return;
    }
    hud.create.disabled = true;
    say('Connecting…');
    p3p2
      .host(url, { name: name() })
      .then(
        () => {
          writeStore(ROOM_URL_KEY, url);
          say('');
          // The invite link to send.
          void p3p2.open();
        },
        (err: Error) => say(err.message),
      )
      .finally(() => (hud.create.disabled = false));
  });

  // A page opened from an invite: "Join?", in the menu, with the menu's name. PLAY reads Join.
  const ask = (invite: Invite) => {
    const at = where(invite.server);
    let lead = `Join a room on ${at}?`;
    let detail = '';
    hud.setInvite('Looking up the invite…', '', false);
    game.invite = (n) => {
      hud.setInvite(lead, 'Joining…', false);
      p3p2.join(invite, { ask: false, name: n }).catch((err: Error) => game.invite && hud.setInvite(lead, err.message));
    };
    p3p2.peek(invite).then(
      (d) => {
        lead = `Join ${d.roomName} on ${at}?`;
        detail = d.hostName ? `Hosted by ${d.hostName} · ${d.members === 1 ? '1 player' : `${d.members} players`}` : 'Nobody is here yet';
      },
      (err: Error) => {
        lead = `You were invited to a room on ${at}.`;
        detail = err.message;
      },
    ).finally(() => game.invite && hud.setInvite(lead, detail));
  };
  hud.alone.addEventListener('click', () => {
    game.invite = null;
    hud.setInvite(null);
    // Out of the address, so a reload does not ask again.
    try {
      const url = new URL(location.href);
      url.searchParams.delete(p3p2.options.urlParam || 'room');
      history.replaceState(history.state, '', url);
    } catch {
      /* the address stays as it is */
    }
    game.play(name());
  });

  p3p2.on('room', (room) => {
    document.body.classList.add('in-room');
    game.invite = null;
    hud.setInvite(null);
    hud.hostForm.hidden = true;
    hud.nick.value = room.self.name.slice(0, 15);
    hud.nick.readOnly = true;
    hud.nick.title = 'Your name in this room';
  });
  p3p2.on('leave', () => {
    document.body.classList.remove('in-room');
    hud.nick.readOnly = false;
    hud.nick.title = '';
  });

  // Back into the room after a reload, without asking; else the invite in the address, if there is one.
  void p3p2
    .resume()
    .catch(() => null)
    .then((room) => {
      const invite = p3p2.invite;
      if (!room && invite) ask(invite);
    });
}
