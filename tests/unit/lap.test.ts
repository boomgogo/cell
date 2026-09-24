// Lap test: holding one screen direction brings the cell back to its spawn point.
import { describe, expect, it } from 'vitest';
import { Frame } from '../../src/sphere/frame.ts';
import { angle, vec3 } from '../../src/sphere/vec3.ts';
import { speedPerTick } from '../../src/sim/rules.ts';
import { addPlayer, emptyWorld } from './helpers.ts';

describe('lap around the sphere', () => {
  for (const mass of [10, 100, 1000]) {
    it(`mass ${mass}: 8 headings each return within 1 % of the circumference`, () => {
      for (let k = 0; k < 8; k++) {
        const w = emptyWorld({ decayRate: 0 });
        const spawn = vec3(0.36, -0.48, 0.8);
        const camera = new Frame(spawn);
        const heading = (k / 8) * Math.PI * 2;
        const org = addPlayer(w, spawn, mass, {
          update: (world, o) => {
            // Camera follows the cell with a transported frame; the "mouse" stays at a fixed screen offset.
            camera.moveTo(o.center(vec3()));
            camera.unproject(world.R, Math.cos(heading) * 800, Math.sin(heading) * 800, o.target);
          },
        });
        const start = vec3(spawn.x, spawn.y, spawn.z);
        const circumference = 2 * Math.PI * w.R;
        const ticks = Math.ceil((circumference / speedPerTick(w.cfg, org.cells[0])) * 1.1);
        let best = Infinity;
        for (let t = 0; t < ticks; t++) {
          w.step();
          if (t > ticks / 2) best = Math.min(best, w.R * angle(org.cells[0].p, start));
        }
        expect(best).toBeLessThan(circumference * 0.01);
      }
    });
  }
});
