import { expect, it } from 'vitest';
import { type Operation } from '../../src/core/domain/types';
import { createEditor } from '../../src/core/editor';
import { operationsFor } from '../../src/core/commands';
import { value, sample, edit } from './helpers';

it.each(['transform-only', 'noop-wire', 'presentation-after', 'noop-transform-after'])('route responsibility follows actual referenced-port geometry: %s', mode => {
  const p = sample(), s = p.sheets[0]!, supply = s.instances.find(i => i.id === 'instance_supply')!, wire = s.wires.find(w => w.id === 'wire_supply_positive')!;
  const ops: Operation[] = [];
  if (mode !== 'transform-only') ops.push({ op: 'wire.replace', wireId: wire.id, from: wire.from, to: wire.to, waypoints: wire.waypoints });
  const responsible = ops.length;
  const moved = { ...supply.transform, position: { x: supply.transform.position.x + 1, y: supply.transform.position.y + 1 } };
  ops.push({ op: 'instance.transform', instanceId: supply.id, transform: moved });
  if (mode === 'presentation-after') ops.push({ op: 'instance.presentation.replace', instanceId: supply.id, label: 'new label', markings: supply.markings });
  if (mode === 'noop-transform-after') ops.push({ op: 'instance.transform', instanceId: supply.id, transform: moved });
  if (mode !== 'transform-only') ops.push({ op: 'page.replace', sheetId: s.id, page: s.page });
  const editor = value(createEditor(p));
  value(editor.apply(operationsFor(p, [{ op: 'page.replace', sheetId: s.id, page: { ...s.page, width: s.page.width + 1 } }]))); value(editor.undo());
  const before = JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()]);
  for (const result of [edit(p, ops), editor.apply(operationsFor(editor.snapshot(), ops)), editor.dryRun(operationsFor(editor.snapshot(), ops))]) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const routes = result.diagnostics.filter(d => d.code === 'INVALID_WIRE_ROUTE');
      expect(routes.map(d => d.objectIds[0]).sort()).toEqual(['wire_supply_positive', 'wire_supply_return']);
      expect(routes.every(d => d.operationIndex === responsible)).toBe(true);
    }
  }
  expect(JSON.stringify([editor.snapshot(), editor.history(), editor.dirty()])).toBe(before);
});
it('genuine wire geometry edit is responsible, later no-op and presentation do not overwrite it', () => {
  const p = sample(), s = p.sheets[0]!, w = s.wires.find(w => w.id === 'wire_supply_positive')!, i = s.instances[0]!;
  const bad: Operation = { op: 'wire.replace', wireId: w.id, from: w.from, to: w.to, waypoints: [{ x: 123, y: 456 }] };
  const result = edit(p, [bad, bad, { op: 'instance.presentation.replace', instanceId: i.id, label: 'changed', markings: i.markings }, { op: 'page.replace', sheetId: s.id, page: { ...s.page, width: s.page.width + 1 } }]);
  expect(result.ok).toBe(false); if (!result.ok) expect(result.diagnostics.filter(d => d.code === 'INVALID_WIRE_ROUTE').map(d => d.operationIndex)).toEqual([0]);
});
it('reordered object keys are semantic no-ops in receipts, dry-run, dirty and nonempty history', () => {
  const p = sample(), s = p.sheets[0]!, i = s.instances[0]!, d = p.devices[0]!;
  const m = i.markings;
  const ops: Operation[] = [
    { op: 'instance.transform', instanceId: i.id, transform: { mirrorX: i.transform.mirrorX, rotation: i.transform.rotation, position: { y: i.transform.position.y, x: i.transform.position.x } } },
    { op: 'page.replace', sheetId: s.id, page: { unit: 'du', height: s.page.height, width: s.page.width } },
    { op: 'instance.presentation.replace', instanceId: i.id, label: i.label, markings: { terminalLabels: Object.fromEntries(Object.entries(m.terminalLabels).reverse()), showTerminals: m.showTerminals, showLabel: m.showLabel, showDeviceName: m.showDeviceName } },
    { op: 'device.parameters.replace', deviceId: d.id, parameters: Object.fromEntries(Object.entries(d.parameters).reverse()) }
  ];
  const editor = value(createEditor(p)), batch = operationsFor(p, ops);
  expect(value(editor.dryRun(batch)).changes.every(c => !c.changed)).toBe(true);
  expect(editor.snapshot().revision).toBe(p.revision); expect(editor.history().undoCount).toBe(0);
  const result = value(editor.apply(batch)); expect(result.changes.every(c => !c.changed)).toBe(true);
  expect(result.project.revision).toBe(p.revision + 1); expect(editor.dirty()).toBe(false); expect(editor.history().undoCount).toBe(1);
  value(editor.undo()); value(editor.redo()); expect(editor.dirty()).toBe(false); expect(editor.snapshot().revision).toBe(p.revision + 3);
  const changed = value(edit(p, [{ op: 'page.replace', sheetId: s.id, page: { ...s.page, width: s.page.width + 1 } }, { op: 'instance.presentation.replace', instanceId: i.id, label: 'real edit', markings: m }]));
  expect(changed.changes.map(c => c.changed)).toEqual([true, true]);
});
it('receipt equality preserves meaningful waypoint array order', () => {
  const p = sample(), s = p.sheets[0]!, from = { kind: 'dangling' as const, position: { x: 0, y: 0 } }, to = { kind: 'dangling' as const, position: { x: 100, y: 100 } };
  const points = [{ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }];
  const base = value(edit(p, [{ op: 'wire.add', sheetId: s.id, wire: { id: 'ordered', from, to, waypoints: points } }])).project;
  const result = value(edit(base, [{ op: 'wire.replace', wireId: 'ordered', from, to, waypoints: [...points].reverse() }]));
  expect(result.changes[0]!.changed).toBe(true);
});
