// ?bench=1 perf harness: large autopiloted player, then p50/p95 frame and tick times.
// Results land in window.__bench for scripts/bench.ts (Playwright + CPU throttling).
// scene=rainbow: a small autopiloted hunter that stays rainbow, with a big NPC pulled next to it every 2 s,
// so explosions, pieces and effects run all the time.
// zones=N: the zone simulated in full around N places, the player's district and the start tiles of N − 1 other
// districts, as a room's host runs it for N players far apart (net/Net.ts): what hosting costs, without the guests.
import type { Game } from '../game.ts';
import { copy, moveAlong, vec3 } from '../sphere/vec3.ts';

export interface BenchResult {
  bgMs: number;
  foodMs: number;
  cellsMs: number;
  drawMs: number;
  counts: string;
  frames: number;
  seconds: number;
  frameP50: number;
  frameP95: number;
  tickP95: number;
  qualityLevel: number;
  zoom: number;
  layerRedraws: number;
}

declare global {
  interface Window {
    __bench?: BenchResult;
  }
}

export function runBench(game: Game, params: URLSearchParams): void {
  const seconds = Number(params.get('seconds') ?? 30);
  const scene = params.get('scene') ?? 'plains';
  const mass = Number(params.get('mass') ?? (scene === 'maze' || scene === 'rainbow' ? 40 : 20000));
  const warmup = 3000;
  game.autopilot(mass, scene);
  const zones = Math.max(1, Math.min(12, Number(params.get('zones') ?? 1)));
  const maze = game.world.maze;
  const here = maze.enabled ? maze.layout.regionAt(game.camera.frame.c) : 0;
  for (let k = 1, i = 0; k < zones && maze.enabled; i++) {
    if (i === here) continue;
    const d = maze.district(i);
    game.world.observers.push(d.point(d.maze.start[0], d.maze.start[1], vec3()));
    k++;
  }
  let feedAt = 0;
  const feed = (now: number) => {
    if (scene !== 'rainbow' || now < feedAt) return;
    feedAt = now + 2000;
    const w = game.world;
    game.human.rainbowUntil = Infinity;
    const me = game.human.largestCell();
    const npc = w.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length === 1);
    if (!me || !npc) return;
    const c = npc.cells[0];
    c.r = Math.sqrt((800 + 2200 * Math.random()) * 100);
    const dir = w.randomTangent(vec3(), me.p, Math.random() * Math.PI * 2);
    copy(c.p, me.p);
    moveAlong(c.p, dir, (me.r + c.r + 200) / w.R);
    copy(c.prev, c.p);
  };
  const frames: number[] = [];
  const ticks: number[] = [];
  const stage = { bg: 0, food: 0, cells: 0, draw: 0 };
  let startAt = 0;
  let last = 0;
  const previous = game.onFrame;
  game.onFrame = (g) => {
    previous?.(g);
    const now = performance.now();
    feed(now);
    if (!startAt) startAt = now + warmup;
    if (now < startAt) {
      last = now;
      return;
    }
    frames.push(now - last);
    ticks.push(g.stats.tickMs);
    const rs = g.renderer.stats;
    stage.bg += rs.bgMs;
    stage.food += rs.foodMs;
    stage.cells += rs.cellsMs;
    stage.draw += rs.drawMs;
    last = now;
    if (now - startAt >= seconds * 1000 && !window.__bench) {
      const pct = (arr: number[], p: number) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * p)];
      const n = frames.length;
      const rs = g.renderer.stats;
      window.__bench = {
        bgMs: stage.bg / n,
        foodMs: stage.food / n,
        cellsMs: stage.cells / n,
        drawMs: stage.draw / n,
        counts: `bg ${rs.background} food ${rs.food} cells ${rs.cells} points ${rs.points}`,
        frames: frames.length,
        seconds,
        frameP50: pct(frames, 0.5),
        frameP95: pct(frames, 0.95),
        tickP95: pct(ticks, 0.95),
        qualityLevel: g.quality.level,
        zoom: g.camera.zoom,
        layerRedraws: rs.layerRedraws,
      };
      console.log('bench', JSON.stringify(window.__bench));
    }
  };
}
