import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Publication, Request } from '../../src/hosts/browser/simulation/protocol';
import { selfhold } from '../fixtures/scenarios/build';
const context: Context = { epoch: 1, document: 2, projectId: 'project', revision: 0, runId: 'test' };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
async function harness() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const frames: Publication[] = [];
  const scope = { postMessage: (message: Publication) => frames.push(structuredClone(message)), onmessage: null as null | ((event: MessageEvent<Request>) => void) };
  vi.stubGlobal('self', scope); await import('../../src/hosts/browser/simulation/worker');
  let sequence = 0;
  const send = (command: Request['command'], override: Partial<Request> = {}) => scope.onmessage!({ data: { context, sequence: ++sequence, command, ...override } } as MessageEvent<Request>);
  send({ kind: 'start', project: selfhold() });
  return { frames, send, last: () => frames.at(-1)! };
}
describe('actual worker entry with injected host clock (shared engine, no fake physics)', () => {
  it('anchors integer 1x time; paused duration creates no debt; Step is exact +1 and Resume consumes pending', async () => {
    const h = await harness(); expect(h.last().mode).toBe('Running');
    vi.advanceTimersByTime(500); expect(h.last().runtime?.timeMs).toBe(500);
    h.send({ kind: 'pause' }); vi.advanceTimersByTime(1000); expect(h.last().runtime?.timeMs).toBe(500);
    h.send({ kind: 'input', instanceId: 'instance2', action: 'press' }); expect(h.last().runtime?.pending).toHaveLength(1);
    expect(h.last().runtime?.live.find(o => o.target.id === 'device2')?.value).toEqual({ quality: 'known', value: false });
    h.send({ kind: 'step' }); expect(h.last().runtime?.timeMs).toBe(501); expect(h.last().runtime?.pending).toHaveLength(0);
    h.send({ kind: 'resume' }); vi.advanceTimersByTime(100); expect(h.last().runtime?.timeMs).toBe(601);
    expect(h.last().runtime?.live.find(o => o.target.id === 'device3')?.value).toEqual({ quality: 'known', value: true });
  });
  it.each(['valid input', 'rejected input', 'rejected lifecycle'] as const)('preserves continuous 1x time with inter-tick %s every 10ms', async kind => {
    const h = await harness();
    for (let n = 0; n < 100; n++) {
      // Real worker interval remains 25ms; commands deliberately fall between ticks.
      vi.advanceTimersByTime(10);
      if (kind === 'rejected lifecycle') h.send({ kind: n % 2 ? 'resume' : 'step' });
      else h.send({ kind: 'input', instanceId: kind === 'valid input' ? 'instance2' : 'missing', action: n % 2 ? 'release' : 'press' });
      expect(h.last().mode).toBe('Running');
      expect(h.last().error === null).toBe(kind === 'valid input');
    }
    expect(performance.now()).toBe(1000);
    expect(h.last().runtime?.timeMs).toBe(1000);
    expect(h.last().runtime?.processedEvents).toBe(kind === 'valid input' ? 100 : 0);
    h.send({ kind: 'pause' }); vi.advanceTimersByTime(1000);
    expect(h.last().runtime?.timeMs).toBe(1000);
    h.send({ kind: 'step' }); expect(h.last().runtime?.timeMs).toBe(1001);
    h.send({ kind: 'resume' }); vi.advanceTimersByTime(1000);
    expect(h.last().runtime?.timeMs).toBe(2001);
  });
  it('rejects duplicate/out-of-order/wrong-context requests; release+pause is atomic and paused releases remain pending', async () => {
    const h = await harness(); h.send({ kind: 'input', instanceId: 'instance2', action: 'press' }); const events = h.last().runtime!.processedEvents;
    h.send({ kind: 'input', instanceId: 'instance2', action: 'press' }, { sequence: 2 }); expect(h.last().runtime!.processedEvents).toBe(events);
    h.send({ kind: 'release' }, { sequence: 3 }); expect(h.last().mode).toBe('Paused');
    expect(h.last().runtime?.live.find(o => o.target.id === 'device2')?.value).toEqual({ quality: 'known', value: false });
    h.send({ kind: 'input', instanceId: 'instance2', action: 'press' }, { sequence: 4, context: { ...context, revision: 9 } }); expect(h.last().runtime?.pending).toHaveLength(0);
    h.send({ kind: 'input', instanceId: 'instance2', action: 'press' }, { sequence: 4 }); h.send({ kind: 'release' }, { sequence: 5 }); expect(h.last().runtime?.pending).toHaveLength(2);
    h.send({ kind: 'step' }, { sequence: 6 }); expect(h.last().runtime?.pending).toHaveLength(0); expect(h.last().runtime?.live.find(o => o.target.id === 'device2')?.value).toEqual({ quality: 'known', value: false });
  });
  it('keeps startup/preflight failures explicit on heartbeat rather than misreporting a silent worker', async () => {
    const h = await harness();
    // A separate worker starts with a structurally valid source-less draft.
    vi.clearAllTimers(); vi.resetModules();
    const frames: Publication[] = [], scope = { postMessage: (f: Publication) => frames.push(f), onmessage: null as null | ((event: MessageEvent<Request>) => void) };
    vi.stubGlobal('self', scope); await import('../../src/hosts/browser/simulation/worker');
    const p = selfhold(); const noSource = { ...p, sheets: [{ ...p.sheets[0]!, instances: p.sheets[0]!.instances.filter(i => i.id !== 'instance0'), wires: [] }] };
    scope.onmessage!({ data: { context, sequence: 1, command: { kind: 'start', project: noSource } } } as unknown as MessageEvent<Request>);
    expect(frames.at(-1)?.mode).toBe('Faulted'); expect(frames.at(-1)?.error).toBeTruthy(); vi.advanceTimersByTime(500);
    expect(frames.at(-1)?.mode).toBe('Faulted'); expect(frames.at(-1)?.runtime).toBeNull(); expect(h.frames).not.toHaveLength(0);
  });
  it('publishes at most 64 retained tail frames, not full core history on every clock tick', async () => {
    const h = await harness();
    for (let n = 0; n < 90; n++) { vi.advanceTimersByTime(125); h.send({ kind: 'input', instanceId: 'instance2', action: n % 2 ? 'release' : 'press' }); }
    expect(h.last().runtime?.history).toHaveLength(64); expect(h.last().runtime!.history[0]!.atMs).toBeGreaterThan(0);
    expect(h.frames.every(f => !f.runtime || f.runtime.history.length <= 64)).toBe(true);
  });
});
