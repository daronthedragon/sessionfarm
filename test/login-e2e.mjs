import http from 'node:http';
import vm from 'node:vm';
import { loginPage } from '../dist/loginpage.js';
import { chromium } from 'playwright-core';
import { createServer } from '../dist/server.js';
import * as pool from '../dist/pool.js';
import * as screencast from '../dist/screencast.js';

const TOKEN = 'tok-login', PORT = 8811, TARGET = 8812;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let pass = 0, fail = 0;
const ok = (n, c, x='') => { c ? (pass++, console.log(`PASS  ${n} ${x}`)) : (fail++, console.log(`FAIL  ${n} ${x}`)); };

// A local page for the remote browser to visit, so nothing depends on the network.
const target = http.createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html' });
  s.end(`<body style="margin:0"><form id=f action="/submitted"><input id=box style="position:absolute;left:100px;top:100px;width:400px;height:50px;font-size:20px"></form></body>`);
});
await new Promise(r => target.listen(TARGET, '127.0.0.1', r));

const server = createServer(TOKEN);
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
await fetch(`${BASE}/profiles`, { method:'POST', headers:H, body: JSON.stringify({ name:'login-e2e' }) });

// 0. the client script must parse — it is generated inside a template literal,
// where a mangled escape produces a page that silently does nothing.
let syntaxOk = true, syntaxErr = '';
try { new vm.Script(loginPage('x', 'y').split('<script>')[1].split('</script>')[0]); }
catch (e) { syntaxOk = false; syntaxErr = e.message; }
ok('client script parses', syntaxOk, syntaxErr);

// 1. bad ticket rejected
const bad = await fetch(`${BASE}/login/login-e2e?ticket=forged`);
ok('forged ticket rejected', bad.status === 401, `(got ${bad.status})`);

// 2. mint a real login URL
const { url } = await (await fetch(`${BASE}/profiles/login-e2e/login-url`, { method:'POST', headers:H })).json();
const loginUrl = url.replace(/^http:\/\/[^/]+/, BASE);
ok('login-url minted', loginUrl.includes('ticket='));

// 3. the operator's own browser opens the login page
const op = await chromium.launch({ headless: true });
const opPage = await op.newPage({ viewport: { width: 1500, height: 1000 } });
await opPage.goto(loginUrl);

// 4. frames arrive over SSE
await opPage.waitForFunction(() => window.__frame && document.getElementById('screen').src.length > 100, null, { timeout: 20000 });
const f = await opPage.evaluate(() => window.__frame);
ok('SSE frames render in operator browser', f.w > 0 && f.h > 0, `(${f.w}x${f.h})`);

// 5. drive the remote browser from the URL bar
await opPage.fill('#url', `http://127.0.0.1:${TARGET}`);
await opPage.press('#url', 'Enter');
await opPage.waitForFunction(() => window.__frame?.url?.includes('8812'), null, { timeout: 20000 });
ok('remote browser navigated from URL bar', true, `(${(await opPage.evaluate(() => window.__frame.url))})`);

// 6. click the remote input by mapping page coords -> operator client coords
const box = await opPage.locator('#screen').boundingBox();
const dims = await opPage.evaluate(() => ({ w: window.__frame.w, h: window.__frame.h }));
const toClient = (px, py) => ({ x: box.x + (px / dims.w) * box.width, y: box.y + (py / dims.h) * box.height });
const c = toClient(300, 125);                       // centre of the 400x50 input at (100,100)
await opPage.mouse.click(c.x, c.y);
await opPage.waitForTimeout(400);

const remotePage = () => pool.getWarm('login-e2e').ctx.pages().find(p => p.url().includes('8812'));
const focused = await remotePage().evaluate(() => document.activeElement?.id);
ok('click focused the remote input', focused === 'box', `(activeElement=${focused})`);

// 7. typing lands in the remote page
await opPage.keyboard.type('hunter2-not-logged');
await opPage.waitForTimeout(600);
const val = await remotePage().evaluate(() => document.getElementById('box').value);
ok('keystrokes reached the remote page', val === 'hunter2-not-logged', `(value="${val}")`);

// 8. Enter submits the form (proves real key events, not just insertText)
await opPage.keyboard.press('Enter');
await opPage.waitForTimeout(1200);
const navigated = pool.getWarm('login-e2e').ctx.pages().some(p => p.url().includes('submitted'));
ok('Enter submitted the remote form', navigated, `(urls=${pool.getWarm('login-e2e').ctx.pages().map(p=>p.url().slice(-24)).join(',')})`);

await op.close();
await screencast.closeAll();
await fetch(`${BASE}/profiles/login-e2e`, { method:'DELETE', headers:H });
await pool.stopAll();
server.close(); target.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
