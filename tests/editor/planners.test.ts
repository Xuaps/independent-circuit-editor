import { expect, it } from 'vitest';
import { applyOperations } from '../../src/core/commands';
import { createEditor } from '../../src/core/editor';
import { planCopy, planDelete, planDetach, planJoin, planSplit, planTransforms } from '../../src/core/editor/planners';
import { portPosition } from '../../src/core/domain/geometry';
import { runReadiness } from '../../src/core/domain/project';
import { value, sample, empty, edit } from '../commands/helpers';
const wired = () => value(edit(empty(), [{ op: 'wire.add', sheetId: 'sheet', wire: { id: 'w', from: { kind: 'dangling', position: { x: 0, y: 0 } }, to: { kind: 'dangling', position: { x: 100, y: 0 } }, waypoints: [] } }])).project;
it('move/rotate/mirror preserves stable topology, routes incident wires and is one undo unit', () => {
  const original = sample(), editor = value(createEditor(original)), i = original.sheets[0]!.instances[0]!;
  for (const rotation of [0, 90, 180, 270] as const) for (const mirrorX of [false, true]) {
    const transform = { position: { x: i.transform.position.x + 100, y: i.transform.position.y + 50 }, rotation, mirrorX };
    const planned = value(planTransforms(editor.snapshot(), { [i.id]: transform })); value(editor.apply(planned));
    expect(editor.snapshot().sheets[0]!.wires.map(w => [w.id, w.from, w.to])).toEqual(original.sheets[0]!.wires.map(w => [w.id, w.from, w.to]));
    expect(editor.snapshot().sheets[0]!.instances.find(x => x.id === i.id)!.transform).toEqual(transform); value(editor.undo());
  }
  expect(editor.history().undoCount).toBe(0); expect(editor.dirty()).toBe(false);
  expect(planTransforms(original, { missing: i.transform }).ok).toBe(false);
  expect(planTransforms(original, { [i.id]: { ...i.transform, position: { x: 1000000, y: 1000000 } } }).ok).toBe(false);
});
it('copy remaps internal controllers/observers, detaches external wire ends and preserves originals', () => {
  const p = sample(), s = p.sheets[0]!, coil = s.instances.find(i => i.definition.id === 'core.relay.coil')!, contact = s.instances.find(i => i.definition.id === 'core.relay.contact.no')!, w = s.wires.find(w => w.from.kind === 'port' || w.to.kind === 'port')!;
  const chosen = [coil.id, contact.id, w.id], ids = { [coil.id]: 'copy_coil', [contact.id]: 'copy_contact', [w.id]: 'copy_wire', [coil.deviceId!]: 'copy_device' };
  const batch = value(planCopy(p, chosen, { ids, deviceNames: { [coil.deviceId!]: 'K_COPY' }, offset: { x: 300, y: 300 } }));
  const result = value(applyOperations(p, batch)).project, sheet = result.sheets[0]!;
  expect(sheet.instances.find(i => i.id === 'copy_coil')!.deviceId).toBe('copy_device'); expect(sheet.instances.find(i => i.id === 'copy_contact')!.deviceId).toBe('copy_device');
  expect(sheet.wires.find(w => w.id === 'copy_wire')![w.from.kind === 'port' && chosen.includes(w.from.instanceId) ? 'to' : 'from'].kind).toBe('dangling');
  expect(p.devices.some(d => d.id === 'copy_device')).toBe(false);
  const external = value(planCopy(p, [contact.id], { ids: { [contact.id]: 'unbound' }, deviceNames: {}, offset: { x: 300, y: 0 } }));
  expect(value(applyOperations(p, external)).project.sheets[0]!.instances.find(i => i.id === 'unbound')!.deviceId).toBeNull();
  expect(planCopy(p, chosen, { ids, deviceNames: { [coil.deviceId!]: p.devices[0]!.name.toLowerCase() }, offset: { x: 300, y: 300 } }).ok).toBe(false);
  expect(planCopy(p, chosen, { ids: {}, deviceNames: {}, offset: { x: 1, y: 1 } }).ok).toBe(false);
  expect(planCopy(p, [contact.id], { ids: { [contact.id]: coil.id }, deviceNames: {}, offset: { x: 1, y: 1 } }).ok).toBe(false);
});
it('explicit split/join/detach affects named topology, not coincident unrelated crossings', () => {
  const p = value(edit(wired(), [{ op: 'wire.add', sheetId: 'sheet', wire: { id: 'cross', from: { kind: 'dangling', position: { x: 50, y: -50 } }, to: { kind: 'dangling', position: { x: 50, y: 50 } }, waypoints: [] } }])).project;
  const split = value(applyOperations(p, value(planSplit(p, 'w', { x: 50, y: 0 }, 'j', 'tail')))).project;
  expect(split.sheets[0]!.wires.find(w => w.id === 'cross')).toEqual(p.sheets[0]!.wires.find(w => w.id === 'cross'));
  expect(split.sheets[0]!.wires.find(w => w.id === 'w')!.to).toEqual({ kind: 'junction', junctionId: 'j' });
  const joined = value(applyOperations(split, value(planJoin(split, 'cross', 'to', { kind: 'junction', junctionId: 'j' })))).project;
  const detached = value(applyOperations(joined, value(planDetach(joined, 'cross', 'to')))).project;
  expect(detached.sheets[0]!.wires.find(w => w.id === 'cross')!.to).toEqual({ kind: 'dangling', position: { x: 50, y: 0 } });
  for (const point of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 1 }]) expect(planSplit(p, 'w', point, 'j', 'tail').ok).toBe(false);
  expect(planSplit(p, 'w', { x: 50, y: 0 }, 'j', 'w').ok).toBe(false);
  expect(planJoin(p, 'w', 'to', { kind: 'dangling', position: { x: 0, y: 0 } }).ok).toBe(false);
});
it('copies selected junction/wire topology in a single undo transaction with explicit names and ID collisions rejected', () => {
  const p = value(applyOperations(wired(), value(planSplit(wired(), 'w', { x: 50, y: 0 }, 'j', 'tail')))).project;
  const editor = value(createEditor(p));
  const batch = value(planCopy(p, ['j', 'tail'], { ids: { j: 'copy_j', tail: 'copy_tail' }, deviceNames: {}, offset: { x: 0, y: 100 } }));
  value(editor.apply(batch)); expect(editor.history().undoCount).toBe(1);
  const copied = editor.snapshot().sheets[0]!.wires.find(w => w.id === 'copy_tail')!;
  expect(copied.from).toEqual({ kind: 'junction', junctionId: 'copy_j' }); expect(copied.to).toEqual({ kind: 'dangling', position: { x: 100, y: 100 } });
  value(editor.undo()); expect(editor.snapshot().sheets[0]!.wires).toEqual(p.sheets[0]!.wires); value(editor.redo()); expect(editor.snapshot().sheets[0]!.wires.find(w => w.id === 'copy_tail')).toEqual(copied);
});
it('splits exactly at a bend without zero-length segments', () => {
  const p = value(edit(empty(), [{ op: 'wire.add', sheetId: 'sheet', wire: { id: 'w', from: { kind: 'dangling', position: { x: 0, y: 0 } }, to: { kind: 'dangling', position: { x: 100, y: 100 } }, waypoints: [{ x: 100, y: 0 }] } }])).project;
  expect(planSplit(p, 'w', { x: 100, y: 0 }, 'j', 'tail').ok).toBe(true);
});
it('confirmed deletion emits explicit detach/remove policies and unbinds removed devices', () => {
  const p = sample(), s = p.sheets[0]!, coil = s.instances.find(i => i.definition.id === 'core.relay.coil')!, incident = s.wires.filter(w => [w.from, w.to].some(e => e.kind === 'port' && e.instanceId === coil.id));
  for (const policy of ['detach', 'remove-wires'] as const) {
    const result = value(applyOperations(p, value(planDelete(p, [coil.id], policy)))).project;
    expect(result.sheets[0]!.instances.some(i => i.id === coil.id)).toBe(false);
    for (const w of incident) { const after = result.sheets[0]!.wires.find(x => x.id === w.id); if (policy === 'remove-wires') expect(after).toBeUndefined(); else { expect(after).toBeDefined(); for (const side of ['from', 'to'] as const) if (w[side].kind === 'port' && w[side].instanceId === coil.id) expect(after![side]).toEqual({ kind: 'dangling', position: portPosition(coil, w[side].portId) }); } }
    expect(runReadiness(result).some(d => d.code === 'MISSING_CONTROLLER')).toBe(true);
  }
  const deleted = value(applyOperations(p, value(planDelete(p, [coil.deviceId!], 'detach')))).project;
  expect(deleted.sheets[0]!.instances.filter(i => i.deviceId === coil.deviceId)).toEqual([]);
  expect(planDelete(p, ['missing'], 'detach').ok).toBe(false);
});
