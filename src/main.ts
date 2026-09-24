import { loadConfig } from './config/index.ts';
import { Game } from './game.ts';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas, loadConfig(params), params);
game.start(params.has('manual'));

if (params.has('debug')) import('./ui/debug.ts').then((m) => m.mountDebug(game));
if (params.has('bench')) import('./ui/bench.ts').then((m) => m.runBench(game, params));

declare global {
  interface Window {
    __game?: Game;
  }
}
window.__game = game;
