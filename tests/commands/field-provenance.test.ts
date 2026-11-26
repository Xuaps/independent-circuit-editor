import { expect, it } from 'vitest';
import { type Operation, type Project } from '../../src/core/domain/types';
import { operationsFor } from '../../src/core/commands';
import { createEditor } from '../../src/core/editor';
import { edit, sample, value } from './helpers';

/** Exercise rejection with a populated redo stack, not only stateless apply. */
function rejected(p: Project, ops: Operation[], code: string, index: number | undefined) {
  const s = p.sheets[0]!, editor = value(createEditor(p));
  value(editor.apply(operationsFor(p, [{ op: 'page.replace', sheetId: s.id, page: { ...s.page, width: s.page.width + 1 } }])));
  value(editor.undo());
  const before = JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()]);
  for (const result of [edit(p, ops), editor.apply(operationsFor(editor.snapshot(), ops)), editor.dryRun(operationsFor(editor.snapshot(), ops))]) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.diagnostics.filter(d => d.code === code);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map(d => d.operationIndex)).toEqual(errors.map(() => index));
    }
  }
  expect(JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()])).toBe(before);
}
it.each(['bad binding', 'deleted device', 'missing binding'])('%s is not overwritten by presentation/no-op binding', mode => {
  const p = sample(), i = p.sheets[0]!.instances.find(i => i.id === 'instance_supply')!;
  const deviceId = mode === 'bad binding' ? 'device_relay' : mode === 'missing binding' ? 'missing_device' : i.deviceId;
  const bad: Operation = mode === 'deleted device' ? { op: 'device.remove', deviceId: i.deviceId! } : { op: 'instance.bind', instanceId: i.id, deviceId };
  rejected(p, [bad, { op: 'instance.presentation.replace', instanceId: i.id, label: 'new label', markings: i.markings }, { op: 'instance.bind', instanceId: i.id, deviceId }], mode === 'bad binding' ? 'INCOMPATIBLE_DEVICE' : 'MISSING_DEVICE', 0);
});
it.each(['instance', 'junction', 'port'] as const)('missing %s endpoint is not overwritten by waypoints, other endpoint or presentation', kind => {
  const p = sample(), s = p.sheets[0]!, w = s.wires[0]!, i = s.instances[0]!;
  const from = kind === 'junction' ? { kind: 'junction' as const, junctionId: 'absent' } : { kind: 'port' as const, instanceId: kind === 'instance' ? 'absent' : i.id, portId: 'absent' };
  rejected(p, [
    { op: 'wire.replace', wireId: w.id, from, to: w.to, waypoints: w.waypoints },
    { op: 'wire.replace', wireId: w.id, from, to: { kind: 'dangling', position: { x: 20, y: 30 } }, waypoints: [{ x: 7, y: 8 }] },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'irrelevant', markings: i.markings }
  ], kind === 'port' ? 'MISSING_PORT' : kind === 'instance' ? 'MISSING_INSTANCE' : 'MISSING_JUNCTION', 0);
});
it.each(['instance', 'junction'] as const)('deleting referenced %s keeps deletion provenance despite wire waypoint edit', kind => {
  const p = sample(), s = p.sheets[0]!, i = s.instances[0]!, junction = s.junctions[0]!;
  const target = kind === 'instance' ? i.id : junction.id;
  const w = s.wires.find(w => [w.from, w.to].some(e => kind === 'instance' ? e.kind === 'port' && e.instanceId === target : e.kind === 'junction' && e.junctionId === target))!;
  rejected(p, [
    kind === 'instance' ? { op: 'instance.remove', instanceId: target } : { op: 'junction.remove', junctionId: target },
    { op: 'wire.replace', wireId: w.id, from: w.from, to: w.to, waypoints: [{ x: 12, y: 13 }] }
  ], kind === 'instance' ? 'MISSING_INSTANCE' : 'MISSING_JUNCTION', 0);
});
it('terminal key provenance survives label/value/valid-key edits and reordered no-ops', () => {
  const p = sample(), i = p.sheets[0]!.instances[0]!;
  const markings = { ...i.markings, terminalLabels: { ...i.markings.terminalLabels, absent: 'bad' } };
  rejected(p, [
    { op: 'instance.presentation.replace', instanceId: i.id, label: i.label, markings },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'new label', markings: { ...markings, terminalLabels: { ...markings.terminalLabels, absent: 'other value' } } },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'new label', markings: { ...markings, terminalLabels: Object.fromEntries(Object.entries(markings.terminalLabels).reverse()) } }
  ], 'UNKNOWN_TERMINAL_LABEL', 0);
});
it('multiple bad terminal keys with different causes omit ambiguous index', () => {
  const p = sample(), i = p.sheets[0]!.instances[0]!;
  rejected(p, [
    { op: 'instance.presentation.replace', instanceId: i.id, label: i.label, markings: { ...i.markings, terminalLabels: { absent: 'a' } } },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'changed', markings: { ...i.markings, terminalLabels: { absent: 'a', another: 'b' } } }
  ], 'UNKNOWN_TERMINAL_LABEL', undefined);
});
it('bad owning parameters survive rename, presentation and key-reordered parameter no-op', () => {
  const p = sample(), i = p.sheets[0]!.instances.find(i => i.id === 'instance_supply')!;
  const parameters = { unexpected: 2, volts: 24 };
  rejected(p, [
    { op: 'device.parameters.replace', deviceId: i.deviceId!, parameters },
    { op: 'device.rename', deviceId: i.deviceId!, name: 'renamed' },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'new label', markings: i.markings },
    { op: 'device.parameters.replace', deviceId: i.deviceId!, parameters: { volts: 24, unexpected: 2 } }
  ], 'INVALID_SHAPE', 0);
});
it('changed already-invalid generic parameter record conservatively omits cause', () => {
  const p = sample();
  rejected(p, [
    { op: 'device.parameters.replace', deviceId: 'device_supply', parameters: { invalid: 1 } },
    { op: 'device.parameters.replace', deviceId: 'device_supply', parameters: { invalid: 1, another: 2 } }
  ], 'INVALID_SHAPE', undefined);
});
it('duplicate normalized name survives case-only rename/no-op and unrelated edits', () => {
  const p = sample(), s = p.sheets[0]!, i = s.instances[0]!, name = p.devices.find(d => d.id === 'device_relay')!.name;
  rejected(p, [
    { op: 'device.rename', deviceId: 'device_supply', name },
    { op: 'device.rename', deviceId: 'device_supply', name: name.toLowerCase() },
    { op: 'device.rename', deviceId: 'device_supply', name: name.toLowerCase() },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'new label', markings: i.markings },
    { op: 'device.rename', deviceId: 'device_lamp', name: 'unrelated' }
  ], 'DUPLICATE_DEVICE_NAME', 0);
});
it('unknown immutable definition belongs to placement, not presentation', () => {
  const p = sample(), s = p.sheets[0]!, i = s.instances[0]!;
  const instance = { ...i, id: 'unknown_definition', definition: { id: 'core.unknown', version: 1 as const }, deviceId: null };
  rejected(p, [
    { op: 'instance.place', sheetId: s.id, instance },
    { op: 'instance.presentation.replace', instanceId: instance.id, label: 'new label', markings: instance.markings }
  ], 'UNKNOWN_DEFINITION', 0);
});
it('multiple missing ports on one instance with different endpoint causes omit ambiguous index', () => {
  const p = sample(), s = p.sheets[0]!, w = s.wires[0]!, i = s.instances[0]!;
  const from = { kind: 'port' as const, instanceId: i.id, portId: 'absent' };
  rejected(p, [
    { op: 'wire.replace', wireId: w.id, from, to: w.to, waypoints: [] },
    { op: 'wire.replace', wireId: w.id, from, to: { ...from, portId: 'another' }, waypoints: [] }
  ], 'MISSING_PORT', undefined);
});
it('reference, label, parameter and name repairs remain valid in final candidate', () => {
  const p = sample(), s = p.sheets[0]!, i = s.instances.find(i => i.id === 'instance_supply')!, d = p.devices.find(d => d.id === i.deviceId)!;
  const result = value(edit(p, [
    { op: 'instance.bind', instanceId: i.id, deviceId: 'absent' }, { op: 'instance.bind', instanceId: i.id, deviceId: i.deviceId },
    { op: 'instance.presentation.replace', instanceId: i.id, label: i.label, markings: { ...i.markings, terminalLabels: { absent: 'bad' } } },
    { op: 'instance.presentation.replace', instanceId: i.id, label: i.label, markings: i.markings },
    { op: 'device.parameters.replace', deviceId: d.id, parameters: { bad: true } }, { op: 'device.parameters.replace', deviceId: d.id, parameters: d.parameters },
    { op: 'device.rename', deviceId: d.id, name: p.devices.find(d => d.id === 'device_relay')!.name }, { op: 'device.rename', deviceId: d.id, name: d.name }
  ]));
  expect(result.project.revision).toBe(p.revision + 1);
});
it.each(['binding', 'wire'] as const)('invalid reference at %s creation survives unrelated presentation', kind => {
  const p = sample(), s = p.sheets[0]!, i = s.instances[0]!;
  const ops: Operation[] = kind === 'binding' ? [
    { op: 'instance.place', sheetId: s.id, instance: { ...i, id: 'placed', deviceId: 'absent' } },
    { op: 'instance.presentation.replace', instanceId: 'placed', label: 'changed', markings: i.markings }
  ] : [
    { op: 'wire.add', sheetId: s.id, wire: { id: 'added', from: { kind: 'port', instanceId: 'absent', portId: 'p' }, to: { kind: 'dangling', position: { x: 0, y: 0 } }, waypoints: [] } },
    { op: 'wire.replace', wireId: 'added', from: { kind: 'port', instanceId: 'absent', portId: 'p' }, to: { kind: 'dangling', position: { x: 2, y: 3 } }, waypoints: [] }
  ];
  rejected(p, ops, kind === 'binding' ? 'MISSING_DEVICE' : 'MISSING_INSTANCE', 0);
});
it('derived bounds follow actual geometry, never subsequent presentation or transform no-op', () => {
  const p = sample(), i = p.sheets[0]!.instances[0]!;
  const transform = { ...i.transform, position: { x: 1000000, y: 1000000 } };
  rejected(p, [
    { op: 'instance.transform', instanceId: i.id, transform },
    { op: 'instance.presentation.replace', instanceId: i.id, label: 'changed', markings: i.markings },
    { op: 'instance.transform', instanceId: i.id, transform }
  ], 'COORDINATE_BOUNDS', 0);
});
it('a later genuinely changed endpoint has its own useful provenance', () => {
  const p = sample(), s = p.sheets[0]!, w = s.wires[0]!;
  rejected(p, [
    { op: 'wire.replace', wireId: w.id, from: { kind: 'junction', junctionId: 'absent' }, to: w.to, waypoints: [] },
    { op: 'wire.replace', wireId: w.id, from: { kind: 'junction', junctionId: 'different' }, to: w.to, waypoints: [] }
  ], 'MISSING_JUNCTION', 1);
});
