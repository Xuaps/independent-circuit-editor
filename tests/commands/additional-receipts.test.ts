import { expect, it } from 'vitest';
import { value, sample, edit } from './helpers';

it('reports true transform, markings, parameter and page edits independently of key order', () => {
  const p = sample(), s = p.sheets[0]!, lamp = s.instances.find(i => i.definition.id === 'core.lamp')!;
  const detached = value(edit(p, s.wires.map(w => ({ op: 'wire.remove' as const, wireId: w.id })))).project;
  const device = p.devices.find(d => d.id === lamp.deviceId)!;
  const result = value(edit(detached, [
    { op: 'instance.transform', instanceId: lamp.id, transform: { mirrorX: !lamp.transform.mirrorX, rotation: lamp.transform.rotation, position: lamp.transform.position } },
    { op: 'instance.presentation.replace', instanceId: lamp.id, label: lamp.label, markings: { ...lamp.markings, showLabel: !lamp.markings.showLabel } },
    { op: 'device.parameters.replace', deviceId: device.id, parameters: { color: device.kind === 'lamp' && device.parameters.color === 'blue' ? 'amber' : 'blue' } },
    { op: 'page.replace', sheetId: s.id, page: { unit: 'du', height: s.page.height, width: s.page.width + 1 } }
  ]));
  expect(result.changes.map(c => c.changed)).toEqual([true, true, true, true]);
});
it('later genuine wire edit supersedes endpoint provenance only for its own route', () => {
  const p = sample(), s = p.sheets[0]!, supply = s.instances.find(i => i.id === 'instance_supply')!, w = s.wires.find(w => w.id === 'wire_supply_positive')!;
  const result = edit(p, [
    { op: 'instance.transform', instanceId: supply.id, transform: { ...supply.transform, position: { x: supply.transform.position.x + 1, y: supply.transform.position.y + 1 } } },
    { op: 'wire.replace', wireId: w.id, from: w.from, to: w.to, waypoints: [{ x: 123, y: 456 }] },
    { op: 'page.replace', sheetId: s.id, page: s.page }
  ]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostics.find(d => d.objectIds.includes(w.id))!.operationIndex).toBe(1);
    expect(result.diagnostics.find(d => d.objectIds.includes('wire_supply_return'))!.operationIndex).toBe(0);
  }
});
