import http from 'node:http';
import { chromium } from 'playwright-core';
import { createServer } from '../dist/server.js';
import * as pool from '../dist/pool.js';

const TOKEN = 'test-token-123';
const BASE = 'http://127.0.0.1:8799';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log(`PASS  ${name} ${extra}`)) : (fail++, console.log(`FAIL  ${name} ${extra}`)); };
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });

const server = createServer(TOKEN);
await new Promise(r => server.listen(8799, '127.0.0.1', r));

// 1. auth
const noAuth = await fetch(`${BASE}/profiles`);
ok('unauthenticated request rejected', noAuth.status === 401, `(got ${noAuth.status})`);

// 2. create
const created = await api('POST', '/profiles', {
  name: 'e2e', notes: 'end to end',
  authCheck: { url: 'https://example.com', okText: 'Example Domain' },
});
ok('create profile', created.status === 201, `(got ${created.status})`);

// 3. acquire
const a1 = await (await api('POST', '/profiles/e2e/acquire', { holder: 'agent-1' })).json();
ok('acquire returns cdpUrl', typeof a1.cdpUrl === 'string' && a1.cdpUrl.startsWith('ws://'), `(${a1.cdpUrl?.slice(0,28)}...)`);

// 4. lease exclusivity
const a2 = await api('POST', '/profiles/e2e/acquire', { holder: 'agent-2' });
ok('second acquire is 409 BUSY', a2.status === 409, `(got ${a2.status})`);

// 5. external client writes state
const b1 = await chromium.connectOverCDP(a1.cdpUrl);
const p1 = await b1.contexts()[0].newPage();
await p1.goto('https://example.com');
await p1.evaluate(() => localStorage.setItem('who', 'agent-1'));
await p1.context().addCookies([{ name: 'auth', value: 'tok-xyz', domain: 'example.com', path: '/', expires: Math.floor(Date.now()/1000)+86400 }]);
await p1.close();
ok('external CDP client wrote state', true);

// 6. does a client disconnect kill the warm browser?
await b1.close();
await new Promise(r => setTimeout(r, 800));
ok('warm browser survives client disconnect', pool.getWarm('e2e') !== undefined);

// 7. release + re-acquire, state still there
const rel = await api('POST', '/profiles/e2e/release', { leaseId: a1.leaseId });
ok('release lease', rel.status === 200, `(got ${rel.status})`);
const a3 = await (await api('POST', '/profiles/e2e/acquire', { holder: 'agent-2' })).json();
const b2 = await chromium.connectOverCDP(a3.cdpUrl);
const p2 = await b2.contexts()[0].newPage();
await p2.goto('https://example.com');
const ls = await p2.evaluate(() => localStorage.getItem('who'));
const ck = (await p2.context().cookies('https://example.com')).find(c => c.name === 'auth')?.value;
ok('state survives across leases', ls === 'agent-1' && ck === 'tok-xyz', `(ls=${ls} cookie=${ck})`);
await p2.close(); await b2.close();

// 8. health check
const h = await (await api('GET', '/profiles/e2e/health')).json();
ok('health check authenticates', h.state === 'authenticated', `(state=${h.state})`);

// 9. status
const st = await (await api('GET', '/profiles/e2e')).json();
ok('status reports warm + lease', st.running === true && st.lease?.holder === 'agent-2', `(running=${st.running} holder=${st.lease?.holder})`);


// 9b. failSelector on its own is a complete test: absent means the session held.
const authSrv = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end(q.url === '/in' ? '<body><h1>account</h1></body>' : '<body><form><input id="login_field"></form></body>');
});
await new Promise(r => authSrv.listen(8802, '127.0.0.1', r));

await api('POST', '/profiles', { name: 'fs-in',  authCheck: { url: 'http://127.0.0.1:8802/in',  failSelector: '#login_field' } });
await api('POST', '/profiles', { name: 'fs-out', authCheck: { url: 'http://127.0.0.1:8802/out', failSelector: '#login_field' } });
const hIn  = await (await api('GET', '/profiles/fs-in/health')).json();
const hOut = await (await api('GET', '/profiles/fs-out/health')).json();
ok('failSelector absent -> authenticated', hIn.state === 'authenticated', `(state=${hIn.state})`);
ok('failSelector present -> expired',      hOut.state === 'expired',      `(state=${hOut.state})`);
await api('DELETE', '/profiles/fs-in'); await api('DELETE', '/profiles/fs-out');
authSrv.close();

// 10. cleanup
const del = await api('DELETE', '/profiles/e2e');
ok('delete profile', del.status === 200, `(got ${del.status})`);

await pool.stopAll();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
