// YouTube chapters for a recorded run, at its growth milestones. YouTube's rules: the first at 0:00, at least three,
// each at least 10 s long.

export interface RunLike {
  fps: number;
  /** Video frame of Play. */
  playVideoFrame: number;
  videoFrames: number;
  /** Every half second of play: t (s), mass, points, rank, region, interior, rainbow. */
  samples: number[][];
  events: { type: string; play: number }[];
  final: { alive: boolean; mass: number };
}

export interface Chapter {
  at: number;
  title: string;
}

const MILESTONES = [100, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000];
const fmt = (n: number) => n.toLocaleString('en-US');

export function chapters(run: RunLike, runSeconds = 300): Chapter[] {
  const play0 = run.playVideoFrame / run.fps;
  const end = run.videoFrames / run.fps;
  const cand: Chapter[] = [{ at: 0, title: 'Start: mass 10' }];
  let next = 0;
  let wasInMaze = false;
  let out = false;
  let top = false;
  for (const [t, mass, , rank, , interior] of run.samples) {
    if (t > runSeconds) break;
    const at = play0 + t;
    if (interior) wasInMaze = true;
    if (wasInMaze && !interior && !out && t > 5) {
      out = true;
      cand.push({ at, title: 'Out of the maze' });
    }
    if (rank === 1 && !top) {
      top = true;
      cand.push({ at, title: '#1 on the leaderboard' });
    }
    while (next < MILESTONES.length && mass >= MILESTONES[next]) {
      // Only the highest milestone passed at once.
      if (next + 1 >= MILESTONES.length || mass < MILESTONES[next + 1]) cand.push({ at, title: `Mass ${fmt(MILESTONES[next])}` });
      next++;
    }
  }
  const rainbow = run.events.find((e) => e.type === 'rainbow');
  if (rainbow) cand.push({ at: play0 + rainbow.play / run.fps, title: 'First rainbow' });
  const finalAt = play0 + runSeconds;
  if (run.final.alive && finalAt < end - 10) cand.push({ at: finalAt, title: `5:00, mass ${fmt(run.final.mass)}` });
  cand.sort((a, b) => a.at - b.at);
  // At least 10 s each (the last one too, up to the end of the video); the final mass is kept over what comes before it.
  const kept: Chapter[] = [];
  for (const c of cand) {
    const last = kept[kept.length - 1];
    if (last && c.at - last.at < 10) {
      if (c.title.startsWith('5:00') && kept.length > 1) kept[kept.length - 1] = c;
      continue;
    }
    if (end - c.at < 10) continue;
    kept.push(c);
  }
  return kept.length >= 3 ? kept : [];
}

export const stamp = (s: number): string => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
