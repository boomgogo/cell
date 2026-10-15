// The autoplayer: it sees only the screen, decides sensibly, moves like a hand, and plays the same game twice.
import { describe, expect, it } from 'vitest';
import { Camera } from '../../src/render/camera.ts';
import { Cell, VIRUS } from '../../src/sim/cell.ts';
import { vec3 } from '../../src/sphere/vec3.ts';
import { Brain, type Intent } from '../../scripts/autoplay/brain.ts';
import { type HandEvent, Hands, type Screen } from '../../scripts/autoplay/hands.ts';
import { FRAME_MS, Harness, runGame } from '../../scripts/autoplay/sim.ts';
import { CELL_STRIDE, takeSnapshot } from '../../scripts/autoplay/snapshot.ts';
import { chapters } from '../../scripts/record/chapters.ts';
import { NORTH, addPlayer, emptyConfig, emptyWorld } from './helpers.ts';

const still = { update: () => {} };

/** A small open world: us at the north pole, a camera on us, a brain for the base rules. */
function scene(myMass: number) {
  const world = emptyWorld({ decayRate: 0 });
  const me = addPlayer(world, NORTH, myMass, still);
  const camera = new Camera(world.cfg);
  camera.resize(1280, 720);
  camera.jumpTo(NORTH, me.sumRadius);
  const brain = new Brain(emptyConfig({ decayRate: 0 }));
  const snap = (t = 1000) => takeSnapshot({ world, camera, human: me, points: 0, t });
  return { world, me, camera, brain, snap };
}

/** The intent's heading as screen x/y (the camera's right and down). */
function heading(it: Intent, camera: Camera): { x: number; y: number } {
  const f = camera.frame;
  const x = it.dir[0] * f.e.x + it.dir[1] * f.e.y + it.dir[2] * f.e.z;
  const y = it.dir[0] * f.s.x + it.dir[1] * f.s.y + it.dir[2] * f.s.z;
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** Screen x of a point `dx` world units along the camera's right. */
function along(world: ReturnType<typeof emptyWorld>, camera: Camera, dx: number, dy = 0) {
  const p = vec3();
  return camera.frame.unproject(world.R, dx, dy, p);
}

describe('the snapshot shows only the screen', () => {
  it('does not change when anything off screen or hidden changes', () => {
    const h = new Harness({ seed: 5 });
    for (let k = 0; k < 120; k++) h.frame();
    h.play('Rad', 10);
    for (let k = 0; k < 120; k++) h.playFrame();
    const view = () => takeSnapshot({ world: h.world, camera: h.camera, human: h.human, points: h.points, t: 2000 });
    const before = JSON.stringify(view());
    // Move a dormant NPC, an off-screen cell and add food far away; draw from the world's rng.
    const dormant = h.world.organisms.find((o) => o.dormant)!;
    dormant.dormantP.x = -dormant.dormantP.x;
    const local = { x: 0, y: 0 };
    const off = h.world.cells.find((c) => !h.camera.toScreen(c.p, local) || Math.abs(local.x - 640) > 3000)!;
    off.p.x += 1e-4;
    h.world.food.add(vec3(-h.camera.frame.c.x, -h.camera.frame.c.y, -h.camera.frame.c.z), 10);
    h.world.rng();
    expect(JSON.stringify(view())).toBe(before);
    // Nothing dormant is in it.
    const ids = new Set<number>();
    const s = view();
    for (let k = 0; k < s.cells.length; k += CELL_STRIDE) ids.add(s.cells[k + 6]);
    for (const o of h.world.organisms) if (o.dormant) expect(ids.has(o.id)).toBe(false);
  });
});

describe('the brain', () => {
  it('flees a bigger cell, and keeps further from one that can split onto it', () => {
    const { world, camera, brain, snap } = scene(100);
    addPlayer(world, along(world, camera, 400), 600, still);
    const it = brain.decide(snap());
    expect(heading(it, camera).x).toBeLessThan(-0.5);
    // A cell big enough to split onto us is a threat from further away.
    const far = scene(100);
    addPlayer(far.world, along(far.world, far.camera, 900), 1200, still);
    expect(heading(far.brain.decide(far.snap()), far.camera).x).toBeLessThan(-0.3);
  });

  it('goes for a smaller cell', () => {
    const { world, camera, brain, snap } = scene(400);
    addPlayer(world, along(world, camera, -600), 40, still);
    let it = brain.decide(snap(1000));
    it = brain.decide(snap(1100));
    expect(heading(it, camera).x).toBeLessThan(-0.7);
  });

  it('splits onto prey in reach, but not with a threat to the halves near', () => {
    const a = scene(400);
    addPlayer(a.world, along(a.world, a.camera, 400), 80, still);
    expect(a.brain.decide(a.snap(1000)).split).toBe(true);
    const b = scene(400);
    addPlayer(b.world, along(b.world, b.camera, 400), 80, still);
    addPlayer(b.world, along(b.world, b.camera, -900, 200), 300, still);
    expect(b.brain.decide(b.snap(1000)).split).toBe(false);
    expect(b.brain.decide(b.snap(1100)).split).toBe(false);
  });

  it('does not split next to a virus it would pop on, nor steer into one', () => {
    const { world, camera, brain, snap } = scene(900);
    const virus = new Cell(world.newId(), VIRUS, along(world, camera, 350), 100, 120, null, 0);
    (world as unknown as { addCell(c: Cell): void }).addCell(virus);
    world.virusMax = 100;
    for (let k = 0; k < 40; k++) world.food.add(along(world, camera, 380 + k * 10, (k % 3) * 8), 10);
    const it = brain.decide(snap());
    expect(heading(it, camera).x).toBeLessThan(0.7);
  });

  it('parks at the end of the run', () => {
    const { brain, snap } = scene(100);
    expect(brain.decide(snap(300_000)).mode).toBe('park');
  });
});

describe('the hands', () => {
  const screen: Screen = { cam: [0, 0, 1, 1, 0, 0, 0, -1, 0, 0.5, 1280, 720], me: [0, 0, 1], avoid: [], split: null };
  const goEast = (t: number, split = false): Intent => ({ mode: 'go', dir: [1, 0, 0], p: [0, 0, 0], dist: 200, split, goal: 'test', t });

  function run(hands: Hands, seconds: number, push: (t: number) => Intent | null): { t: number; e: HandEvent; x: number; y: number }[] {
    const out: { t: number; e: HandEvent; x: number; y: number }[] = [];
    for (let k = 0; k < seconds * 60; k++) {
      const t = k / 60;
      if (k % 6 === 0) {
        const it = push(t);
        if (it) hands.push(it);
      }
      for (const e of hands.frame(t, screen)) out.push({ t, e, x: hands.x, y: hands.y });
    }
    return out;
  }

  it('reacts after 150–260 ms, reaches the target and stays near it', () => {
    const hands = new Hands(1, false, 1280, 720);
    const start = { x: hands.x, y: hands.y };
    const ev = run(hands, 2, (t) => (t === 0 ? goEast(0) : null));
    // Nothing before the reaction time; visibly on its way soon after (a reach starts slowly).
    const firstMove = ev.find((x) => Math.hypot(x.x - start.x, x.y - start.y) > 3);
    expect(firstMove!.t).toBeGreaterThanOrEqual(0.15);
    expect(firstMove!.t).toBeLessThanOrEqual(0.4);
    // Our cell is at the centre (640, 360); the target is 200 px to the right.
    expect(Math.hypot(hands.x - 840, hands.y - 360)).toBeLessThan(3);
  });

  it('presses Space at most about five times a second, each held 60–110 ms', () => {
    const hands = new Hands(2, false, 1280, 720);
    const ev = run(hands, 4, (t) => ({ ...goEast(t * 1000, true), mode: 'at', p: [0.012, 0, 0.99993] }));
    const downs = ev.filter((x) => x.e.type === 'key' && x.e.down).map((x) => x.t);
    const ups = ev.filter((x) => x.e.type === 'key' && !x.e.down).map((x) => x.t);
    expect(downs.length).toBeGreaterThan(2);
    expect(downs.length / 4).toBeLessThanOrEqual(5.1);
    for (let k = 0; k < Math.min(downs.length, ups.length); k++) {
      expect(ups[k] - downs[k]).toBeGreaterThanOrEqual(0.05);
      expect(ups[k] - downs[k]).toBeLessThanOrEqual(0.12);
    }
  });

  it('keeps a thumb on the screen and off its edge, even steering into a corner and re-gripping', () => {
    const phone: Screen = { cam: [0, 0, 1, 1, 0, 0, 0, -1, 0, 0.5, 432, 576], me: [0, 0, 1], avoid: [], split: null };
    const hands = new Hands(4, true, 432, 576);
    const corner: Intent = { mode: 'go', dir: [-0.6, 0, 0], p: [0, 0, 0], dist: 900, split: false, goal: 'test', t: 0 };
    corner.dir = [-Math.SQRT1_2, -Math.SQRT1_2, 0];
    const points: { x: number; y: number }[] = [];
    for (let k = 0; k < 60 * 30; k++) {
      if (k % 6 === 0) hands.push({ ...corner, t: (k / 60) * 1000 });
      for (const e of hands.frame(k / 60, phone)) if (e.type === 'touch') points.push(...e.points);
    }
    expect(points.length).toBeGreaterThan(10);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.y).toBeGreaterThanOrEqual(24);
      expect(p.x).toBeLessThanOrEqual(432 - 24);
      expect(p.y).toBeLessThanOrEqual(576 - 24);
    }
  });

  it('moves the same way for the same seed', () => {
    const a = run(new Hands(9, false, 1280, 720), 2, (t) => goEast(t * 1000));
    const b = run(new Hands(9, false, 1280, 720), 2, (t) => goEast(t * 1000));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('the harness', () => {
  it('plays the same game for the same seed and parameters', () => {
    const a = runGame({ seed: 3, seconds: 15 });
    const b = runGame({ seed: 3, seconds: 15 });
    expect(b).toEqual(a);
    expect(a.problems).toEqual([]);
  }, 60_000);

  it('runs at 60 frames a second of game time', () => {
    expect(FRAME_MS).toBeCloseTo(1000 / 60, 9);
  });
});

describe('chapters', () => {
  const run = {
    fps: 60,
    playVideoFrame: 300,
    videoFrames: 60 * 320,
    samples: Array.from({ length: 600 }, (_, k) => {
      const t = (k + 1) / 2;
      return [t, 10 + t * t * 0.05, 0, t > 230 ? 1 : 5, 0, t < 40 ? 1 : 0, 0];
    }),
    events: [{ type: 'rainbow', play: 30 * 60 }],
    final: { alive: true, mass: 4510 },
  };

  it('follow YouTube’s rules: first at 0:00, at least three, each at least 10 s', () => {
    const ch = chapters(run);
    expect(ch.length).toBeGreaterThanOrEqual(3);
    expect(ch[0].at).toBe(0);
    for (let k = 1; k < ch.length; k++) expect(ch[k].at - ch[k - 1].at).toBeGreaterThanOrEqual(10);
    expect(run.videoFrames / 60 - ch[ch.length - 1].at).toBeGreaterThanOrEqual(10);
    expect(ch.map((c) => c.title)).toContain('#1 on the leaderboard');
  });

  it('are left out when there are fewer than three', () => {
    expect(chapters({ ...run, samples: run.samples.slice(0, 10), events: [], final: { alive: false, mass: 0 } })).toEqual([]);
  });
});

