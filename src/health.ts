import * as pool from './pool.js';
import * as store from './store.js';
import type { HealthResult } from './types.js';

/**
 * Load the profile's auth-check URL in its own warm context and decide whether
 * the login still holds. Runs in a throwaway page so it never disturbs whatever
 * a lease holder is doing.
 */
export async function check(name: string): Promise<HealthResult> {
  const cfg = store.read(name);
  if (!cfg) throw new Error(`no such profile "${name}"`);

  const checkedAt = new Date().toISOString();
  if (!cfg.authCheck) {
    return { state: 'unknown', checkedAt, detail: 'no authCheck configured for this profile' };
  }

  const { url, okSelector, okText, failSelector } = cfg.authCheck;
  const entry = await pool.start(name);
  const page = await entry.ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (failSelector && (await page.locator(failSelector).count()) > 0) {
      const r: HealthResult = { state: 'expired', checkedAt, detail: `failSelector matched: ${failSelector}` };
      pool.setHealth(name, r);
      return r;
    }
    if (okSelector) {
      const ok = (await page.locator(okSelector).count()) > 0;
      const r: HealthResult = {
        state: ok ? 'authenticated' : 'expired',
        checkedAt,
        detail: ok ? `okSelector matched: ${okSelector}` : `okSelector absent: ${okSelector}`,
      };
      pool.setHealth(name, r);
      return r;
    }
    if (okText) {
      const body = (await page.textContent('body')) ?? '';
      const ok = body.includes(okText);
      const r: HealthResult = {
        state: ok ? 'authenticated' : 'expired',
        checkedAt,
        detail: ok ? `okText found` : `okText absent: ${okText}`,
      };
      pool.setHealth(name, r);
      return r;
    }
    const r: HealthResult = { state: 'unknown', checkedAt, detail: 'authCheck has no okSelector, okText or failSelector' };
    pool.setHealth(name, r);
    return r;
  } catch (err) {
    const r: HealthResult = { state: 'error', checkedAt, detail: (err as Error).message };
    pool.setHealth(name, r);
    return r;
  } finally {
    await page.close().catch(() => undefined);
  }
}
