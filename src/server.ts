import http from 'node:http';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as pool from './pool.js';
import * as health from './health.js';
import type { ProfileConfig } from './types.js';

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: unknown;
  params: Record<string, string>;
}

function send(res: http.ServerResponse, code: number, payload: unknown): void {
  const data = JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { status: 400 });
  }
}

/** Constant-time bearer comparison so the token can't be probed by timing. */
function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type Handler = (ctx: Ctx) => Promise<void> | void;
const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method, pattern, keys, handler });
}

route('GET', '/profiles', ({ res }) => {
  send(res, 200, { profiles: store.list().map((c) => pool.status(c)) });
});

route('POST', '/profiles', ({ res, body }) => {
  const b = body as Partial<ProfileConfig>;
  if (!b?.name) throw Object.assign(new Error('name is required'), { status: 400 });
  const cfg = store.create({
    name: b.name,
    notes: b.notes,
    proxy: b.proxy,
    userAgent: b.userAgent,
    viewport: b.viewport,
    locale: b.locale,
    timezoneId: b.timezoneId,
    authCheck: b.authCheck,
  });
  send(res, 201, cfg);
});

route('GET', '/profiles/:name', ({ res, params }) => {
  const cfg = store.read(params.name);
  if (!cfg) throw Object.assign(new Error('no such profile'), { status: 404 });
  send(res, 200, pool.status(cfg));
});

route('DELETE', '/profiles/:name', async ({ res, params }) => {
  await pool.stop(params.name);
  store.remove(params.name);
  send(res, 200, { deleted: params.name });
});

route('POST', '/profiles/:name/start', async ({ res, params }) => {
  await pool.start(params.name);
  const cfg = store.read(params.name)!;
  send(res, 200, pool.status(cfg));
});

route('POST', '/profiles/:name/stop', async ({ res, params }) => {
  await pool.stop(params.name);
  send(res, 200, {
    stopped: params.name,
    warning: 'session cookies for this profile are now gone; sites using them will need a fresh login',
  });
});

route('POST', '/profiles/:name/acquire', async ({ res, params, body }) => {
  const b = (body ?? {}) as { ttlMs?: number; holder?: string };
  const { lease, cdpUrl } = await pool.acquire(params.name, { ttlMs: b.ttlMs, holder: b.holder });
  send(res, 200, {
    leaseId: lease.id,
    cdpUrl,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    hint: 'connect with playwright chromium.connectOverCDP(cdpUrl); do NOT call browser.close() — release the lease instead',
  });
});

route('POST', '/profiles/:name/release', ({ res, params, body }) => {
  const b = (body ?? {}) as { leaseId?: string };
  if (!b.leaseId) throw Object.assign(new Error('leaseId is required'), { status: 400 });
  const ok = pool.release(params.name, b.leaseId);
  if (!ok) throw Object.assign(new Error('lease not found or already released'), { status: 409 });
  send(res, 200, { released: params.name });
});

route('GET', '/profiles/:name/health', async ({ res, params }) => {
  send(res, 200, await health.check(params.name));
});

export function createServer(token: string): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req, token)) return send(res, 401, { error: 'unauthorized' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.pattern);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
          return await r.handler({ req, res, body, params });
        }
        send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        const status = e.status ?? (e.code === 'BUSY' ? 409 : 500);
        send(res, status, { error: e.message });
      }
    })();
  });
}
