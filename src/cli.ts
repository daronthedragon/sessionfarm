#!/usr/bin/env node
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { chromium } from 'playwright-core';
import { createServer } from './server.js';
import * as store from './store.js';
import * as pool from './pool.js';

const USAGE = `sessionfarm — persistent logged-in browser profiles as a service

  sessionfarm serve [--port 8787] [--host 127.0.0.1]
      Start the API. Reads SESSIONFARM_TOKEN, or prints a generated one.

  sessionfarm create <name> [--notes "..."] [--proxy http://host:port]
      Create an empty profile.

  sessionfarm login <name>
      Open a visible browser on the profile so you can log in by hand.
      Close it when done; persistent cookies are kept.

  sessionfarm list
  sessionfarm rm <name>

Env:
  SESSIONFARM_HOME    profile storage (default ~/.sessionfarm)
  SESSIONFARM_TOKEN   bearer token required by the API
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'serve': {
      const port = Number(flag(rest, 'port') ?? process.env.SESSIONFARM_PORT ?? 8787);
      const host = flag(rest, 'host') ?? '127.0.0.1';
      let token = process.env.SESSIONFARM_TOKEN;
      if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        console.log(`no SESSIONFARM_TOKEN set — generated one for this run:\n\n  ${token}\n`);
      }
      const server = createServer(token);
      server.listen(port, host, () => {
        console.log(`sessionfarm listening on http://${host}:${port}`);
        console.log(`profiles: ${store.home()}`);
      });
      const shutdown = async () => {
        console.log('\nshutting down; stopping warm browsers');
        await pool.stopAll();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      break;
    }

    case 'create': {
      const name = rest[0];
      if (!name) throw new Error('usage: sessionfarm create <name>');
      const proxy = flag(rest, 'proxy');
      const cfg = store.create({ name, notes: flag(rest, 'notes'), proxy: proxy ? { server: proxy } : undefined });
      console.log(`created ${cfg.name} at ${store.profileDir(name)}`);
      break;
    }

    case 'login': {
      const name = rest[0];
      if (!name) throw new Error('usage: sessionfarm login <name>');
      const cfg = store.read(name);
      if (!cfg) throw new Error(`no such profile "${name}" — run: sessionfarm create ${name}`);
      const ctx = await chromium.launchPersistentContext(store.dataDir(name), {
        headless: false,
        proxy: cfg.proxy,
        userAgent: cfg.userAgent,
        viewport: cfg.viewport ?? { width: 1280, height: 800 },
        locale: cfg.locale,
        timezoneId: cfg.timezoneId,
      });
      await ctx.newPage().then((p) => p.goto(flag(rest, 'url') ?? 'about:blank').catch(() => undefined));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('log in, then press Enter here to save the profile... ');
      rl.close();
      await ctx.close();
      console.log(`saved. persistent cookies for "${name}" are on disk.`);
      console.log('note: session-only cookies are NOT saved — sites relying on them need the browser kept warm.');
      break;
    }

    case 'list': {
      const profiles = store.list();
      if (!profiles.length) { console.log('no profiles yet'); break; }
      for (const p of profiles) console.log(`${p.name}\t${p.notes ?? ''}\tcreated ${p.createdAt}`);
      break;
    }

    case 'rm': {
      const name = rest[0];
      if (!name) throw new Error('usage: sessionfarm rm <name>');
      store.remove(name);
      console.log(`removed ${name}`);
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
