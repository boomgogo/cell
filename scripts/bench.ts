// Load + render benchmark: serves dist/ with `vite preview`, then with system Chrome via Playwright:
//  1. load: Lighthouse-like mobile throttling (Slow 4G: 150 ms RTT, 1.6 Mbps down, 4× CPU) → time until the
//     menu is interactive and the world is simulating;
//  2. render: ?bench=1 scene (autopiloted mass-20000 player, full active zone) under CPU throttling → p50/p95.
// Usage: npm run build && npm run bench -- [--cpu 4] [--seconds 20] [--scene all|plains|maze|rainbow] [--only load|render]
//   [--headed]
// Scenes: `plains` = mass-20000 autopilot at the widest zoom; `maze` = small autopiloted grazer on
// a district's start tile (walls, maze food, ghosts, camera alignment); `rainbow` = small rainbow hunter exploding big
// cells (explosion pieces, effects).
// Runs on the local GPU through ANGLE/EGL; prints the GPU name so results can be compared across machines.
import { chromium, type Page } from '@playwright/test';
import { preview } from 'vite';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const cpu = Number(arg('cpu', '4'));
const seconds = Number(arg('seconds', '20'));
const headed = process.argv.includes('--headed');

const server = await preview({ preview: { port: 4173, strictPort: false } });
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:4173/';
const only = arg('only', 'all');
// Use the machine's real GPU in headless mode (ANGLE over EGL); pass --no-gpu to force CPU raster.
const gpuArgs = process.argv.includes('--no-gpu') ? [] : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'];
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: gpuArgs });

async function throttle(page: Page, network: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
  }
}

try {
  {
    const p = await browser.newPage();
    const gpu = await p.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    console.log(`GPU: ${gpu}`);
    await p.close();
  }
  // 1. Load
  const loads: number[] = [];
  for (let run = 0; run < (only === 'render' ? 0 : 3); run++) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await throttle(page, true);
    const t0 = Date.now();
    await page.goto(`${url}?seed=${run + 1}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const g = (window as unknown as { __game?: { world: { tick: number } } }).__game;
      const btn = document.getElementById('play') as HTMLButtonElement | null;
      return !!g && g.world.tick > 0 && !!btn && btn.offsetParent !== null;
    }, undefined, { timeout: 30000, polling: 20 });
    loads.push(Date.now() - t0);
    await ctx.close();
  }
  if (loads.length) console.log(`load (Slow 4G, ${cpu}× CPU, cold cache): ${loads.map((l) => `${l} ms`).join(', ')}`);

  // 2. Render
  const sceneArg = arg('scene', 'all');
  for (const scene of sceneArg === 'all' ? ['plains', 'maze', 'rainbow'] : [sceneArg])
  for (const vp of [
    { name: 'desktop 1920×1080', width: 1920, height: 1080, dsf: 1, mobile: false },
    { name: 'phone 412×915 @2.625x', width: 412, height: 915, dsf: 2.625, mobile: true },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('page error:', m.text());
    });
    await page.goto(`${url}?bench=1&seed=1&seconds=${seconds}&scene=${scene}&district=0`);
    await throttle(page, false);
    const result = await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench, undefined, {
      timeout: (seconds + 60) * 1000,
      polling: 500,
    });
    const r = (await result.jsonValue()) as Record<string, number>;
    console.log(
      `render ${scene} ${vp.name}, ${cpu}× CPU: frame p50 ${r.frameP50.toFixed(1)} ms, p95 ${r.frameP95.toFixed(1)} ms, ` +
        `tick p95 ${r.tickP95.toFixed(2)} ms, quality level ${r.qualityLevel}, zoom ${r.zoom.toFixed(3)}, frames ${r.frames}\n` +
        `    avg JS per frame: background ${r.bgMs.toFixed(1)} ms (layer redraws ${r.layerRedraws}), food ${r.foodMs.toFixed(1)} ms, cells ${r.cellsMs.toFixed(1)} ms, draw ${r.drawMs.toFixed(1)} ms (${r.counts})`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}
