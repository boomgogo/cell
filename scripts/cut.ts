// Makes the finished pieces from the recorded runs:
//   youtube  the text to paste (titles, description with chapters, tags), thumbnail stills and a contact sheet
//   short    a YouTube Short: moments of a phone run played by touch (re-recorded from its dry run), in bands
//   x        a 16:9 video for X, cut from the YouTube master
// Usage: npm run cut -- youtube | short --seed N | x  [--out dir]
// Needs ffmpeg; `short` also needs Chrome and the built site, as it records again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FPS, REPO_URL, RUN_SECONDS, type RunLog, SITE, SITE_URL, arg, dryRun, launch, outDir, playRun, startServer } from './record.ts';
import { chapters, stamp } from './record/chapters.ts';
import { TAG_709, X264, clock, encodeAudio, ffmpeg, loudness, probe } from './record/ffmpeg.ts';

const FONT = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';
/** Has the arrow (→), which Noto Sans here doesn't. */
const SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';
const PAPER = '0xf7f4ec';
const KEY = '0x241f1c';
const CORAL = '0xff665e';
const XFADE = 0.25;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

// Text for drawtext goes through a file, which spares escaping it in the filter graph.
function textFile(dir: string, name: string, text: string): string {
  const path = join(dir, `${name}.txt`);
  writeFileSync(path, text);
  return `textfile=${path}:expansion=none`;
}

const videoTime = (run: RunLog, play: number) => (run.playVideoFrame + play) / FPS;

/** The moments worth showing, in seconds of play: the biggest gains, rainbow chains, #1, the end. */
export function moments(run: RunLog): { name: string; at: number; weight: number }[] {
  const out: { name: string; at: number; weight: number }[] = [];
  const evs = run.events;
  // Explosions: the biggest victim of each chain.
  for (const e of evs) {
    if (e.type === 'explode') out.push({ name: `explode-${Math.round(e.play / FPS)}`, at: e.play / FPS, weight: Number(e.mass) * (1 + Number(e.k) * 0.3) });
    if (e.type === 'eat' && e.what === 'cell' && Number(e.mass) >= 40) out.push({ name: `eat-${Math.round(e.play / FPS)}`, at: e.play / FPS, weight: Number(e.mass) });
  }
  // Mass gained in 3 s windows (catches a run of crumbs after an explosion).
  const s = run.samples;
  for (let k = 6; k < s.length; k++) {
    const gain = s[k][1] - s[k - 6][1];
    if (gain > 50) out.push({ name: `gain-${Math.round(s[k][0])}`, at: s[k][0] - 1.5, weight: gain });
  }
  const rainbow = evs.find((e) => e.type === 'rainbow');
  if (rainbow) out.push({ name: 'rainbow', at: rainbow.play / FPS, weight: 1 });
  if (run.final.topAt > 0) out.push({ name: 'top', at: run.final.topAt, weight: 1 });
  return out.sort((a, b) => b.weight - a.weight);
}

/** Picks up to n windows [from, to] (seconds of play) around the best moments, without overlaps. */
function pickWindows(list: { name: string; at: number; weight: number }[], n: number, before: number, after: number, taken: [number, number][] = []): { name: string; from: number; to: number }[] {
  const out: { name: string; from: number; to: number }[] = [];
  for (const m of list) {
    if (out.length >= n) break;
    const from = Math.max(1, m.at - before);
    const to = Math.min(RUN_SECONDS, m.at + after);
    if ([...taken, ...out.map((w) => [w.from, w.to] as [number, number])].some(([a, b]) => from < b + 1 && to > a - 1)) continue;
    out.push({ name: m.name, from, to });
  }
  return out;
}

/**
 * n windows of 6 s around the run's best moments, in order, clear of its first 7 s and its end; a run with few big
 * moments fills up with its growth along the way, evenly spaced.
 */
function highlights(run: RunLog, n: number): { name: string; from: number; to: number }[] {
  const end = Math.min(RUN_SECONDS, run.playFrames / FPS);
  const keepOut: [number, number][] = [[0, 7], [end - 7, end + 3]];
  const best = pickWindows(moments(run), n, 1.5, 4.5, keepOut);
  if (best.length < n) {
    const last = end - 12;
    const fill = [0.2, 0.4, 0.6, 0.8, 0.5, 0.3, 0.7].map((k, i) => ({ name: `grow-${i}`, at: 10 + k * (last - 10), weight: 0 }));
    best.push(...pickWindows(fill, n - best.length, 1.5, 4.5, [...keepOut, ...best.map((w) => [w.from, w.to] as [number, number])]));
  }
  return best.sort((a, b) => a.from - b.from);
}

// ---- YouTube: the text, stills and a contact sheet ----

async function youtube(out: string): Promise<void> {
  const dir = join(out, 'youtube');
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunLog;
  const master = join(dir, 'cell-youtube.mp4');
  const info = await probe(master);
  const f = run.final;
  const ch = chapters(run);
  const chain = f.chain > 1 ? `, a rainbow chain of ${f.chain} explosions` : '';
  const top = f.topAt > 0 ? ` It reached #1 on the leaderboard at ${stamp(f.topAt)} of play.` : '';
  const result = f.alive
    ? `mass ${fmt(f.mass)} after 5 minutes${f.peak > f.mass * 1.1 ? ` (its peak was ${fmt(f.peak)}: big cells lose a little mass every second)` : ''}`
    : `a peak mass of ${fmt(f.peak)} before it was eaten`;
  const text = [
    'TITLE (pick one)',
    ...(f.alive
      ? [`Cell: from mass 10 to ${fmt(f.mass)} in 5 minutes (browser game, one take)`, `How big can you get in 5 minutes? Cell, a free browser game on a sphere`, `Cell: 5 minutes, one life, ${fmt(f.mass)} mass (no cuts)`]
      : [`Cell: one life, from mass 10 to ${fmt(f.peak)} (browser game, one take)`, `Cell, a free browser game on a sphere: one life, no cuts`]),
    '',
    'DESCRIPTION',
    `One life in Cell, from mass 10 to ${result}, with ${fmt(f.points)} points${chain}.${top} One take, no cuts.`,
    '',
    'Cell is a free, open-source browser game: you are a bacterium on a sphere among hundreds of colonies. Eat pellets and smaller cells, avoid bigger ones, and find the rainbow spores in the twelve fruit mazes to explode cells bigger than you. No ads, no sign-up, nothing to install; it runs on phones and on PCs without a graphics card.',
    '',
    `Play: ${SITE_URL}`,
    `Source: ${REPO_URL}`,
    '',
    "This run is played by the game's own autoplay bot. It sees only what a player sees (the screen, the minimap and the leaderboard), and moves the mouse and presses keys the way a person does. It was recorded frame by frame in Chrome, so every frame is exactly as the game draws it.",
    '',
    ...(ch.length ? ['CHAPTERS', ...ch.map((c) => `${stamp(c.at)} ${c.title}`), ''] : []),
    'HOW TO PLAY',
    '- Steer with the mouse or a finger. Space splits (to catch prey), W ejects mass.',
    '- Eat cells smaller than you; anything bigger can eat you.',
    '- A rainbow spore makes you rainbow for 8 seconds: touch a bigger cell and it explodes.',
    '- Narrow maze corridors keep big cells out, but the phages that live in the mazes chase you.',
    '',
    'TAGS',
    'cell game, agar, io game, browser game, web game, free game, no ads, open source game, bacteria game, gameplay, one take',
  ].join('\n');
  writeFileSync(join(dir, 'youtube.txt'), text + '\n');
  // Stills (1280×720, no text): the final cell, the best moments, the start.
  const stills: { name: string; at: number }[] = [{ name: 'final', at: videoTime(run, Math.min(run.playFrames, RUN_SECONDS * FPS) - 30) }];
  // The best moments, at least 8 s apart (a chain of gains reads as one moment).
  for (const m of moments(run)) {
    if (stills.length >= 5) break;
    const at = videoTime(run, m.at * FPS + 20);
    if (stills.every((x) => Math.abs(x.at - at) >= 8)) stills.push({ name: m.name, at });
  }
  stills.push({ name: 'start', at: videoTime(run, 90) });
  const lines: string[] = [];
  for (const [k, s] of stills.entries()) {
    const file = join(dir, `thumb-${k + 1}.jpg`);
    await ffmpeg(['-ss', s.at.toFixed(3), '-i', master, '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '2', file]).done;
    lines.push(`thumb-${k + 1}.jpg  ${stamp(s.at)}  ${s.name}`);
  }
  writeFileSync(join(dir, 'thumbs.txt'), lines.join('\n') + '\n');
  await contactSheet(master, join(dir, 'contact.jpg'), 15, info.duration);
  const sound = await loudness(master);
  console.log(`Wrote youtube.txt (${ch.length} chapters), ${stills.length} stills and contact.jpg in ${dir}`);
  console.log(`Master: ${info.width}×${info.height} ${info.fps} fps, ${info.vcodec} ${info.profile}, ${info.acodec}, ${clock(info.duration)}, ${(info.size / 1e9).toFixed(2)} GB; sound ${sound.i} LUFS, ${sound.peak} dBTP`);
}

/** Stills every `every` seconds, tiled 6 across at 320 px. */
async function contactSheet(video: string, out: string, every: number, duration: number): Promise<void> {
  const n = Math.max(1, Math.floor(duration / every));
  const rows = Math.ceil(n / 6);
  await ffmpeg(['-i', video, '-vf', `fps=1/${every},scale=320:-2,tile=6x${rows}:padding=4:color=white`, '-frames:v', '1', '-q:v', '3', out]).done;
}

// ---- The Short: moments of a phone run, re-recorded by touch, in bands ----

async function short(out: string, seed: number): Promise<void> {
  const dir = join(out, 'short');
  mkdirSync(dir, { recursive: true });
  const dry = await dryRun('short', seed, out, {});
  const f = dry.final;
  // Hook: the end (the biggest it gets). Then the start, then the best moments in order, then the end again. A run with
  // few big moments fills up with growth along the way, evenly spaced, so the Short runs about 45 s.
  const best = highlights(dry, 5);
  const end = Math.min(RUN_SECONDS, dry.playFrames / FPS - 0.2);
  const windows = [
    { name: 'piece-start', from: 0.2, to: 4.2 },
    ...best.map((w) => ({ name: `piece-${w.name}`, from: w.from, to: w.to })),
    { name: 'piece-end', from: end - 5, to: Math.min(dry.playFrames / FPS, end + 2.5) },
  ].map((w) => ({ name: w.name, from: Math.round(w.from * FPS), to: Math.round(w.to * FPS) }));
  console.log(`Short from seed ${seed}: ${f.alive ? `mass ${fmt(f.mass)} at 5:00` : `eaten at ${f.deathAt} s, peak ${fmt(f.peak)}`}; pieces ${windows.map((w) => `${w.name} ${clock(w.from / FPS)}`).join(', ')}`);
  const server = await startServer();
  const browser = await launch();
  let log: RunLog;
  try {
    log = await playRun(browser, server.url, { seed, profile: 'short', dry: false, params: dry.params, dir, windows, compare: dry.hashes });
  } finally {
    await browser.close();
    await server.close();
  }
  if (log.diverged !== null) console.warn(`The replay left its dry run at ${log.diverged} s.`);
  writeFileSync(join(dir, 'run.json'), JSON.stringify(log));
  // The hook is the last piece's best frames: its final 2 s, shown first.
  const pieces = [{ file: 'piece-end', ss: Math.max(0, (windows[windows.length - 1].to - windows[windows.length - 1].from) / FPS - 2.2), t: 2 }, ...windows.map((w) => ({ file: w.name, ss: 0, t: (w.to - w.from) / FPS }))];
  // Bands: the name and the link above the game, where Shorts' overlays leave them be; the result below (Shorts' caption
  // sits over the bottom, and its buttons over the right-hand side).
  const W = 1080;
  const TOP = 260;
  const GAME = 1440;
  const band =
    `drawtext=fontfile=${FONT}:${textFile(dir, 'band-title', 'C E L L')}:fontsize=96:fontcolor=${KEY}:shadowcolor=${CORAL}:shadowx=5:shadowy=4:x=(w-text_w)/2:y=26,` +
    `drawtext=fontfile=${MONO}:${textFile(dir, 'band-link', `Play free at ${SITE}`)}:fontsize=50:fontcolor=${KEY}:x=(w-text_w)/2:y=166,` +
    `drawtext=fontfile=${SANS}:${textFile(dir, 'band-line', f.alive ? `mass 10 → ${fmt(f.mass)} in 5 minutes` : `mass 10 → ${fmt(f.peak)}, one life`)}:fontsize=46:fontcolor=${KEY}:x=(w-text_w)/2:y=${TOP + GAME + 44}`;
  const inputs: string[] = [];
  const filters: string[] = [];
  pieces.forEach((p, k) => {
    inputs.push('-ss', p.ss.toFixed(3), '-t', p.t.toFixed(3), '-i', join(dir, `${p.file}.mp4`));
    inputs.push('-ss', p.ss.toFixed(3), '-t', p.t.toFixed(3), '-i', join(dir, `${p.file}.wav`));
    filters.push(`[${2 * k}:v]scale=${W}:${GAME},pad=${W}:1920:0:${TOP}:color=${PAPER},setsar=1,fps=${FPS},format=yuv420p[v${k}]`);
    filters.push(`[${2 * k + 1}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`);
  });
  let v = 'v0';
  let a = 'a0';
  let offset = pieces[0].t;
  for (let k = 1; k < pieces.length; k++) {
    offset -= XFADE;
    filters.push(`[${v}][v${k}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[vx${k}]`);
    filters.push(`[${a}][a${k}]acrossfade=d=${XFADE}[ax${k}]`);
    v = `vx${k}`;
    a = `ax${k}`;
    offset += pieces[k].t;
  }
  filters.push(`[${v}]${band},${TAG_709}[vout]`);
  const raw = join(dir, 'short-raw.mp4');
  const wav = join(dir, 'short.wav');
  await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `[${a}]`, ...X264(FPS), '-c:a', 'pcm_s16le', raw]).done;
  await ffmpeg(['-i', raw, '-vn', '-c:a', 'pcm_s16le', wav]).done;
  const final = join(dir, 'cell-short.mp4');
  const audio = join(dir, 'short.m4a');
  const sound = await encodeAudio(wav, audio);
  await ffmpeg(['-i', raw, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', final]).done;
  for (const x of [raw, audio, wav]) rmSync(x, { force: true });
  const info = await probe(final);
  writeFileSync(
    join(dir, 'short.txt'),
    [
      'TITLE',
      `Mass 10 to ${fmt(f.alive ? f.mass : f.peak)} in 5 minutes #shorts`,
      '',
      'DESCRIPTION',
      `Cell, a free browser game on a sphere: eat smaller cells, dodge bigger ones, explode them with a rainbow. Played on a phone by the game's own autoplay bot. No ads, open source.`,
      `Play: ${SITE_URL}`,
      '#browsergame #iogame #agario #indiegame',
    ].join('\n') + '\n',
  );
  await contactSheet(final, join(dir, 'contact.jpg'), 3, info.duration);
  // Shorts' safe zones over a still: the top bar, the right-hand buttons, the caption at the bottom.
  await ffmpeg(['-ss', '3', '-i', final, '-frames:v', '1', '-vf', 'drawbox=x=0:y=0:w=1080:h=120:color=red@0.35:t=fill,drawbox=x=936:y=700:w=144:h=900:color=red@0.35:t=fill,drawbox=x=0:y=1560:w=936:h=360:color=red@0.35:t=fill', join(dir, 'safe-zones.jpg')]).done;
  console.log(`Wrote ${final}: ${info.width}×${info.height}, ${info.duration.toFixed(1)} s; sound ${sound.i} LUFS, ${sound.peak} dBTP`);
}

// ---- X: a 16:9 cut of the master ----

async function x(out: string): Promise<void> {
  const dir = join(out, 'x');
  mkdirSync(dir, { recursive: true });
  const src = join(out, 'youtube');
  const run = JSON.parse(readFileSync(join(src, 'run.json'), 'utf8')) as RunLog;
  const master = join(src, 'video.mp4');
  const wav = join(src, 'video.wav');
  const f = run.final;
  const endPlay = Math.min(run.playFrames / FPS, RUN_SECONDS);
  // The final size first (X plays muted: the first seconds decide), the start, the best moments, the end and the card.
  const best = highlights(run, 4);
  const segs: { at: number; t: number }[] = [
    { at: videoTime(run, (endPlay - 2) * FPS), t: 2 },
    { at: videoTime(run, 0.3 * FPS), t: 3 },
    ...best.map((w) => ({ at: videoTime(run, w.from * FPS), t: w.to - w.from })),
    { at: videoTime(run, (endPlay - 4) * FPS), t: 4 + 3 + 3 },
  ];
  const inputs: string[] = [];
  const filters: string[] = [];
  segs.forEach((s, k) => {
    inputs.push('-ss', s.at.toFixed(3), '-t', s.t.toFixed(3), '-i', master);
    inputs.push('-ss', s.at.toFixed(3), '-t', s.t.toFixed(3), '-i', wav);
    filters.push(`[${2 * k}:v]scale=1920:1080,setsar=1,fps=${FPS},format=yuv420p[v${k}]`);
    filters.push(`[${2 * k + 1}:a]aresample=48000[a${k}]`);
  });
  let v = 'v0';
  let a = 'a0';
  let offset = segs[0].t;
  for (let k = 1; k < segs.length; k++) {
    offset -= XFADE;
    filters.push(`[${v}][v${k}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[vx${k}]`);
    filters.push(`[${a}][a${k}]acrossfade=d=${XFADE}[ax${k}]`);
    v = `vx${k}`;
    a = `ax${k}`;
    offset += segs[k].t;
  }
  filters.push(`[${v}]${TAG_709}[vout]`);
  const raw = join(dir, 'x-raw.mp4');
  const rawWav = join(dir, 'x.wav');
  await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `[${a}]`, ...X264(FPS, 18), '-c:a', 'pcm_s16le', raw]).done;
  await ffmpeg(['-i', raw, '-vn', '-c:a', 'pcm_s16le', rawWav]).done;
  const final = join(dir, 'cell-x.mp4');
  const audio = join(dir, 'x.m4a');
  const sound = await encodeAudio(rawWav, audio, '256k');
  await ffmpeg(['-i', raw, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', final]).done;
  for (const p of [raw, audio, rawWav]) rmSync(p, { force: true });
  const info = await probe(final);
  const post = `How big can you get in 5 minutes? Cell, a free browser game on a sphere: mass 10 to ${fmt(f.alive ? f.mass : f.peak)} in one take. Played by its own autoplay bot. No ads, open source.\n\nPlay: ${SITE_URL}\nCode: ${REPO_URL}`;
  // X counts each link as 23 characters.
  const length = post.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
  writeFileSync(join(dir, 'x.txt'), `${post}\n`);
  console.log(`Wrote ${final}: ${info.width}×${info.height}, ${info.duration.toFixed(1)} s, ${(info.size / 1e6).toFixed(1)} MB; sound ${sound.i} LUFS, ${sound.peak} dBTP; post ${length} of 280 characters`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const out = outDir();
  if (cmd === 'youtube') await youtube(out);
  else if (cmd === 'short') await short(out, Number(arg('seed', '1')));
  else if (cmd === 'x') await x(out);
  else {
    console.log('Usage: npm run cut -- youtube | short --seed N | x  [--out dir]');
    process.exit(1);
  }
  if (!existsSync(out)) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
