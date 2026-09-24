// Radius-aware path flood, resident ghosts, NPCs moving through mazes.
import { describe, expect, it } from 'vitest';
import { BotController } from '../../src/ai/bot.ts';
import { GhostController } from '../../src/ai/ghost.ts';
import { DIFFICULTY, PERSONALITIES } from '../../src/ai/personalities.ts';
import { populateResidents } from '../../src/ai/population.ts';
import { MASK_GHOST, MASK_REGULAR } from '../../src/maze/district.ts';
import { OPEN, PEN } from '../../src/maze/generate.ts';
import { MARGIN_TILES } from '../../src/maze/layout.ts';
import { Flood } from '../../src/maze/nav.ts';
import { PELLET } from '../../src/sim/food.ts';
import { Organism } from '../../src/sim/organism.ts';
import { vec3 } from '../../src/sphere/vec3.ts';
import { addPlayer, arcadeWorld } from './helpers.ts';

describe('path flood', () => {
  it('reaches fine pockets only for cells that fit, and path costs are at least the straight distance', () => {
    const w = arcadeWorld();
    const d = w.maze.district(0);
    const G = d.G;
    const flood = new Flood();
    const start = 2 * G + 2; // plains margin corner
    const pocket = (() => {
      const [x, y] = [d.maze.power[0], d.maze.power[1]];
      return Math.floor(y) * G + Math.floor(x);
    })();
    flood.run(d, start, 40, MASK_REGULAR, G * G, Infinity);
    expect(flood.reached(pocket)).toBe(true);
    for (let k = 0; k < flood.count; k++) {
      const t = flood.list[k];
      const i = t % G;
      const j = (t - i) / G;
      expect(flood.cost[t]).toBeGreaterThanOrEqual(Math.hypot(i - 2, j - 2) - 1e-3);
      expect(d.tiles[t]).toBe(OPEN);
    }
    flood.run(d, start, 100, MASK_REGULAR, G * G, Infinity);
    expect(flood.reached(pocket)).toBe(false);
    // Big cells can use the ring avenue but not coarse corridors.
    const avenue = (MARGIN_TILES + 4) * G + d.G / 2;
    flood.run(d, start, 500, MASK_REGULAR, G * G, Infinity);
    expect(flood.reached(avenue)).toBe(true);
    expect(flood.reached(d.tileIndex(d.maze.start[0], d.maze.start[1]))).toBe(false);
    // Ghosts can path into the pen; regular cells can't.
    const pen = d.tileIndex(d.maze.pen[0], d.maze.pen[1]);
    expect(d.tiles[pen]).toBe(PEN);
    flood.run(d, start, 50, MASK_GHOST, G * G, Infinity);
    expect(flood.reached(pen)).toBe(true);
    flood.run(d, start, 50, MASK_REGULAR, G * G, Infinity);
    expect(flood.reached(pen)).toBe(false);
  });
});

describe('resident ghosts', () => {
  it('spawn in their pen, leave it, and chase down a small player', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(2);
    w.observer = vec3(d.c.x, d.c.y, d.c.z);
    const residents = populateResidents(w);
    expect(residents).toHaveLength(48);
    const mine = residents.filter((o) => o.resident!.district === 2);
    expect(mine.every((o) => o.alive && !o.dormant && o.cells.length === 1)).toBe(true);
    for (const o of mine) {
      d.locate(o.cells[0].p);
      expect(d.tiles[d.tileIndex(d.gx, d.gy)]).toBe(PEN);
    }
    // After 6 s everyone is out of the pen.
    for (let t = 0; t < 25 * 6; t++) w.step();
    for (const o of mine) {
      d.locate(o.cells[0].p);
      expect(d.tiles[d.tileIndex(d.gx, d.gy)]).not.toBe(PEN);
    }
    // A small stationary player at the start tile gets caught within 40 s of chase.
    const player = addPlayer(w, d.point(d.maze.start[0], d.maze.start[1], vec3()), 10);
    player.controller = { update: (_w, o) => o.cells[0] && Object.assign(o.target, o.cells[0].p) };
    let caught = false;
    for (let t = 0; t < 25 * 40 && !caught; t++) {
      w.step();
      caught = !player.alive;
    }
    expect(caught).toBe(true);
    expect(mine.some((o) => (o.controller as GhostController).mode === 'chase' || o.kills > 0)).toBe(true);
  });

  it('flee from a smaller rainbow cell nearby', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(3);
    w.observer = vec3(d.c.x, d.c.y, d.c.z);
    const residents = populateResidents(w).filter((o) => o.resident!.district === 3);
    for (let t = 0; t < 25 * 8; t++) w.step();
    // Put the hero on an open tile 3–8 tiles from a ghost (close enough to scare it, not touching).
    const ghost = residents.find((o) => o.cells.length > 0)!;
    d.locate(ghost.cells[0].p);
    const gi = Math.floor(d.gx);
    const gj = Math.floor(d.gy);
    let spot = -1;
    for (let ring = 3; ring <= 8 && spot < 0; ring++) {
      for (let j = gj - ring; j <= gj + ring && spot < 0; j++) {
        for (let i = gi - ring; i <= gi + ring; i++) {
          if (Math.max(Math.abs(i - gi), Math.abs(j - gj)) !== ring || i < 0 || j < 0 || i >= d.G || j >= d.G) continue;
          if (d.tiles[j * d.G + i] === OPEN && d.tileClear[j * d.G + i] >= 50) {
            spot = j * d.G + i;
            break;
          }
        }
      }
    }
    expect(spot).toBeGreaterThanOrEqual(0);
    const si = spot % d.G;
    const hero = new Organism(w.newId(), 'hero', 50, { update: (_w, o) => o.cells[0] && Object.assign(o.target, o.cells[0].p) }, true);
    w.addOrganism(hero);
    w.spawnOrganism(hero, d.point(si + 0.5, (spot - si) / d.G + 0.5, vec3()), 20);
    w.arcade!.grantRainbow(hero);
    for (let t = 0; t < 10; t++) w.step();
    expect(residents.some((o) => (o.controller as GhostController).mode === 'flee')).toBe(true);
  });
});

describe('NPCs in mazes', () => {
  it('a small grazer inside a maze eats maze food and never ends up inside a wall', () => {
    const w = arcadeWorld({ decayRate: 0 });
    const d = w.maze.district(4);
    const npc = new Organism(w.newId(), 'npc', 90, new BotController(PERSONALITIES.grazer, DIFFICULTY.hard, 0), false);
    w.addOrganism(npc);
    w.spawnOrganism(npc, d.point(d.maze.start[0], d.maze.start[1], vec3()), 15);
    let dots = 0;
    for (let t = 0; t < 25 * 60; t++) {
      w.step();
      for (const e of w.events) if (e.type === 'eat' && e.eaterOrg === npc.id && e.foodKind === PELLET && e.foodTag >= 0) dots++;
      const c = npc.cells[0];
      if (!c) break;
      if (t % 5 === 0 && d.locate(c.p)) expect(d.solid(Math.floor(d.gx), Math.floor(d.gy), MASK_REGULAR)).toBe(false);
    }
    expect(dots).toBeGreaterThan(40);
  });
});
