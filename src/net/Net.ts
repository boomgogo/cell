// The sphere as a p3p2 room: several players among the colonies.
//
// A p3p2 server relays and remembers, and knows nothing of cells. This is what the game knows of a room, and the
// one place it talks to one.
//
// - One world, on the host's page. It is simulated in full around every player, not only around the camera
//   (`World.observers`). A guest's colony is an organism in it, steered by what the guest's page says it wants
//   (`in`, each of the page's ticks): where to go, splits and ejects. Where to go is kept relative to the colony, so
//   that the round trip does not bend it.
// - What each guest sees, the host tells that guest alone, about twelve times a second (`v`): the cells and the
//   food near it, and what happened there. All of it goes out as one message with a part for each guest
//   (`room.sendEach`), which the server counts once against the host's rate.
// - A guest's page draws that: its own world stands still, and holds the host's cells and food in place of its
//   own (`drawing`). Its own colony's cells it moves itself, at once, and the host's views put them right
//   (predict.ts); the pellets they pass over go at once too, and come back if the host never took them.
// - Every five seconds the host sends everybody a save of the world (`sv`): every colony and every cell, not the
//   food. When the host goes, the next player makes a world from the save and carries on.
// - At most MAX_PLAYERS play at once (the host's page runs the world for all of them); more can watch. A player who
//   comes in looks where the host looks, and starts near a friend. The first page in a room sets its rules
//   (rules.ts): a page with other rules reloads into them.
import type { CloseReason, Member, P3P2, Room } from '@p3p2/client';
import { BotController } from '../ai/bot.ts';
import { GhostController } from '../ai/ghost.ts';
import { GHOSTS } from '../ai/population.ts';
import { DIFFICULTY, PERSONALITIES, type PersonalityId } from '../ai/personalities.ts';
import type { Game, GameNet } from '../game.ts';
import { HumanController } from '../input/human.ts';
import { Cell, EJECTED, PLAYER, VIRUS, type CellKind } from '../sim/cell.ts';
import type { Controller } from '../sim/controller.ts';
import type { EatenKind, SimEvent } from '../sim/events.ts';
import { PELLET } from '../sim/food.ts';
import { Organism } from '../sim/organism.ts';
import { bigEnoughToEat, eatReach } from '../sim/rules.ts';
import { ghostSpecies } from '../sim/species.ts';
import type { World } from '../sim/world.ts';
import { type Vec3, copy, dot, transport, vec3 } from '../sphere/vec3.ts';
import { type HostCell, Prediction } from './predict.ts';
import { type Rules, rulesDiffer, withRules, worldRules } from './rules.ts';
import { Reader, Writer, deflate, inflate } from './wire.ts';

/** Ticks of the world between two views: 12.5 a second at 25 ticks a second. */
const VIEW_TICKS = 2;
const VIEW_MS = 80;
const SAVE_MS = 5000;
/** A pellet a guest's own cells ate ahead of the host comes back after this long (ms) if the host never took it. */
const EAT_AHEAD_MS = 1500;
/** A cell in a view: new to the guest (its owner and hue follow), or one of the guest's own (how it moves follows). */
const CELL_NEW = 128;
const CELL_OWN = 64;
/** A view reaches this much past the edge of the guest's screen, so what comes into sight is already there. */
const VIEW_MARGIN = 600;
const BOARD_SIZE = 10;
const NONE = 0xffffffff;
/**
 * Players with a colony in the world at once, the host included; more can watch. The host's page runs the world in
 * full around every player, so its cost grows with how far apart they are. Measured (`npm run bench -- --scene maze
 * --cpu 4 --zones N`, the spec's low-end proxy, a 2017 laptop at 4× CPU throttling; ai/next_2.md): frame p95 29–30 ms
 * alone, 31–33 ms with two players in two districts, 32–34 ms with three, 35–37 ms with four, 40–41 ms with eight.
 * Eight far apart keep the world in real time (tick p95 29–30 ms of the 40 ms tick) at a lower frame rate; eight
 * together cost about what one does.
 */
export const MAX_PLAYERS = 8;
/** A guest on the menu with no friend in sight looks where the host looks once it is this far from it. */
const LOOK_AGAIN = 4000;
/** Why the room is over, on the menu (p3p2's panel, which would say so, shows only while the page is in a room). */
const CLOSED: Record<CloseReason, string> = {
  left: '',
  kicked: 'You were removed from the room.',
  ended: 'The room was closed for everyone.',
  replaced: 'This room is now open in another tab.',
  lost: 'The connection to the room was lost.',
};
/** Where a page that reloaded into a room's rules notes it: the same reload twice is a loop, and is not done. */
const RULES_KEY = 'cell.rules-reload';

const KIND_VIEW = 1;
const KIND_SAVE = 2;
const KIND_INTENT = 3;
const KIND_SAVE_PART = 4;
/**
 * A save is a few tens of kilobytes even squeezed, and a message may be at most 64 KB on a server as it comes: it
 * goes in parts of at most this many bytes.
 */
const SAVE_PART = 32 * 1024;
/** Room for a save part's own header, and the server's framing, under the server's largest frame. */
const SAVE_PART_SLACK = 1024;

const EV_EAT = 1;
const EV_DEATH = 2;
const EV_POP = 3;
const EV_RAINBOW = 4;
const EV_EXPLODE = 5;
const EV_BOUNCE = 6;
const EV_PACK = 7;
const EV_UNPACK = 8;

const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
const DIFFICULTY_IDS = Object.keys(DIFFICULTY) as (keyof typeof DIFFICULTY)[];

/** Ticks of a guest's steering the host keeps, to pick the one for each step. */
const STEER_KEPT = 16;
/** Steps over which the host looks for the steering that came soonest (two seconds). */
const STEER_WINDOW = 50;

/**
 * A guest's colony on the host: it wants what the guest's page said. Each of the page's ticks comes with its number,
 * and the page moves the colony itself, a tick at a time: each step here makes the move of one of its ticks, with that
 * tick's steering, so that the page can play the same moves over again (predict.ts). Steering takes longer some times
 * than others: the steps pair with the page's ticks by the soonest it came in lately, so that a step's own steering is
 * almost always here by then.
 */
class RemoteController implements Controller {
  /** Where the colony goes before the page has steered (where it was put). */
  readonly target: Vec3 = vec3(0, 0, 1);
  /** The page's last ticks of steering: the tick, the aim, and where the page had the colony then. */
  private readonly steer: { tick: number; aim: Vec3; from: Vec3 }[] = [];
  splits = 0;
  ejects = 0;
  private splitsDone = -1;
  private ejectsDone = -1;
  /** The guest's page is in the background or its connection is down: the colony stays where it is. */
  held = false;
  /** The page's newest tick less this world's tick, at each of the last STEER_WINDOW steps. */
  private readonly ahead = new Int32Array(STEER_WINDOW);
  private seen = 0;
  /** This world's tick at the last step that steered the colony. */
  private steppedAt = -1;
  /** The page's tick that a step of this world's `tick` makes the move of is `tick + offset`. */
  private offset = 0;
  private readonly here = vec3();

  /** One tick of the page's steering: where the pointer is, and where the page had the colony. */
  steering(tick: number, aim: Vec3, from: Vec3): void {
    const steer = this.steer;
    const last = steer[steer.length - 1];
    // Splits and ejects go at once, between ticks: a second word for the same tick.
    if (last && tick === last.tick) {
      copy(last.aim, aim);
      copy(last.from, from);
      return;
    }
    if (last && tick < last.tick) {
      // A page that started again counts its ticks from the start again.
      if (last.tick - tick <= STEER_KEPT) return;
      this.restart();
    }
    const old = steer.length >= STEER_KEPT ? steer.shift()! : { tick: 0, aim: vec3(), from: vec3() };
    old.tick = tick;
    copy(old.aim, aim);
    copy(old.from, from);
    steer.push(old);
  }

  /** The page started again (a reload): its ticks with it. */
  restart(): void {
    this.steer.length = 0;
    this.seen = 0;
  }

  /** The guest's counts of splits and ejects so far: each one more than last time is one more to do. */
  wants(splits: number, ejects: number): void {
    if (this.splitsDone < 0) this.splitsDone = splits;
    if (this.ejectsDone < 0) this.ejectsDone = ejects;
    this.splits = splits;
    this.ejects = ejects;
  }

  update(world: World, org: Organism): void {
    if (this.held) {
      // Not where the pointer last was: a page in the background is not steering.
      if (org.cells.length > 0) org.center(org.target);
      return;
    }
    const steer = this.steer;
    copy(org.target, this.target);
    // After a gap (the colony was dead, or its page away), what came soonest before says nothing of now.
    if (world.tick - this.steppedAt > 1) this.seen = 0;
    this.steppedAt = world.tick;
    if (steer.length > 0) {
      // Pair this step with one of the page's ticks.
      const newest = steer[steer.length - 1].tick - world.tick;
      this.ahead[this.seen++ % STEER_WINDOW] = newest;
      let soonest = newest;
      for (let i = Math.min(this.seen, STEER_WINDOW) - 1; i >= 0; i--) soonest = Math.min(soonest, this.ahead[i]);
      this.offset = soonest;
      // That tick's steering, or the last before it that came (or, if none is that old, the oldest here).
      const want = world.tick + this.offset;
      let pick = steer[0];
      for (const s of steer) if (s.tick <= want) pick = s;
      // The pointer as far and in the same direction from the colony as it was on the page.
      copy(org.target, pick.aim);
      if (org.cells.length > 0) transport(org.target, pick.from, org.center(this.here));
    }
    if (this.splits !== this.splitsDone) {
      org.wantSplit = true;
      this.splitsDone = (this.splitsDone + 1) & 0xffff;
    }
    if (this.ejects !== this.ejectsDone) {
      org.wantEject = true;
      this.ejectsDone = (this.ejectsDone + 1) & 0xffff;
    }
  }

  /** The page's tick that this world's state after `tick` stands for (NONE before it steered). */
  echo(tick: number): number {
    return this.seen > 0 ? Math.max(0, tick + this.offset) : NONE;
  }
}

/** What the host keeps for each guest. */
interface Guest {
  member: Member;
  org: Organism | null;
  controller: RemoteController;
  /** Where the guest's camera looks, and how far it sees. */
  readonly center: Vec3;
  radius: number;
  /** The food the guest has, by the host's slot, and that slot's fill count. */
  food: Map<number, number>;
  /** The cells and colonies the guest has been told about: what does not change is not sent again. */
  cells: Set<number>;
  orgs: Map<number, string>;
  /** The next view starts the guest's picture again (a new host's first). */
  fresh: boolean;
}

/** The fields of an event a guest gets, which are org ids: the guest's own colony is its own player there. */
const ORG_FIELDS = ['organismId', 'eaterOrg', 'preyOrg', 'victimId', 'killerId'] as const;

export class Net implements GameNet {
  room: Room | null = null;

  // ---- the host's side
  private readonly guests = new Map<number, Guest>();
  /** The seed of the world this page runs: its own, or the last host's after it took over from a save. */
  private seed = 0;
  private events: SimEvent[] = [];
  private ticks = 0;
  private savedAt = 0;
  private readonly writer = new Writer(8192);
  private readonly visibleFood: number[] = [];

  // ---- a guest's side
  /** The last save of the world, as bytes, for when this page becomes the host. */
  private save: Uint8Array | null = null;
  /** The parts of the save on its way, by its number. */
  private parts: { id: number; got: (Uint8Array | null)[] } = { id: -1, got: [] };
  /** The host's id of this player's colony. */
  private me = 0;
  private readonly foodIndex = new Map<number, number>();
  private readonly orgs = new Map<number, Organism>();
  private viewAt = 0;
  private pending: Uint8Array[] = [];
  private splits = 0;
  private ejects = 0;
  /** This player's own cells, moved here at once and put right by the host's views. */
  private readonly predict = new Prediction();
  /** What the newest view said of this player's own cells, for the prediction. */
  private own: { tick: number; echo: number; cells: HostCell[] } | null = null;
  /** The host's slot of each food item here, by this page's slot. */
  private readonly foodHost = new Map<number, number>();
  /** Pellets this player's cells ate here ahead of the host, by the host's slot, until the host says it took them. */
  private readonly ateAhead = new Map<number, { p: Vec3; hue: number; kind: number; at: number }>();
  private board: { id: number; human: boolean; mass: number; name: string; country: string }[] = [];
  /** Where the host looks, as it last said. */
  private readonly hostLook = vec3(0, 0, 1);
  /** The host's live spores, a bit for each spot of each district. */
  private readonly spores = new Uint16Array(12).fill(0xffff);
  /** The page's world as it was before the room: alone again, a fresh one is made. */
  private offs: Array<() => void> = [];

  private readonly game: Game;

  constructor(game: Game, p3p2: P3P2) {
    this.game = game;
    p3p2.on('leave', (reason) => this.left(reason));
  }

  get drawing(): boolean {
    return this.room !== null && !this.room.isHost;
  }

  // ---- in and out of a room -------------------------------------------------------------------------------------

  /** A room started: this page is its host, or a guest of it. */
  enter(room: Room): void {
    if (room === this.room) return;
    if (this.room) this.left();
    this.room = room;
    this.game.net = this;
    this.seed = this.game.seed;
    this.offs.push(
      room.on('v', (data, from) => {
        if (from && from.id === room.host?.id && data instanceof Uint8Array && !room.isHost) this.pending.push(data);
      }),
      room.on('sv', (data, from) => {
        if (from && from.id === room.host?.id && data instanceof Uint8Array && !room.isHost) this.onSavePart(data);
      }),
      room.on('in', (data, from) => {
        if (room.isHost && from && data instanceof Uint8Array) this.onIntent(from, data);
      }),
      room.on('play', (data, from) => {
        if (room.isHost && from) this.onPlay(from, data);
      }),
      // A guest's page that has just started (a reload keeps the member) has nothing: its picture starts again.
      room.on('fresh', (_data, from) => {
        if (!room.isHost || !from) return;
        const guest = this.guestOf(from);
        guest.fresh = true;
        guest.controller.restart();
      }),
      // The host has no room for another colony: back to the menu, saying so.
      room.on('full', (data, from) => {
        if (from && from.id === room.host?.id && !room.isHost) this.game.refused(fullMessage(data));
      }),
      room.on('member-state', (m, state) => {
        if (room.isHost && m.id !== room.self.id) this.guestOf(m).controller.held = state !== 'here';
      }),
      room.on('member-join', () => this.showRoom()),
      room.on('member-leave', (m) => {
        this.forget(m.id);
        this.showRoom();
      }),
      room.on('host-change', () => {
        this.roles();
        this.showRoom();
      }),
      room.on('status', () => this.showRoom()),
    );
    this.roles();
    this.showRoom();
    this.checkRules(room);
  }

  /** The room's rules, which the first page in it offered: a page with other rules reloads into them. */
  private checkRules(room: Room): void {
    const mine = worldRules(new URLSearchParams(location.search));
    room
      .offer('rules', mine)
      .then((theirs) => {
        if (room !== this.room || !rulesDiffer(theirs, mine)) return;
        const url = withRules(location.href, theirs as Rules);
        if (!url || readSession(RULES_KEY) === url) return;
        writeSession(RULES_KEY, url);
        location.replace(url);
      })
      .catch(() => {});
  }

  /** The menu's Friends button and room line: who is here. */
  private showRoom(): void {
    const room = this.room;
    if (!room) {
      this.game.hud.setRoom(null, 0);
      return;
    }
    const n = room.members.length;
    const role = room.isHost ? 'you run this world' : room.host ? `${room.host.name || 'a friend'} runs this world` : 'waiting for the host';
    const status = room.status === 'reconnecting' ? ' · reconnecting…' : '';
    this.game.hud.setRoom(`In ${room.name || 'a room'} · ${n} ${n === 1 ? 'player' : 'players'} · ${role}${status}`, n);
  }

  private left(reason?: CloseReason): void {
    for (const off of this.offs) off();
    this.offs = [];
    const wasGuest = this.hosting === false;
    this.room = null;
    this.game.net = null;
    for (const guest of this.guests.values()) if (guest.org) this.kill(guest.org);
    this.guests.clear();
    this.game.world.observers.length = 0;
    this.hosting = null;
    // A guest's world is a picture of the host's: alone again, the page plays a world of its own.
    if (wasGuest) this.solo();
    this.showRoom();
    if (reason && CLOSED[reason]) this.game.hud.setRoom(CLOSED[reason], 0);
  }

  /** Whether this page was the host when it last looked. */
  private hosting: boolean | null = null;

  /** Who does what, whenever the host may have changed. */
  private roles(): void {
    const room = this.room;
    if (!room) return;
    const host = room.isHost;
    if (host === this.hosting) return;
    const was = this.hosting;
    this.hosting = host;
    if (host) {
      if (was === false) this.promote();
      for (const m of room.members) if (m.id !== room.self.id) this.guestOf(m).controller.held = m.state !== 'here';
      this.savedAt = 0;
      this.sent = { view: 0, save: 0, views: 0, since: performance.now() };
    } else {
      this.becomeGuest();
    }
  }

  // ---- the host's side ------------------------------------------------------------------------------------------

  private guestOf(member: Member): Guest {
    let guest = this.guests.get(member.id);
    if (!guest) {
      guest = {
        member,
        org: null,
        controller: new RemoteController(),
        center: vec3(0, 0, 1),
        radius: 4000,
        food: new Map(),
        cells: new Set(),
        orgs: new Map(),
        fresh: true,
      };
      copy(guest.center, this.game.camera.frame.c);
      this.guests.set(member.id, guest);
    }
    return guest;
  }

  private forget(memberId: number): void {
    const guest = this.guests.get(memberId);
    if (!guest) return;
    if (guest.org) this.kill(guest.org);
    this.guests.delete(memberId);
  }

  /** A colony gone with its player: its cells leave the world. */
  private kill(org: Organism): void {
    const world = this.game.world;
    for (const c of org.cells.slice()) world.dropCell(c);
    org.alive = false;
    const at = world.organisms.indexOf(org);
    if (at >= 0) world.organisms.splice(at, 1);
    world.reindex();
  }

  private onIntent(from: Member, data: Uint8Array): void {
    const guest = this.guestOf(from);
    try {
      const r = new Reader(data);
      if (r.u8() !== KIND_INTENT) return;
      const tick = r.u32();
      const aim = r.unit(vec3());
      const from = r.unit(vec3());
      const splits = r.u16();
      const ejects = r.u16();
      r.unit(guest.center);
      guest.radius = Math.min(20000, r.u16());
      guest.controller.wants(splits, ejects);
      guest.controller.steering(tick, aim, from);
    } catch {
      // Not whole: the next one is a tick away.
    }
  }

  /** A guest pressed PLAY: its colony goes into the world, near where it looks. */
  private onPlay(from: Member, data: unknown): void {
    const guest = this.guestOf(from);
    const ask = (data ?? {}) as { n?: unknown; h?: unknown; c?: unknown };
    const world = this.game.world;
    if (!playing(guest.org) && this.playing(guest) >= MAX_PLAYERS) {
      this.room?.send('full', { max: MAX_PLAYERS }, { to: from.id });
      return;
    }
    let org = guest.org;
    if (!org || !world.organisms.includes(org)) {
      org = new Organism(world.newId(), '', 0, guest.controller, true);
      world.addOrganism(org);
      guest.org = org;
    }
    if (org.alive && org.cells.length > 0) return;
    org.name = typeof ask.n === 'string' ? ask.n.slice(0, 15) : '';
    org.hue = typeof ask.h === 'number' && Number.isFinite(ask.h) ? Math.floor(ask.h) % 360 : 0;
    org.country = typeof ask.c === 'string' && /^[a-z]{2}$/.test(ask.c) ? ask.c : '';
    // Near a friend, so that friends play together: the host's colony, or the nearest other player's.
    const friend = this.friendOf(guest);
    const at = friend ? spawnNear(world, this.game.cfg.startRadius, friend) : this.game.spawnPoint(guest.center);
    world.spawnOrganism(org, at);
    copy(guest.controller.target, at);
  }

  /** Where a guest who presses PLAY joins in: the host's colony if it is playing, else the other player nearest it. */
  private friendOf(guest: Guest): Vec3 | null {
    const human = this.game.human;
    if (this.game.state === 'playing' && playing(human)) return human.center(vec3());
    let best: Vec3 | null = null;
    let bestDot = -2;
    for (const other of this.guests.values()) {
      if (other === guest || !playing(other.org)) continue;
      const c = other.org!.center(vec3());
      const d = dot(c, guest.center);
      if (d > bestDot) {
        bestDot = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Players in the world on this host's page: its own, and its guests' but `except`'s. A colony whose player is away
   * (a closed page keeps its place for 30 s, and gets it back on a reload) holds no place from one who is here.
   */
  private playing(except: Guest | null): number {
    let n = this.game.state === 'playing' && playing(this.game.human) ? 1 : 0;
    for (const guest of this.guests.values()) if (guest !== except && !guest.controller.held && playing(guest.org)) n++;
    return n;
  }

  /** On a guest's page: the live spores of district `d`, as the host last said, a bit for each spot. */
  sporeMask(d: number): number {
    return this.spores[d] ?? 0;
  }

  /** On the host's page: the world has room for no other colony, so this page's own PLAY waits too. */
  full(): string | null {
    return this.room?.isHost === true && this.playing(null) >= MAX_PLAYERS ? fullMessage({ max: MAX_PLAYERS }) : null;
  }

  /** After each step of the host's world: views every second tick, a save every five seconds. */
  stepped(now: number): void {
    const room = this.room;
    if (!room?.isHost) return;
    const world = this.game.world;
    for (const e of world.events) this.events.push(e);
    // The zone simulated in full: around every guest who plays too. One who watches looks where the host looks when it
    // comes in, and costs no zone of its own.
    world.observers.length = 0;
    for (const guest of this.guests.values()) if (playing(guest.org)) world.observers.push(guest.org!.center(vec3()));
    if (++this.ticks % VIEW_TICKS !== 0) return;
    if (this.guests.size > 0) {
      const parts: [Member, Uint8Array][] = [];
      for (const guest of this.guests.values()) parts.push([guest.member, this.view(guest)]);
      room.sendEach('v', parts, { volatile: true });
      for (const [, bytes] of parts) this.sent.view += bytes.length;
      this.sent.views += parts.length;
    }
    this.events = [];
    if (now - this.savedAt >= SAVE_MS && this.guests.size > 0) {
      this.savedAt = now;
      void this.sendSave(room);
    }
  }

  private saveId = 0;
  /** The last save's size, whole and squeezed, in bytes. */
  private saveSize: [number, number] = [0, 0];
  /** What this page has sent as the host since it became the host: bytes of views and saves, and views. */
  private sent = { view: 0, save: 0, views: 0, since: 0 };

  /** The world's save, squeezed and in parts. A part that is dropped loses that save: the next one is five seconds off. */
  private async sendSave(room: Room): Promise<void> {
    const raw = this.saveWorld();
    const packed = await deflate(raw);
    this.saveSize = [raw.length, packed.length];
    if (room !== this.room || !room.isHost) return;
    const id = (this.saveId = (this.saveId + 1) >>> 0);
    // Parts as large as the server takes, and no larger than SAVE_PART.
    const max = room.limits.maxFrameBytes;
    const part = Number.isFinite(max) && max > SAVE_PART_SLACK * 2 ? Math.min(SAVE_PART, max - SAVE_PART_SLACK) : SAVE_PART;
    const count = Math.ceil(packed.length / part);
    if (count > 255) return;
    for (let i = 0; i < count; i++) {
      const w = new Writer(part + 16);
      w.u8(KIND_SAVE_PART).u32(id).u8(i).u8(count).raw(packed.subarray(i * part, (i + 1) * part));
      room.send('sv', w.bytes(), { volatile: true });
      this.sent.save += w.length;
    }
  }

  /** What one guest sees: the cells and food near it, what changed in its food, and what happened near it. */
  private view(guest: Guest): Uint8Array {
    const world = this.game.world;
    const w = this.writer.reset();
    const org = guest.org;
    const center = org && org.alive && org.cells.length > 0 ? org.center(vec3()) : guest.center;
    const radius = guest.radius + VIEW_MARGIN;
    const fresh = guest.fresh;
    if (fresh) {
      guest.food.clear();
      guest.cells.clear();
      guest.orgs.clear();
      guest.fresh = false;
    }
    const board = world.tick % 8 < VIEW_TICKS;
    w.u8(KIND_VIEW).u32(world.tick).u32(org?.id ?? 0).u32(guest.controller.echo(world.tick)).u8((fresh ? 1 : 0) | (board ? 2 : 0));
    // A new picture says where to look: at the guest's own colony, or where the host looks, so that friends start in
    // one district (each page's own world seed would put each in its own).
    if (fresh) w.unit(playing(org) ? org!.center(vec3()) : this.game.camera.frame.c);

    // The cells in sight, and the colonies they belong to.
    const cells: Cell[] = [];
    world.queryCells(center, radius, (c) => {
      if (!c.removed && world.distance(c.p, center) - c.r <= radius) cells.push(c);
    });
    const owners = new Set<Organism>();
    for (const c of cells) if (c.owner) owners.add(c.owner);
    if (org) owners.add(org);
    const infos: Organism[] = [];
    for (const o of owners) {
      const key = `${o.name}|${o.hue}|${o.country}|${o.rainbowUntil}|${o.resident ? 1 : 0}`;
      if (guest.orgs.get(o.id) === key) continue;
      guest.orgs.set(o.id, key);
      infos.push(o);
    }
    w.u16(infos.length);
    for (const o of infos) {
      w.u32(o.id).u16(o.hue).u8((o.isHuman ? 1 : 0) | (o.resident ? 2 : 0)).u32(o.rainbowUntil).text(o.name).text(o.country);
    }
    const seen = new Set<number>();
    w.u16(cells.length);
    for (const c of cells) {
      const known = guest.cells.has(c.id);
      const own = org !== null && c.owner === org;
      seen.add(c.id);
      w.u32(c.id).u8(c.kind | (known ? 0 : CELL_NEW) | (own ? CELL_OWN : 0)).unit(c.p).f32(c.r).f32(c.packed);
      if (!known) w.u32(c.owner?.id ?? NONE).u16(c.hue);
      // The guest's page moves its own cells itself, from here: how they glide, since when they may merge, and how the
      // walls held them (no wall near is -1).
      if (own) w.f32(c.boost).unit(c.heading).u32(c.bornTick).f32(c.squeeze).f32(Number.isFinite(c.clearance) ? c.clearance : -1);
    }
    guest.cells = seen;

    // Food: what left the guest's sight or was eaten, and what came into it or grew.
    const food = world.food;
    const visible = this.visibleFood;
    visible.length = 0;
    food.query(center, radius, (i) => {
      if (food.alive[i]) visible.push(i);
    });
    const now = new Set<number>(visible);
    const gone: number[] = [];
    for (const [i, gen] of guest.food) if (!now.has(i) || food.gen[i] !== gen) gone.push(i);
    for (const i of gone) guest.food.delete(i);
    const added: number[] = [];
    for (const i of visible) if (!guest.food.has(i)) added.push(i);
    w.u16(gone.length);
    for (const i of gone) w.u32(i);
    w.u16(added.length);
    const p = vec3();
    for (const i of added) {
      guest.food.set(i, food.gen[i]);
      p.x = food.x[i];
      p.y = food.y[i];
      p.z = food.z[i];
      w.u32(i).unit(p).u16(food.hue[i]).u8(food.kind[i]);
    }

    // What happened since the last view, near the guest or to its colony.
    const mine = org?.id ?? -1;
    const near = Math.cos((radius + 400) / world.R);
    const at = vec3();
    const events = this.events.filter((e) => {
      switch (e.type) {
        case 'death':
          return e.organismId === mine;
        case 'rainbow':
        case 'pack':
          return e.organismId === mine;
        case 'pop':
          return true;
        case 'explode':
          if (e.organismId === mine || e.victimId === mine) return true;
          break;
        case 'eat':
          if (e.eaterOrg === mine) return true;
          break;
        case 'unpack':
          if (e.organismId === mine) return true;
          break;
      }
      if (!('x' in e)) return false;
      at.x = e.x;
      at.y = e.y;
      at.z = e.z;
      return dot(at, center) > near;
    });
    w.u16(events.length);
    for (const e of events) writeEvent(w, e);

    // The leaderboard, now and then.
    if (board) {
      const top = world.leaderboard.slice(0, BOARD_SIZE);
      if (org && org.alive && !top.includes(org)) top.push(org);
      w.u8(top.length);
      // Whether each is a player too: a colony a guest first meets on the board is made here, before it is in sight.
      for (const o of top) w.u32(o.id).u8(o.isHuman ? 1 : 0).f32(o.lastMass).text(o.name).text(o.country);
      // The spores of every district, for the guest's minimap and banner: its own maze grows none.
      for (let d = 0; d < 12; d++) w.u16(sporeMask(world, d));
      // Where the host looks: a guest on the menu with no friend in sight looks there.
      w.unit(this.game.camera.frame.c);
    }
    return w.bytes();
  }

  /** Every colony and every cell, for whoever is the next host. Food is not in it: a new host grows its own. */
  private saveWorld(): Uint8Array {
    const world = this.game.world;
    const w = new Writer(65536);
    w.u8(KIND_SAVE).u32(this.seed).u32(world.tick).u32(world.idFloor).u8(Math.max(0, DIFFICULTY_IDS.findIndex((d) => DIFFICULTY[d] === this.game.difficulty)));
    const members = new Map<Organism, number>();
    for (const guest of this.guests.values()) if (guest.org) members.set(guest.org, guest.member.id);
    if (this.room) members.set(this.game.human, this.room.self.id);
    const orgs = world.organisms.filter((o) => !o.isHuman || members.has(o));
    w.u16(orgs.length);
    for (const o of orgs) {
      const c = o.controller;
      if (o.resident) {
        w.u8(1).u8(o.resident.district).u8(Math.max(0, GHOSTS.findIndex((g) => g.style === o.resident!.style))).u16(0);
      } else if (o.isHuman) {
        w.u8(2).u32(members.get(o) ?? 0);
      } else {
        const bot = c instanceof BotController ? c : null;
        w.u8(0).u8(Math.max(0, PERSONALITY_IDS.indexOf(bot?.personality.id ?? 'grazer'))).u16(bot?.phase ?? 0);
      }
      w.u32(o.id).text(o.name).u16(o.hue).text(o.country);
      w.u8((o.alive ? 1 : 0) | (o.dormant ? 2 : 0));
      w.unit(o.dormantP).unit(o.dormantHeading).f32(o.dormantMass).u32(o.respawnTick).u32(o.rainbowUntil);
      w.u16(o.kills).f32(o.peakMass).u32(o.spawnTick).u8(o.explodeCount);
    }
    w.u16(world.cells.length);
    for (const c of world.cells) {
      w.u32(c.id).u8(c.kind).unit(c.p).f32(c.r).u32(c.owner?.id ?? NONE).f32(c.boost).unit(c.heading);
      w.u32(c.bornTick).f32(c.packed).u32(c.graceUntil).u16(c.hue);
    }
    return w.bytes();
  }

  // ---- a guest's side -------------------------------------------------------------------------------------------

  /** This page draws the host's world from now on: its own world stands still, emptied. */
  private becomeGuest(): void {
    const world = this.game.world;
    world.clearCells();
    for (let i = 0; i < world.food.span; i++) world.food.remove(i);
    // The maze is still built here, for its walls; the food it would grow is the host's.
    world.maze.onBuilt = null;
    world.events.length = 0;
    this.forgetPicture();
    this.orgs.clear();
    this.pending = [];
    this.me = 0;
    this.board = [];
    world.leaderboard = [];
    // Everybody in this world is the host's: this page's own colony is in it only as what the host says. Its id is
    // one the host's world never gives out (ids start at 1): the page's own count reaches the same numbers as the
    // host's, and the host's Ada must not be this page's Grace.
    for (const o of world.organisms) o.alive = false;
    world.organisms.length = 0;
    const own = this.game.human;
    const human = new Organism(0, own.name, own.hue, new HumanController(this.game.input, this.game.camera), true);
    human.country = own.country;
    this.game.human = human;
    world.addOrganism(human);
    this.room?.send('fresh', null, { to: 'host' });
  }

  /** A part of the host's save. When it has them all, the save is this page's, for when it becomes the host. */
  private onSavePart(data: Uint8Array): void {
    let id: number;
    let index: number;
    let count: number;
    let bytes: Uint8Array;
    try {
      const r = new Reader(data);
      if (r.u8() !== KIND_SAVE_PART) return;
      id = r.u32();
      index = r.u8();
      count = r.u8();
      bytes = r.rest();
    } catch {
      return;
    }
    if (id !== this.parts.id) this.parts = { id, got: new Array<Uint8Array | null>(count).fill(null) };
    if (index >= this.parts.got.length) return;
    this.parts.got[index] = bytes;
    if (this.parts.got.some((b) => b === null)) return;
    const whole = new Uint8Array(this.parts.got.reduce((n, b) => n + b!.length, 0));
    let at = 0;
    for (const b of this.parts.got) {
      whole.set(b!, at);
      at += b!.length;
    }
    void inflate(whole)
      .then((save) => {
        if (id === this.parts.id) this.save = save;
      })
      .catch(() => {});
  }

  /**
   * Once a frame on a guest's page, `dt` ms after the last: the host's views since the last frame, this player's own
   * cells moved on, and where between the host's two last views to draw everything else.
   */
  frame(now: number, dt: number): number {
    const room = this.room;
    if (!room) return 1;
    for (const bytes of this.pending) this.apply(bytes, now);
    this.pending = [];
    const game = this.game;
    const own = this.own;
    this.own = null;
    if (own) {
      if (own.echo === NONE || own.cells.length === 0) this.predict.clear();
      else this.predict.correct(game.world, game.human, own.cells, own.tick, own.echo);
    }
    this.intent(dt, room);
    this.predict.draw(game.world, dt, game.cfg.tickMs);
    this.eatAhead(now);
    if (this.viewAt === 0) return 1;
    return Math.min(1, Math.max(0, (now - this.viewAt) / VIEW_MS));
  }

  /**
   * What this player wants, to the host, each tick of this page's: where the pointer is and where the colony was then
   * (as this page has it), splits and ejects so far, and what it can see. Splits and ejects go at once.
   */
  private intent(dt: number, room: Room): void {
    const game = this.game;
    const human = game.human;
    human.controller.update(game.world, human);
    if (human.wantSplit) this.splits = (this.splits + 1) & 0xffff;
    if (human.wantEject) this.ejects = (this.ejects + 1) & 0xffff;
    const urgent = human.wantSplit || human.wantEject;
    human.wantSplit = false;
    human.wantEject = false;
    const ticks = this.predict.advance(game.world, human, dt, game.cfg.tickMs);
    if (!urgent && ticks === 0) return;
    const w = new Writer(40);
    w.u8(KIND_INTENT).u32(this.predict.tick).unit(human.target).unit(this.predict.from).u16(this.splits).u16(this.ejects);
    w.unit(game.camera.frame.c).u16(Math.ceil(game.camera.viewRadius()));
    room.send('in', w.bytes(), { to: 'host', volatile: !urgent });
  }

  /**
   * The pellets under this player's cells, where this page has them, go at once: the host takes them a round trip
   * later, and says so. One the host has not taken by EAT_AHEAD_MS (this page's cells were not where the host's went)
   * comes back.
   */
  private eatAhead(now: number): void {
    const world = this.game.world;
    const food = world.food;
    const cfg = world.cfg;
    const fr = food.radius;
    const eaten: number[] = [];
    // Only where this page moves the cells itself: else they are drawn where the host has them, and it says.
    const mine = this.predict.active ? this.game.human.cells : [];
    for (const c of mine) {
      if (!c.owner?.species.eatsFood || !bigEnoughToEat(cfg, c.r, fr)) continue;
      const cosReach = Math.cos(eatReach(cfg, c.r, fr, false) / world.R);
      food.query(c.p, c.r, (i) => {
        if (food.alive[i] && food.kind[i] === PELLET && c.p.x * food.x[i] + c.p.y * food.y[i] + c.p.z * food.z[i] > cosReach) eaten.push(i);
      });
    }
    for (const i of eaten) {
      const host = this.foodHost.get(i);
      if (host === undefined || !food.alive[i]) continue;
      this.ateAhead.set(host, { p: vec3(food.x[i], food.y[i], food.z[i]), hue: food.hue[i], kind: food.kind[i], at: now });
      food.remove(i);
      this.foodHost.delete(i);
      this.foodIndex.delete(host);
    }
    for (const [host, f] of this.ateAhead) {
      if (now - f.at < EAT_AHEAD_MS) continue;
      this.ateAhead.delete(host);
      const i = food.add(f.p, f.hue, f.kind);
      this.foodIndex.set(host, i);
      this.foodHost.set(i, host);
    }
  }

  play(name: string, hue: number): boolean {
    const room = this.room;
    if (!room || room.isHost) return false;
    room.send('play', { n: name, h: hue, c: this.game.human.country }, { to: 'host' });
    return true;
  }

  /** One view from the host: the cells, the food and the events, in place of what this page had. */
  private apply(bytes: Uint8Array, now: number): void {
    const game = this.game;
    const world = game.world;
    let r: Reader;
    try {
      r = new Reader(bytes);
      if (r.u8() !== KIND_VIEW) return;
    } catch {
      return;
    }
    try {
      world.tick = r.u32();
      this.me = r.u32();
      const echo = r.u32();
      const flags = r.u8();
      if (flags & 1) {
        world.clearCells();
        for (const i of this.foodIndex.values()) world.food.remove(i);
        this.foodIndex.clear();
        this.foodHost.clear();
        this.ateAhead.clear();
        const look = r.unit(vec3());
        if (game.state !== 'playing') game.lookAt(look);
      }
      // Where the last view was drawn to is where the next one starts from.
      const was = this.viewAt === 0 ? 1 : Math.min(1, Math.max(0, (now - this.viewAt) / VIEW_MS));
      this.viewAt = now;

      for (let n = r.u16(); n > 0; n--) {
        const id = r.u32();
        const hue = r.u16();
        const f = r.u8();
        const rainbow = r.u32();
        const name = r.text();
        const country = r.text();
        const org = this.orgOf(id, (f & 1) !== 0);
        org.hue = hue;
        org.rainbowUntil = rainbow;
        if (org !== game.human) org.name = name;
        org.country = country;
        org.resident = f & 2 ? { district: 0, style: 'chaser', tier: 0 } : null;
      }

      const seen = new Set<number>();
      const mine: HostCell[] = [];
      const p = vec3();
      for (let n = r.u16(); n > 0; n--) {
        const id = r.u32();
        const k = r.u8();
        r.unit(p);
        const radius = r.f32();
        const packed = r.f32();
        let cell = world.cellsById.get(id);
        if (k & CELL_NEW) {
          const owner = r.u32();
          const hue = r.u16();
          if (!cell) {
            const org = owner === NONE ? null : this.orgOf(owner, false);
            cell = new Cell(id, (k & 3) as CellKind, p, radius, hue, org, world.tick);
            world.putCell(cell);
          }
        }
        if (k & CELL_OWN) {
          const boost = r.f32();
          const heading = r.unit(vec3());
          const bornTick = r.u32();
          const squeeze = r.f32();
          const clear = r.f32();
          const clearance = clear < 0 ? Infinity : clear;
          if (cell) mine.push({ id, p: vec3(p.x, p.y, p.z), r: radius, packed, boost, heading, bornTick, squeeze, clearance, hue: cell.hue });
        }
        if (!cell) continue;
        seen.add(id);
        // This player's own cells stay where this page moves them (the pointer aims from there); the view puts them
        // right through the prediction.
        if ((k & CELL_OWN) !== 0 && this.predict.cells.has(id)) continue;
        // From where it was drawn, to where the host has it now.
        lerpInto(cell.prev, cell.prev, cell.p, was);
        copy(cell.p, p);
        cell.r = radius;
        cell.packed = packed;
      }
      for (const c of world.cells) if (!seen.has(c.id)) world.dropCell(c);
      world.reindex();
      this.own = { tick: world.tick, echo, cells: mine };

      const food = world.food;
      for (let n = r.u16(); n > 0; n--) {
        const host = r.u32();
        const i = this.foodIndex.get(host);
        if (i !== undefined) {
          food.remove(i);
          this.foodHost.delete(i);
        }
        this.foodIndex.delete(host);
        // Eaten here ahead of the host, and now there too.
        this.ateAhead.delete(host);
      }
      for (let n = r.u16(); n > 0; n--) {
        const host = r.u32();
        r.unit(p);
        const hue = r.u16();
        const kind = r.u8();
        const old = this.foodIndex.get(host);
        if (old !== undefined) {
          food.remove(old);
          this.foodHost.delete(old);
        }
        this.ateAhead.delete(host);
        const i = food.add(p, hue, kind);
        this.foodIndex.set(host, i);
        this.foodHost.set(i, host);
      }

      world.events.length = 0;
      for (let n = r.u16(); n > 0; n--) world.events.push(this.mapEvent(readEvent(r)));

      if (flags & 2) {
        this.board = [];
        for (let n = r.u8(); n > 0; n--) this.board.push({ id: r.u32(), human: r.u8() === 1, mass: r.f32(), name: r.text(), country: r.text() });
        for (let d = 0; d < 12; d++) this.spores[d] = r.u16();
        r.unit(this.hostLook);
        if (game.state !== 'playing' && !game.friendInSight() && world.distance(this.hostLook, game.camera.frame.c) > LOOK_AGAIN) game.lookAt(this.hostLook);
      }
    } catch {
      // A view cut short: what was read of it stands, and the next one puts the rest right.
    }

    // The colonies: alive while they have cells here, and the leaderboard as the host has it.
    for (const org of this.orgs.values()) {
      org.alive = org.cells.length > 0;
      if (org.alive) org.lastMass = org.mass;
    }
    const was = game.human.alive;
    game.human.alive = game.human.cells.length > 0;
    // The host has just put this player in its world: home is here.
    if (game.human.alive && !was && game.state === 'playing') game.placed(game.human.center(vec3()));
    if (game.human.alive) {
      game.human.lastMass = game.human.mass;
      if (game.human.lastMass > game.human.peakMass) game.human.peakMass = game.human.lastMass;
    }
    world.leaderboard = this.board.map((b) => {
      const org = this.orgOf(b.id, b.human);
      if (org !== game.human) {
        org.name = b.name;
        org.country = b.country;
      }
      org.lastMass = b.mass;
      return org;
    });
    game.takeEvents(now);
  }

  /** The organism with the host's id `id` on this page: this player's own colony is its own player. */
  private orgOf(id: number, human: boolean): Organism {
    const game = this.game;
    if (id === this.me && this.me !== 0) return game.human;
    let org = this.orgs.get(id);
    if (!org) {
      org = new Organism(id, '', 0, { update() {} }, human);
      this.orgs.set(id, org);
      game.world.addOrganism(org);
    }
    return org;
  }

  /** An event of the host's, with this player's colony as this page's own player. */
  private mapEvent(e: SimEvent): SimEvent {
    const me = this.me;
    const own = this.game.human.id;
    const fields = e as unknown as Record<string, number | null>;
    for (const f of ORG_FIELDS) if (f in fields && fields[f] === me && me !== 0) fields[f] = own;
    return e;
  }

  /** The host left, and this page is the next: a world from the last save, or a new one, and this page runs it. */
  private promote(): void {
    const game = this.game;
    const room = this.room;
    const save = this.save;
    let world: World | null = null;
    let human: Organism | null = null;
    if (save && room) {
      try {
        ({ world, human } = this.restore(save, room));
      } catch {
        world = null;
      }
    }
    if (!world) this.seed = game.seed;
    if (!world || !human) {
      // No save to go on from: a world of this page's own, and everybody starts again in it.
      world = game.newWorld(game.seed);
      human = new Organism(world.newId(), game.human.name, game.human.hue, new HumanController(game.input, game.camera), true);
      human.country = game.human.country;
      world.addOrganism(human);
      if (game.human.alive) world.spawnOrganism(human, game.spawnPoint(game.camera.frame.c));
    }
    game.replaceWorld(world, human);
    this.orgs.clear();
    this.forgetPicture();
    this.viewAt = 0;
    for (const guest of this.guests.values()) guest.fresh = true;
  }

  /** A world made from a save: every colony and cell as the last host had them, and its own food. */
  private restore(bytes: Uint8Array, room: Room): { world: World; human: Organism } {
    const game = this.game;
    const r = new Reader(bytes);
    if (r.u8() !== KIND_SAVE) throw new Error('not a save');
    const seed = r.u32();
    this.seed = seed;
    const tick = r.u32();
    const idFloor = r.u32();
    r.u8();
    const world = game.newWorld(seed);
    world.clearCells();
    world.tick = tick;
    world.idFloor = idFloor;
    const byId = new Map(world.organisms.map((o) => [o.id, o]));
    const keep: Organism[] = [];
    let human: Organism | null = null;
    const members = new Set(room.members.map((m) => m.id));
    const p = vec3();
    for (let n = r.u16(); n > 0; n--) {
      const type = r.u8();
      let controller: Controller | null = null;
      let memberId = 0;
      let district = 0;
      let ghost = 0;
      if (type === 1) {
        district = r.u8();
        ghost = r.u8();
        r.u16();
      } else if (type === 2) {
        memberId = r.u32();
      } else {
        const personality = PERSONALITIES[PERSONALITY_IDS[r.u8()] ?? 'grazer'];
        const phase = r.u16();
        controller = new BotController(personality, game.difficulty, phase);
      }
      const id = r.u32();
      const name = r.text();
      const hue = r.u16();
      const country = r.text();
      const f = r.u8();
      let org = byId.get(id);
      if (type === 2) {
        if (memberId === room.self.id) {
          org = new Organism(id, name, hue, new HumanController(game.input, game.camera), true);
          human = org;
        } else if (members.has(memberId)) {
          const guest = this.guests.get(memberId) ?? this.guestOf(room.members.find((m) => m.id === memberId)!);
          org = new Organism(id, name, hue, guest.controller, true);
          guest.org = org;
        } else org = undefined;
      } else if (!org) {
        if (type === 1) {
          const g = GHOSTS[ghost % GHOSTS.length]!;
          org = new Organism(id, name, hue, new GhostController(g.style, 0), false);
          org.species = ghostSpecies(world.cfg.ghostSpeed);
          org.resident = { district, style: g.style, tier: g.tier };
        } else org = new Organism(id, name, hue, controller ?? { update() {} }, false);
      } else if (controller && !(org.controller instanceof BotController && org.controller.personality === (controller as BotController).personality)) {
        org.controller = controller;
      }
      r.unit(p);
      const heading = vec3();
      r.unit(heading);
      const dormantMass = r.f32();
      const respawnTick = r.u32();
      const rainbowUntil = r.u32();
      const kills = r.u16();
      const peakMass = r.f32();
      const spawnTick = r.u32();
      const explodeCount = r.u8();
      if (!org) continue;
      org.name = name;
      org.hue = hue;
      org.country = country;
      org.alive = (f & 1) !== 0;
      org.dormant = (f & 2) !== 0;
      copy(org.dormantP, p);
      copy(org.dormantHeading, heading);
      org.dormantMass = dormantMass;
      org.respawnTick = respawnTick;
      org.rainbowUntil = rainbowUntil;
      org.kills = kills;
      org.peakMass = peakMass;
      org.spawnTick = spawnTick;
      org.explodeCount = explodeCount;
      org.cells.length = 0;
      keep.push(org);
    }
    world.organisms.length = 0;
    for (const org of keep) world.addOrganism(org);
    const orgsById = new Map(keep.map((o) => [o.id, o]));
    for (let n = r.u16(); n > 0; n--) {
      const id = r.u32();
      const kind = r.u8() as CellKind;
      r.unit(p);
      const radius = r.f32();
      const owner = r.u32();
      const boost = r.f32();
      const heading = vec3();
      r.unit(heading);
      const bornTick = r.u32();
      const packed = r.f32();
      const graceUntil = r.u32();
      const hue = r.u16();
      const org = owner === NONE ? null : (orgsById.get(owner) ?? null);
      if (owner !== NONE && !org) continue;
      if (kind !== PLAYER && kind !== EJECTED && kind !== VIRUS) continue;
      const cell = new Cell(id, kind, p, radius, hue, org, bornTick);
      cell.boost = boost;
      copy(cell.heading, heading);
      cell.packed = packed;
      cell.graceUntil = graceUntil;
      world.putCell(cell);
    }
    world.reindex();
    if (!human) {
      human = new Organism(world.newId(), game.human.name, game.human.hue, new HumanController(game.input, game.camera), true);
      human.country = game.human.country;
      world.addOrganism(human);
    }
    for (const org of world.organisms) if (org.alive && !org.dormant && org.cells.length === 0 && !org.isHuman) org.alive = false;
    return { world, human };
  }

  /** Alone again after being a guest: a fresh world of this page's own. */
  private solo(): void {
    const game = this.game;
    const world = game.newWorld(Math.floor(Math.random() * 2 ** 31));
    const human = new Organism(world.newId(), game.human.name, game.human.hue, new HumanController(game.input, game.camera), true);
    human.country = game.human.country;
    world.addOrganism(human);
    game.replaceWorld(world, human);
    this.orgs.clear();
    this.forgetPicture();
    this.save = null;
  }

  /** The host's food and this player's own cells as this page had them: a new picture, or a world of this page's. */
  private forgetPicture(): void {
    this.foodIndex.clear();
    this.foodHost.clear();
    this.ateAhead.clear();
    this.predict.clear();
    this.own = null;
  }

  // ---- for the tests --------------------------------------------------------------------------------------------

  /** What this page knows of the room and the world, as plain numbers. */
  status(): {
    inRoom: boolean;
    host: boolean;
    guests: number;
    me: number;
    cells: number;
    food: number;
    human: { alive: boolean; mass: number; x: number; y: number; z: number } | null;
    others: { name: string; mass: number; x: number; y: number; z: number }[];
    saved: boolean;
    saveBytes: [number, number];
    sent: { view: number; save: number; views: number; ms: number };
    tickMs: number;
    /** A guest's own cells moved on its page: ticks ahead of the host's last view, and how far that view moved one. */
    predicted: { ahead: number; correction: number } | null;
  } {
    const game = this.game;
    const world = game.world;
    const human = game.human;
    const at = human.center(vec3());
    const others = world.organisms
      .filter((o) => o.isHuman && o !== human && o.alive && o.cells.length > 0)
      .map((o) => {
        const c = o.center(vec3());
        return { name: o.name, mass: Math.round(o.mass), x: c.x, y: c.y, z: c.z };
      });
    return {
      inRoom: this.room !== null,
      host: this.room?.isHost ?? false,
      guests: this.guests.size,
      me: this.me,
      cells: world.cells.length,
      food: world.food.count,
      human: { alive: human.alive && human.cells.length > 0, mass: Math.round(human.mass), x: at.x, y: at.y, z: at.z },
      others,
      saved: this.save !== null,
      saveBytes: this.saveSize,
      sent: { view: this.sent.view, save: this.sent.save, views: this.sent.views, ms: this.sent.since ? performance.now() - this.sent.since : 0 },
      tickMs: game.stats.tickMs,
      predicted: this.predict.active ? { ahead: this.predict.ahead, correction: this.predict.correction } : null,
    };
  }
}

function lerpInto(out: Vec3, a: Vec3, b: Vec3, t: number): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
}

function writeEvent(w: Writer, e: SimEvent): void {
  const p = vec3();
  switch (e.type) {
    case 'eat':
      p.x = e.x;
      p.y = e.y;
      p.z = e.z;
      w.u8(EV_EAT).u32(e.eaterId).u32(e.eatenId).u8(e.eatenKind).unit(p).f32(e.r).u16(e.hue);
      w.u32(e.eaterOrg < 0 ? NONE : e.eaterOrg).u32(e.preyOrg < 0 ? NONE : e.preyOrg).u8(e.foodKind < 0 ? 255 : e.foodKind);
      return;
    case 'death':
      w.u8(EV_DEATH).u32(e.organismId).u32(e.killerId ?? NONE);
      return;
    case 'pop':
      w.u8(EV_POP).u32(e.cellId);
      return;
    case 'rainbow':
      w.u8(EV_RAINBOW).u32(e.organismId).u32(e.untilTick);
      return;
    case 'explode':
      p.x = e.x;
      p.y = e.y;
      p.z = e.z;
      w.u8(EV_EXPLODE).u32(e.organismId).u32(e.victimId).u32(e.cellId).unit(p).f32(e.r).u16(e.hue).u8(e.pieces).u8(e.k);
      return;
    case 'bounce':
      p.x = e.x;
      p.y = e.y;
      p.z = e.z;
      w.u8(EV_BOUNCE).u32(e.cellId).unit(p).f32(e.r).u16(e.hue);
      return;
    case 'pack':
      w.u8(EV_PACK).u32(e.cellId).u32(e.organismId);
      return;
    case 'unpack':
      p.x = e.x;
      p.y = e.y;
      p.z = e.z;
      w.u8(EV_UNPACK).u32(e.cellId).u32(e.organismId).unit(p).f32(e.r).u16(e.hue);
      return;
  }
}

function readEvent(r: Reader): SimEvent {
  const p = vec3();
  switch (r.u8()) {
    case EV_EAT: {
      const eaterId = r.u32();
      const eatenId = r.u32();
      const eatenKind = r.u8() as EatenKind;
      r.unit(p);
      const radius = r.f32();
      const hue = r.u16();
      const eaterOrg = r.u32();
      const preyOrg = r.u32();
      const foodKind = r.u8();
      return {
        type: 'eat',
        eaterId,
        eatenId,
        eatenKind,
        x: p.x,
        y: p.y,
        z: p.z,
        r: radius,
        hue,
        eaterOrg: eaterOrg === NONE ? -1 : eaterOrg,
        // Own cells merging back: the same organism on both sides, so it scores nothing (ui/points.ts).
        preyOrg: preyOrg === NONE ? -1 : preyOrg,
        foodKind: foodKind === 255 ? -1 : foodKind,
        foodTag: -1,
      };
    }
    case EV_DEATH: {
      const organismId = r.u32();
      const killer = r.u32();
      return { type: 'death', organismId, killerId: killer === NONE ? null : killer };
    }
    case EV_POP:
      return { type: 'pop', cellId: r.u32() };
    case EV_RAINBOW:
      return { type: 'rainbow', organismId: r.u32(), untilTick: r.u32() };
    case EV_EXPLODE: {
      const organismId = r.u32();
      const victimId = r.u32();
      const cellId = r.u32();
      r.unit(p);
      const radius = r.f32();
      const hue = r.u16();
      const pieces = r.u8();
      const k = r.u8();
      return { type: 'explode', organismId, victimId, cellId, x: p.x, y: p.y, z: p.z, r: radius, hue, pieces, k };
    }
    case EV_BOUNCE: {
      const cellId = r.u32();
      r.unit(p);
      return { type: 'bounce', cellId, x: p.x, y: p.y, z: p.z, r: r.f32(), hue: r.u16() };
    }
    case EV_PACK:
      return { type: 'pack', cellId: r.u32(), organismId: r.u32() };
    case EV_UNPACK: {
      const cellId = r.u32();
      const organismId = r.u32();
      r.unit(p);
      return { type: 'unpack', cellId, organismId, x: p.x, y: p.y, z: p.z, r: r.f32(), hue: r.u16() };
    }
    default:
      throw new RangeError('an event this page does not know');
  }
}

/** A colony with cells in the world. */
function playing(org: Organism | null): boolean {
  return org !== null && org.alive && org.cells.length > 0;
}

/** What a page says when the host has no room for its colony. */
function fullMessage(data: unknown): string {
  const max = typeof (data as { max?: unknown } | null)?.max === 'number' ? (data as { max: number }).max : MAX_PLAYERS;
  return `This world is full: ${max} playing. Watch, or try again in a moment.`;
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage */
  }
}

/** The live spores of district `d` on this page, a bit for each spot. A district not built yet has them all. */
function sporeMask(world: World, d: number): number {
  const st = world.arcade?.states[d];
  if (!st) return 0xffff;
  let mask = 0;
  for (let k = 0; k < st.powerFood.length && k < 16; k++) if (st.powerFood[k] >= 0) mask |= 1 << k;
  return mask;
}

/**
 * Where a player who comes to join a friend (a colony's centre) starts, close enough to see it. In a maze, the
 * corridor spot nearest the friend with nothing big or another player close; on the plains, a safe spot near it.
 */
export function spawnNear(world: World, r: number, friend: Vec3): Vec3 {
  const maze = world.maze;
  const free = (p: Vec3) => {
    let ok = true;
    world.queryCells(p, 900, (c) => {
      if (!c.owner) return;
      if (c.r > r && world.distance(c.p, p) - c.r < 500) ok = false;
      if (c.owner.isHuman && world.distance(c.p, p) - c.r < 200) ok = false;
    });
    return ok;
  };
  if (maze.enabled && maze.inInterior(friend)) {
    const d = maze.district(maze.layout.regionAt(friend));
    const dots = d.maze.dots;
    const p = vec3();
    const spots: { k: number; dist: number }[] = [];
    for (let k = 0; k < dots.length; k += 2) spots.push({ k, dist: world.distance(d.point(dots[k], dots[k + 1], p), friend) });
    spots.sort((a, b) => a.dist - b.dist);
    for (const { k } of spots) if (free(d.point(dots[k], dots[k + 1], p))) return p;
  }
  return world.findSafeSpotNear(vec3(), friend, 1200, r);
}
