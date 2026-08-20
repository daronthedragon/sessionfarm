#!/usr/bin/env node
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createServer, mintTicket } from './server.js';
import * as screencast from './screencast.js';
import * as health from './health.js';
import * as store from './store.js';
import * as pool from './pool.js';

const USAGE = `sessionfarm — persistent logged-in browser profiles as a service

  sessionfarm serve [--port 8787] [--host 127.0.0.1]
      Start the API. Reads SESSIONFARM_TOKEN, or prints a generated one.

  sessionfarm create <name> [--notes "..."] [--proxy http://host:port]
      Create an empty profile.

  sessionfarm login <name> [--url https://…] [--no-open]
      Stream the profile's browser to your own browser so you can log in by
      hand. Works identically on a laptop and on a headless VPS.

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


function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]]
            : ['xdg-open', [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log('(could not open a browser automatically - open the URL above)');
  }
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
      if (!store.read(name)) throw new Error(`no such profile "${name}" - run: sessionfarm create ${name}`);

      // Same code path a VPS runs. The browser being remote is the point: there
      // is no headed-only mode to drift out of sync with the streamed one.
      const token = process.env.SESSIONFARM_TOKEN ?? crypto.randomBytes(24).toString('hex');
      const port = Number(flag(rest, 'port') ?? 0) || (await freePort());
      const server = createServer(token);
      await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

      const ticket = mintTicket(name, token);
      const url = `http://127.0.0.1:${port}/login/${encodeURIComponent(name)}?ticket=${encodeURIComponent(ticket)}`;
      await screencast.get(name);

      console.log(`
driving profile "${name}" at:

  ${url}
`);
      if (flag(rest, 'url')) {
        const cast = await screencast.get(name);
        await cast.input({ type: 'nav', url: flag(rest, 'url')! });
      }
      if (!rest.includes('--no-open')) openBrowser(url);
      console.log('log in, then press Enter here to finish...');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('');
      rl.close();

      const result = await health.check(name);
      console.log(`health: ${result.state}${result.detail ? ' - ' + result.detail : ''}`);
      console.log(`profile stays warm while the server runs; session cookies die if it stops.`);
      await screencast.closeAll();
      await pool.stopAll();
      server.close();
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
