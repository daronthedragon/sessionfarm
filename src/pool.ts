import net from 'node:net';
import crypto from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright-core';
import * as store from './store.js';
import type { Lease, ProfileConfig, ProfileStatus, HealthResult } from './types.js';

interface Warm {
  ctx: BrowserContext;
  cdpUrl: string;
  startedAt: number;
  lastUsed: number;
  lease: Lease | null;
  health: HealthResult | null;
}

const warm = new Map<string, Warm>();
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port: number, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`chromium CDP endpoint did not open on port ${port} within ${timeoutMs}ms`);
}

/**
 * Start a profile's browser and keep it warm.
 *
 * Warm means the *process stays alive*. Session cookies are destroyed on
 * browser exit, so relaunching on demand would silently log the profile out of
 * any site that uses them. Restart is therefore an auth-risk event, never a
 * routine one.
 */
export async function start(name: string, headless = true): Promise<Warm> {
  const existing = warm.get(name);
  if (existing) return existing;

  const cfg: ProfileConfig | null = store.read(name);
  if (!cfg) throw new Error(`no such profile "${name}"`);

  const port = await freePort();
  const ctx = await chromium.launchPersistentContext(store.dataDir(name), {
    headless,
    args: [`--remote-debugging-port=${port}`],
    proxy: cfg.proxy,
    userAgent: cfg.userAgent,
    viewport: cfg.viewport ?? { width: 1280, height: 800 },
    locale: cfg.locale,
    timezoneId: cfg.timezoneId,
  });

  const cdpUrl = await waitForCdp(port);
  const entry: Warm = { ctx, cdpUrl, startedAt: Date.now(), lastUsed: Date.now(), lease: null, health: null };

  // If Chromium dies for any reason, drop it from the pool so the next
  // acquire starts clean instead of handing out a dead endpoint.
  ctx.on('close', () => {
    if (warm.get(name) === entry) warm.delete(name);
  });

  warm.set(name, entry);
  return entry;
}

export async function stop(name: string): Promise<void> {
  const entry = warm.get(name);
  if (!entry) return;
  warm.delete(name);
  await entry.ctx.close().catch(() => undefined);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...warm.keys()].map((n) => stop(n)));
}

function leaseActive(entry: Warm): boolean {
  return entry.lease !== null && entry.lease.expiresAt > Date.now();
}

export async function acquire(
  name: string,
  opts: { ttlMs?: number; holder?: string } = {},
): Promise<{ lease: Lease; cdpUrl: string }> {
  const entry = await start(name);
  if (leaseActive(entry)) {
    const err = new Error(`profile "${name}" is leased until ${new Date(entry.lease!.expiresAt).toISOString()}`);
    (err as Error & { code?: string }).code = 'BUSY';
    throw err;
  }
  const ttl = opts.ttlMs ?? DEFAULT_LEASE_MS;
  const lease: Lease = {
    id: crypto.randomUUID(),
    profile: name,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + ttl,
    holder: opts.holder,
  };
  entry.lease = lease;
  entry.lastUsed = Date.now();
  return { lease, cdpUrl: entry.cdpUrl };
}

export function release(name: string, leaseId: string): boolean {
  const entry = warm.get(name);
  if (!entry || !entry.lease || entry.lease.id !== leaseId) return false;
  entry.lease = null;
  entry.lastUsed = Date.now();
  return true;
}

export function getWarm(name: string): Warm | undefined {
  return warm.get(name);
}

export function setHealth(name: string, health: HealthResult): void {
  const entry = warm.get(name);
  if (entry) entry.health = health;
}

export function status(cfg: ProfileConfig): ProfileStatus {
  const entry = warm.get(cfg.name);
  return {
    name: cfg.name,
    running: Boolean(entry),
    warmForMs: entry ? Date.now() - entry.startedAt : null,
    lease: entry && leaseActive(entry) ? entry.lease : null,
    lastUsed: entry ? new Date(entry.lastUsed).toISOString() : null,
    health: entry?.health ?? null,
    notes: cfg.notes,
  };
}
