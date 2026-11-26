import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOperations, operationsFor, validateOperations } from '../../src/core/commands';
import { defaultDevice } from '../../src/core/catalog';
import { runReadiness } from '../../src/core/domain/project';
import { type Operation } from '../../src/core/domain/types';
import { decodeProject, sameDesign } from '../../src/core/persistence';
import { value, empty, sample, edit } from './helpers';

describe('atomic canonical commands', () => {
  it('executes the actual 29-op example, matching editable content and revision', () => {
    const before = value(decodeProject(readFileSync('design/contracts/examples/empty.circuit.json', 'utf8')));
    const applied = value(applyOperations(before, readFileSync('design/contracts/examples/build-selfhold.operations.json', 'utf8')));
    expect(applied.project.revision).toBe(1); expect(value(sameDesign(applied.project, sample()))).toBe(true);
    expect(applied.changes).toHaveLength(29); expect(before.revision).toBe(0);
  });
  it('handles all 17 tags with complete replacement and explicit removal', () => {
    let p = empty(); const instance = { ...sample().sheets[0]!.instances[0]!, id: 'instance', deviceId: 'device', definition: { id: 'core.lamp', version: 1 as const } };
    const ops: Operation[] = [
      { op: 'device.create', device: defaultDevice('device', 'H1', 'lamp') },
      { op: 'device.rename', deviceId: 'device', name: 'H2' },
      { op: 'device.parameters.replace', deviceId: 'device', parameters: { color: 'green' } },
      { op: 'instance.place', sheetId: 'sheet', instance },
      { op: 'instance.bind', instanceId: 'instance', deviceId: null },
      { op: 'instance.transform', instanceId: 'instance', transform: { position: { x: 100, y: 100 }, rotation: 90, mirrorX: true } },
      { op: 'instance.presentation.replace', instanceId: 'instance', label: 'hello', markings: { showDeviceName: false, showLabel: true, showTerminals: false, terminalLabels: {} } },
      { op: 'junction.create', sheetId: 'sheet', junction: { id: 'junction', position: { x: 0, y: 0 } } },
      { op: 'wire.add', sheetId: 'sheet', wire: { id: 'wire', from: { kind: 'junction', junctionId: 'junction' }, to: { kind: 'dangling', position: { x: 100, y: 0 } }, waypoints: [] } },
      { op: 'wire.replace', wireId: 'wire', from: { kind: 'dangling', position: { x: 0, y: 0 } }, to: { kind: 'dangling', position: { x: 0, y: 100 } }, waypoints: [] },
      { op: 'annotation.add', sheetId: 'sheet', annotation: { id: 'annotation', position: { x: 0, y: 0 }, text: 'inert' } },
      { op: 'page.replace', sheetId: 'sheet', page: { width: 1200, height: 900, unit: 'du' } }
    ];
    p = value(edit(p, ops)).project;
    expect(p.devices[0]!.parameters).toEqual({ color: 'green' }); expect(p.sheets[0]!.instances[0]!.label).toBe('hello');
    p = value(edit(p, [{ op: 'wire.remove', wireId: 'wire' }, { op: 'junction.remove', junctionId: 'junction' }, { op: 'annotation.remove', annotationId: 'annotation' }, { op: 'instance.remove', instanceId: 'instance' }, { op: 'device.remove', deviceId: 'device' }])).project;
    expect(p.devices).toEqual([]); expect(p.sheets[0]!.instances).toEqual([]); expect(p.revision).toBe(2);
  });
  it.each(['early', 'middle', 'late'])('rolls back %s target failures', position => {
    const p = empty(), before = JSON.stringify(p); const good: Operation = { op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }, bad: Operation = { op: 'device.remove', deviceId: 'missing' };
    const ops = position === 'early' ? [bad, good] : position === 'middle' ? [good, bad, { op: 'device.rename' as const, deviceId: 'd', name: 'K2' }] : [good, { op: 'device.rename' as const, deviceId: 'd', name: 'K2' }, bad];
    const r = edit(p, ops); expect(r.ok).toBe(false); if (!r.ok) expect(r.diagnostics[0]!.operationIndex).toBe(ops.indexOf(bad)); expect(JSON.stringify(p)).toBe(before);
  });
  it('rejects stale/wrong target and overflow before mutation', () => {
    const p = empty(), batch = operationsFor(p, [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }]);
    expect(applyOperations(p, { ...batch, target: { projectId: 'other', expectedRevision: 0 } }).ok).toBe(false);
    expect(applyOperations(p, { ...batch, target: { ...batch.target, expectedRevision: 1 } }).ok).toBe(false);
    const max = { ...p, revision: Number.MAX_SAFE_INTEGER }; const r = edit(max, batch.operations); expect(r.ok).toBe(false); if (!r.ok) expect(r.diagnostics[0]!.code).toBe('REVISION_OVERFLOW');
  });
  it('reserves original and earlier creation IDs even after removal', () => {
    const p = value(edit(empty(), [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }])).project;
    for (const before of [p, empty()]) {
      const ops: Operation[] = before.devices.length ? [] : [{ op: 'device.create', device: defaultDevice('d', 'K1', 'relay') }];
      ops.push({ op: 'device.remove', deviceId: 'd' }, { op: 'device.create', device: defaultDevice('d', 'K2', 'relay') });
      const r = edit(before, ops); expect(r.ok).toBe(false); if (!r.ok) expect(r.diagnostics[0]!.code).toBe('DUPLICATE_ID');
    }
  });
  it('defers route/reference repairs, but never cascades primitive deletion', () => {
    const p = sample(), s = p.sheets[0]!, i = s.instances.find(i => s.wires.some(w => [w.from, w.to].some(e => e.kind === 'port' && e.instanceId === i.id)))!;
    expect(edit(p, [{ op: 'instance.remove', instanceId: i.id }]).ok).toBe(false);
    const ops: Operation[] = [{ op: 'instance.transform', instanceId: i.id, transform: { ...i.transform, position: { x: i.transform.position.x + 1, y: i.transform.position.y + 1 } } }, { op: 'instance.transform', instanceId: i.id, transform: i.transform }];
    expect(edit(p, ops).ok).toBe(true);
    const device = p.devices[0]!; expect(edit(p, [{ op: 'device.remove', deviceId: device.id }]).ok).toBe(false);
  });
  it('attributes final reference failure to deletion rather than unrelated final op', () => {
    const p = sample(), i = p.sheets[0]!.instances[0]!;
    const r = edit(p, [{ op: 'instance.remove', instanceId: i.id }, { op: 'page.replace', sheetId: p.sheets[0]!.id, page: p.sheets[0]!.page }]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.diagnostics.some(d => d.operationIndex === 0)).toBe(true);
  });
  it('rejects incompatible binding, invalid ports, wrong owning parameters and duplicate names', () => {
    const p = sample(), i = p.sheets[0]!.instances[0]!, device = p.devices.find(d => d.kind !== p.devices.find(d => d.id === i.deviceId)!.kind)!;
    const w = p.sheets[0]!.wires[0]!;
    const cases: Operation[][] = [
      [{ op: 'instance.bind', instanceId: i.id, deviceId: device.id }],
      [{ op: 'wire.replace', wireId: w.id, from: { kind: 'port', instanceId: i.id, portId: 'missing' }, to: w.to, waypoints: [] }],
      [{ op: 'device.parameters.replace', deviceId: p.devices[0]!.id, parameters: { color: 'green', extra: true } }],
      [{ op: 'device.rename', deviceId: p.devices[0]!.id, name: p.devices[1]!.name.toLowerCase() }],
      [{ op: 'wire.remove', wireId: i.id }]
    ];
    for (const ops of cases) expect(edit(p, ops).ok).toBe(false);
  });
  it('accepts unbound/source-count/duplicate-controller drafts separately from Run', () => {
    const p = sample(), s = p.sheets[0]!, coil = s.instances.find(i => i.definition.id === 'core.relay.coil')!;
    const duplicate = value(edit(p, [{ op: 'instance.place', sheetId: s.id, instance: { ...coil, id: 'duplicate' } }])).project;
    expect(runReadiness(duplicate).some(d => d.code === 'DUPLICATE_CONTROLLER')).toBe(true);
    const unbound = value(edit(p, [{ op: 'instance.bind', instanceId: coil.id, deviceId: null }])).project;
    expect(runReadiness(unbound).some(d => d.code === 'UNBOUND_INSTANCE')).toBe(true);
    expect(runReadiness(empty()).some(d => d.code === 'SOURCE_COUNT')).toBe(true);
  });
  it('retains truthful final parameter/name provenance and semantic no-op receipts', () => {
    const p = value(edit(empty(), [{ op: 'device.create', device: defaultDevice('a', 'K1', 'relay') }, { op: 'device.create', device: defaultDevice('z', 'K2', 'relay') }])).project;
    const badParameters = edit(p, [{ op: 'device.parameters.replace', deviceId: 'a', parameters: { color: 'green' } }, { op: 'device.rename', deviceId: 'a', name: 'K3' }]);
    expect(badParameters.ok).toBe(false); if (!badParameters.ok) expect(badParameters.diagnostics[0]!.operationIndex).toBe(0);
    const badName = edit(p, [{ op: 'device.rename', deviceId: 'a', name: 'K2' }, { op: 'device.parameters.replace', deviceId: 'a', parameters: {} }]);
    expect(badName.ok).toBe(false); if (!badName.ok) expect(badName.diagnostics[0]!.operationIndex).toBe(0);
    const noOp = value(edit(p, [{ op: 'device.rename', deviceId: 'a', name: 'K1' }])); expect(noOp.project.revision).toBe(p.revision + 1); expect(noOp.changes[0]!.changed).toBe(false);
  });
  it('bounds and isolates programmatic and transport ingress without executing accessors', () => {
    let invoked = false; const accessor = { get operations() { invoked = true; return []; } };
    expect(validateOperations(accessor).ok).toBe(false); expect(invoked).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const bad of [cycle, { operations: [() => 1] }, { toJSON() { throw new Error('must not run'); } }, '{"format":"x","format":"y"}', new Uint8Array([255]), { ...operationsFor(empty(), []), unknown: 'x' }]) expect(validateOperations(bad).ok).toBe(false);
    const r = validateOperations({ ...operationsFor(empty(), []), unknown: Array(32).fill('x'.repeat(1024 * 1024)) });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.category).toBe('resource-limit');
    for (const n of [1, 100, 500]) { const malformed = { ...operationsFor(empty(), []), operations: Array.from({ length: n }, () => ({ op: 'execute', code: 'bad' })) }; const rejected = validateOperations(malformed); expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.diagnostics).toHaveLength(1); }
  });
});
