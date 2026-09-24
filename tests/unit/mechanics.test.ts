import { describe, expect, it } from 'vitest';
import { EJECTED, VIRUS, Cell } from '../../src/sim/cell.ts';
import { Organism } from '../../src/sim/organism.ts';
import { massToRadius } from '../../src/sim/rules.ts';
import { angle, vec3 } from '../../src/sphere/vec3.ts';
import { NORTH, addPlayer, emptyWorld, offset } from './helpers.ts';

describe('core mechanics on the sphere', () => {
  it('eats food within reach and conserves area', () => {
    const w = emptyWorld();
    const org = addPlayer(w, NORTH, 10);
    w.food.add(offset(w, NORTH, 20, 0), 10);
    w.food.add(offset(w, NORTH, 400, 0), 10);
    const r0 = org.cells[0].r;
    w.step();
    expect(w.food.count).toBe(1);
    expect(org.cells[0].r).toBeCloseTo(Math.sqrt(r0 * r0 + 100), 6);
    expect(w.events.filter((e) => e.type === 'eat')).toHaveLength(1);
  });

  it('no eat while the prey is not covered deeply enough (d ≥ R − r/3)', () => {
    const w = emptyWorld();
    const big = addPlayer(w, NORTH, 200); // r 141.4
    const small = addPlayer(w, offset(w, NORTH, 120, 0), 100); // r 100 → reach 141.4 − 33.3 = 108.1
    big.controller = { update: (_w, o) => Object.assign(o.target, o.cells[0].p) };
    small.controller = { update: (_w, o) => Object.assign(o.target, o.cells[0].p) };
    w.step();
    expect(small.cells).toHaveLength(1);
  });

  it('eats when overlap is deep enough, not when too similar in size', () => {
    const w = emptyWorld();
    const big = addPlayer(w, NORTH, 200);
    const prey = addPlayer(w, offset(w, NORTH, 50, 0), 100);
    const peer = addPlayer(w, offset(w, NORTH, -2000, 0), 200);
    const peer2 = addPlayer(w, offset(w, NORTH, -2030, 0), 180);
    for (const o of [big, prey, peer, peer2]) o.controller = { update: (_w, x) => x.cells[0] && Object.assign(x.target, x.cells[0].p) };
    const bigR = big.cells[0].r;
    w.step();
    expect(prey.alive).toBe(false);
    expect(big.cells[0].r).toBeCloseTo(Math.sqrt(bigR * bigR + 100 * 100), 3);
    expect(big.kills).toBe(1);
    expect(peer.alive && peer2.alive).toBe(true); // 200 vs 180: ratio 1.054 < 1.1401
  });

  it('split halves mass and the new cell travels ~780 units along a great circle', () => {
    const w = emptyWorld({ decayRate: 0 });
    const org = addPlayer(w, NORTH, 400);
    const target = offset(w, NORTH, 5000, 0);
    org.controller = { update: (_w, o) => Object.assign(o.target, target) };
    org.wantSplit = true;
    const massBefore = org.mass;
    w.step();
    expect(org.cells).toHaveLength(2);
    expect(org.cells[0].mass).toBeCloseTo(massBefore / 2, 3);
    // Freeze movement toward target to measure pure boost travel.
    org.controller = { update: (_w, o) => Object.assign(o.target, o.cells[1].p) };
    const start = vec3(org.cells[1].p.x, org.cells[1].p.y, org.cells[1].p.z);
    for (let i = 0; i < 60; i++) w.step();
    const travelled = w.R * angle(start, org.cells[1].p);
    expect(travelled).toBeGreaterThan(600);
    expect(travelled).toBeLessThan(800);
  });

  it('own cells push apart until the merge time, then merge', () => {
    const w = emptyWorld({ decayRate: 0 });
    const org = addPlayer(w, NORTH, 400);
    const hold = vec3(NORTH.x, NORTH.y, NORTH.z);
    org.controller = { update: (_w, o) => Object.assign(o.target, hold) };
    org.wantSplit = true;
    w.step();
    expect(org.cells).toHaveLength(2);
    for (let i = 0; i < 25 * 10; i++) w.step();
    expect(org.cells).toHaveLength(2);
    const [a, b] = org.cells;
    expect(w.R * angle(a.p, b.p)).toBeGreaterThan((a.r + b.r) * 0.95);
    for (let i = 0; i < 25 * 25; i++) w.step();
    expect(org.cells).toHaveLength(1);
    expect(org.mass).toBeCloseTo(400, 3);
  });

  it('eject costs 20.25 mass, makes a 16-mass pellet, and respects cooldown', () => {
    const w = emptyWorld({ decayRate: 0 });
    const org = addPlayer(w, NORTH, 100);
    const target = offset(w, NORTH, 1000, 0);
    org.controller = { update: (_w, o) => Object.assign(o.target, target) };
    org.wantEject = true;
    w.step();
    const ejected = w.cells.filter((c) => c.kind === EJECTED);
    expect(ejected).toHaveLength(1);
    expect(ejected[0].mass).toBeCloseTo(16, 6);
    expect(org.mass).toBeCloseTo(100 - 20.25, 3);
    org.wantEject = true;
    w.step();
    expect(w.cells.filter((c) => c.kind === EJECTED)).toHaveLength(1);
  });

  it('seven feeds make a virus shoot a new virus', () => {
    const w = emptyWorld();
    const virus = new Cell(w.newId(), VIRUS, NORTH, 100, 120, null, 0);
    (w as unknown as { addCell(c: Cell): void }).addCell(virus);
    w.virusMax = 100;
    for (let i = 0; i < 7; i++) {
      const ej = new Cell(w.newId(), EJECTED, offset(w, NORTH, 60, 0), 40, 0, null, w.tick);
      ej.heading.x = 0;
      ej.heading.y = 1;
      ej.heading.z = 0;
      (w as unknown as { addCell(c: Cell): void }).addCell(ej);
      w.step();
    }
    const viruses = w.cells.filter((c) => c.kind === VIRUS);
    expect(viruses).toHaveLength(2);
    expect(viruses[0].r).toBeCloseTo(100, 6);
  });

  it('a big cell that eats a virus pops into many pieces and gains its mass', () => {
    const w = emptyWorld({ decayRate: 0 });
    const org = addPlayer(w, NORTH, 1000);
    const hold = vec3(NORTH.x, NORTH.y, NORTH.z);
    org.controller = { update: (_w, o) => Object.assign(o.target, hold) };
    const virus = new Cell(w.newId(), VIRUS, offset(w, NORTH, 30, 0), 100, 120, null, 0);
    (w as unknown as { addCell(c: Cell): void }).addCell(virus);
    w.virusMax = 100;
    w.step();
    expect(org.cells.length).toBeGreaterThan(8);
    expect(org.cells.length).toBeLessThanOrEqual(16);
    expect(org.mass).toBeCloseTo(1100, 1);
  });

  it('small cells pass under viruses', () => {
    const w = emptyWorld();
    const org = addPlayer(w, NORTH, 50);
    const hold = vec3(NORTH.x, NORTH.y, NORTH.z);
    org.controller = { update: (_w, o) => Object.assign(o.target, hold) };
    const virus = new Cell(w.newId(), VIRUS, offset(w, NORTH, 10, 0), 100, 120, null, 0);
    (w as unknown as { addCell(c: Cell): void }).addCell(virus);
    w.step();
    expect(org.cells).toHaveLength(1);
    expect(w.cells.filter((c) => c.kind === VIRUS)).toHaveLength(1);
  });

  it('auto-splits at r ≥ 1500', () => {
    const w = emptyWorld({ decayRate: 0 });
    const org = addPlayer(w, NORTH, (1501 * 1501) / 100);
    const hold = vec3(NORTH.x, NORTH.y, NORTH.z);
    org.controller = { update: (_w, o) => Object.assign(o.target, hold) };
    w.step();
    expect(org.cells).toHaveLength(2);
  });

  it('NPCs outside the active zone go dormant and wake when the observer comes near', () => {
    const w = emptyWorld();
    const far = offset(w, NORTH, 12000, 0);
    const npc = new Organism(w.newId(), 'npc', 0, { update() {} }, false);
    w.addOrganism(npc);
    w.spawnOrganism(npc, far, massToRadius(10) ** 2 / 100);
    w.observer = vec3(NORTH.x, NORTH.y, NORTH.z);
    for (let i = 0; i < 25; i++) w.step();
    expect(npc.dormant).toBe(true);
    expect(npc.cells).toHaveLength(0);
    Object.assign(w.observer, npc.dormantP);
    for (let i = 0; i < 25; i++) w.step();
    expect(npc.dormant).toBe(false);
    expect(npc.cells).toHaveLength(1);
  });
});

describe('spawning', () => {
  it('findSafeSpotNear returns a unit vector within range, away from bigger cells', () => {
    const w = emptyWorld();
    const threat = addPlayer(w, NORTH, 2000);
    threat.controller = { update: (_w, o) => Object.assign(o.target, o.cells[0].p) };
    for (let i = 0; i < 20; i++) {
      const p = w.findSafeSpotNear(vec3(), NORTH, 3000, 31.6, 600);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 9);
      const d = w.R * angle(p, NORTH);
      expect(d).toBeLessThanOrEqual(3000 + 1e-6);
      expect(d - threat.cells[0].r - 31.6).toBeGreaterThanOrEqual(600);
    }
  });
});
