// The autoplayer in Node, faster than real time: play one game, a batch of seeds, or tune the brain for its size at the
// end of a 5-minute run. Games run in worker threads.
//
// Usage:
//   npm run autoplay -- run --seed 3 [--driver npc] [--set risk=4,margin=150] [--touch]
//   npm run autoplay -- batch --seeds 1-200 [--driver npc] [--set …] [--params file.json] [--workers 8]
//   npm run autoplay -- tune --seeds 1-200 --holdout 1001-1200 [--passes 3] [--out dir]
//
// The measure: mass at the end of the run, 0 if the player died. Tuning keeps a change only when it raises the mean of
// the best 10 % of runs by 5 % and at least 70 % of runs still live to the end; every candidate plays the same seeds.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type BrainParams, DEFAULT_PARAMS } from './autoplay/brain.ts';
import type { RunOptions, RunResult } from './autoplay/sim.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** "1-200" or "1,5,9" → seeds. */
export function seedList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (b === undefined || Number.isNaN(b)) out.push(a);
    else for (let s = a; s <= b; s++) out.push(s);
  }
  return out;
}

/** "risk=4,margin=150" → partial params (numbers only, known keys only). */
export function parseSet(spec: string): Partial<BrainParams> {
  const out: Record<string, number> = {};
  for (const kv of spec.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in DEFAULT_PARAMS) || !Number.isFinite(Number(v))) throw new Error(`--set: unknown or non-numeric ${kv}`);
    out[k] = Number(v);
  }
  return out as Partial<BrainParams>;
}

/** Plays every option set on a pool of worker threads; results come back in order. */
export async function playAll(jobs: RunOptions[], workers = Math.min(8, availableParallelism())): Promise<RunResult[]> {
  const results: RunResult[] = new Array(jobs.length);
  let next = 0;
  const pool = Array.from({ length: Math.min(workers, jobs.length) }, () => new Worker(new URL('./autoplay/worker.ts', import.meta.url)));
  await Promise.all(
    pool.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const feed = () => {
            if (next >= jobs.length) {
              void w.terminate();
              resolve();
              return;
            }
            const k = next++;
            w.once('message', (r: RunResult) => {
              results[k] = r;
              feed();
            });
            w.postMessage(jobs[k]);
          };
          w.on('error', reject);
          feed();
        }),
    ),
  );
  return results;
}

export interface Stats {
  runs: number;
  alive: number;
  median: number;
  top10: number;
  best: number;
  bestSeed: number;
  curve: number[];
  peakMedian: number;
  pointsMedian: number;
  topShare: number;
  splits: number;
  sources: Record<string, number>;
  deaths: Record<string, number>;
  problems: string[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function stats(rs: RunResult[]): Stats {
  const final = rs.map((r) => r.mass);
  const sorted = [...final].sort((a, b) => b - a);
  const n10 = Math.max(1, Math.round(rs.length / 10));
  const best = rs.reduce((b, r) => (r.mass > b.mass ? r : b), rs[0]);
  const minutes = Math.max(...rs.map((r) => r.curve.length));
  const curve: number[] = [];
  for (let m = 0; m < minutes; m++) curve.push(median(rs.map((r) => r.curve[m] ?? 0)));
  const sources: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.sources)) sources[k] = (sources[k] ?? 0) + v / rs.length;
  const deaths: Record<string, number> = {};
  for (const r of rs) {
    if (!r.death) continue;
    const kind = r.death.split(' ')[0];
    deaths[kind] = (deaths[kind] ?? 0) + 1;
  }
  return {
    runs: rs.length,
    alive: rs.filter((r) => r.alive).length / rs.length,
    median: median(final),
    top10: sorted.slice(0, n10).reduce((s, x) => s + x, 0) / n10,
    best: best.mass,
    bestSeed: best.seed,
    curve,
    peakMedian: median(rs.map((r) => r.peak)),
    pointsMedian: median(rs.map((r) => r.points)),
    topShare: rs.filter((r) => r.topAt >= 0).length / rs.length,
    splits: rs.reduce((s, r) => s + r.splits, 0) / rs.length,
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, Math.round(v)])),
    deaths,
    problems: rs.flatMap((r) => r.problems.map((p) => `seed ${r.seed}: ${p}`)).slice(0, 20),
  };
}

export function formatStats(label: string, s: Stats): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  return [
    `${label}: ${s.runs} runs, alive at the end ${pct(s.alive)}, mass at the end: median ${s.median}, best-10 % mean ${Math.round(s.top10)}, best ${s.best} (seed ${s.bestSeed})`,
    `  median mass by minute ${s.curve.join(' → ')}; median peak ${s.peakMedian}; median points ${s.pointsMedian}; reached #1 ${pct(s.topShare)}; splits/run ${s.splits.toFixed(1)}`,
    `  mass from (mean per run) ${JSON.stringify(s.sources)}; deaths ${JSON.stringify(s.deaths)}`,
    ...(s.problems.length ? [`  PROBLEMS: ${s.problems.join('; ')}`] : []),
  ].join('\n');
}

/** The tuning objective: the best-10 % mean, or nothing when fewer than 70 % live to the end. */
const objective = (s: Stats) => (s.alive >= 0.7 ? s.top10 : s.top10 * (s.alive / 0.7) ** 4);

/** Values tried for each parameter around the current one. */
const STEPS: Partial<Record<keyof BrainParams, number[]>> = {
  margin: [0.6, 1.5],
  fall: [0.7, 1.4],
  risk: [0.6, 1.6],
  lunge: [0.5, 1.6],
  splitReach: [1.15, 1.25],
  food: [0.6, 1.6],
  prey: [0.6, 1.6],
  chaseMax: [0.6, 1.6],
  splitShare: [0.6, 1.6],
  splitSafe: [0.7, 1.4],
  spore: [0.5, 2],
  sporeBig: [0.5, 2],
  sporeRange: [0.6, 1.6],
  rainbowShare: [0.6, 1.6],
  sporeMem: [0.5, 1],
  hunt: [0.25, 0.5],
  mazeLeave: [0.85, 1.12],
  mazeMaxR: [0.75, 1.3],
  virus: [0.5, 2],
  wander: [0.5, 2],
  keep: [0.5, 2],
};

async function main() {
  const cmd = process.argv[2] ?? 'batch';
  const workers = Number(arg('workers', String(Math.min(8, availableParallelism()))));
  const driver = arg('driver', 'brain') as 'brain' | 'npc';
  const touch = process.argv.includes('--touch');
  const size = touch ? { width: 432, height: 576 } : { width: 1280, height: 720 };
  let params: Partial<BrainParams> = {};
  const file = arg('params', '');
  if (file) params = JSON.parse(readFileSync(file, 'utf8'));
  params = { ...params, ...parseSet(arg('set', '')) };

  if (cmd === 'run') {
    const [r] = await playAll([{ seed: Number(arg('seed', '1')), driver, params, touch, ...size }], 1);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'batch') {
    const seeds = seedList(arg('seeds', '1-64'));
    const t0 = Date.now();
    const rs = await playAll(seeds.map((seed) => ({ seed, driver, params, touch, ...size })), workers);
    console.log(formatStats(`${driver}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ''}`, stats(rs)));
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    const out = arg('out', '');
    if (out) writeFileSync(out, JSON.stringify(rs, null, 1));
    return;
  }
  if (cmd === 'tune') {
    const seeds = seedList(arg('seeds', '1-200'));
    const holdout = seedList(arg('holdout', '1001-1200'));
    const passes = Number(arg('passes', '3'));
    const outDir = arg('out', 'recordings/tune');
    mkdirSync(outDir, { recursive: true });
    const log = join(outDir, 'tune.log');
    const say = (s: string) => {
      console.log(s);
      appendFileSync(log, `${s}\n`);
    };
    const play = async (p: Partial<BrainParams>, list = seeds) => stats(await playAll(list.map((seed) => ({ seed, params: p, touch, ...size })), workers));
    let current: BrainParams = { ...DEFAULT_PARAMS, ...params };
    let currentStats = await play(current);
    say(formatStats('start', currentStats));
    for (let pass = 1; pass <= passes; pass++) {
      let changed = false;
      for (const [key, factors] of Object.entries(STEPS) as [keyof BrainParams, number[]][]) {
        for (const f of factors) {
          // A parameter at 0 (a feature switched off) tries the step values themselves.
          const value = current[key] === 0 ? f : Math.round(current[key] * f * 1000) / 1000;
          const cand = { ...current, [key]: value };
          const s = await play(cand);
          // Runs are chaotic (any change replays every seed differently), so a change must win clearly.
          const better = objective(s) > objective(currentStats) * 1.05;
          say(`pass ${pass} ${key} ${current[key]} → ${value}: objective ${Math.round(objective(s))} vs ${Math.round(objective(currentStats))}, alive ${Math.round(s.alive * 100)} %, median ${s.median}${better ? '  KEPT' : ''}`);
          if (better) {
            current = cand;
            currentStats = s;
            changed = true;
            writeFileSync(join(outDir, 'params.json'), JSON.stringify(current, null, 2));
            break;
          }
        }
      }
      say(formatStats(`after pass ${pass}`, currentStats));
      if (!changed) break;
    }
    writeFileSync(join(outDir, 'params.json'), JSON.stringify(current, null, 2));
    say(`tuned parameters: ${JSON.stringify(current)}`);
    // Held-out seeds: the tuned brain against the default one and the NPC baseline.
    say(formatStats('held out, tuned', await play(current, holdout)));
    say(formatStats('held out, defaults', await play(DEFAULT_PARAMS, holdout)));
    say(formatStats('held out, NPC hunter (hard)', stats(await playAll(holdout.map((seed) => ({ seed, driver: 'npc' as const, touch, ...size })), workers))));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
