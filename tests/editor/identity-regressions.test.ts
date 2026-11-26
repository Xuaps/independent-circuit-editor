import { expect, it } from 'vitest';
import { planRelocateJunctions } from '../../src/core/editor/relocation';
import { planCopy, planTransforms } from '../../src/core/editor/planners';
import { createEditor } from '../../src/core/editor';
import { type Transform } from '../../src/core/domain/types';
import { semanticDesignKey } from '../../src/core/persistence';
import { value, empty, sample, edit } from '../commands/helpers';

function fixture(id: string) {
  const template = sample().sheets[0]!.instances.find(i => i.definition.id === 'core.lamp')!;
  return value(edit(empty(), [
    { op: 'instance.place', sheetId: 'sheet', instance: { ...template, id, deviceId: null, transform: { position: { x: 100, y: 100 }, rotation: 0, mirrorX: false } } },
    { op: 'instance.place', sheetId: 'sheet', instance: { ...template, id: 'unrelated', deviceId: null, transform: { position: { x: 300, y: 300 }, rotation: 0, mirrorX: false } } },
    { op: 'junction.create', sheetId: 'sheet', junction: { id: 'j', position: { x: 0, y: 100 } } },
    { op: 'wire.add', sheetId: 'sheet', wire: { id: 'w', from: { kind: 'junction', junctionId: 'j' }, to: { kind: 'port', instanceId: id, portId: 'p1' }, waypoints: [] } }
  ])).project;
}
it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])('relocates incident supported ID %s with omitted/empty/unrelated/own maps and monotonic undo/redo', id => {
  const p = fixture(id), replacements = { j: { id: 'fresh', position: { x: 0, y: 150 } } };
  const transform: Transform = { position: { x: 150, y: 200 }, rotation: 90, mirrorX: true };
  for (const transforms of [undefined, {}, { unrelated: transform }, { [id]: transform }]) {
    const editor = value(createEditor(p)), plan = value(planRelocateJunctions(p, replacements, transforms));
    const moved = value(editor.apply(plan.batch)).project;
    expect(moved.sheets[0]!.instances.find(i => i.id === id)!.transform).toEqual(transforms && Object.hasOwn(transforms, id) ? transform : p.sheets[0]!.instances[0]!.transform);
    expect(moved.sheets[0]!.wires[0]!.to).toEqual({ kind: 'port', instanceId: id, portId: 'p1' });
    expect(plan.junctionMapping).toEqual({ j: 'fresh' });
    value(editor.undo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(value(semanticDesignKey(p)));
    value(editor.redo()); expect(value(semanticDesignKey(editor.snapshot()))).toBe(value(semanticDesignKey(moved)));
    expect(editor.snapshot().revision).toBe(p.revision + 3);
  }
});
it('rejects malformed JSON-data transforms and replacements before geometry without publishing', () => {
  const p = fixture('constructor'), editor = value(createEditor(p));
  for (const bad of [null, {}, { position: null, rotation: 0, mirrorX: false }, { position: { x: 0, y: 0 }, rotation: 45, mirrorX: false }]) {
    const transforms = { constructor: bad } as unknown as Record<string, Transform>;
    expect(planTransforms(p, transforms).ok).toBe(false);
    expect(planRelocateJunctions(p, { j: { id: 'fresh', position: { x: 0, y: 150 } } }, transforms).ok).toBe(false);
  }
  expect(planRelocateJunctions(p, { j: null } as never).ok).toBe(false);
  expect(planRelocateJunctions(p, { j: { id: 'fresh', position: null } } as never).ok).toBe(false);
  expect(editor.snapshot()).toEqual(p); expect(editor.history().undoCount).toBe(0); expect(editor.dirty()).toBe(false);
});
it('copy mappings never accept inherited ID or device-name entries', () => {
  const p = fixture('constructor');
  const missing = planCopy(p, ['constructor'], { ids: {}, deviceNames: {}, offset: { x: 0, y: 100 } });
  expect(missing.ok).toBe(false); if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe('MISSING_COPY_ID');
  const s = sample(), supply = s.sheets[0]!.instances.find(i => i.definition.id === 'core.dc.supply')!;
  const renamed = { ...s, devices: s.devices.map(d => d.id === supply.deviceId ? { ...d, id: 'constructor' } : d), sheets: s.sheets.map(sheet => ({ ...sheet, instances: sheet.instances.map(i => i.deviceId === supply.deviceId ? { ...i, deviceId: 'constructor' } : i) })) };
  const result = planCopy(renamed, [supply.id], { ids: { [supply.id]: 'copy', constructor: 'copy_device' }, deviceNames: {}, offset: { x: 0, y: 100 } });
  expect(result.ok).toBe(false); if (!result.ok) expect(result.diagnostics[0]!.code).toBe('MISSING_COPY_DEVICE');
});
