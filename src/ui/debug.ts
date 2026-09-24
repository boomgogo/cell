// ?debug=1 panel: background pattern, zoom override, membrane toggles,
// maze toggles (camera alignment, corner assist, maze zoom), teleport, rainbow and explosion testing, packing
// (feed +50, escape radius overlay), the paper/press stock and an NPC steering overlay, live stats.
// Loaded lazily so it costs nothing in the normal bundle.
import { BotController } from '../ai/bot.ts';
import type { Game } from '../game.ts';
import { stock } from '../render/canvas/palette.ts';
import { PATTERNS, type BackgroundPattern } from '../render/canvas/background.ts';
import { copy, moveAlong, vec3 } from '../sphere/vec3.ts';

/** Each maze tile's escape radius (the biggest cell that can get out from there), drawn over the game. */
function drawEscape(game: Game): void {
  const cam = game.camera;
  const d = game.world.maze.districtAt(cam.center);
  if (!d || !d.locate(cam.center) || d.F * cam.zoom < 18) return;
  const ctx = game.renderer.ctx;
  const dpr = game.renderer.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `${Math.min(12, d.F * cam.zoom * 0.3).toFixed(0)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const n = Math.ceil(cam.viewRadius() / d.F) + 1;
  const ci = Math.floor(d.gx);
  const cj = Math.floor(d.gy);
  const p = vec3();
  const pt = { x: 0, y: 0 };
  for (let j = Math.max(0, cj - n); j <= Math.min(d.G - 1, cj + n); j++) {
    for (let i = Math.max(0, ci - n); i <= Math.min(d.G - 1, ci + n); i++) {
      const e = d.escape[j * d.G + i];
      if (e === 0 || !cam.toScreen(d.point(i + 0.5, j + 0.5, p), pt)) continue;
      ctx.fillStyle = e === Infinity ? '#2a8a2a' : e < 100 ? '#c01818' : e < 300 ? '#c06000' : '#1860c0';
      ctx.fillText(e === Infinity ? '∞' : String(Math.round(e)), pt.x, pt.y);
    }
  }
}

/** Every NPC on screen with its action, progress-detector firings and a line to its wander goal. */
function drawNpcs(game: Game): void {
  const cam = game.camera;
  const ctx = game.renderer.ctx;
  ctx.setTransform(game.renderer.dpr, 0, 0, game.renderer.dpr, 0, 0);
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stock.key;
  ctx.fillStyle = stock.key;
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 0 };
  for (const o of game.world.organisms) {
    const bot = o.controller;
    const c = o.largestCell();
    if (!(bot instanceof BotController) || !c || o.dormant || !cam.toScreen(c.p, a)) continue;
    if (a.x < 0 || a.y < 0 || a.x > cam.width || a.y > cam.height) continue;
    const goal = bot.goal;
    if (goal && cam.toScreen(goal, b)) {
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillText(`${bot.action}${bot.jitterCount ? ` ×${bot.jitterCount}` : ''}`, a.x, a.y - c.r * cam.zoom - 6);
  }
}

export function mountDebug(game: Game): void {
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  const R = game.cfg.sphereRadius;
  const maze = game.world.maze;
  panel.innerHTML = `
    <div class="row"><b>debug</b> · preset ${game.cfg.preset} · R ${R}</div>
    <label>stock <select id="dbg-stock"><option ${game.opts.dark ? '' : 'selected'}>paper</option><option ${game.opts.dark ? 'selected' : ''}>press</option></select></label>
    <label><input id="dbg-npc" type="checkbox"> NPC goals and actions</label>
    <label>background <select id="dbg-bg">${PATTERNS.map((p) => `<option ${p === game.opts.pattern ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>zoom <input id="dbg-zoom" type="range" min="0" max="2" step="0.01" value="0"> <span id="dbg-zoom-v">auto</span></label>
    <label><input id="dbg-mem" type="checkbox" checked> jelly membranes</label>
    <label><input id="dbg-dent" type="checkbox" checked> contact dents</label>
    <label><input id="dbg-spring" type="checkbox" checked> size spring</label>
    <label><input id="dbg-shrink" type="checkbox"> ghost shrink</label>
    <label><input id="dbg-q" type="checkbox" checked> adaptive quality</label>
    <label>R <select id="dbg-r">${[4000, 8000, 12000, 16000, 24000].map((r) => `<option ${r === R ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    ${
      maze.enabled
        ? `<label><input id="dbg-align" type="checkbox" ${game.camera.alignEnabled ? 'checked' : ''}> align camera in mazes</label>
    <label>corner assist <input id="dbg-assist" type="range" min="0" max="1" step="0.05" value="${game.cfg.cornerAssist}"> <span id="dbg-assist-v">${game.cfg.cornerAssist}</span></label>
    <label>maze zoom <input id="dbg-mz" type="range" min="0.3" max="1" step="0.05" value="${game.camera.mazeZoom}"> <span id="dbg-mz-v">${game.camera.mazeZoom}</span></label>
    <div class="row"><button id="dbg-tp">teleport: random spot</button> <button id="dbg-power">rainbow</button> <button id="dbg-big">big NPC here</button> <button id="dbg-feed">feed +50</button></div>
    <label><input id="dbg-escape" type="checkbox"> escape radius overlay</label>`
        : ''
    }
    <pre id="dbg-stats"></pre>`;
  document.body.appendChild(panel);
  const el = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!;
  const bind = (id: string, fn: (input: HTMLInputElement) => void) => el<HTMLInputElement>(id).addEventListener('input', (e) => fn(e.target as HTMLInputElement));

  el<HTMLSelectElement>('dbg-stock').addEventListener('change', (e) => game.setTheme((e.target as HTMLSelectElement).value === 'press'));
  let showNpcs = false;
  bind('dbg-npc', (i) => (showNpcs = i.checked));
  el<HTMLSelectElement>('dbg-bg').addEventListener('change', (e) => {
    game.opts.pattern = (e.target as HTMLSelectElement).value as BackgroundPattern;
    game.quality.enabled = false;
    el<HTMLInputElement>('dbg-q').checked = false;
  });
  bind('dbg-zoom', (i) => {
    game.camera.zoomOverride = Number(i.value);
    el('dbg-zoom-v').textContent = Number(i.value) > 0 ? i.value : 'auto';
  });
  bind('dbg-mem', (i) => (game.opts.membranes = i.checked));
  bind('dbg-dent', (i) => (game.opts.contactDents = i.checked));
  bind('dbg-spring', (i) => (game.opts.sizeSpring = i.checked));
  bind('dbg-shrink', (i) => (game.opts.ghostShrink = i.checked));
  bind('dbg-q', (i) => (game.quality.enabled = i.checked));
  el<HTMLSelectElement>('dbg-r').addEventListener('change', (e) => {
    const params = new URLSearchParams(location.search);
    params.set('sphereRadius', (e.target as HTMLSelectElement).value);
    location.search = params.toString();
  });
  let showEscape = false;
  if (maze.enabled) {
    bind('dbg-align', (i) => (game.camera.alignEnabled = i.checked));
    bind('dbg-escape', (i) => (showEscape = i.checked));
    // Packing: grow the player's biggest cell by 50 mass; in a corridor the extra is packed.
    el('dbg-feed').addEventListener('click', () => {
      const c = game.human.largestCell();
      if (c) c.r = Math.sqrt(c.r * c.r + 5000);
    });
    bind('dbg-assist', (i) => {
      game.world.cfg.cornerAssist = Number(i.value);
      el('dbg-assist-v').textContent = i.value;
    });
    bind('dbg-mz', (i) => {
      game.camera.mazeZoom = Number(i.value);
      el('dbg-mz-v').textContent = i.value;
    });
    // Recognition check: drop the camera (and the player, if playing) somewhere random in the plains.
    el('dbg-tp').addEventListener('click', () => {
      const w = game.world;
      const p = vec3();
      for (let k = 0; k < 50; k++) {
        const z = 2 * Math.random() - 1;
        const a = Math.random() * Math.PI * 2;
        p.x = Math.sqrt(1 - z * z) * Math.cos(a);
        p.y = Math.sqrt(1 - z * z) * Math.sin(a);
        p.z = z;
        if (!w.maze.inInterior(p, 300)) break;
      }
      const c = game.human.alive ? game.human.cells[0] : null;
      if (c) {
        for (const cell of game.human.cells) {
          Object.assign(cell.p, p);
          Object.assign(cell.prev, p);
        }
      }
      game.camera.jumpTo(p, c ? game.human.sumRadius : 64);
    });
    el('dbg-power').addEventListener('click', () => {
      const w = game.world;
      if (game.human.cells.length > 0 && w.arcade) w.arcade.grantRainbow(game.human);
    });
    // Explosion testing: pull an active NPC next to the player and make it big.
    el('dbg-big').addEventListener('click', () => {
      const w = game.world;
      const me = game.human.cells[0];
      const npc = w.organisms.find((o) => !o.isHuman && !o.resident && o.alive && !o.dormant && o.cells.length > 0);
      if (!me || !npc) return;
      const c = npc.cells[0];
      c.r = Math.sqrt(3000 * 100);
      const dir = w.randomTangent(vec3(), me.p, Math.random() * Math.PI * 2);
      copy(c.p, me.p);
      moveAlong(c.p, dir, (me.r + c.r + 300) / w.R);
      copy(c.prev, c.p);
    });
  }

  const stats = el<HTMLPreElement>('dbg-stats');
  let n = 0;
  game.onFrame = (g) => {
    if (showEscape) drawEscape(g);
    if (showNpcs) drawNpcs(g);
    if (n++ % 15 !== 0) return;
    const w = g.world;
    const r = g.renderer.stats;
    const active = w.organisms.filter((o) => o.alive && !o.dormant).length;
    let mazeLine = '';
    if (w.maze.enabled) {
      const built = Array.from({ length: 12 }, (_, i) => (w.maze.isBuilt(i) ? 1 : 0)).reduce((a: number, b: number) => a + b, 0);
      const c = g.human.cells[0];
      const clear = c ? (Number.isFinite(c.clearance) ? c.clearance.toFixed(0) : '∞') : '-';
      const room = c ? w.maze.roomAt(c.p) : NaN;
      const roomText = Number.isFinite(room) ? room.toFixed(0) : room === Infinity ? '∞' : '-';
      mazeLine =
        `\ndistricts built ${built}/12  layer redraws ${r.layerRedraws}\nclearance ${clear}  squeeze ${c ? c.squeeze.toFixed(2) : '-'}  district w ${g.camera.districtWeight.toFixed(2)}` +
        `\nway out ${roomText}  r ${c ? c.r.toFixed(0) : '-'}  packed ${c ? c.packed.toFixed(0) : '-'}`;
    }
    stats.textContent =
      `fps ${g.stats.fps.toFixed(0)}  p95 ${g.stats.p95.toFixed(1)} ms\n` +
      `tick ${g.stats.tickMs.toFixed(2)} ms  quality ${g.quality.level}\n` +
      `zoom ${g.camera.zoom.toFixed(3)}  view ${(g.camera.viewRadius()).toFixed(0)} u\n` +
      `cells ${r.cells}  food ${r.food}  bg ${r.background}\n` +
      `points ${r.points}  ghosts ${r.ghosts}\n` +
      `npc active ${active} / ${w.organisms.length - 1}\n` +
      `food total ${w.food.count}  viruses ${w.virusCount}` +
      mazeLine;
  };
}
