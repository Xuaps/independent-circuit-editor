import { expect, it } from 'vitest';
import fc from 'fast-check';
import { createEditor } from '../../src/core/editor';
import { operationsFor } from '../../src/core/commands';
import { defaultDevice } from '../../src/core/catalog';
import { semanticDesignKey, serializeProject } from '../../src/core/persistence';
import { empty, value } from '../commands/helpers';
it('dry-run is isolated, one batch is one undo unit, dirty ignores monotonic revision', () => {
  const editor = value(createEditor(empty()));
  const batch = operationsFor(editor.snapshot(), [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }, { op: 'device.rename', deviceId: 'd', name: 'K2' }]);
  const dry = value(editor.dryRun(batch)); expect(dry.project.revision).toBe(1); expect(editor.snapshot().revision).toBe(0); expect(editor.history().undoCount).toBe(0); expect(editor.dirty()).toBe(false);
  expect(Object.isFrozen(dry.project.devices[0])).toBe(true); value(editor.apply(batch)); expect(editor.history().undoCount).toBe(1); expect(editor.dirty()).toBe(true);
  value(editor.undo()); expect(editor.snapshot().revision).toBe(2); expect(editor.dirty()).toBe(false);
  value(editor.redo()); expect(editor.snapshot().revision).toBe(3); expect(editor.snapshot().devices[0]!.name).toBe('K2'); editor.markSaved(); expect(editor.dirty()).toBe(false);
  value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'device.rename', deviceId: 'd', name: 'K2' }]))); expect(editor.snapshot().revision).toBe(4); expect(editor.dirty()).toBe(false);
});
it('failed edit/dry-run preserve redo, saved marker, history and snapshots; successful branch clears redo', () => {
  const editor = value(createEditor(empty())); value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }]))); value(editor.undo());
  const before = JSON.stringify({ project: editor.snapshot(), history: editor.history(), dirty: editor.dirty() });
  const bad = operationsFor(editor.snapshot(), [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }, { op: 'device.remove', deviceId: 'missing' }]);
  expect(editor.apply(bad).ok).toBe(false); expect(editor.dryRun(bad).ok).toBe(false); expect(editor.undo().ok).toBe(false);
  expect(JSON.stringify({ project: editor.snapshot(), history: editor.history(), dirty: editor.dirty() })).toBe(before);
  value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'device.create', device: defaultDevice('new', 'K2', 'relay') }]))); expect(editor.history().redoCount).toBe(0); expect(editor.redo().ok).toBe(false);
});
it('does not leak mutable input, results or history views', () => {
  const original = structuredClone(empty()), editor = value(createEditor(original)); (original as unknown as { title: string }).title = 'outside';
  const device = structuredClone(defaultDevice('d', 'K1', 'relay')); const batch = structuredClone(operationsFor(editor.snapshot(), [{ op: 'device.create', device }]));
  const result = value(editor.apply(batch)); (batch.operations as unknown as { device: { name: string } }[])[0]!.device.name = 'outside';
  expect(() => { (result.project.devices[0] as unknown as { name: string }).name = 'outside'; }).toThrow();
  expect(() => { (editor.history() as unknown as { undoCount: number }).undoCount = 100; }).toThrow();
  value(editor.undo()); value(editor.redo()); expect(editor.snapshot().devices[0]!.name).toBe('K1'); expect(editor.snapshot().title).toBe('');
});
it('trims count only after successful commits and exposes accounting', () => {
  const editor = value(createEditor(empty()));
  for (let n = 0; n < 101; n++) value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'page.replace', sheetId: 'sheet', page: { width: 1000 + n, height: 800, unit: 'du' } }])));
  expect(editor.history().undoCount).toBe(100); expect(editor.history().trimmed).toBe(1); expect(editor.history().retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  for (let n = 0; n < 100; n++) value(editor.undo()); expect(editor.undo().ok).toBe(false); expect(editor.history().redoCount).toBe(100);
});
it('honors exact retained byte boundary and rejects oversized transactions without eviction', () => {
  const p = empty(), size = new TextEncoder().encode(value(serializeProject(p))).length;
  // No-op revision has the same encoded length at 0..9.
  const editor = value(createEditor(p, { bytes: size * 2 }));
  const batch = () => operationsFor(editor.snapshot(), [{ op: 'page.replace', sheetId: 'sheet', page: p.sheets[0]!.page }]);
  value(editor.apply(batch())); expect(editor.history().retainedBytes).toBe(size * 2);
  value(editor.apply(batch())); expect(editor.history().trimmed).toBe(1); expect(editor.history().undoCount).toBe(1);
  const before = JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()]);
  expect(editor.apply(operationsFor(editor.snapshot(), [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }])).ok).toBe(false);
  expect(JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()])).toBe(before);
  const tooSmall = value(createEditor(p, { bytes: size * 2 - 1 })); expect(tooSmall.apply(operationsFor(p, [{ op: 'page.replace', sheetId: 'sheet', page: p.sheets[0]!.page }])).ok).toBe(false); expect(tooSmall.history().undoCount).toBe(0);
});
it('rejects invalid history limits and overflow travel without changing stacks', () => {
  for (const lower of [{ count: 101 }, { count: 0 }, { bytes: 32 * 1024 * 1024 + 1 }, { bytes: NaN }]) expect(createEditor(empty(), lower).ok).toBe(false);
  const editor = value(createEditor({ ...empty(), revision: Number.MAX_SAFE_INTEGER - 1 })); value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'page.replace', sheetId: 'sheet', page: empty().sheets[0]!.page }])));
  const before = JSON.stringify([editor.snapshot(), editor.history()]); expect(editor.undo().ok).toBe(false); expect(JSON.stringify([editor.snapshot(), editor.history()])).toBe(before);
});
it('seed20261116/200: changed histories undo/redo/replay inverse laws with monotonic revisions', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 20 }), widths => {
    const editor = value(createEditor(empty())), states = [value(semanticDesignKey(editor.snapshot()))]; let revision = 0;
    for (const width of widths) { value(editor.apply(operationsFor(editor.snapshot(), [{ op: 'page.replace', sheetId: 'sheet', page: { width: width + 1000, height: 800, unit: 'du' } }]))); states.push(value(semanticDesignKey(editor.snapshot()))); expect(editor.snapshot().revision).toBe(++revision); }
    for (let n = widths.length - 1; n >= 0; n--) { value(editor.undo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(states[n]); expect(editor.snapshot().revision).toBe(++revision); }
    for (let n = 1; n <= widths.length; n++) { value(editor.redo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(states[n]); expect(editor.snapshot().revision).toBe(++revision); }
    const replay = value(createEditor(empty())); for (const width of widths) value(replay.apply(operationsFor(replay.snapshot(), [{ op: 'page.replace', sheetId: 'sheet', page: { width: width + 1000, height: 800, unit: 'du' } }])));
    expect(value(semanticDesignKey(replay.snapshot()))).toBe(states.at(-1));
  }), { seed: 20261116, numRuns: 200 });
});
