import type { Page, CDPSession } from 'playwright-core';
import * as pool from './pool.js';

export interface Frame {
  img: string;
  /** Viewport size in CSS pixels, used by the client to map click coordinates. */
  w: number;
  h: number;
  url: string;
}

type Subscriber = (frame: Frame) => void;

/** Alt=1, Ctrl=2, Meta=4, Shift=8 — the CDP modifier bitmask. */
export interface InputEvent {
  type: 'mouse' | 'scroll' | 'key' | 'text' | 'nav' | 'back';
  action?: 'move' | 'down' | 'up' | 'click';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  modifiers?: number;
  text?: string;
  url?: string;
}

/** Keys that need a real key event; anything else is inserted as text. */
const VKEY: Record<string, number> = {
  Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Shift: 16, Control: 17, Alt: 18, Meta: 91,
};

class Cast {
  private cdp: CDPSession | null = null;
  private page: Page | null = null;
  private subs = new Set<Subscriber>();
  private last: Frame | null = null;

  constructor(private name: string) {}

  private async attach(page: Page): Promise<void> {
    if (this.page === page) return;
    await this.detach();

    const ctx = page.context();
    const cdp = await ctx.newCDPSession(page);
    this.page = page;
    this.cdp = cdp;

    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      const frame: Frame = {
        img: f.data,
        w: f.metadata.deviceWidth,
        h: f.metadata.deviceHeight,
        url: this.page?.url() ?? '',
      };
      this.last = frame;
      for (const s of this.subs) s(frame);
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

    // A closed page leaves us streaming nothing; fall back to whatever is left.
    page.once('close', () => {
      if (this.page !== page) return;
      const remaining = ctx.pages().filter((p) => !p.isClosed());
      this.page = null;
      this.cdp = null;
      if (remaining.length) void this.attach(remaining[remaining.length - 1]);
    });
  }

  private async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.page = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  async open(): Promise<void> {
    const entry = await pool.start(this.name);
    const ctx = entry.ctx;
    const live = ctx.pages().filter((p) => !p.isClosed());
    const page = live.length ? live[live.length - 1] : await ctx.newPage();
    await this.attach(page);

    // OAuth and consent flows open popups. Follow them, or the operator ends up
    // staring at a frozen frame of the page that spawned the window.
    ctx.on('page', (p) => void this.attach(p));
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    // Screencast only emits on visual change, so a fresh subscriber would see
    // nothing at all until the page happens to move. Replay the last frame.
    if (this.last) fn(this.last);
    return () => this.subs.delete(fn);
  }

  async input(ev: InputEvent): Promise<void> {
    if (!this.cdp || !this.page) throw new Error('screencast is not attached to a page');
    const cdp = this.cdp;
    const mods = ev.modifiers ?? 0;

    switch (ev.type) {
      case 'mouse': {
        const base = { x: ev.x ?? 0, y: ev.y ?? 0, button: ev.button ?? 'left', modifiers: mods, clickCount: ev.clickCount ?? 1 };
        if (ev.action === 'move') {
          await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', clickCount: 0 });
        } else if (ev.action === 'click') {
          await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
          await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
        } else {
          await cdp.send('Input.dispatchMouseEvent', { ...base, type: ev.action === 'down' ? 'mousePressed' : 'mouseReleased' });
        }
        return;
      }
      case 'scroll':
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: ev.x ?? 0, y: ev.y ?? 0,
          deltaX: ev.deltaX ?? 0, deltaY: ev.deltaY ?? 0, modifiers: mods,
        });
        return;
      case 'text':
        // insertText handles unicode and IME output that key events mangle.
        await cdp.send('Input.insertText', { text: ev.text ?? '' });
        return;
      case 'key': {
        const key = ev.key ?? '';
        const vk = VKEY[key];
        await cdp.send('Input.dispatchKeyEvent', {
          type: ev.action === 'up' ? 'keyUp' : 'keyDown',
          key,
          code: ev.code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          modifiers: mods,
          // Enter must carry its text or forms will not submit.
          text: key === 'Enter' ? '\r' : undefined,
        });
        return;
      }
      case 'nav':
        await this.page.goto(ev.url ?? 'about:blank', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        return;
      case 'back':
        await this.page.goBack().catch(() => undefined);
        return;
    }
  }

  async close(): Promise<void> {
    this.subs.clear();
    await this.detach();
  }

  get subscriberCount(): number {
    return this.subs.size;
  }
}

const casts = new Map<string, Cast>();

export async function get(name: string): Promise<Cast> {
  let cast = casts.get(name);
  if (!cast) {
    cast = new Cast(name);
    casts.set(name, cast);
    await cast.open();
  }
  return cast;
}

export async function closeAll(): Promise<void> {
  await Promise.all([...casts.values()].map((c) => c.close()));
  casts.clear();
}
