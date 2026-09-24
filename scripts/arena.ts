// Headless NPC arena: runs the sphere sim in Node faster than real time and
// reports per-personality outcomes. With `--preset arcade` the world has maze districts, rainbow power pellets and
// resident ghosts; an observer camera tours the districts (one minute each) so the active zone stays full, and maze,
// power, explosion and packing metrics are added.
// Usage: npm run arena -- [--seed 1] [--minutes 10] [--R 4000] [--npc 50] [--preset base|arcade] [--difficulty normal]
//        [--cfg botTurnCost=0.35,botWanderEnter=0.02]
import { loadConfig, perSphere } from '../src/config/index.ts';
import { DIFFICULTY, type PersonalityId } from '../src/ai/personalities.ts';
import { BotController, botStats } from '../src/ai/bot.ts';
import { GhostController, ghostStats } from '../src/ai/ghost.ts';
import { personalityOf, populateNpcs, populateResidents } from '../src/ai/population.ts';
import { PELLET, POWER } from '../src/sim/food.ts';
import type { Organism } from '../src/sim/organism.ts';
import { World } from '../src/sim/world.ts';
import { vec3 } from '../src/sphere/vec3.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const seed = Number(arg('seed', '1'));
const minutes = Number(arg('minutes', '10'));
const preset = arg('preset', 'base');
const arcade = preset === 'arcade';
const params = new URLSearchParams({ preset, sphereRadius: arg('R', arcade ? '16000' : '4000') });
const cfg = loadConfig(params);
// Tuning: --cfg key=value[,key=value] overrides numeric config entries (e.g. --cfg botTurnCost=0.2).
for (const kv of arg('cfg', '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  if (!(k in cfg) || !Number.isFinite(Number(v))) throw new Error(`--cfg: unknown or non-numeric ${kv}`);
  (cfg as unknown as Record<string, number>)[k] = Number(v);
}
const npcCount = Number(arg('npc', String(perSphere(cfg, cfg.npcPerRefArea))));
const difficulty = DIFFICULTY[arg('difficulty', 'normal') as keyof typeof DIFFICULTY] ?? DIFFICULTY.normal;

const world = new World(cfg, { seed });
const maze = world.maze;
const observer = vec3(0, 0, 1);
if (maze.enabled) {
  // Pre-generate districts (the browser does this in idle time) and park the observer at the first one.
  while (maze.buildNext()) {}
  Object.assign(observer, maze.layout.regions[0].centre);
  world.observer = observer;
}
const npcs = populateNpcs(world, { count: npcCount, difficulty, varyMass: !arcade ? false : true });
const residents = populateResidents(world);

interface Stats {
  lives: number;
  deaths: number;
  kills: number;
  peakMassSum: number;
  peakMassMax: number;
  lifeTicks: number;
  topTicks: number;
  mazeFood: number;
  power: number;
  explodes: number;
  exploded: number;
  diedAfterExplode: number;
  eatenByGhost: number;
  mazeTicks: number;
  gridTicks: number;
  stuckTicks: number;
}
const stats = new Map<PersonalityId, Stats>();
const statOf = (o: Organism) => {
  const id = personalityOf(o)!;
  let s = stats.get(id);
  if (!s) {
    s = {
      lives: 0,
      deaths: 0,
      kills: 0,
      peakMassSum: 0,
      peakMassMax: 0,
      lifeTicks: 0,
      topTicks: 0,
      mazeFood: 0,
      power: 0,
      explodes: 0,
      exploded: 0,
      diedAfterExplode: 0,
      eatenByGhost: 0,
      mazeTicks: 0,
      gridTicks: 0,
      stuckTicks: 0,
    };
    stats.set(id, s);
  }
  return s;
};
for (const o of npcs) statOf(o).lives++;
const byId = new Map(world.organisms.map((o) => [o.id, o]));
let ghostKills = 0;
let ghostDeaths = 0;
let insideWall = 0;
let explosions = 0;
let piecesMade = 0;
let maxCells = 0;
/** Tick each organism was last exploded (deaths within 10 s count as "died after explode"). */
const lastExploded = new Map<number, number>();
// Packing, sampled once a second over every player cell inside a maze: cells bigger than their way out
// (trapped, should stay 0), cells carrying packed mass, the largest packed mass seen; pack and unpack events.
let mazeCellSeconds = 0;
let trappedCellSeconds = 0;
let packedCellSeconds = 0;
let maxPacked = 0;
let packs = 0;
let unpacks = 0;

// Exploration: per active NPC, 30-second windows of net displacement against path length. A window is
// "stuck" when the cell ended less than 3 r from where it started. Reversals are thinks that turned more than 135°.
const WINDOW = Math.round(30000 / cfg.tickMs);
const BUCKETS = [100, 200, 300, 400, 600, Infinity];
const bucketName = (i: number) => (i === 0 ? 'r < 100' : BUCKETS[i] === Infinity ? `r > ${BUCKETS[i - 1]}` : `${BUCKETS[i - 1]}–${BUCKETS[i]}`);
interface Explore {
  windows: number;
  stuck: number;
  ratios: number[];
  thinks: number;
  reversals: number;
}
const explore = BUCKETS.map((): Explore => ({ windows: 0, stuck: 0, ratios: [], thinks: 0, reversals: 0 }));
interface Win {
  start: { x: number; y: number; z: number };
  last: { x: number; y: number; z: number };
  path: number;
  thinks: number;
  reversals: number;
  valid: boolean;
}
const wins = new Map<Organism, Win>();

const wasAlive = new Map(npcs.map((o) => [o, o.alive]));
const lifeStart = new Map(npcs.map((o) => [o, 0]));
const ticks = Math.round((minutes * 60 * 1000) / cfg.tickMs);
const t0 = performance.now();
let maxTick = 0;
const tickTimes: number[] = [];

function closeLife(o: Organism) {
  const s = statOf(o);
  s.deaths++;
  s.kills += o.kills;
  s.peakMassSum += o.peakMass;
  s.peakMassMax = Math.max(s.peakMassMax, o.peakMass);
  s.lifeTicks += world.tick - (lifeStart.get(o) ?? 0);
}

const perMinute = Math.round(60000 / cfg.tickMs);
for (let t = 0; t < ticks; t++) {
  if (maze.enabled && t % perMinute === 0) Object.assign(observer, maze.layout.regions[(t / perMinute) % 12].centre);
  const s0 = performance.now();
  world.step();
  const dt = performance.now() - s0;
  tickTimes.push(dt);
  maxTick = Math.max(maxTick, dt);
  for (const e of world.events) {
    if (e.type === 'eat' && e.eaterOrg >= 0) {
      const o = byId.get(e.eaterOrg);
      if (o && personalityOf(o)) {
        if (e.foodKind === PELLET && e.foodTag >= 0) statOf(o).mazeFood++;
        if (e.foodKind === POWER) statOf(o).power++;
      }
    } else if (e.type === 'explode') {
      explosions++;
      piecesMade += e.pieces;
      const o = byId.get(e.organismId);
      if (o && personalityOf(o)) statOf(o).explodes++;
      const v = byId.get(e.victimId);
      if (v && personalityOf(v)) statOf(v).exploded++;
      lastExploded.set(e.victimId, world.tick);
    } else if (e.type === 'pack') packs++;
    else if (e.type === 'unpack') unpacks++;
    else if (e.type === 'death') {
      const victim = byId.get(e.organismId);
      const killer = e.killerId !== null ? byId.get(e.killerId) : undefined;
      if (killer?.resident) ghostKills++;
      if (victim?.resident) ghostDeaths++;
      if (killer?.resident && victim && personalityOf(victim)) statOf(victim).eatenByGhost++;
      const at = lastExploded.get(e.organismId);
      if (victim && personalityOf(victim) && at !== undefined && world.tick - at < 250) statOf(victim).diedAfterExplode++;
    }
  }
  for (const o of npcs) {
    const alive = o.alive;
    if (wasAlive.get(o) && !alive) closeLife(o);
    if (!wasAlive.get(o) && alive) {
      statOf(o).lives++;
      lifeStart.set(o, world.tick);
    }
    wasAlive.set(o, alive);
    if (o.cells.length > maxCells) maxCells = o.cells.length;
    if (maze.enabled && alive && !o.dormant && t % 5 === 0) {
      const c = o.cells[0];
      if (c && maze.regionWithGridAt(c.p) >= 0) statOf(o).gridTicks += 5;
      if (c && maze.inInterior(c.p)) {
        statOf(o).mazeTicks += 5;
        const d = maze.districtAt(c.p);
        if (d && d.locate(c.p) && d.solid(Math.floor(d.gx), Math.floor(d.gy), 0)) insideWall++;
      }
    }
  }
  for (const o of npcs) {
    const c = o.alive && !o.dormant ? o.largestCell() : null;
    const bot = o.controller as BotController;
    let w = wins.get(o);
    if (!c) {
      if (w) w.valid = false;
      continue;
    }
    if (!w) {
      w = { start: vec3(), last: vec3(), path: 0, thinks: bot.thinks, reversals: bot.reversals, valid: false };
      wins.set(o, w);
    }
    if (w.valid) w.path += world.distance(w.last, c.p);
    Object.assign(w.last, c.p);
    if (t % WINDOW === 0) {
      if (w.valid && w.path > 0) {
        const net = world.distance(w.start, c.p);
        const b = explore[BUCKETS.findIndex((r) => c.r < r)];
        b.windows++;
        if (net < 3 * c.r) b.stuck++;
        b.ratios.push(net / w.path);
        b.thinks += bot.thinks - w.thinks;
        b.reversals += bot.reversals - w.reversals;
      }
      Object.assign(w.start, c.p);
      w.path = 0;
      w.thinks = bot.thinks;
      w.reversals = bot.reversals;
      w.valid = true;
    }
  }
  const top = world.leaderboard[0];
  if (top && personalityOf(top)) statOf(top).topTicks++;
  if (maze.enabled && t % 25 === 0) {
    for (const c of world.cells) {
      if (!c.owner || c.removed) continue;
      const room = maze.roomAt(c.p);
      if (room === Infinity) continue;
      mazeCellSeconds++;
      if (room > 0 && c.r > room + 1) trappedCellSeconds++;
      if (c.packed > 0) packedCellSeconds++;
      maxPacked = Math.max(maxPacked, c.packed);
    }
  }
}
// Close still-running lives so their stats count.
for (const o of npcs) {
  const s = statOf(o);
  if (o.controller instanceof BotController) s.stuckTicks += o.controller.stuckTicks;
  if (!o.alive) continue;
  s.kills += o.kills;
  s.peakMassSum += o.peakMass;
  s.peakMassMax = Math.max(s.peakMassMax, o.peakMass);
  s.lifeTicks += world.tick - (lifeStart.get(o) ?? 0);
}

const elapsed = performance.now() - t0;
tickTimes.sort((a, b) => a - b);
console.log(
  `arena preset=${preset} seed=${seed} R=${cfg.sphereRadius} npcs=${npcCount} residents=${residents.length} food=${world.foodTarget} viruses≥${world.virusMin} ` +
    `${minutes} min sim in ${(elapsed / 1000).toFixed(1)} s (avg tick ${(elapsed / ticks).toFixed(2)} ms, p95 ${tickTimes[Math.floor(ticks * 0.95)].toFixed(2)} ms, max ${maxTick.toFixed(1)} ms)`,
);
console.log(
  'personality  lives  deaths  avg-life(s)  kills  avg-peak  max-peak  time-at-#1' +
    (arcade ? '  maze-food  power  explodes  exploded  died<10s  ghost-deaths  maze-s  stuck-%' : ''),
);
for (const [id, s] of [...stats.entries()].sort()) {
  const lifeS = (s.lifeTicks * cfg.tickMs) / 1000 / Math.max(1, s.lives);
  const extra = arcade
    ? `${String(s.mazeFood).padStart(11)} ${String(s.power).padStart(6)} ${String(s.explodes).padStart(9)} ${String(s.exploded).padStart(9)} ` +
      `${String(s.diedAfterExplode).padStart(9)} ${String(s.eatenByGhost).padStart(13)} ` +
      `${((s.mazeTicks * cfg.tickMs) / 1000).toFixed(0).padStart(7)} ${((100 * s.stuckTicks) / Math.max(1, s.gridTicks)).toFixed(1).padStart(8)}`
    : '';
  console.log(
    `${id.padEnd(11)} ${String(s.lives).padStart(6)} ${String(s.deaths).padStart(7)} ${lifeS.toFixed(0).padStart(12)} ` +
      `${String(s.kills).padStart(6)} ${(s.peakMassSum / Math.max(1, s.lives)).toFixed(0).padStart(9)} ` +
      `${s.peakMassMax.toFixed(0).padStart(9)} ${((100 * s.topTicks) / ticks).toFixed(0).padStart(10)}%` +
      extra,
  );
}
if (arcade) {
  console.log(`residents: kills ${ghostKills}, deaths ${ghostDeaths}; NPC samples inside walls: ${insideWall}; ghost thinks ${JSON.stringify(ghostStats)}`);
  const styles = new Map<string, [number, number]>();
  for (const o of residents) {
    const g = o.controller as GhostController;
    const acc = styles.get(g.style) ?? [0, 0];
    acc[0] += g.chaseOffsetSum;
    acc[1] += g.chaseCount;
    styles.set(g.style, acc);
  }
  console.log(`ghost chase target offset from prey (tiles): ${[...styles].map(([k, [sum, n]]) => `${k} ${(sum / Math.max(1, n)).toFixed(1)} (n=${n})`).join(', ')}`);
  console.log(
    `explosions ${explosions} (${(piecesMade / Math.max(1, explosions)).toFixed(1)} pieces each), cap knockbacks ${world.explodeKnockbacks} ` +
      `(${((100 * world.explodeKnockbacks) / Math.max(1, explosions + world.explodeKnockbacks)).toFixed(1)} %), too small to split (eaten) ` +
      `${world.explodeTooSmall}, most cells in one organism ${maxCells}`,
  );
  console.log(
    `packing: cell-seconds in mazes ${mazeCellSeconds}, trapped (bigger than the way out) ${trappedCellSeconds}, ` +
      `carrying packed mass ${packedCellSeconds} (${((100 * packedCellSeconds) / Math.max(1, mazeCellSeconds)).toFixed(1)} %), ` +
      `packs ${packs}, swells ${unpacks}, most packed ${maxPacked.toFixed(0)}`,
  );
}
console.log('explore (30 s windows)  windows  stuck-%  median net/path  reversals/think');
explore.forEach((b, i) => {
  if (!b.windows) return;
  b.ratios.sort((x, y) => x - y);
  console.log(
    `${bucketName(i).padEnd(22)} ${String(b.windows).padStart(8)} ${((100 * b.stuck) / b.windows).toFixed(0).padStart(8)} ` +
      `${b.ratios[b.ratios.length >> 1].toFixed(2).padStart(16)} ${(b.reversals / Math.max(1, b.thinks)).toFixed(2).padStart(16)}`,
  );
});
console.log(`bot decisions: ${JSON.stringify(botStats)}`);
