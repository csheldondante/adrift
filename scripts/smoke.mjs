// Headless smoke test: boots the dev server, loads the game in Chrome with WebGPU,
// runs an optional scripted input sequence, prints console output, saves screenshots.
// Usage: node scripts/smoke.mjs [outDir] [query]   e.g. query="autotest=cut"
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'smoke-out';
const query = process.argv[3] ?? '';
const seconds = Number(process.env.SMOKE_SECONDS ?? 6);
fs.mkdirSync(outDir, { recursive: true });

const chromePaths = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = chromePaths.find((p) => fs.existsSync(p));

const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0] + (query ? `?${query}` : '');

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let errors = 0;
page.on('console', (m) => {
  if (m.type() === 'error') errors++;
  console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`); });

await page.goto(url);
// autotests can request a screenshot at an exact moment: window.__shotReq = "name"
let polling = true;
const poll = (async () => {
  while (polling) {
    const req = await page.evaluate(() => { const r = window.__shotReq; window.__shotReq = null; return r; }).catch(() => null);
    if (req) await page.screenshot({ path: path.join(outDir, `${req}.png`) });
    await new Promise((r) => setTimeout(r, 30));
  }
})();
const shots = Math.max(1, Math.round(seconds / 2));
for (let i = 0; i < shots; i++) {
  await page.waitForTimeout((seconds * 1000) / shots);
  await page.screenshot({ path: path.join(outDir, `shot-${i}.png`) });
}
polling = false;
await poll;
const stats = await page.evaluate(() => (window).__stats ?? null);
console.log('STATS', JSON.stringify(stats));
console.log(`ERRORS ${errors}`);
await browser.close();
await server.close();
process.exit(errors ? 1 : 0);
