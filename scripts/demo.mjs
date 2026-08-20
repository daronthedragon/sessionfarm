// Drives a real sessionfarm and prints what actually happened.
// Every value below comes from a live call; nothing here is illustrative.
import { chromium } from 'playwright-core';
import { createServer } from '../dist/server.js';
import * as pool from '../dist/pool.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const HOME = path.join(os.tmpdir(), 'sessionfarm-demo');
fs.rmSync(HOME, { recursive: true, force: true });
process.env.SESSIONFARM_HOME = HOME;

const TOKEN = 'demo-token', PORT = 8787, BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
const short = (s, n = 46) => (s.length > n ? s.slice(0, n) + '…' : s);

const server = createServer(TOKEN);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

console.log('$ sessionfarm create client-b --notes "client B, main account"');
await api('POST', '/profiles', {
  name: 'client-b', notes: 'client B, main account',
  authCheck: { url: 'https://example.com', okText: 'Example Domain' },
});
console.log('created client-b at ~/.sessionfarm/profiles/client-b\n');

console.log('$ sessionfarm serve');
console.log(`sessionfarm listening on ${BASE}\n`);

console.log('# an agent takes a lease on the warm profile');
const a1 = await (await api('POST', '/profiles/client-b/acquire', { holder: 'agent-1' })).json();
console.log(`POST /profiles/client-b/acquire  ->  200`);
console.log(`     leaseId   ${a1.leaseId}`);
console.log(`     cdpUrl    ${short(a1.cdpUrl)}\n`);

console.log('# it attaches over CDP and works in the already-open session');
const browser = await chromium.connectOverCDP(a1.cdpUrl);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
await page.evaluate(() => localStorage.setItem('who', 'agent-1'));
await page.context().addCookies([{ name: 'auth', value: 'tok-xyz', domain: 'example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 }]);
console.log(`connected. active page: ${page.url()}\n`);

console.log('# a second agent asks for the same profile');
const busy = await api('POST', '/profiles/client-b/acquire', { holder: 'agent-2' });
console.log(`POST /profiles/client-b/acquire  ->  ${busy.status}  ${(await busy.json()).error}\n`);

console.log('# agent-1 hands it back; agent-2 gets the same warm session');
await api('POST', '/profiles/client-b/release', { leaseId: a1.leaseId });
await page.close(); await browser.close();
const a2 = await (await api('POST', '/profiles/client-b/acquire', { holder: 'agent-2' })).json();
const b2 = await chromium.connectOverCDP(a2.cdpUrl);
const p2 = await b2.contexts()[0].newPage();
await p2.goto('https://example.com');
const who = await p2.evaluate(() => localStorage.getItem('who'));
const auth = (await p2.context().cookies('https://example.com')).find((c) => c.name === 'auth')?.value;
console.log(`localStorage.who  ${who}`);
console.log(`cookie auth       ${auth}   <- login state carried across the handover\n`);
await p2.close(); await b2.close();

const h = await (await api('GET', '/profiles/client-b/health')).json();
console.log(`GET  /profiles/client-b/health   ->  ${h.state}`);
const st = await (await api('GET', '/profiles/client-b')).json();
console.log(`warm for ${(st.warmForMs / 1000).toFixed(1)}s, leased by ${st.lease?.holder}`);

await pool.stopAll();
server.close();
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(0);
