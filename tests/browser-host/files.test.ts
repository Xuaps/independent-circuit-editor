import { describe, expect, it, vi } from 'vitest';
import { createLocalClient, type FileTransaction } from '../../src/ui/editor/application';
import { canonical, readFile, safeName, writeConfirmed } from '../../src/hosts/browser/files';
import { RECOVERY_KEY, RecoveryStore } from '../../src/hosts/browser/recovery';
import { exportSvg } from '../../src/ui/export/design';
import { decodeProject } from '../../src/core/persistence';
import sample from '../../examples/p0/selfhold.circuit.json';
const project = () => { const r = decodeProject(JSON.stringify(sample)); if (!r.ok) throw Error('bad fixture'); return r.value; };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const edit = { kind: 'annotation' as const, position: { x: 100, y: 100 }, text: 'later' };
describe('browser host file transactions (native writes are adapter mocks)', () => {
  it('locks immediately, drains prior dispatches, rejects concurrent transactions and saves only locked content', async () => {
    const c = createLocalClient(), gate = deferred();
    const prior = c.dispatch(edit);
    const tx = c.fileTransaction(async p => { expect(p.design().sheets[0]!.annotations).toHaveLength(1); await gate.promise; p.confirmSaved(); });
    expect((await c.dispatch(edit)).diagnostics[0]?.code).toBe('FILE_BUSY');
    await expect(c.fileTransaction(async () => {})).rejects.toThrow('busy');
    await prior; gate.resolve(); await tx; expect(c.getSnapshot().dirty).toBe(false);
    await c.dispatch(edit); expect(c.getSnapshot().dirty).toBe(true);
    await c.dispatch({ kind: 'undo' }); expect(c.getSnapshot().dirty).toBe(false);
  });
  it('expired transaction capabilities cannot mark or replace a later document', async () => {
    const c = createLocalClient(); let captured!: FileTransaction;
    await c.fileTransaction(async port => { captured = port; expect(Object.keys(port).sort()).toEqual(['confirmSaved', 'design', 'replace']); expect(Object.isFrozen(port)).toBe(true); });
    await c.dispatch(edit); const before = c.getSnapshot();
    expect(() => captured.confirmSaved()).toThrow('Expired'); expect(() => captured.replace(project())).toThrow('Expired'); expect(() => captured.design()).toThrow('Expired'); expect(c.getSnapshot()).toBe(before);
  });
  it('failed read preserves design/history and releases lock; replacement resets history through checked session', async () => {
    const c = createLocalClient(); await c.dispatch(edit); const before = c.getSnapshot();
    await expect(c.fileTransaction(async () => { throw Error('read failed'); })).rejects.toThrow();
    expect(c.getSnapshot()).toBe(before);
    await expect(c.fileTransaction(async p => p.replace({ ...project(), runtime: {} } as never))).rejects.toThrow('Invalid replacement');
    expect(c.getSnapshot()).toBe(before);
    await c.fileTransaction(async p => p.replace(project())); expect(c.getSnapshot().history.undoCount).toBe(0);
    expect(c.getSnapshot().design).toEqual(project()); expect((await c.dispatch(edit)).ok).toBe(true);
  });
  it.each(['create', 'write', 'close'])('does not report confirmed success after %s failure', async phase => {
    const close = vi.fn(async () => { if (phase === 'close') throw Error('close'); }), abort = vi.fn(async () => {});
    const handle = { name: 'file', createWritable: async () => { if (phase === 'create') throw Error('create'); return { write: async () => { if (phase === 'write') throw Error('write'); }, close, abort }; } };
    await expect(writeConfirmed(handle, canonical(project()))).rejects.toThrow(phase);
    expect(abort).toHaveBeenCalledTimes(phase === 'create' ? 0 : 1);
  });
  it('confirms only after write then close', async () => { const calls: string[] = []; await writeConfirmed({ name: 'x', createWritable: async () => ({ write: async () => { calls.push('write'); }, close: async () => { calls.push('close'); } }) }, 'design'); expect(calls).toEqual(['write', 'close']); });
  it('bounds file bytes before reading and identifies by content not suffix', async () => {
    const arrayBuffer = vi.fn(); await expect(readFile({ size: 10485761, arrayBuffer } as unknown as File)).rejects.toThrow('RESOURCE_LIMIT'); expect(arrayBuffer).not.toHaveBeenCalled();
    const bytes = new TextEncoder().encode(canonical(project())); expect(await readFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer } as File)).toEqual(project());
  });
  it('sanitizes names without accepting paths', () => expect(safeName('../../<evil>')).toBe('_______evil_.circuit.json'));
});
describe('bounded versioned recovery (single synchronous record)', () => {
  const memory = () => { const map = new Map<string, string>([['unrelated', 'keep']]); return { map, store: new RecoveryStore({ getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); } }) }; };
  it('roundtrips design only, preserves unrelated keys, clears matching version only', () => { const { map, store } = memory(); store.write(project()); const changed = { ...project(), revision: project().revision + 1 }; store.clearMatching(changed); expect(store.read()).toEqual(project()); store.clearMatching(project()); expect(store.read()).toBeNull(); expect(map.get('unrelated')).toBe('keep'); });
  it.each(['{', '{"format":1,"format":2}', '{"__proto__":{}}', ' '.repeat(10485761), JSON.stringify({ ...sample, formatVersion: 2 })])('rejects corrupt/future/oversized/duplicate/prototype record', text => { const { map, store } = memory(); map.set(RECOVERY_KEY, text); expect(() => store.read()).toThrow('Recovery is corrupt'); expect(map.get(RECOVERY_KEY)).toBe(text); });
  it.each(['denied', 'quota'])('surfaces %s storage without pretending success', kind => { const store = new RecoveryStore({ getItem: () => { throw Error(kind); }, setItem: () => { throw Error(kind); }, removeItem: () => { throw Error(kind); } }); expect(() => store.read()).toThrow(kind); expect(() => store.write(project())).toThrow(kind); expect(() => store.discard()).toThrow(kind); });
  it('retains graph identity and rejects runtime fields', () => { const { store } = memory(); store.write(project()); expect(store.read()).toEqual(project()); expect(() => store.write({ ...project(), runtime: {} } as never)).toThrow(); });
});
it('standalone design SVG escapes hostile labels, contains no app/remote/runtime overlays', () => { const p = project(), s = p.sheets[0]!; const svg = exportSvg({ ...p, sheets: [{ ...s, annotations: [{ id: 'hostile', position: { x: 10, y: 10 }, text: '<script>alert("x")</script>&' }] }] }); expect(svg).toContain('&lt;script&gt;'); expect(svg).not.toMatch(/<script|foreignObject|https?:\/\/(?!www.w3.org\/2000\/svg)|onload=|selected|data-port/); expect(svg).toContain('font-family="sans-serif"'); });
