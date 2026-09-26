// Adaptive quality judges load, not vsync: a smooth game on a 60/120/144 Hz display with the odd missed vsync keeps its
// level, an overloaded device still steps down quickly, and a device on the edge settles instead of flip-flopping.
import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng.ts';
import { defaultRenderOptions } from '../../src/render/canvas/renderer.ts';
import { QualityController } from '../../src/render/quality.ts';

/** Feeds `seconds` of frames; `frame(level)` returns [dt, work] for the current level. */
function run(q: QualityController, seconds: number, frame: (level: number) => [number, number]): number {
  const opts = defaultRenderOptions();
  let t = 0;
  let changes = 0;
  while (t < seconds * 1000) {
    const [dt, work] = frame(q.level);
    t += dt;
    if (q.record(dt, work, opts)) changes++;
  }
  return changes;
}

/** A display at `hz` where 5 % of frames miss one vsync, with light work. */
const jittery = (hz: number, work: number, seed = 1) => {
  const rng = createRng(seed);
  const iv = 1000 / hz;
  return (): [number, number] => [rng() < 0.05 ? 2 * iv : iv, work * (0.8 + 0.4 * rng())];
};

describe('QualityController', () => {
  for (const hz of [60, 120, 144]) {
    it(`keeps full quality at ${hz} Hz with missed vsyncs and light work`, () => {
      const q = new QualityController(defaultRenderOptions());
      expect(run(q, 120, jittery(hz, 3))).toBe(0);
      expect(q.level).toBe(0);
    });
  }

  it('steps down one level per window on an overloaded 60 Hz device', () => {
    const q = new QualityController(defaultRenderOptions());
    // Every frame takes 30 ms of work, so frames land every other vsync (33 ms).
    run(q, 2 + 2 * 1.6, () => [33.3, 30]);
    expect(q.level).toBeGreaterThanOrEqual(1);
    run(q, 4 * 1.6, () => [33.3, 30]);
    expect(q.level).toBe(6);
  });

  it('steps down when GPU bound (slow frame rate, little JS work)', () => {
    const q = new QualityController(defaultRenderOptions());
    run(q, 2 + 2 * 1.6, () => [33.3, 2]);
    expect(q.level).toBeGreaterThanOrEqual(1);
  });

  it('settles on a device at the edge instead of flip-flopping', () => {
    const q = new QualityController(defaultRenderOptions());
    // Level 0 is too heavy (30 fps); every lower level is smooth with headroom, which tempts a step back up.
    const changes = run(q, 600, (level) => (level === 0 ? [33.3, 25] : [16.7, 3]));
    expect(q.level).toBe(1);
    expect(changes).toBeLessThanOrEqual(3);
    expect(q.locked).toBe(true);
    // A step back up comes only after three windows of headroom.
    for (let i = 1; i < q.events.length; i++) if (q.events[i].to < q.events[i].from) expect(q.events[i].t - q.events[i - 1].t).toBeGreaterThanOrEqual(3 * 1500);
  });

  it('does nothing when disabled (?quality=N)', () => {
    const q = new QualityController(defaultRenderOptions());
    q.enabled = false;
    expect(run(q, 30, () => [50, 45])).toBe(0);
  });
});
