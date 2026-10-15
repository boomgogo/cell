// Worker thread for scripts/autoplay.ts: plays the games it is sent and posts the results back.
import { parentPort } from 'node:worker_threads';
import { type RunOptions, runGame } from './sim.ts';

parentPort!.on('message', (opts: RunOptions) => {
  parentPort!.postMessage(runGame(opts));
});
