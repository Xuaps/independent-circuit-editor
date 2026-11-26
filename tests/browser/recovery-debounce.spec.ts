import { expect, test, type Page } from '@playwright/test';
import type { Publication } from '../../src/hosts/browser/simulation/protocol';
import { advanced, graph, inspectProject, moreFiles } from './helpers/authoring';

const key = 'independent-circuit:recovery:v1';
const bytes = async (page: Page) => (await page.getByTestId('project-json').textContent())!;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
type Mode = 'Running' | 'Paused';
type Frame = { mode: Mode; publication: number; sequence: number; timeMs: number };
type TimerEvent = [kind: 'arm' | 'cancel' | 'fire', id: number];
type RecoveryProbe = {
  frames: Frame[];
  advanceTo(target: number): { pending: { id: number; due: number }[]; events: TimerEvent[]; writes: string[]; stored: string | null };
};
declare global { interface Window { recoveryProbe: RecoveryProbe } }

function observeRecovery(key: string) {
  const browser: Window = window;
  const nativeSet = browser.setTimeout.bind(browser), nativeClear = browser.clearTimeout.bind(browser);
  const nativeWrite = Storage.prototype.setItem, NativeWorker = window.Worker;
  const jobs = new Map<number, { due: number; run(): void }>();
  const events: TimerEvent[] = [], writes: string[] = [], frames: Frame[] = [];
  let clock = 0, nextId = -1;
  // Gate the 300 ms recovery task only; leave the worker, watchdog and other timers real.
  browser.setTimeout = (handler, delay, ...args) => {
    if (delay !== 300 || typeof handler !== 'function') return nativeSet(handler, delay, ...args);
    const id = nextId--;
    jobs.set(id, { due: clock + delay, run: () => handler(...args) });
    events.push(['arm', id]);
    return id;
  };
  browser.clearTimeout = id => {
    if (id === undefined || id >= 0) return nativeClear(id);
    if (jobs.delete(id)) events.push(['cancel', id]);
  };
  Storage.prototype.setItem = function (k, value) {
    nativeWrite.call(this, k, value);
    if (this === localStorage && k === key) writes.push(value);
  };
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name !== 'circuit-runtime') return;
      this.addEventListener('message', ({ data }: MessageEvent<Publication>) => {
        const { mode, publication, sequence, runtime } = data;
        if (runtime && (mode === 'Running' || mode === 'Paused')) frames.push({ mode, publication, sequence, timeMs: runtime.timeMs });
      });
    }
  };
  window.recoveryProbe = {
    frames,
    advanceTo(target: number) {
      for (const [id, job] of jobs) {
        if (job.due > target) continue;
        clock = job.due;
        jobs.delete(id);
        events.push(['fire', id]);
        job.run();
      }
      clock = target;
      return { pending: [...jobs].map(([id, job]) => ({ id, due: job.due })), events, writes, stored: localStorage.getItem(key) };
    },
  };
}

const advanceTo = (page: Page, target: number) => page.evaluate(target => window.recoveryProbe.advanceTo(target), target);

async function heartbeats(page: Page, mode: Mode, after = 0): Promise<Frame[]> {
  const result = await page.waitForFunction(({ mode, after }) => {
    // Running startup is at t=0. The first Paused message acknowledges Pause; only later messages are heartbeats.
    const frames = window.recoveryProbe.frames.filter(frame => frame.mode === mode);
    const eligible = mode === 'Running' ? frames.filter(frame => frame.timeMs > 0) : frames.slice(1);
    const next = eligible.filter(frame => frame.publication > after);
    return next.length >= 3 ? next.slice(0, 3) : null;
  }, { mode, after });
  const frames = await result.jsonValue();
  await result.dispose();
  return frames!;
}

async function annotate(page: Page, text: string) {
  await button(page, 'Text tool').click();
  await advanced(page);
  await page.getByLabel('Annotation text', { exact: true }).fill(text);
  await page.getByLabel('Cursor X', { exact: true }).fill('140');
  await page.getByLabel('Cursor Y', { exact: true }).fill('440');
  await button(page, 'Place at coordinates').click();
  await expect(page.getByTestId('project-json')).toContainText(text);
}

for (const [mode, replacement] of [['Running', 'a superseding edit'], ['Paused', 'Undo']] as const) {
  test(`recovery debounce survives real ${mode} heartbeats after ${replacement}`, async ({ page }) => {
    await page.goto('/');
    await moreFiles(page);
    page.once('dialog', dialog => dialog.accept('Discard'));
    await button(page, 'Load example').click();
    await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();
    await inspectProject(page);
    const baseline = await bytes(page), baselineGraph = await graph(page);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(baseline);
    await page.evaluate(observeRecovery, key);

    const firstText = `Intermediate recovery edit before ${mode}`;
    await annotate(page, firstText);
    const initial = await advanceTo(page, 100);
    expect(initial.pending).toHaveLength(1);
    const [first] = initial.pending;
    expect(first!.due).toBe(300);
    if (mode === 'Running') await annotate(page, 'Latest recovery edit before Running');
    else {
      await button(page, 'Undo (1)').click();
      await expect(page.getByTestId('project-json')).not.toContainText(firstText);
      expect(await graph(page)).toEqual({ ...baselineGraph, revision: expect.any(Number) });
    }
    const expected = await bytes(page);
    const superseded = await advanceTo(page, 200);
    expect(superseded.pending).toHaveLength(1);
    const [latest] = superseded.pending;
    expect(latest!.due).toBe(400);
    expect(superseded.events).toEqual([['arm', first!.id], ['cancel', first!.id], ['arm', latest!.id]]);

    await button(page, 'Run').click();
    if (mode === 'Paused') await button(page, 'Pause').click();
    const heading = page.getByRole('heading', { name: `Simulation — ${mode}` });
    await expect(heading).toBeVisible();
    const [a, b, c] = await heartbeats(page, mode);
    if (mode === 'Running') {
      expect(b!.timeMs).toBeGreaterThan(a!.timeMs);
      expect(c!.timeMs).toBeGreaterThan(b!.timeMs);
      await expect.poll(async () => Number((await page.getByTestId('runtime-clock').textContent())!.match(/\d+/)![0])).toBeGreaterThanOrEqual(c!.timeMs);
    } else {
      expect([b!.sequence, c!.sequence]).toEqual([a!.sequence, a!.sequence]);
      expect([b!.timeMs, c!.timeMs]).toEqual([a!.timeMs, a!.timeMs]);
    }

    const beforeDeadline = await advanceTo(page, 399);
    expect(beforeDeadline.events, `same-design ${mode} publications must leave the latest edit timer untouched`).toEqual(superseded.events);
    expect(beforeDeadline.pending).toEqual([latest]);
    expect(beforeDeadline.writes).toEqual([]);
    expect(beforeDeadline.stored).toBe(baseline);
    const atDeadline = await advanceTo(page, 400);
    expect(atDeadline).toEqual({ pending: [], events: [...superseded.events, ['fire', latest!.id]], writes: [expected], stored: expected });
    await expect(heading).toBeVisible();

    const after = await page.evaluate(() => window.recoveryProbe.frames.at(-1)!.publication);
    await heartbeats(page, mode, after);
    expect(await advanceTo(page, 700)).toEqual(atDeadline);
    await expect(heading).toBeVisible();
  });
}
