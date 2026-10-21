import { P3P2 } from '@p3p2/client';
import { loadConfig } from './config/index.ts';
import { Game } from './game.ts';
import type { Net } from './net/Net.ts';
import { mountFriends } from './ui/friends.ts';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas, loadConfig(params), params);
game.start(params.has('manual'));

// Friends on one sphere, through a p3p2 server (net/Net.ts). The library's entry is under 2 KB, and an ordinary
// visit asks no server anything; the room's code, here and in the library, loads when a room is opened. The menu hosts
// and answers invites with its own name (ui/friends.ts). The panel has no button of its own (every corner of the
// screen is taken): in a room, the menu's Friends button opens it. Enter plays, so it is not chat.
const p3p2 = new P3P2({ game: { id: 'cell', version: __BUILD__ }, ui: { button: false, chatKey: false } });
let net: Net | null = null;
p3p2.on('room', (room) => {
  void import('./net/Net.ts').then((m) => {
    net ??= new m.Net(game, p3p2);
    net.enter(room);
  });
});
mountFriends(game, p3p2);

if (params.has('debug')) import('./ui/debug.ts').then((m) => m.mountDebug(game));
if (params.has('bench')) import('./ui/bench.ts').then((m) => m.runBench(game, params));

declare global {
  interface Window {
    __game?: Game;
    /** For the tests: what the page knows of the room, once one has been opened. */
    __net?: () => Net | null;
  }
}
window.__game = game;
window.__net = () => net;
