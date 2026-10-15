// What a player sees, as plain data: the autoplay brain gets nothing else. One DOM-free function builds it, in the page
// (injected by the recorder) and in the Node harness, so the fairness tests cover both.
//
// In it: the camera, our own cells, every cell whose disc reaches the screen (the renderer's own visibility rule),
// pellets and spores on screen, the minimap's spores, the leaderboard, the points. Not in it: anything else off screen,
// dormant NPCs, controllers (personalities, goals), merge timers and exact rainbow timers of others, the world's rng.
import type { Camera } from '../../src/render/camera.ts';
import { PLAYER, VIRUS } from '../../src/sim/cell.ts';
import { POWER } from '../../src/sim/food.ts';
import type { Organism } from '../../src/sim/organism.ts';
import { isRainbow, ticksPerSecond } from '../../src/sim/rules.ts';
import type { World } from '../../src/sim/world.ts';

/** Kinds in `Snapshot.cells`. */
export const K_CELL = 0;
export const K_EJECTED = 1;
export const K_VIRUS = 2;
/** Flags in `Snapshot.cells`. */
export const F_RAINBOW = 1;
/** Rainbow with under 2 s left: the renderer flickers it. */
export const F_FLICKER = 2;
export const F_PHAGE = 4;

export const ME_STRIDE = 7;
export const CELL_STRIDE = 8;
export const FOOD_STRIDE = 3;

export interface Snapshot {
  /** Milliseconds since Play (the player's own clock). */
  t: number;
  /** Camera: centre, screen right, screen down (unit vectors), CSS px per world unit, viewport width and height. */
  cam: number[];
  /** Own cells: id, x, y, z (unit vector), radius, packed mass, age in ms. */
  me: number[];
  /** The Mass box. */
  mass: number;
  /** Rainbow seconds left, from the HUD bar (0 when not rainbow). */
  rainbow: number;
  /** Other visible cells: id, x, y, z, radius, kind (K_*), owner id (−1 for none), flags (F_*). */
  cells: number[];
  /** Food on screen in the camera chart (world units from the centre, x right, y down): x, y, kind (0 pellet, 2 spore). */
  food: number[];
  /** Spores on the minimap's visible side of the globe: x, y, z. */
  spores: number[];
  /** Leaderboard masses, top 10. */
  board: number[];
  /** Our place on the leaderboard (1-based; 0 when not on it). */
  rank: number;
  points: number;
}

export interface View {
  world: World;
  camera: Camera;
  human: Organism;
  points: number;
  /** Milliseconds since Play. */
  t: number;
}

const local = { x: 0, y: 0 };

export function takeSnapshot(view: View): Snapshot {
  const { world, camera, human } = view;
  const cfg = world.cfg;
  const tick = world.tick;
  const tps = ticksPerSecond(cfg);
  const f = camera.frame;
  const w = camera.width;
  const h = camera.height;
  const zoom = camera.zoom;
  const snap: Snapshot = {
    t: view.t,
    cam: [f.c.x, f.c.y, f.c.z, f.e.x, f.e.y, f.e.z, f.s.x, f.s.y, f.s.z, zoom, w, h],
    me: [],
    mass: human.alive ? human.mass : 0,
    rainbow: 0,
    cells: [],
    food: [],
    spores: [],
    board: [],
    rank: 0,
    points: view.points,
  };
  if (human.alive) {
    for (const c of human.cells) snap.me.push(c.id, c.p.x, c.p.y, c.p.z, c.r, c.packed, (tick - c.bornTick) * cfg.tickMs);
    const left = human.rainbowUntil - tick;
    if (left > 0) snap.rainbow = left / tps;
  }

  // Cells: the renderer draws those whose disc (plus 10 units) reaches the viewport.
  const reachOf = (r: number) => (r + 10) * zoom;
  const flash = 2 * tps;
  world.queryCells(f.c, camera.viewRadius() + 1600, (c) => {
    if (c.owner === human) return;
    if (!camera.toScreen(c.p, local)) return;
    const reach = reachOf(c.r);
    if (local.x < -reach || local.y < -reach || local.x > w + reach || local.y > h + reach) return;
    const owner = c.owner;
    let flags = 0;
    if (owner && isRainbow(owner, tick)) {
      flags |= F_RAINBOW;
      if (owner.rainbowUntil - tick < flash) flags |= F_FLICKER;
    }
    if (owner?.resident) flags |= F_PHAGE;
    const kind = c.kind === PLAYER ? K_CELL : c.kind === VIRUS ? K_VIRUS : K_EJECTED;
    snap.cells.push(c.id, c.p.x, c.p.y, c.p.z, c.r, kind, owner ? owner.id : -1, flags);
  });

  // Food on screen, in the camera chart.
  const food = world.food;
  const R = world.R;
  const fr = food.radius;
  world.food.query(f.c, camera.viewRadius() + fr, (i) => {
    const cos = f.projectXYZ(R, food.x[i], food.y[i], food.z[i], local);
    if (cos <= 0) return;
    const sx = w / 2 + local.x * zoom;
    const sy = h / 2 + local.y * zoom;
    const reach = (fr + 10) * zoom;
    if (sx < -reach || sy < -reach || sx > w + reach || sy > h + reach) return;
    snap.food.push(Math.round(local.x), Math.round(local.y), food.kind[i] === POWER ? 2 : 0);
  });

  // The minimap shows the live spores of every built district on the globe's near side.
  const arcade = world.arcade;
  if (arcade) {
    for (const st of arcade.states) {
      if (!st) continue;
      for (let k = 0; k < st.powerFood.length; k++) {
        const i = st.powerFood[k];
        if (i < 0) continue;
        if (food.x[i] * f.c.x + food.y[i] * f.c.y + food.z[i] * f.c.z <= 0) continue;
        snap.spores.push(food.x[i], food.y[i], food.z[i]);
      }
    }
  }

  const board = world.leaderboard;
  for (let i = 0; i < Math.min(10, board.length); i++) snap.board.push(Math.floor(board[i].lastMass));
  const rank = board.indexOf(human);
  snap.rank = human.alive && rank >= 0 ? rank + 1 : 0;
  return snap;
}
