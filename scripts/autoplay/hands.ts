// The autoplayer's hands: intents in, timed input events out, the way a person moves a mouse or a thumb. Pure and seeded
// (the same seed moves the same way), so a recording and its dry run send identical input.
//
// - Reaction: an intent is acted on 150–260 ms after the snapshot it was decided from.
// - The cursor sits along the heading, a little way from our cell (the camera keeps the cell near the screen centre).
//   Big changes are minimum-jerk reaches timed by Fitts's law, landing near the target and then correcting onto it;
//   small ones are smooth pursuit with about 90 ms of lag, plus a little tremor.
// - Splits: Space, pressed once the cursor has settled on the target, held 60–110 ms, at most about 5 a second.
// - Touch: one thumb drags to steer and now and then lifts and comes down again; the other taps the Split button.
import { createRng, type Rng } from '../../src/core/rng.ts';
import type { Intent } from './brain.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the hands know about the screen this frame. */
export interface Screen {
  /** The camera: centre, right, down (unit vectors), zoom, viewport w, h (as in Snapshot.cam). */
  cam: number[];
  /** Our largest cell (unit vector), or null when there is none. */
  me: number[] | null;
  /** Places the cursor or thumb must not rest on (the minimap, buttons). */
  avoid: Rect[];
  /** The Split button (touch). */
  split: Rect | null;
}

export type HandEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'key'; code: 'Space' | 'KeyW'; down: boolean }
  | { type: 'touch'; phase: 'start' | 'move' | 'end'; points: { id: number; x: number; y: number }[] }
  /** Menu only: a mouse button, and a typed character. */
  | { type: 'button'; down: boolean; x: number; y: number }
  | { type: 'char'; key: string; down: boolean };

const STEER = 1;
const TAP = 2;
/** How close (CSS px) a thumb comes to the screen's edge. */
const EDGE_TOUCH = 24;

const minJerk = (s: number) => s * s * s * (10 - 15 * s + 6 * s * s);

/** About N(0, 1) from four uniforms. */
function gauss(rng: Rng): number {
  return (rng() + rng() + rng() + rng() - 2) * Math.sqrt(3);
}

const between = (rng: Rng, a: number, b: number) => a + rng() * (b - a);

/** Fitts's law: seconds to reach a target `dist` px away and `width` px across. */
export const reachTime = (dist: number, width: number) => 0.1 + 0.11 * Math.log2(dist / Math.max(4, width) + 1);

interface Move {
  t0: number;
  dur: number;
  fx: number;
  fy: number;
  /** Lateral bend (px) and where the main movement lands relative to the target. */
  bend: number;
  offX: number;
  offY: number;
}

export class Hands {
  readonly touch: boolean;
  /** Sphere radius in world units (set by the caller from the config). */
  R = 16000;
  private readonly rng: Rng;
  /** Cursor (or steering thumb), CSS px. */
  x: number;
  y: number;
  private queue: { at: number; intent: Intent }[] = [];
  private active: Intent | null = null;
  private move: Move | null = null;
  private polar: { t0: number; dur: number; a0: number; r0: number; bend: number } | null = null;
  private lastT = 0;
  private tremorX = 0;
  private tremorY = 0;
  // Splits.
  private splitFor = -1;
  private splitDone = -1;
  private settledSince = -1;
  private settleNeed = 0.1;
  private keyUpAt = -1;
  private lastPress = -1e9;
  // Touch.
  private down = false;
  private liftUntil = -1;
  private nextLift = 0;
  private tapUntil = -1;
  private tapAt = { x: 0, y: 0 };
  /** Presses so far (tests, logs). */
  presses = 0;

  constructor(seed: number, touch: boolean, w: number, h: number) {
    this.rng = createRng(seed ^ 0x5eed);
    this.touch = touch;
    this.x = w / 2 + 120;
    this.y = h / 2 + 60;
    this.nextLift = between(this.rng, 5, 11);
  }

  /** A new intent, decided from the snapshot at `intent.t`, is acted on after the player's reaction time. */
  push(intent: Intent): void {
    const reaction = Math.min(0.26, Math.max(0.15, 0.2 + 0.03 * gauss(this.rng)));
    this.queue.push({ at: intent.t / 1000 + reaction, intent });
  }

  /** Our cell on screen this frame (the centre the cursor swings around). */
  private me: { x: number; y: number } | null = null;

  /** Screen point the active intent asks for, kept inside the viewport and off the places to avoid. */
  private target(view: Screen): { x: number; y: number } | null {
    const it = this.active;
    this.me = view.me ? this.toScreen(view.cam, view.me[0], view.me[1], view.me[2]) : null;
    if (!it || !view.me) return null;
    const cam = view.cam;
    const w = cam[10];
    const h = cam[11];
    const me = this.me!;
    if (it.mode === 'park') return me;
    if (it.mode === 'at') return this.clamp(this.toScreen(cam, it.p[0], it.p[1], it.p[2]), w, h);
    // A thumb stays off the bezel (Chrome cancels a touch dragged along the screen's edge, as phones do).
    const margin = this.touch ? EDGE_TOUCH : 12;
    // 'go': along the heading (a world tangent) from our cell, shortened to stay on screen and off the avoid zones.
    const dx = it.dir[0] * cam[3] + it.dir[1] * cam[4] + it.dir[2] * cam[5];
    const dy = it.dir[0] * cam[6] + it.dir[1] * cam[7] + it.dir[2] * cam[8];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return me;
    const ux = dx / l;
    const uy = dy / l;
    let dist = it.dist;
    // A thumb's contact area is wide: it keeps further from the buttons than a cursor does.
    const pad = this.touch ? 24 : 8;
    for (let k = 0; k < 24; k++) {
      const px = me.x + ux * dist;
      const py = me.y + uy * dist;
      const inside = px >= margin && py >= margin && px <= w - margin && py <= h - margin;
      if (inside && !view.avoid.some((r) => px >= r.x - pad && py >= r.y - pad && px <= r.x + r.w + pad && py <= r.y + r.h + pad)) break;
      dist *= 0.85;
    }
    // The cell slows when the pointer is within 32 world units of it: keep the cursor clear of that.
    const zoom = cam[9];
    dist = Math.max(dist, Math.min(it.dist, 48 * zoom + 10));
    return { x: me.x + ux * dist, y: me.y + uy * dist };
  }

  private toScreen(cam: number[], x: number, y: number, z: number): { x: number; y: number } {
    // Azimuthal equidistant projection about the camera centre (as Frame.project), then to CSS px.
    const cosT = x * cam[0] + y * cam[1] + z * cam[2];
    const tx = x * cam[3] + y * cam[4] + z * cam[5];
    const ty = x * cam[6] + y * cam[7] + z * cam[8];
    const sinT = Math.hypot(tx, ty);
    const zoom = cam[9];
    if (sinT < 1e-12) return { x: cam[10] / 2, y: cam[11] / 2 };
    const k = (this.R * Math.atan2(sinT, cosT)) / sinT;
    return { x: cam[10] / 2 + tx * k * zoom, y: cam[11] / 2 + ty * k * zoom };
  }

  private clamp(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
    const m = this.touch ? EDGE_TOUCH : 4;
    return { x: Math.min(w - m, Math.max(m, p.x)), y: Math.min(h - m, Math.max(m, p.y)) };
  }

  /** Where the cursor or the fingers are now, for drawing them (id 1: the cursor or steering thumb, 2: the tapping one). */
  fingers(): { x: number; y: number; down: boolean; id: number }[] {
    if (!this.touch) return [{ x: this.x, y: this.y, down: false, id: 1 }];
    const out = [{ x: this.x, y: this.y, down: this.down, id: 1 }];
    out.push({ x: this.tapAt.x, y: this.tapAt.y, down: this.tapUntil >= 0, id: 2 });
    return out;
  }

  /** The browser cancelled the steering thumb's touch: it is up now, and comes down again after a moment. */
  cancelTouch(now: number): void {
    this.down = false;
    this.tapUntil = -1;
    this.liftUntil = now + 0.2;
  }

  /** The events for the frame at `now` (seconds since Play). */
  frame(now: number, view: Screen): HandEvent[] {
    const out: HandEvent[] = [];
    const dt = Math.max(0, now - this.lastT);
    this.lastT = now;
    while (this.queue.length && this.queue[0].at <= now) this.active = this.queue.shift()!.intent;
    const goal = this.target(view);

    // Key release of a press in progress.
    if (this.keyUpAt >= 0 && now >= this.keyUpAt) {
      out.push({ type: 'key', code: 'Space', down: false });
      this.keyUpAt = -1;
    }

    const ox = this.x;
    const oy = this.y;
    if (goal) this.steer(now, dt, goal);
    // Tremor: a fraction of a pixel, smoothed.
    this.tremorX = 0.8 * this.tremorX + 0.2 * gauss(this.rng) * 0.35;
    this.tremorY = 0.8 * this.tremorY + 0.2 * gauss(this.rng) * 0.35;
    const w = view.cam[10];
    const h = view.cam[11];
    const edge = this.touch ? EDGE_TOUCH : 2;
    const px = Math.min(w - edge, Math.max(edge, this.x + this.tremorX));
    const py = Math.min(h - edge, Math.max(edge, this.y + this.tremorY));
    const moved = Math.abs(px - ox) > 0.01 || Math.abs(py - oy) > 0.01;
    this.x = px;
    this.y = py;

    if (!this.touch) {
      if (moved) out.push({ type: 'move', x: px, y: py });
      this.splits(now, goal, out);
      return out;
    }

    // Touch: the steering thumb.
    const points = () => {
      const p: { id: number; x: number; y: number }[] = [];
      if (this.down) p.push({ id: STEER, x: this.x, y: this.y });
      if (this.tapUntil >= 0) p.push({ id: TAP, x: this.tapAt.x, y: this.tapAt.y });
      return p;
    };
    if (this.liftUntil >= 0 && now >= this.liftUntil) this.liftUntil = -1;
    if (!this.down && goal && this.liftUntil < 0) {
      // The thumb comes down where it means to steer (on the screen, off its edge).
      this.x = Math.min(w - edge, Math.max(edge, goal.x));
      this.y = Math.min(h - edge, Math.max(edge, goal.y));
      this.move = null;
      this.down = true;
      out.push({ type: 'touch', phase: 'start', points: points() });
    } else if (this.down && now >= this.nextLift && this.tapUntil < 0) {
      this.down = false;
      this.liftUntil = now + between(this.rng, 0.15, 0.35);
      this.nextLift = now + between(this.rng, 5, 12);
      out.push({ type: 'touch', phase: 'end', points: points() });
    } else if (this.down && moved) out.push({ type: 'touch', phase: 'move', points: points() });
    this.splits(now, goal, out, view);
    return out;
  }

  private steer(now: number, dt: number, goal: { x: number; y: number }): void {
    // Steering swings the cursor around our cell (in polar coordinates about it), as a player does: a straight line to
    // the other side would cross the cell, where it slows down. Aiming at a point moves in a straight line.
    const c = this.me;
    if (c && this.active && this.active.mode === 'go') {
      const a0 = Math.atan2(this.y - c.y, this.x - c.x);
      const r0 = Math.hypot(this.x - c.x, this.y - c.y);
      const a1 = Math.atan2(goal.y - c.y, goal.x - c.x);
      const r1 = Math.hypot(goal.x - c.x, goal.y - c.y);
      let da = a1 - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const arc = Math.abs(da) * Math.max(r0, r1) + Math.abs(r1 - r0);
      let m = this.polar;
      if (m && (now - m.t0 >= m.dur || arc < 2)) m = this.polar = null;
      if (!m && arc > 90) {
        m = this.polar = { t0: now, dur: reachTime(arc, this.touch ? 60 : 40) * (this.touch ? 1.15 : 1), a0, r0, bend: Math.max(-12, Math.min(12, 10 * gauss(this.rng))) };
      }
      if (m) {
        // The end follows the (moving) goal; the radius bulges a little mid-swing.
        const e = minJerk(Math.min(1, (now - m.t0) / m.dur));
        let dm = a1 - m.a0;
        while (dm > Math.PI) dm -= 2 * Math.PI;
        while (dm < -Math.PI) dm += 2 * Math.PI;
        const a = m.a0 + dm * e;
        const r = Math.max(8, m.r0 + (r1 - m.r0) * e + m.bend * 4 * e * (1 - e));
        this.x = c.x + Math.cos(a) * r;
        this.y = c.y + Math.sin(a) * r;
        return;
      }
      const k = 1 - Math.exp(-dt / (this.touch ? 0.11 : 0.09));
      const a = a0 + da * k;
      const r = r0 + (r1 - r0) * k;
      this.x = c.x + Math.cos(a) * r;
      this.y = c.y + Math.sin(a) * r;
      this.move = null;
      return;
    }
    this.polar = null;
    const dist = Math.hypot(goal.x - this.x, goal.y - this.y);
    const m = this.move;
    if (m) {
      const s = (now - m.t0) / m.dur;
      if (s >= 1 || dist < 2) {
        this.move = null;
      } else {
        // The end of the reach follows the (moving) goal; the path bends a little and lands slightly off.
        const e = minJerk(Math.min(1, s));
        const tx = goal.x + m.offX * (1 - e);
        const ty = goal.y + m.offY * (1 - e);
        const lx = m.fx + (tx - m.fx) * e;
        const ly = m.fy + (ty - m.fy) * e;
        const dx = tx - m.fx;
        const dy = ty - m.fy;
        const l = Math.hypot(dx, dy) || 1;
        const b = m.bend * 4 * e * (1 - e);
        this.x = lx - (dy / l) * b;
        this.y = ly + (dx / l) * b;
        return;
      }
    }
    if (dist > 70) {
      const width = this.touch ? 60 : 40;
      this.move = {
        t0: now,
        dur: reachTime(dist, width) * (this.touch ? 1.15 : 1),
        fx: this.x,
        fy: this.y,
        bend: Math.max(-30, Math.min(30, dist * 0.06 * gauss(this.rng))),
        offX: Math.max(-14, Math.min(14, dist * 0.04 * gauss(this.rng))),
        offY: Math.max(-14, Math.min(14, dist * 0.04 * gauss(this.rng))),
      };
      return;
    }
    const k = 1 - Math.exp(-dt / (this.touch ? 0.11 : 0.09));
    this.x += (goal.x - this.x) * k;
    this.y += (goal.y - this.y) * k;
  }

  /** Space (or a tap on Split) once the cursor has settled on the split target. */
  private splits(now: number, goal: { x: number; y: number } | null, out: HandEvent[], view?: Screen): void {
    const it = this.active;
    if (this.touch && this.tapUntil >= 0 && now >= this.tapUntil) {
      this.tapUntil = -1;
      const pts: { id: number; x: number; y: number }[] = this.down ? [{ id: STEER, x: this.x, y: this.y }] : [];
      out.push({ type: 'touch', phase: 'end', points: pts });
    }
    if (!it || !it.split || !goal || this.splitDone === it.t) {
      this.settledSince = -1;
      return;
    }
    if (this.splitFor !== it.t) {
      this.splitFor = it.t;
      this.settledSince = -1;
      this.settleNeed = between(this.rng, 0.06, 0.15);
    }
    // Give up on a split the hand couldn't line up in time.
    if (now - it.t / 1000 > 0.9) {
      this.splitDone = it.t;
      return;
    }
    const off = Math.hypot(goal.x - this.x, goal.y - this.y);
    if (off > 10 || this.move || this.polar) {
      this.settledSince = -1;
      return;
    }
    if (this.settledSince < 0) this.settledSince = now;
    if (now - this.settledSince < this.settleNeed || now - this.lastPress < 0.2 || this.keyUpAt >= 0 || this.tapUntil >= 0) return;
    this.splitDone = it.t;
    this.lastPress = now;
    this.presses++;
    if (!this.touch) {
      out.push({ type: 'key', code: 'Space', down: true });
      this.keyUpAt = now + between(this.rng, 0.06, 0.11);
      return;
    }
    const b = view?.split;
    if (!b) return;
    this.tapAt = {
      x: b.x + b.w * Math.min(0.75, Math.max(0.25, 0.5 + 0.15 * gauss(this.rng))),
      y: b.y + b.h * Math.min(0.75, Math.max(0.25, 0.5 + 0.15 * gauss(this.rng))),
    };
    this.tapUntil = now + between(this.rng, 0.07, 0.14);
    const pts: { id: number; x: number; y: number }[] = this.down ? [{ id: STEER, x: this.x, y: this.y }] : [];
    pts.push({ id: TAP, x: this.tapAt.x, y: this.tapAt.y });
    out.push({ type: 'touch', phase: 'start', points: pts });
  }
}

/**
 * The menu, by hand: from a resting position, reach the name field, click (or tap) it, type `name`, reach Play and
 * press it. Returns the events per frame (index 0 = the first frame) at `fps`.
 */
export function menuScript(seed: number, name: string, nick: Rect, play: Rect, touch: boolean, w: number, h: number, fps = 60): HandEvent[][] {
  const rng = createRng(seed ^ 0x3e2a);
  const frames: HandEvent[][] = [];
  const at = (k: number) => (frames[k] ??= []);
  let f = 0;
  let x = w * (touch ? 0.62 : 0.74);
  let y = h * (touch ? 0.84 : 0.8);
  const hold = (s: number) => (f += Math.max(1, Math.round(s * fps)));
  const point = (r: Rect) => ({
    x: r.x + r.w * Math.min(0.8, Math.max(0.2, 0.5 + 0.12 * gauss(rng))),
    y: r.y + r.h * Math.min(0.75, Math.max(0.25, 0.5 + 0.12 * gauss(rng))),
  });
  const reach = (to: { x: number; y: number }, width: number) => {
    if (touch) {
      x = to.x;
      y = to.y;
      return;
    }
    const dist = Math.hypot(to.x - x, to.y - y);
    const dur = reachTime(dist, width);
    const n = Math.max(1, Math.round(dur * fps));
    const bend = Math.max(-25, Math.min(25, dist * 0.06 * gauss(rng)));
    const fx = x;
    const fy = y;
    for (let k = 1; k <= n; k++) {
      const e = minJerk(k / n);
      const l = dist || 1;
      const b = bend * 4 * e * (1 - e);
      at(f + k).push({ type: 'move', x: fx + (to.x - fx) * e - ((to.y - fy) / l) * b, y: fy + (to.y - fy) * e + ((to.x - fx) / l) * b });
    }
    f += n;
    x = to.x;
    y = to.y;
  };
  const press = (r: Rect) => {
    const p = point(r);
    reach(p, Math.min(r.w, r.h));
    hold(between(rng, 0.06, 0.15));
    if (touch) at(f).push({ type: 'touch', phase: 'start', points: [{ id: 1, x: p.x, y: p.y }] });
    else at(f).push({ type: 'button', down: true, x: p.x, y: p.y });
    hold(touch ? between(rng, 0.07, 0.14) : between(rng, 0.06, 0.11));
    if (touch) at(f).push({ type: 'touch', phase: 'end', points: [] });
    else at(f).push({ type: 'button', down: false, x: p.x, y: p.y });
  };
  // The hand comes to the mouse (or the thumb to the screen), rests a moment, then goes for the name field.
  if (!touch) at(0).push({ type: 'move', x, y });
  hold(between(rng, 0.5, 0.8));
  press(nick);
  hold(between(rng, 0.25, 0.45));
  for (const ch of name) {
    at(f).push({ type: 'char', key: ch, down: true });
    hold(between(rng, 0.05, 0.09));
    at(f).push({ type: 'char', key: ch, down: false });
    hold(between(rng, 0.06, 0.16));
  }
  hold(between(rng, 0.2, 0.4));
  press(play);
  return Array.from({ length: f + 1 }, (_, k) => frames[k] ?? []);
}