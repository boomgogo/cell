// DOM HUD: score, leaderboard, menu, touch buttons (plain DOM, interactive immediately), plus the arcade
// HUD: points and high score, power bar, district banner, toasts, minimap, mute and the home arrow.
import type { Flags } from '../render/canvas/flags.ts';
import type { Organism } from '../sim/organism.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  readonly menu = $<HTMLDivElement>('menu');
  readonly form = $<HTMLFormElement>('play-form');
  readonly nick = $<HTMLInputElement>('nick');
  readonly death = $<HTMLParagraphElement>('death');
  readonly score = $<HTMLDivElement>('score');
  readonly leaderboard = $<HTMLOListElement>('lb');
  readonly touch = $<HTMLDivElement>('touch');
  readonly splitBtn = $<HTMLButtonElement>('btn-split');
  readonly ejectBtn = $<HTMLButtonElement>('btn-eject');
  readonly arcadeHud = $<HTMLDivElement>('arcade-hud');
  readonly points = $<HTMLDivElement>('points');
  readonly hiscore = $<HTMLDivElement>('hiscore');
  readonly laps = $<HTMLDivElement>('laps');
  readonly power = $<HTMLDivElement>('power');
  readonly banner = $<HTMLDivElement>('banner');
  readonly toastEl = $<HTMLDivElement>('toast');
  readonly minimap = $<HTMLCanvasElement>('minimap');
  readonly mute = $<HTMLButtonElement>('mute');
  readonly homeArrow = $<HTMLDivElement>('home-arrow');
  arcade = false;
  /** Flag atlas for the leaderboard (lazy; null until loaded). */
  flags: Flags | null = null;
  private lastBoard = '';
  private lastScore = -1;
  private lastPoints = -1;
  private lastBanner = '';
  private toastUntil = 0;
  private lastPower = -1;

  /** Arcade features (mazes on): points, banner, minimap, mute, home arrow — in either look. */
  setArcade(on: boolean): void {
    this.arcade = on;
    $('arcade-help').hidden = !on;
    this.minimap.hidden = !on;
    this.mute.hidden = !on;
  }

  /** The dark press stock (`?theme=press`); the default is paper. */
  setDark(on: boolean): void {
    document.body.classList.toggle('dark', on);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', on ? '#1b1a17' : '#f7f4ec');
  }

  showMenu(message: string | null): void {
    this.menu.hidden = false;
    this.death.hidden = !message;
    this.death.textContent = message ?? '';
    this.score.hidden = true;
    this.touch.hidden = true;
    this.arcadeHud.hidden = true;
    this.homeArrow.hidden = true;
    try {
      this.nick.focus({ preventScroll: true });
    } catch {
      /* focus can throw in some embedded browsers */
    }
  }

  hideMenu(touch: boolean): void {
    this.menu.hidden = true;
    this.score.hidden = false;
    this.touch.hidden = !touch;
    this.arcadeHud.hidden = !this.arcade;
  }

  setScore(mass: number): void {
    const s = Math.floor(mass);
    if (s === this.lastScore) return;
    this.lastScore = s;
    this.score.textContent = `Score: ${s}`;
  }

  setPoints(points: number, high: number, laps: number): void {
    if (points === this.lastPoints) return;
    this.lastPoints = points;
    this.points.textContent = points.toLocaleString('en-US');
    this.hiscore.textContent = `HI ${Math.max(points, high).toLocaleString('en-US')}`;
    this.laps.hidden = laps === 0;
    this.laps.textContent = `LAPS ${laps}`;
  }

  /** Rainbow bar: fraction of the rainbow state left (0 hides it). */
  setPower(fraction: number): void {
    const f = Math.round(fraction * 50) / 50;
    if (f === this.lastPower) return;
    this.lastPower = f;
    this.power.hidden = f <= 0;
    (this.power.firstElementChild as HTMLElement).style.width = `${f * 100}%`;
  }

  setBanner(text: string, sub: string): void {
    const key = `${text}|${sub}`;
    if (key === this.lastBanner) return;
    this.lastBanner = key;
    this.banner.hidden = !text;
    this.banner.replaceChildren(document.createTextNode(text));
    if (sub) {
      const small = document.createElement('small');
      small.textContent = sub;
      this.banner.appendChild(small);
    }
  }

  toast(text: string, ms: number, now: number): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastUntil = now + ms;
  }

  tick(now: number): void {
    if (!this.toastEl.hidden && now > this.toastUntil) this.toastEl.hidden = true;
  }

  /** Arrow at the screen edge toward home; null hides it. */
  setHomeArrow(x: number, y: number, angle: number, label: string | null): void {
    if (label === null) {
      this.homeArrow.hidden = true;
      return;
    }
    this.homeArrow.hidden = false;
    this.homeArrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    (this.homeArrow.firstElementChild as HTMLElement).style.transform = `rotate(${(angle + Math.PI / 2).toFixed(3)}rad)`;
    (this.homeArrow.lastElementChild as HTMLElement).textContent = label;
  }

  setLeaderboard(board: Organism[], player: Organism | null): void {
    const rows = boardRows(board, player);
    // Rebuild the list only when names, flags or the player's row change; ranks and masses are text writes.
    const flags = this.flags;
    const key = (flags ? 'f' : '') + rows.map((r) => (r.me ? '*' : '') + r.country + ':' + r.name).join('\n');
    if (key !== this.lastBoard) {
      this.lastBoard = key;
      this.leaderboard.replaceChildren(
        ...rows.map((r) => {
          const li = document.createElement('li');
          li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="ms"></span>';
          const nm = li.children[1] as HTMLElement;
          nm.textContent = r.name;
          const css = flags && r.country ? flags.css(r.country) : '';
          if (css) {
            const fl = document.createElement('i');
            fl.className = 'fl';
            fl.style.cssText = css;
            nm.prepend(fl);
          }
          if (r.me) li.className = 'me';
          return li;
        }),
      );
    }
    const lis = this.leaderboard.children;
    for (let i = 0; i < rows.length; i++) {
      const [rk, , ms] = lis[i].children as unknown as HTMLElement[];
      const rank = `${rows[i].rank}.`;
      const mass = rows[i].mass.toLocaleString('en-US');
      if (rk.textContent !== rank) rk.textContent = rank;
      if (ms.textContent !== mass) ms.textContent = mass;
    }
  }
}

export const UNNAMED = 'A stray spore';

export interface BoardRow {
  rank: number;
  name: string;
  /** Flag country code ('' for none). */
  country: string;
  mass: number;
  me: boolean;
}

/** Top 10 of the (already sorted) board, plus the player's own row when outside it. */
export function boardRows(board: Organism[], player: Organism | null): BoardRow[] {
  const row = (o: Organism, i: number): BoardRow => ({ rank: i + 1, name: o.name || UNNAMED, country: o.country, mass: Math.floor(o.lastMass), me: o === player });
  const rows = board.slice(0, 10).map(row);
  if (player && player.alive && !rows.some((r) => r.me)) {
    const rank = board.indexOf(player);
    if (rank >= 0) rows.push(row(player, rank));
  }
  return rows;
}
