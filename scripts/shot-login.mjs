// Captures the login stream as it really renders: a headless Chromium being
// driven from an ordinary browser tab. No credentials are typed.
import { chromium } from 'playwright-core';
import { createServer } from '../dist/server.js';
import * as pool from '../dist/pool.js';
import * as screencast from '../dist/screencast.js';
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs';

const HOME = path.join(os.tmpdir(), 'sessionfarm-shot');
fs.rmSync(HOME, { recursive: true, force: true });
process.env.SESSIONFARM_HOME = HOME;

const TOKEN = 'shot', PORT = 8821, BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const server = createServer(TOKEN);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await fetch(`${BASE}/profiles`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'client-b' }) });
const { url } = await (await fetch(`${BASE}/profiles/client-b/login-url`, { method: 'POST', headers: H })).json();

const op = await chromium.launch({ headless: true });
const page = await op.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
await page.goto(url.replace(/^http:\/\/[^/]+/, BASE));
await page.waitForFunction(() => window.__frame, null, { timeout: 20000 });

await page.fill('#url', 'https://github.com/login');
await page.press('#url', 'Enter');
await page.waitForFunction(() => window.__frame?.url?.includes('github'), null, { timeout: 25000 });
await page.waitForTimeout(3500);            // let the remote page paint fully

console.log('remote page:', await page.evaluate(() => window.__frame.url));
await page.screenshot({ path: 'assets/login-stream.png' });

await op.close(); await screencast.closeAll(); await pool.stopAll(); server.close();
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(0);
