import { describe, expect, it, vi } from 'vitest';
import { runtimeController } from '../../src/hosts/browser/simulation/controller';
import { createLocalClient } from '../../src/ui/editor/application';
import type { Publication, Request, RuntimeState, WorkerPort } from '../../src/hosts/browser/simulation/protocol';
import { selfhold } from '../fixtures/scenarios/build';
import { createSession } from '../../src/core/session';
class FakeWorker implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null; onerror: WorkerPort['onerror'] = null;
  sent: Request[] = []; terminated = false;
  postMessage(message: Request) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  frame(overrides: Partial<Publication> = {}) {
    const request = this.sent.at(-1)!;
    const s = createSession(selfhold()); if (!s.ok) throw Error(); s.value.run(request.context.runId);
    const v = s.value.view();
    return { context: request.context, sequence: request.sequence, publication: 1, mode: 'Running' as const, runtime: v.runtime, error: null, ...overrides };
  }
  emit(data: Publication) { this.onmessage?.({ data } as MessageEvent<Publication>); }
}
describe('bounded runtime transport and synchronous escape hatch', () => {
  it('ignores wrong identities/revision/epoch, duplicate/out of order publications and impossible command acknowledgements', () => {
    const w = new FakeWorker(), updates: RuntimeState[] = [], c = runtimeController(s => updates.push(s), () => w);
    c.start(selfhold(), 1); const good = w.frame();
    for (const context of [{ ...good.context, epoch: 90 }, { ...good.context, document: 99 }, { ...good.context, revision: 99 }, { ...good.context, runId: 'old' }, { ...good.context, projectId: 'wrong' }]) w.emit({ ...good, context });
    w.emit({ ...good, sequence: 9 });
    w.emit({ ...good, runtime: { ...good.runtime!, revision: 999 } });
    w.emit({ ...good, runtime: { ...good.runtime!, runId: 'obsolete_g1' } });
    expect(updates).toHaveLength(1);
    w.emit(good); expect(updates).toHaveLength(2); w.emit(good); w.emit({ ...good, publication: 0 }); expect(updates).toHaveLength(2);
    c.command({ kind: 'pause' }); w.emit({ ...good, sequence: 2, publication: 2, mode: 'Paused' });
    w.emit({ ...good, sequence: 1, publication: 3 }); expect(updates.at(-1)?.mode).toBe('Paused');
    c.stop(); const count = updates.length; w.emit({ ...good, publication: 4 }); expect(updates).toHaveLength(count); expect(w.terminated).toBe(true);
  });
  it('keeps pending-intent acknowledgements even at unchanged physics publication', () => {
    const w = new FakeWorker(), updates: RuntimeState[] = [], c = runtimeController(s => updates.push(s), () => w);
    c.start(selfhold(), 0); const good = w.frame(); w.emit(good);
    c.command({ kind: 'pause' }); w.emit({ ...good, sequence: 2, publication: 2, mode: 'Paused' });
    c.command({ kind: 'input', instanceId: 'instance2', action: 'press' });
    w.emit({ ...good, sequence: 3, publication: 3, mode: 'Paused', runtime: { ...good.runtime!, pending: [{ atMs: 0, sequence: 1, actions: [{ instanceId: 'instance2', action: 'press', payload: {} }] }] } });
    expect(updates.at(-1)?.runtime?.pending).toHaveLength(1); c.stop(true); expect(updates.at(-1)?.runtime).toBeNull();
  });
  it('unresponsive worker faults honestly and Stop never awaits it; obsolete error callbacks cannot damage a restarted run', () => {
    vi.useFakeTimers(); const workers: FakeWorker[] = [], updates: RuntimeState[] = [];
    const c = runtimeController(s => updates.push(s), () => { const w = new FakeWorker(); workers.push(w); return w; });
    c.start(selfhold(), 0); vi.advanceTimersByTime(3001); expect(updates.at(-1)?.mode).toBe('Faulted'); expect(updates.at(-1)?.error).toContain('unresponsive');
    c.stop(); expect(updates.at(-1)?.mode).toBe('Editing'); c.start(selfhold(), 0);
    workers[0]!.onerror?.({} as ErrorEvent); expect(updates.at(-1)?.mode).toBe('Running'); c.stop(); vi.useRealTimers();
  });
  it('drains accepted edits before capture, fences every mutator, and preserves design/history/dirty across Stop/Reset', async () => {
    const w = new FakeWorker(), client = createLocalClient(selfhold(), undefined, () => w);
    const edit = client.dispatch({ kind: 'annotation', position: { x: 20, y: 20 }, text: 'accepted' }); const run = client.run();
    for (const intent of [{ kind: 'undo' }, { kind: 'redo' }, { kind: 'delete', ids: ['instance1'], policy: 'detach' }, { kind: 'annotation', position: { x: 30, y: 30 }, text: 'late' }] as const) expect((await client.dispatch(intent)).diagnostics[0]?.code).toBe('EDIT_LOCKED');
    await edit; await run;
    const before = client.getSnapshot(), bytes = client.inspect(); expect(w.sent[0]?.command.kind).toBe('start');
    if (w.sent[0]?.command.kind === 'start') expect(w.sent[0].command.project.sheets[0]?.annotations).toHaveLength(1);
    w.emit(w.frame({ runtime: null })); expect(client.getSnapshot().design).toBe(before.design);
    client.stop(); expect(client.getSnapshot().history).toEqual(before.history); expect(client.getSnapshot().dirty).toBe(true); expect(client.inspect()).toBe(bytes);
    client.stop(true); expect(client.getSnapshot().history).toEqual(before.history); expect((await client.dispatch({ kind: 'undo' })).ok).toBe(true);
  });
  it('bounds unacknowledged commands and does not enqueue unbounded work', () => {
    const w = new FakeWorker(), updates: RuntimeState[] = [], c = runtimeController(s => updates.push(s), () => w);
    c.start(selfhold(), 0); for (let n = 0; n < 1100; n++) c.command({ kind: 'input', instanceId: 'instance2', action: 'press' });
    expect(w.sent).toHaveLength(1024); expect(w.terminated).toBe(true); expect(updates.at(-1)?.error).toContain('pending limit'); c.stop();
  });
  it('Save can await a native picker while pause/release/Stop bypass file queue; replacement remains guarded', async () => {
    const w = new FakeWorker(), client = createLocalClient(selfhold(), undefined, () => w); await client.run();
    let finish!: () => void;
    const save = client.fileTransaction(async port => { expect(() => port.replace()).toThrow('Stop'); await new Promise<void>(r => finish = r); port.confirmSaved(); });
    await Promise.resolve(); client.control({ kind: 'pause' }); client.control({ kind: 'release' }); expect(w.sent.map(r => r.command.kind)).toEqual(['start', 'pause', 'release']);
    client.stop(); expect(client.getSnapshot().mode).toBe('Editing'); expect(w.terminated).toBe(true); finish(); await save;
    expect(client.getSnapshot().design).toEqual(selfhold()); expect(client.getSnapshot().dirty).toBe(false);
  });
});
