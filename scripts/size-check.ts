// Bundle budget: total gzip size of the initial load (HTML + entry JS + CSS) must stay under
// 60 KB; warn above 40 KB. Lazy chunks (debug panel, bench) are reported but not counted.
// Usage: npm run build && npm run size
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const BUDGET = 60 * 1024;
const TARGET = 40 * 1024;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = new Set<string>(['index.html']);
for (const m of html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)) initial.add(m[1]);

const files: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p.slice(DIST.length + 1));
  }
};
walk(DIST);

let total = 0;
for (const f of files.sort()) {
  const buf = readFileSync(join(DIST, f));
  const gz = gzipSync(buf, { level: 9 }).length;
  const counted = initial.has(f);
  if (counted) total += gz;
  console.log(`${counted ? '*' : ' '} ${f.padEnd(40)} ${(buf.length / 1024).toFixed(1).padStart(7)} KB  gzip ${(gz / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`initial load (gzip): ${(total / 1024).toFixed(1)} KB — budget ${BUDGET / 1024} KB, target ${TARGET / 1024} KB`);
if (total > BUDGET) {
  console.error('FAIL: over budget');
  process.exit(1);
}
if (total > TARGET) console.warn('WARN: above target');
