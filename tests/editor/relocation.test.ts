import { expect, it } from 'vitest';
import { planRelocateJunctions } from '../../src/core/editor/relocation';
import { createEditor } from '../../src/core/editor';
import { value, empty, edit } from '../commands/helpers';
import { serializeProject, semanticDesignKey } from '../../src/core/persistence';
function branched() {
  return value(edit(empty(), [
    { op: 'junction.create', sheetId: 'sheet', junction: { id: 'a', position: { x: 0, y: 0 } } },
    { op: 'junction.create', sheetId: 'sheet', junction: { id: 'b', position: { x: 100, y: 0 } } },
    { op: 'junction.create', sheetId: 'sheet', junction: { id: 'coincident', position: { x: 50, y: 50 } } },
    { op: 'wire.add', sheetId: 'sheet', wire: { id: 'ab', from: { kind: 'junction', junctionId: 'a' }, to: { kind: 'junction', junctionId: 'b' }, waypoints: [] } },
    { op: 'wire.add', sheetId: 'sheet', wire: { id: 'left', from: { kind: 'dangling', position: { x: -100, y: 0 } }, to: { kind: 'junction', junctionId: 'a' }, waypoints: [] } },
    { op: 'wire.add', sheetId: 'sheet', wire: { id: 'down', from: { kind: 'junction', junctionId: 'a' }, to: { kind: 'dangling', position: { x: 0, y: 100 } }, waypoints: [] } }
  ])).project;
}
it('explicit relocation remaps every multi-branch endpoint and both sides, without coordinate merges; undo/redo stable mapping', () => {
  const p = branched(), editor = value(createEditor(p));
  const planned = value(planRelocateJunctions(p, { a: { id: 'new_a', position: { x: 50, y: 50 } }, b: { id: 'new_b', position: { x: 150, y: 50 } } }));
  expect(planned.junctionMapping).toEqual({ a: 'new_a', b: 'new_b' }); expect(Object.isFrozen(planned.junctionMapping)).toBe(true);
  value(editor.apply(planned.batch)); const moved = editor.snapshot(), sheet = moved.sheets[0]!;
  expect(sheet.junctions.map(j => j.id).sort()).toEqual(['coincident', 'new_a', 'new_b']);
  expect(sheet.wires.find(w => w.id === 'ab')!.from).toEqual({ kind: 'junction', junctionId: 'new_a' });
  expect(sheet.wires.find(w => w.id === 'ab')!.to).toEqual({ kind: 'junction', junctionId: 'new_b' });
  expect(sheet.wires.find(w => w.id === 'left')!.to).toEqual({ kind: 'junction', junctionId: 'new_a' });
  expect(sheet.wires.find(w => w.id === 'down')!.from).toEqual({ kind: 'junction', junctionId: 'new_a' });
  expect(editor.history().undoCount).toBe(1); value(editor.undo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(value(semanticDesignKey(p)));
  value(editor.redo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(value(semanticDesignKey(moved))); expect(editor.snapshot().revision).toBe(p.revision + 3);
});
it('missing/colliding/bounds/degenerate/unsupported relocation previews never mutate history or dirty', () => {
  const p = branched(), editor = value(createEditor(p)), before = JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()]);
  for (const replacements of [
    { a: { id: '', position: { x: 10, y: 10 } } },
    { missing: { id: 'fresh', position: { x: 10, y: 10 } } },
    { a: { id: 'b', position: { x: 10, y: 10 } } },
    { a: { id: 'a', position: { x: 10, y: 10 } } },
    { a: { id: 'fresh', position: { x: 1000001, y: 10 } } },
    { a: { id: 'fresh', position: { x: 100, y: 0 } } }
  ]) expect(planRelocateJunctions(p, replacements).ok).toBe(false);
  expect(JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()])).toBe(before);
});
it('compound relocation respects byte/count limits and fails before any eviction', () => {
  const p = branched(), size = new TextEncoder().encode(value(serializeProject(p))).byteLength;
  const editor = value(createEditor(p, { bytes: size * 2, count: 1 }));
  const batch = value(planRelocateJunctions(p, { a: { id: 'long_replacement_id', position: { x: 50, y: 50 } } })).batch;
  expect(editor.apply(batch).ok).toBe(false); expect(editor.history()).toEqual({ undoCount: 0, redoCount: 0, retainedBytes: 0, trimmed: 0 });
  expect(editor.snapshot()).toEqual(p); expect(editor.dirty()).toBe(false);
});
