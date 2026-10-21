// A guest's own cells, moved on its page at once. The host's world is the truth, but a round trip away: on its own,
// a guest's page would show its cells answering the pointer half a second late. So the page moves them itself, with
// the world's own movement (World.moveCells: steering, walls, holding apart), one move a tick, and tells the host each
// tick's steering with the tick's number. Each view of the host's says which of this page's ticks its state stands
// for; the page puts its cells where the host has them and plays its steering since that tick over again
// (client-side prediction with server reconciliation). What the two still disagree on (a push from another cell, a
// merge, a tick the host ran late) is put right at once in the cells' moves, and fades out on screen.
import { Cell, PLAYER } from '../sim/cell.ts';
import type { Organism } from '../sim/organism.ts';
import type { World } from '../sim/world.ts';
import { type Vec3, copy, nlerp, normalize, transport, vec3 } from '../sphere/vec3.ts';

/** Ticks of steering kept: five seconds, far more than a round trip that can be played with. */
const RING = 128;
/** How fast a correction fades out on screen (ms, time constant). */
const FADE_MS = 100;
/** A correction this large (world units) is not faded: the cell was somewhere else (a respawn, an explosion). */
const SNAP = 400;

/** One of the guest's own cells, as the host has it. */
export interface HostCell {
  id: number;
  p: Vec3;
  r: number;
  packed: number;
  boost: number;
  heading: Vec3;
  bornTick: number;
  /** What the walls left: the speed factor of a squeeze, and how far the nearest wall is (Infinity: none near). */
  squeeze: number;
  clearance: number;
  hue: number;
}

export class Prediction {
  /** This page's ticks so far: one move of its cells each, and the number its steering goes to the host with. */
  tick = 0;
  /** Where the colony was when the last tick aimed (the host keeps the aim relative to the colony). */
  readonly from = vec3(0, 0, 1);
  /** Ticks this page was ahead of the host's last view, and how far that view moved a cell (world units). */
  ahead = 0;
  correction = 0;
  /** The cells as this page moves them, by id. */
  readonly cells = new Map<number, Cell>();
  private list: Cell[] = [];
  /** Time toward the next tick (ms). */
  private acc = 0;
  /** Each tick's aim, and where the colony was then: the last RING ticks. */
  private readonly aims = new Float64Array(RING * 3);
  private readonly froms = new Float64Array(RING * 3);
  /** What corrections moved each cell by, still to fade out on screen. */
  private readonly offsets = new Map<number, Vec3>();
  /** The host's tick that this page's tick k moves in is k + base. */
  private base = 0;
  private readonly aim = vec3();
  private readonly was = vec3();
  private readonly here = vec3();
  private readonly saved = vec3();

  /** Whether the page moves cells of its own now. */
  get active(): boolean {
    return this.list.length > 0;
  }

  /** The colony's centre as this page has it, as Organism.center makes it; null without cells. */
  center(out: Vec3): Vec3 | null {
    if (this.list.length === 0) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of this.list) {
      x += c.p.x;
      y += c.p.y;
      z += c.p.z;
    }
    const l = Math.hypot(x, y, z) || 1;
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
    return out;
  }

  /** No cells of its own (not playing, a fresh picture, another world). The tick count goes on. */
  clear(): void {
    this.cells.clear();
    this.list = [];
    this.offsets.clear();
    this.ahead = 0;
    this.correction = 0;
  }

  /**
   * The host's view: `cells` are the colony's cells after this page's tick `echo`, which was the host's `hostTick`.
   * They are the cells now; the steering since `echo` moves them on to this page's tick.
   */
  correct(world: World, org: Organism, cells: readonly HostCell[], hostTick: number, echo: number): void {
    const before = new Map<number, Vec3>();
    for (const c of this.list) before.set(c.id, vec3(c.p.x, c.p.y, c.p.z));
    const next: Cell[] = [];
    for (const h of cells) {
      const c = this.cells.get(h.id) ?? new Cell(h.id, PLAYER, h.p, h.r, h.hue, org, h.bornTick);
      copy(c.p, h.p);
      copy(c.prev, h.p);
      c.r = h.r;
      c.packed = h.packed;
      c.boost = h.boost;
      copy(c.heading, h.heading);
      c.bornTick = h.bornTick;
      c.squeeze = h.squeeze;
      c.clearance = h.clearance;
      next.push(c);
    }
    this.cells.clear();
    for (const c of next) this.cells.set(c.id, c);
    for (const id of this.offsets.keys()) if (!this.cells.has(id)) this.offsets.delete(id);
    this.list = next;
    this.base = hostTick - echo;
    // The host is behind by the round trip: the steering it has not had yet, again. A host ahead of this page (its
    // guess at which tick it stands for has drifted) or far behind it stands as it is.
    const behind = this.tick - echo;
    this.ahead = behind;
    if (behind > 0 && behind < RING) for (let k = echo + 1; k <= this.tick; k++) this.move(world, org, k);

    // On screen, each cell goes on from where it was drawn, and the difference fades out.
    let worst = 0;
    for (const c of next) {
      const was = before.get(c.id);
      if (!was) continue;
      const dx = was.x - c.p.x;
      const dy = was.y - c.p.y;
      const dz = was.z - c.p.z;
      const d = Math.hypot(dx, dy, dz) * world.R;
      worst = Math.max(worst, d);
      if (d > SNAP) {
        this.offsets.delete(c.id);
        continue;
      }
      let off = this.offsets.get(c.id);
      if (!off) this.offsets.set(c.id, (off = vec3()));
      off.x += dx;
      off.y += dy;
      off.z += dz;
    }
    this.correction = worst;
  }

  /**
   * `dt` ms of this page's time: a move of its cells for each tick it completes, toward `org.target`, which is kept
   * as that tick's aim. Returns the number of ticks.
   */
  advance(world: World, org: Organism, dt: number, tickMs: number): number {
    this.acc += dt;
    let n = 0;
    while (this.acc >= tickMs) {
      this.acc -= tickMs;
      this.tick++;
      n++;
      // Where the colony is as this page has it, else as it is drawn (the host's), else nowhere: the aim as it is.
      if (!this.center(this.from)) {
        if (org.cells.length > 0) org.center(this.from);
        else copy(this.from, org.target);
      }
      const i = (this.tick % RING) * 3;
      this.aims[i] = org.target.x;
      this.aims[i + 1] = org.target.y;
      this.aims[i + 2] = org.target.z;
      this.froms[i] = this.from.x;
      this.froms[i + 1] = this.from.y;
      this.froms[i + 2] = this.from.z;
      if (this.list.length > 0) world.moveCells(org, this.list, this.tick + this.base);
    }
    return n;
  }

  /** Tick `k` again, with its own aim, kept relative to the colony as the host keeps it. */
  private move(world: World, org: Organism, k: number): void {
    const i = (k % RING) * 3;
    const aim = this.aim;
    aim.x = this.aims[i];
    aim.y = this.aims[i + 1];
    aim.z = this.aims[i + 2];
    const from = this.was;
    from.x = this.froms[i];
    from.y = this.froms[i + 1];
    from.z = this.froms[i + 2];
    if (this.center(this.here)) transport(aim, from, this.here);
    copy(this.saved, org.target);
    copy(org.target, aim);
    world.moveCells(org, this.list, k + this.base);
    copy(org.target, this.saved);
  }

  /** The cells into the world's own copies of them, where they are drawn: between this page's last two ticks. */
  draw(world: World, dt: number, tickMs: number): void {
    const t = Math.min(1, this.acc / tickMs);
    const fade = Math.exp(-dt / FADE_MS);
    for (const c of this.list) {
      const cell = world.cellsById.get(c.id);
      if (!cell) continue;
      const out = cell.p;
      nlerp(out, c.prev, c.p, t);
      const off = this.offsets.get(c.id);
      if (off) {
        out.x += off.x;
        out.y += off.y;
        out.z += off.z;
        normalize(out);
        off.x *= fade;
        off.y *= fade;
        off.z *= fade;
        if (Math.hypot(off.x, off.y, off.z) * world.R < 0.05) this.offsets.delete(c.id);
      }
      // The same place at both ends of the frame's interpolation: the host's views' alpha moves it no further.
      copy(cell.prev, out);
      cell.r = c.r;
      cell.packed = c.packed;
    }
  }
}
