import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProfileConfig } from './types.js';

export function home(): string {
  return process.env.SESSIONFARM_HOME || path.join(os.homedir(), '.sessionfarm');
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function profileDir(name: string): string {
  return path.join(home(), 'profiles', name);
}

/** The Chromium user-data-dir. Kept separate from config.json so Chromium never sees our files. */
export function dataDir(name: string): string {
  return path.join(profileDir(name), 'data');
}

function configPath(name: string): string {
  return path.join(profileDir(name), 'config.json');
}

export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid profile name "${name}": use letters, digits, dot, dash, underscore (max 64)`);
  }
}

export function list(): ProfileConfig[] {
  const dir = path.join(home(), 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => read(d.name))
    .filter((p): p is ProfileConfig => p !== null);
}

export function read(name: string): ProfileConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(name), 'utf8')) as ProfileConfig;
  } catch {
    return null;
  }
}

export function create(cfg: Omit<ProfileConfig, 'createdAt'>): ProfileConfig {
  assertValidName(cfg.name);
  if (read(cfg.name)) throw new Error(`profile "${cfg.name}" already exists`);
  const full: ProfileConfig = { ...cfg, createdAt: new Date().toISOString() };
  fs.mkdirSync(dataDir(cfg.name), { recursive: true });
  write(full);
  return full;
}

export function write(cfg: ProfileConfig): void {
  fs.mkdirSync(profileDir(cfg.name), { recursive: true });
  fs.writeFileSync(configPath(cfg.name), JSON.stringify(cfg, null, 2));
}

export function remove(name: string): void {
  assertValidName(name);
  fs.rmSync(profileDir(name), { recursive: true, force: true });
}
