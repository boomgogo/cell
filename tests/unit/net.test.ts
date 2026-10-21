// A room in Node: a host's page and guests' pages, each a world of its own as in the browser, joined by an
// in-memory stand-in for a p3p2 room (what the server relays, in order, at once). No server and no browser: this is
// the game's side of a room. tests/e2e/friends.spec.ts plays the same through a real server.
import type { Member, P3P2, Room } from '@p3p2/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFFICULTY } from '../../src/ai/personalities.ts';
import { populateNpcs, populateResidents } from '../../src/ai/population.ts';
import { arcadeConfig } from '../../src/config/arcade.ts';
import { createRng } from '../../src/core/rng.ts';
import type { GameConfig } from '../../src/config/types.ts';
import type { Game, GameState } from '../../src/game.ts';
import { HumanController } from '../../src/input/human.ts';
import type { Input } from '../../src/input/input.ts';
import { MAX_PLAYERS, Net } from '../../src/net/Net.ts';
import { rulesDiffer, withRules, worldRules } from '../../src/net/rules.ts';
import { Reader, Writer } from '../../src/net/wire.ts';
import { Camera } from '../../src/render/camera.ts';
import { PLAYER } from '../../src/sim/cell.ts';
import type { EatEvent } from '../../src/sim/events.ts';
import { PELLET } from '../../src/sim/food.ts';
import { Organism } from '../../src/sim/organism.ts';
import { eatReach } from '../../src/sim/rules.ts';
import { World } from '../../src/sim/world.ts';
import { type Vec3, dot, vec3 } from '../../src/sphere/vec3.ts';
import { eatPoints } from '../../src/ui/points.ts';

// ---- a room without a server

type Handler = (...args: unknown[]) => void;

class Hub {
  readonly rooms: FakeRoom[] = [];
  hostId: number | null = null;
  readonly values = new Map<string, unknown>();
  /** How long a message takes each way, in ticks of `clock` (a real server is a round trip away from everybody). */
  lag = 0;
  /** Up to this many ticks more for any one message, in order all the same (a connection's ups and downs). */
  jitter = 0;
  /** Ticks so far, for `lag` (run() counts them). */
  clock = 0;
  /** Messages on their way: a server never hands one over before the sender's call returns. */
  private readonly queue: { at: number; deliver: () => void }[] = [];
  private lastAt = 0;
  private readonly rand = createRng(7);
  private nextId = 1;

  post(deliver: () => void): void {
    const at = Math.max(this.lastAt, this.clock + this.lag + Math.floor(this.rand() * (this.jitter + 1)));
    this.lastAt = at;
    this.queue.push({ at, deliver });
  }

  /** Everything sent so far that has arrived by now, and what that sends in turn. */
  flush(): void {
    for (let n = 0; this.queue.length > 0 && this.queue[0].at <= this.clock && n < 100_000; n++) this.queue.shift()!.deliver();
  }

  join(name: string): FakeRoom {
    const member: Member = { id: this.nextId, pid: `pid-${this.nextId}`, name, order: this.nextId, rtt: null, state: 'here' } as Member;
    this.nextId++;
    const room = new FakeRoom(this, member);
    this.rooms.push(room);
    this.hostId ??= member.id;
    for (const r of this.rooms) if (r !== room) r.emit('member-join', member);
    return room;
  }

  leave(room: FakeRoom): void {
    this.rooms.splice(this.rooms.indexOf(room), 1);
    for (const r of this.rooms) r.emit('member-leave', room.self, 'left');
    if (this.hostId === room.self.id) {
      this.hostId = this.rooms[0]?.self.id ?? null;
      for (const r of this.rooms) r.emit('host-change', r.host);
    }
  }

  state(room: FakeRoom, state: 'here' | 'away' | 'lost'): void {
    (room.self as { state: string }).state = state;
    for (const r of this.rooms) if (r !== room) r.emit('member-state', room.self, state);
  }

  member(id: number): FakeRoom | undefined {
    return this.rooms.find((r) => r.self.id === id);
  }
}

/** What Net uses of a p3p2 `Room`, delivered at once and in order. */
class FakeRoom {
  readonly name = 'Test room';
  readonly status = 'open';
  readonly limits = { maxFrameBytes: 65536, maxLogBytes: 1 << 20 };
  /** Bytes this member sent, by channel. */
  readonly sent = new Map<string, number>();
  private readonly handlers = new Map<string, Set<Handler>>();

  readonly hub: Hub;
  readonly self: Member;

  constructor(hub: Hub, self: Member) {
    this.hub = hub;
    this.self = self;
  }

  get members(): Member[] {
    return this.hub.rooms.map((r) => r.self);
  }

  get host(): Member | null {
    return this.hub.hostId === null ? null : (this.hub.member(this.hub.hostId)?.self ?? null);
  }

  get isHost(): boolean {
    return this.hub.hostId === this.self.id;
  }

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }

  send(channel: string, data: unknown, options: { to?: 'others' | 'all' | 'host' | number } = {}): boolean {
    const to = options.to ?? 'others';
    const targets =
      to === 'host'
        ? this.hub.rooms.filter((r) => r.self.id === this.hub.hostId)
        : typeof to === 'number'
          ? this.hub.rooms.filter((r) => r.self.id === to)
          : this.hub.rooms.filter((r) => to === 'all' || r !== this);
    this.count(channel, data);
    const copy = copyOf(data);
    for (const r of targets) this.hub.post(() => r.emit(channel, copyOf(copy), this.self, { ts: Date.now(), retained: false }));
    return true;
  }

  sendEach(channel: string, parts: Iterable<readonly [Member | number, Uint8Array]>): boolean {
    for (const [m, bytes] of parts) {
      this.count(channel, bytes);
      const copy = copyOf(bytes);
      this.hub.post(() => this.hub.member(typeof m === 'number' ? m : m.id)?.emit(channel, copy, this.self, { ts: Date.now(), retained: false }));
    }
    return true;
  }

  offer(channel: string, data: unknown): Promise<unknown> {
    if (!this.hub.values.has(channel)) this.hub.values.set(channel, copyOf(data));
    return Promise.resolve(copyOf(this.hub.values.get(channel)));
  }

  private count(channel: string, data: unknown): void {
    const n = data instanceof Uint8Array ? data.length : JSON.stringify(data ?? null).length;
    this.sent.set(channel, (this.sent.get(channel) ?? 0) + n);
  }
}

function copyOf(data: unknown): unknown {
  return data instanceof Uint8Array ? new Uint8Array(data) : data === undefined ? undefined : structuredClone(data);
}

const P3P2_STUB = { on: () => () => {}, open() {} } as unknown as P3P2;

// ---- a page without a DOM: the parts of Game that Net uses, as Game does them

class FakeInput {
  has = false;
  splits = 0;
  consumeSplit(): boolean {
    if (this.splits === 0) return false;
    this.splits--;
    return true;
  }
  consumeEject(): boolean {
    return false;
  }
}

interface Page {
  game: Game;
  net: Net;
  room: FakeRoom;
  input: FakeInput;
  /** Points this page scored, as Game scores them. */
  points: () => number;
  refusedWith: () => string;
  play(name: string): void;
}

function page(hub: Hub, name: string, seed: number, district: number, cfg: GameConfig = arcadeConfig): Page {
  const world = new World(cfg, { seed });
  const camera = new Camera(cfg);
  camera.resize(1280, 720);
  const d = world.maze.district(district);
  camera.jumpTo(d.point(d.maze.start[0], d.maze.start[1], vec3()), 64);
  world.observer = camera.frame.c;
  populateNpcs(world, { difficulty: DIFFICULTY.normal });
  populateResidents(world);
  const input = new FakeInput();
  const human = new Organism(world.newId(), '', 50, new HumanController(input as unknown as Input, camera), true);
  world.addOrganism(human);
  let points = 0;
  let refusedWith = '';
  const g = {
    cfg,
    seed,
    world,
    camera,
    input,
    human,
    state: 'menu' as GameState,
    net: null,
    difficulty: DIFFICULTY.normal,
    stats: { tickMs: 0 },
    hud: { setRoom() {} },
    newWorld(s: number): World {
      const w = new World(cfg, { seed: s });
      w.observer = camera.frame.c;
      populateNpcs(w, { difficulty: DIFFICULTY.normal });
      populateResidents(w);
      return w;
    },
    replaceWorld(w: World, h: Organism): void {
      g.world = w;
      g.human = h;
      w.observer = camera.frame.c;
    },
    placed(at: Vec3): void {
      camera.jumpTo(at, g.human.sumRadius);
    },
    takeEvents(): void {
      if (g.state !== 'playing') return;
      for (const e of g.world.events) if (e.type === 'eat') points += eatPoints(e, g.human.id);
    },
    lookAt(at: Vec3): void {
      camera.jumpTo(at, 64);
    },
    friendInSight(): Organism | null {
      return g.world.organisms.find((o) => o.isHuman && o !== g.human && o.alive && o.cells.length > 0) ?? null;
    },
    refused(message: string): void {
      g.state = 'menu';
      refusedWith = message;
    },
    spawnPoint(near: Vec3): Vec3 {
      const w = g.world;
      const dist = w.maze.district(w.maze.layout.regionAt(near));
      const p = dist.point(dist.maze.start[0], dist.maze.start[1], vec3());
      let threat = false;
      w.queryCells(p, 900, (c) => {
        if (c.owner && c.r > cfg.startRadius && w.distance(c.p, p) - c.r < 500) threat = true;
        if (c.owner?.isHuman && w.distance(c.p, p) - c.r < 200) threat = true;
      });
      return threat ? w.findSafeSpotNear(vec3(), near, 4000, cfg.startRadius) : p;
    },
  };
  const game = g as unknown as Game;
  const net = new Net(game, P3P2_STUB);
  const room = hub.join(name);
  net.enter(room as unknown as Room);
  return {
    game,
    net,
    room,
    input,
    points: () => points,
    refusedWith: () => refusedWith,
    play(nick: string) {
      const full = game.net?.full() ?? null;
      if (full) return game.refused(full);
      game.human.name = nick;
      const remote = game.net?.play(nick, 120) ?? false;
      if (!remote) game.world.spawnOrganism(game.human, game.spawnPoint(game.camera.frame.c));
      game.state = 'playing';
    },
  };
}

let now = 1000;

/** `ticks` of the host's world, each followed by a frame on every guest's page. */
function run(host: Page, guests: Page[], ticks: number): void {
  const hub = host.room.hub;
  for (let t = 0; t < ticks; t++) {
    hub.clock++;
    hub.flush();
    const g = host.game;
    g.world.step();
    g.takeEvents(now);
    g.net?.stepped(now);
    hub.flush();
    now += g.cfg.tickMs;
    for (const guest of guests) {
      guest.game.net?.frame(now, g.cfg.tickMs);
      hub.flush();
      // The guest's camera follows its colony, as Game.frame does.
      const h = guest.game.human;
      if (h.cells.length > 0) guest.game.camera.jumpTo(h.center(vec3()), h.sumRadius);
    }
  }
}

/** The host's own world's organism for the guest's colony. */
function colonyOf(host: Page, guest: Page): Organism {
  const name = guest.game.human.name;
  const org = host.game.world.organisms.find((o) => o.isHuman && o !== host.game.human && o.name === name);
  if (!org) throw new Error(`no colony for ${name} on the host`);
  return org;
}

beforeEach(() => {
  vi.stubGlobal('location', { search: '', href: 'http://localhost:5173/', replace: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wire', () => {
  it('reads back what it wrote, and drops a message cut short', () => {
    const w = new Writer(4);
    w.u8(7).u16(65535).u32(4_000_000_000).i16(-1234).f32(3.25).unit(vec3(0.6, 0, 0.8)).text('Ada 🌍');
    const bytes = w.bytes();
    const r = new Reader(bytes);
    expect([r.u8(), r.u16(), r.u32(), r.i16(), r.f32()]).toEqual([7, 65535, 4_000_000_000, -1234, 3.25]);
    const u = r.unit(vec3());
    expect(u.x).toBeCloseTo(0.6, 4);
    expect(u.z).toBeCloseTo(0.8, 4);
    expect(r.text()).toBe('Ada 🌍');
    expect(r.done).toBe(true);
    const short = new Reader(bytes.subarray(0, 5));
    short.u32();
    expect(() => short.u32()).toThrow(RangeError);
  });
});

describe('rules', () => {
  it('names the world a page makes, and an address that makes the room’s', () => {
    const mine = worldRules(new URLSearchParams(''));
    expect(mine.preset).toBe('arcade');
    expect(mine.mapSeed).toBe('1');
    expect(rulesDiffer(worldRules(new URLSearchParams('?preset=arcade&mapSeed=1')), mine)).toBe(false);
    const base = worldRules(new URLSearchParams('?preset=base&difficulty=hard'));
    expect(rulesDiffer(base, mine)).toBe(true);
    const url = withRules('http://localhost/?room=abc&preset=base', mine);
    expect(url).toBe('http://localhost/?room=abc');
    const there = withRules('http://localhost/?room=abc', base);
    expect(rulesDiffer(worldRules(new URL(there!).searchParams), base)).toBe(false);
    // Somebody else's data: what this build can't make is no address, and what isn't rules is no difference.
    expect(withRules('http://localhost/', { ...mine, sphereRadius: 'lots' })).toBeNull();
    expect(rulesDiffer('nonsense', mine)).toBe(false);
    expect(rulesDiffer({ somethingNew: 'x' }, mine)).toBe(false);
  });

  it('a guest whose rules differ reloads into the room’s', async () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 11, 3);
    vi.stubGlobal('location', { search: '?preset=base', href: 'http://localhost:5173/?preset=base', replace: vi.fn() });
    page(hub, 'Grace', 12, 7);
    await Promise.resolve();
    await Promise.resolve();
    expect((location.replace as ReturnType<typeof vi.fn>).mock.calls).toEqual([['http://localhost:5173/']]);
    expect(host.room.isHost).toBe(true);
  });
});

describe('a room', () => {
  it('a guest draws the host’s world, starts in the host’s district, and steers its colony', () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 21, 3);
    const guest = page(hub, 'Grace', 22, 7);
    const layout = host.game.world.maze.layout;
    expect(layout.regionAt(guest.game.camera.frame.c)).toBe(7);
    run(host, [guest], 3);
    // The first view says where the host looks: the guest's page looks there too.
    expect(layout.regionAt(guest.game.camera.frame.c)).toBe(3);

    guest.play('Grace');
    run(host, [guest], 10);
    const colony = colonyOf(host, guest);
    expect(colony.cells.length).toBeGreaterThan(0);
    expect(layout.regionAt(colony.center(vec3()))).toBe(3);
    const mine = guest.net.status();
    expect(mine.human?.alive).toBe(true);
    // The guest's own colony, drawn where the host has it (16-bit places: half a unit).
    const at = colony.center(vec3());
    expect(host.game.world.distance(at, vec3(mine.human!.x, mine.human!.y, mine.human!.z))).toBeLessThan(2);

    // Every cell the host has within the guest's sight is on the guest's page, where the host has it.
    const center = colony.center(vec3());
    const radius = guest.game.camera.viewRadius();
    let checked = 0;
    host.game.world.queryCells(center, radius, (c) => {
      if (host.game.world.distance(c.p, center) - c.r > radius) return;
      const drawn = guest.game.world.cellsById.get(c.id);
      expect(drawn, `cell ${c.id}`).toBeDefined();
      // Where the host had it at its last view: this tick, or the one before.
      expect(Math.min(host.game.world.distance(drawn!.p, c.p), host.game.world.distance(drawn!.p, c.prev))).toBeLessThan(2);
      checked++;
    });
    expect(checked).toBeGreaterThan(0);
    expect(guest.game.world.food.count).toBeGreaterThan(50);

    // Steering: the guest's pointer, a few hundred units to one side, becomes the colony's target on the host.
    const aim = vec3();
    guest.game.camera.toWorld(guest.game.camera.width / 2 + 300, guest.game.camera.height / 2, aim);
    guest.input.has = true;
    Object.assign(guest.input, { x: guest.game.camera.width / 2 + 300, y: guest.game.camera.height / 2 });
    run(host, [guest], 4);
    expect(dot(colony.target, aim)).toBeGreaterThan(Math.cos(50 / host.game.world.R));
  });

  it('a guest who joins a host that is playing starts near it, in a corridor of its district', () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 25, 4);
    host.play('Ada');
    run(host, [], 50);
    const guest = page(hub, 'Grace', 26, 10);
    run(host, [guest], 3);
    guest.play('Grace');
    run(host, [guest], 3);
    const world = host.game.world;
    const ada = host.game.human.center(vec3());
    const grace = colonyOf(host, guest).center(vec3());
    expect(world.maze.layout.regionAt(grace)).toBe(world.maze.layout.regionAt(ada));
    expect(world.maze.inInterior(grace)).toBe(true);
    // On screen together, and not on top of each other.
    expect(world.distance(ada, grace)).toBeLessThan(1500);
    expect(world.distance(ada, grace)).toBeGreaterThan(host.game.human.sumRadius + 150);
  });

  it('own merges pay nothing on a guest’s page, and eating someone else’s cell does', () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 31, 3);
    const guest = page(hub, 'Grace', 32, 7);
    run(host, [guest], 2);
    guest.play('Grace');
    run(host, [guest], 4);
    const colony = colonyOf(host, guest);
    const at = colony.center(vec3());
    const eat = (preyOrg: number): EatEvent => ({ type: 'eat', eaterId: colony.cells[0].id, eatenId: 999_999, eatenKind: PLAYER, x: at.x, y: at.y, z: at.z, r: 40, hue: 0, eaterOrg: colony.id, preyOrg, foodKind: -1, foodTag: -1 });
    const before = guest.points();
    // Its own piece merging back (the eater's organism on both sides), then an NPC's cell.
    const world = host.game.world;
    const npc = world.organisms.find((o) => !o.isHuman && !o.resident)!;
    const step = world.step.bind(world);
    let extra: EatEvent[] = [eat(colony.id)];
    world.step = () => {
      step();
      world.events.push(...extra);
      extra = [];
    };
    run(host, [guest], 2);
    expect(guest.points()).toBe(before);
    extra = [eat(npc.id)];
    run(host, [guest], 2);
    expect(guest.points() - before).toBe(eatPoints(eat(npc.id), colony.id));
    expect(guest.points() - before).toBeGreaterThan(0);
  });

  it('the next player carries the world on from the host’s save', async () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 41, 3);
    const guest = page(hub, 'Grace', 42, 7);
    run(host, [guest], 2);
    host.play('Ada');
    guest.play('Grace');
    // Past the first save (every 5 s once there is a guest).
    run(host, [guest], 140);
    // The save is packed in the background, then sent.
    await vi.waitFor(
      () => {
        hub.flush();
        expect(guest.net.status().saved).toBe(true);
      },
      { timeout: 5000 },
    );
    const colony = colonyOf(host, guest);
    const was = colony.center(vec3());
    const hostWorld = host.game.world;
    const npcs = hostWorld.organisms.filter((o) => !o.isHuman && o.alive).length;

    const hostAlive = hostWorld.organisms.filter((o) => !o.isHuman && o.alive).map((o) => o.id);
    const hostTick = hostWorld.tick;
    hub.leave(host.room);
    expect(guest.room.isHost).toBe(true);
    const world = guest.game.world;
    expect(world).not.toBe(hostWorld);
    // Its colony is its own player again, where the save had it (at most 5 s back), with every colony in the world.
    expect(guest.game.human.cells.length).toBeGreaterThan(0);
    expect(world.distance(guest.game.human.center(vec3()), was)).toBeLessThan(2500);
    // Every colony of the host's world but the host's own player, each as the save had it: a colony that came back
    // to life after the save is waiting to, due by the time the host left.
    expect(world.organisms.length).toBe(hostWorld.organisms.length - 1);
    expect(world.organisms.find((o) => o.name === 'Ada' && o.isHuman)).toBeUndefined();
    for (const id of hostAlive) {
      const o = world.organisms.find((x) => x.id === id);
      expect(o, `colony ${id}`).toBeDefined();
      if (!o!.alive) expect(o!.respawnTick).toBeLessThanOrEqual(hostTick);
    }
    expect(world.organisms.filter((o) => !o.isHuman && o.alive).length).toBeGreaterThan(npcs * 0.8);
    // And it runs it: a third page sees its world.
    const third = page(hub, 'Lin', 43, 9);
    run(guest, [third], 8);
    expect(world.maze.layout.regionAt(third.game.camera.frame.c)).toBe(world.maze.layout.regionAt(guest.game.human.center(vec3())));
    expect(third.net.status().cells).toBeGreaterThan(0);
    expect(third.net.status().others.map((o) => o.name)).toContain('Grace');
  }, 30_000);

  it('a full world refuses another colony; a colony whose page is away stays where it is, and holds no place', () => {
    const hub = new Hub();
    const host = page(hub, 'Ada', 51, 3);
    const guests = Array.from({ length: MAX_PLAYERS }, (_, i) => page(hub, `G${i}`, 60 + i, i % 12));
    run(host, guests, 2);
    host.play('Ada');
    for (const g of guests) g.play(g.room.self.name);
    run(host, guests, 4);
    const last = guests[MAX_PLAYERS - 1];
    expect(last.refusedWith()).toMatch(/full/);
    expect(last.game.state).toBe('menu');
    for (const g of guests.slice(0, MAX_PLAYERS - 1)) expect(g.refusedWith()).toBe('');

    // A guest's page goes to the background: its colony stops where it is, not where its pointer last was.
    const g0 = guests[0];
    g0.input.has = true;
    Object.assign(g0.input, { x: g0.game.camera.width / 2 + 400, y: g0.game.camera.height / 2 });
    run(host, guests, 3);
    const colony = colonyOf(host, g0);
    hub.state(g0.room, 'away');
    run(host, [], 2);
    const c = colony.center(vec3());
    expect(host.game.world.distance(colony.target, c)).toBeLessThan(5);

    // And it holds no place from a player who is here: the one refused can play now.
    last.play(last.room.self.name);
    run(host, guests, 4);
    expect(colonyOf(host, last).cells.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('a server a round trip away', () => {
  /** A host and a guest who plays, with each message 200 ms on its way. */
  function lagged(seed: number, jitter = 0): { host: Page; guest: Page } {
    const hub = new Hub();
    hub.lag = 5;
    hub.jitter = jitter;
    const host = page(hub, 'Ada', seed, 3);
    const guest = page(hub, 'Grace', seed + 1, 7);
    run(host, [guest], 15);
    guest.play('Grace');
    run(host, [guest], 40);
    return { host, guest };
  }

  /** The guest's colony where its page draws it. */
  function drawn(guest: Page): Vec3 {
    const s = guest.net.status();
    return vec3(s.human!.x, s.human!.y, s.human!.z);
  }

  /** The nearest pellet on the guest's page that its colony can reach in a straight line. */
  function nearestPellet(guest: Page): Vec3 {
    const world = guest.game.world;
    const food = world.food;
    const at = guest.game.human.center(vec3());
    let best: Vec3 | null = null;
    let bestD = Infinity;
    food.query(at, 1500, (i) => {
      if (!food.alive[i] || food.kind[i] !== PELLET) return;
      const p = vec3(food.x[i], food.y[i], food.z[i]);
      const d = world.distance(at, p);
      if (d < guest.game.human.sumRadius + 40 || d >= bestD || world.maze.blocked(at, p)) return;
      best = p;
      bestD = d;
    });
    if (!best) throw new Error('no pellet in reach');
    return best;
  }

  /** The guest's pointer `beyond` times as far from the screen's centre as `p` is, in its direction. */
  function aimPast(guest: Page, p: Vec3, beyond: number): void {
    const cam = guest.game.camera;
    const s = { x: 0, y: 0 };
    cam.toScreen(p, s);
    guest.input.has = true;
    Object.assign(guest.input, { x: cam.width / 2 + (s.x - cam.width / 2) * beyond, y: cam.height / 2 + (s.y - cam.height / 2) * beyond });
  }

  it('a guest’s own colony answers its pointer at once, and the host’s views keep it where the host has it', () => {
    const { host, guest } = lagged(71);
    const world = host.game.world;
    const colony = colonyOf(host, guest);
    const predicted = guest.net.status().predicted;
    expect(predicted).not.toBeNull();
    // Its page is ahead of the host's last view by about the round trip, ten ticks: less the tick the host steps with
    // what came in just before it, and more while a view waits for the next view tick.
    expect(predicted!.ahead).toBeGreaterThanOrEqual(9);
    expect(predicted!.ahead).toBeLessThanOrEqual(11);
    // Standing still, both pages have the colony in one place.
    expect(world.distance(drawn(guest), colony.center(vec3()))).toBeLessThan(2);

    const goal = nearestPellet(guest);
    aimPast(guest, goal, 4);
    const from = drawn(guest);
    const hostFrom = colony.center(vec3());
    run(host, [guest], 2);
    // On the guest's page, a move toward the pointer at once (drawn between the page's last two ticks, as a page draws
    // a world of its own). On the host, nothing yet: the steering is on its way.
    expect(world.distance(from, drawn(guest))).toBeGreaterThan(5);
    expect(world.distance(drawn(guest), goal)).toBeLessThan(world.distance(from, goal) - 5);
    expect(world.distance(hostFrom, colony.center(vec3()))).toBeLessThan(1);

    // Steering on: the host follows a round trip behind, and its views hardly move the guest's colony.
    let worst = 0;
    for (let t = 0; t < 60; t++) {
      run(host, [guest], 1);
      worst = Math.max(worst, guest.net.status().predicted?.correction ?? 0);
    }
    expect(world.distance(hostFrom, colony.center(vec3()))).toBeGreaterThan(300);
    expect(worst).toBeLessThan(6);

    // Let go: once the host has had the last of the steering, both pages have the colony in one place again.
    guest.input.has = false;
    run(host, [guest], 20);
    expect(world.distance(drawn(guest), colony.center(vec3()))).toBeLessThan(2);
  });

  it('pellets go from under a guest’s own cells at once, and one the host never took comes back', () => {
    const { host, guest } = lagged(81);
    const world = guest.game.world;
    const food = world.food;
    const pellets = () => {
      const out = new Map<string, Vec3>();
      for (let i = 0; i < food.span; i++) {
        if (food.alive[i] && food.kind[i] === PELLET) out.set(`${food.x[i]},${food.y[i]},${food.z[i]}`, vec3(food.x[i], food.y[i], food.z[i]));
      }
      return out;
    };
    // From now on the host eats nothing: whatever goes from the guest's page went ahead of it.
    (host.game.world as unknown as { eatFood: () => void }).eatFood = () => {};
    aimPast(guest, nearestPellet(guest), 4);
    const ate = new Map<string, Vec3>();
    let before = pellets();
    for (let t = 0; t < 25; t++) {
      run(host, [guest], 1);
      const after = pellets();
      const cells = guest.game.human.cells;
      for (const [k, p] of before) if (!after.has(k) && cells.some((c) => world.distance(c.p, p) < c.r + 50)) ate.set(k, p);
      // Nothing left under the cells where the page draws them.
      for (const c of cells) {
        const reach = eatReach(world.cfg, c.r, food.radius, false);
        for (const p of after.values()) expect(world.distance(c.p, p)).toBeGreaterThan(reach - 0.5);
      }
      before = after;
    }
    expect(ate.size).toBeGreaterThan(0);

    // Stop, and wait for the host, which never took them: each is back, but those under the colony now.
    guest.input.has = false;
    run(host, [guest], 50);
    const now = pellets();
    const cells = guest.game.human.cells;
    let back = 0;
    for (const [k, p] of ate) {
      if (cells.some((c) => world.distance(c.p, p) < c.r + 20)) continue;
      expect(now.has(k), `pellet ${k}`).toBe(true);
      back++;
    }
    expect(back).toBeGreaterThan(0);
  });

  it('with a connection that comes and goes in fits, and frames of the guest’s own, its colony still hardly jumps', () => {
    const { host, guest } = lagged(91, 3);
    const hub = host.room.hub;
    const world = host.game.world;
    const colony = colonyOf(host, guest);
    const rand = createRng(3);
    aimPast(guest, nearestPellet(guest), 4);
    const corrections: number[] = [];
    // The host's ticks as run() makes them; between them, the guest's page draws frames 8 to 28 ms apart.
    let spare = 0;
    for (let t = 0; t < 80; t++) {
      hub.clock++;
      hub.flush();
      host.game.world.step();
      host.game.takeEvents(now);
      host.net.stepped(now);
      hub.flush();
      spare += host.game.cfg.tickMs;
      while (spare > 0) {
        const dt = Math.min(spare, 8 + rand() * 20);
        spare -= dt;
        now += dt;
        guest.net.frame(now, dt);
        hub.flush();
        const h = guest.game.human;
        if (h.cells.length > 0) guest.game.camera.jumpTo(h.center(vec3()), h.sumRadius);
        const p = guest.net.status().predicted;
        if (p) corrections.push(p.correction);
      }
    }
    // A whole move (15 to 18 units here) would be a step paired with the wrong tick of the page's.
    corrections.sort((a, b) => a - b);
    expect(corrections[Math.floor(corrections.length / 2)]).toBeLessThan(2);
    expect(corrections[corrections.length - 1]).toBeLessThan(12);

    // Let go: a round trip is up to 16 ticks now, and the colony comes to rest a little after the last of it.
    guest.input.has = false;
    run(host, [guest], 50);
    expect(world.distance(drawn(guest), colony.center(vec3()))).toBeLessThan(2);
  });
});
