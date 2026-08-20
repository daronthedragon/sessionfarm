# sessionfarm

**Persistent logged-in browser profiles as a service.** Agents borrow a warm, already-authenticated browser over CDP instead of re-solving login on every run.

Every "agent that acts as me" project rebuilds the same broken thing: a headless browser that logs in from scratch, trips a challenge, and dies. sessionfarm keeps the profiles alive and hands them out under a lease.

```
agent ──HTTP──> sessionfarm ──CDP──> warm chromium (profile: client-b)
                     │
                     └─ profiles on disk, one user-data-dir each
```

## Why "warm" means the process stays alive

While building this, one measurement changed the design:

| cookie type | survives browser restart? |
|---|---|
| persistent (has `expires`) | yes |
| session-only (no `expires`) | **no** |

localStorage survives too. But plenty of sites keep you signed in with a session cookie, so a pool that *relaunches on demand* would silently log those profiles out and blame the site.

So sessionfarm never recycles a browser to save memory. A stop is an auth-risk event, and `POST /stop` says so in its response. Restarts are something you choose, not something the pool does behind your back.

## Install

```bash
npm install
npm run build
```

Chromium comes from your existing Playwright install (`playwright-core` does not download browsers).

## Quickstart

```bash
# 1. create a profile and log into it by hand, once
node dist/cli.js create client-b --notes "client B, main account"
node dist/cli.js login client-b --url https://example.com

# 2. serve
SESSIONFARM_TOKEN=secret node dist/cli.js serve
```

Then, from an agent:

```js
import { chromium } from 'playwright-core';

const r = await fetch('http://127.0.0.1:8787/profiles/client-b/acquire', {
  method: 'POST',
  headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
  body: JSON.stringify({ holder: 'my-agent', ttlMs: 600000 }),
});
const { cdpUrl, leaseId } = await r.json();

const browser = await chromium.connectOverCDP(cdpUrl);   // already logged in
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
// ... do the work ...
await page.close();

await fetch('http://127.0.0.1:8787/profiles/client-b/release', {
  method: 'POST',
  headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
  body: JSON.stringify({ leaseId }),
});
```

Any CDP client works — Playwright, Puppeteer, or raw DevTools Protocol in any language. That is the whole integration surface.

## Leases

A profile serves one holder at a time; Chromium locks its user-data-dir, and two agents driving one session corrupt each other's state anyway. A second `acquire` gets `409`. Leases carry a TTL so a crashed agent cannot hold a profile forever.

Release the lease — do not call `browser.close()`. Closing the client is harmless (verified: the warm browser survives a client disconnect) but it does not free the lease.

## Health checks

Give a profile an `authCheck` and sessionfarm can tell you whether the login still holds:

```json
{
  "name": "client-b",
  "authCheck": {
    "url": "https://example.com/account",
    "okSelector": "[data-testid=avatar]",
    "failSelector": "form#login"
  }
}
```

`GET /profiles/:name/health` runs it in a throwaway page, so it never disturbs a lease holder.

## API

| method | path | purpose |
|---|---|---|
| `GET` | `/profiles` | list, with warm/lease/health status |
| `POST` | `/profiles` | create |
| `GET` | `/profiles/:name` | status |
| `DELETE` | `/profiles/:name` | stop and delete |
| `POST` | `/profiles/:name/start` | boot the browser, keep it warm |
| `POST` | `/profiles/:name/stop` | stop it (kills session cookies) |
| `POST` | `/profiles/:name/acquire` | take a lease, get a `cdpUrl` |
| `POST` | `/profiles/:name/release` | give the lease back |
| `GET` | `/profiles/:name/health` | is this profile still logged in |

Every route requires `Authorization: Bearer $SESSIONFARM_TOKEN`, compared in constant time.

## Running on a VPS

Profiles live in `$SESSIONFARM_HOME` (default `~/.sessionfarm`). The intended flow is to log in on a machine with a screen, then copy the profile directory to the server:

```bash
rsync -a ~/.sessionfarm/profiles/client-b/ vps:~/.sessionfarm/profiles/client-b/
```

Bind the API to `127.0.0.1` and reach it over an SSH tunnel. It has a bearer token, not an authorization model — do not put it on a public interface.

## Tests

```bash
npm test
```

Covers auth rejection, create, lease exclusivity, external CDP attach, state surviving across leases, warm survival after client disconnect, health check, status, delete.

## Scope

Per-profile proxy, user-agent, viewport, locale and timezone are supported. Deliberately not included yet: fingerprint spoofing beyond those, automatic re-login, and a UI.

Note that many platforms restrict automation and multi-account use in their terms. This is infrastructure for sessions you are entitled to drive — client accounts you manage, your own brands, your own testing.

## License

MIT
