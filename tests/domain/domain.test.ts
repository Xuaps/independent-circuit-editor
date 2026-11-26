import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import empty from '../../design/contracts/examples/empty.circuit.json';
import unfinished from '../../design/contracts/examples/unfinished.circuit.json';
import selfhold from '../../design/contracts/examples/selfhold.circuit.json';
import { defaultDevice } from '../../src/core/catalog';
import { boundedPoint, portPosition, transformPoint, wirePoints } from '../../src/core/domain/geometry';
import { createProject, documentDiagnostics, projectIndex, runReadiness, validateProject } from '../../src/core/domain/project';
import { sameDesign, serializeProject } from '../../src/core/persistence';
import type { Instance, Project, Result, Sheet } from '../../src/core/domain/types';
function good<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.value; }
function codes(input: unknown): string[] { const result = validateProject(input); return result.ok ? [] : result.diagnostics.map(d => d.code); }
function base() { return good(createProject('p', 's')); }
function instance(id = 'i', deviceId: string | null = null, definition = 'core.relay.contact.no'): Instance {
  return { id, deviceId, definition: { id: definition, version: 1 }, variant: 'default', parameters: {}, label: '', markings: { showDeviceName: true, showLabel: true, showTerminals: true, terminalLabels: {} }, transform: { position: { x: 0, y: 0 }, rotation: 0, mirrorX: false } };
}
function withInstances(items: readonly Instance[], devices: Project['devices'] = []): Project { const p = base(); return { ...p, devices, sheets: [{ ...p.sheets[0]!, instances: items }] }; }
describe('saveable draft vs preflight, not simulation', () => {
  it('accepts known examples and separates unfinished/empty preflight', () => {
    for (const data of [empty, unfinished, selfhold]) expect(validateProject(data).ok).toBe(true);
    expect(runReadiness(good(validateProject(empty))).map(d => d.code)).toContain('SOURCE_COUNT');
    expect(runReadiness(good(validateProject(unfinished))).map(d => d.code)).toContain('UNBOUND_INSTANCE');
    expect(runReadiness(good(validateProject(selfhold)))).toEqual([]);
  });
  it('requires explicit unique IDs, preserves ASCII name case and rejects case-insensitive duplicates', () => {
    expect(codes({ ...base(), devices: [defaultDevice('p', 'D', 'relay')] })).toContain('DUPLICATE_ID');
    expect(codes({ ...base(), devices: [defaultDevice('a', 'K', 'relay'), defaultDevice('b', 'k', 'relay')] })).toContain('DUPLICATE_DEVICE_NAME');
    expect(good(validateProject({ ...base(), devices: [defaultDevice('constructor', 'Mixed', 'relay')] })).devices[0]!.name).toBe('Mixed');
    expect(codes({ ...base(), projectId: undefined })).toContain('INVALID_DATA');
  });
  it('null is saveable; non-null missing/incompatible devices and unknown definitions are errors', () => {
    expect(validateProject(withInstances([instance()])).ok).toBe(true);
    expect(codes(withInstances([instance('i', 'missing')]))).toContain('MISSING_DEVICE');
    expect(codes(withInstances([instance('i', 'd')], [defaultDevice('d', 'D', 'lamp')]))).toContain('INCOMPATIBLE_DEVICE');
    expect(codes(withInstances([instance('i', null, 'core.unknown')]))).toContain('UNKNOWN_DEFINITION');
    const item = instance(); expect(codes(withInstances([{ ...item, definition: { id: item.definition.id, version: 2 } } as unknown as Instance]))).toContain('INVALID_SHAPE');
    expect(codes({ ...base(), runtime: {} })).toContain('INVALID_SHAPE');
  });
  it('controller cardinality blocks Run but not Save; metadata is not another placed source', () => {
    const relay = defaultDevice('r', 'K1', 'relay');
    const observer = withInstances([instance('contact', 'r')], [relay]);
    expect(validateProject(observer).ok).toBe(true);
    expect(runReadiness(observer).map(d => d.code)).toContain('MISSING_CONTROLLER');
    const dup = withInstances([instance('a', 'r', 'core.relay.coil'), instance('b', 'r', 'core.relay.coil')], [relay]);
    expect(validateProject(dup).ok).toBe(true);
    expect(runReadiness(dup).map(d => d.code)).toContain('DUPLICATE_CONTROLLER');
    const source = withInstances([instance('source', 'v', 'core.dc.supply')], [defaultDevice('v', 'V', 'dcSupply'), defaultDevice('unused', 'Other', 'dcSupply')]);
    expect(runReadiness(source)).toEqual([]);
    expect(runReadiness(withInstances([...source.sheets[0]!.instances, instance('two', 'unused', 'core.dc.supply')], source.devices)).map(d => d.code)).toContain('SOURCE_COUNT');
    const independent = withInstances([instance('a', 'r', 'core.relay.coil'), instance('b', 'other')], [relay, defaultDevice('other', 'K2', 'relay')]);
    expect(runReadiness(independent).find(d => d.code === 'MISSING_CONTROLLER')!.objectIds).toEqual(['other']);
  });
  it('keeps query maps private and data immutable/isolated including constructor IDs', () => {
    const input = structuredClone(selfhold); input.devices[0]!.id = 'constructor';
    for (const i of input.sheets[0]!.instances) if (i.deviceId === selfhold.devices[0]!.id) i.deviceId = 'constructor';
    const project = good(validateProject(input)); const index = projectIndex(project);
    input.title = 'mutated'; expect(index.snapshot().title).not.toBe('mutated');
    expect(index.device('constructor')!.id).toBe('constructor'); expect(index.device('__proto__')).toBeUndefined();
    expect(Object.values(index).every(value => typeof value === 'function')).toBe(true);
    expect(() => { (index.snapshot().devices as unknown[]).pop(); }).toThrow();
    expect(() => { (index.device('constructor') as { name: string }).name = 'changed'; }).toThrow();
    const bound = index.boundInstances('constructor'); expect(Object.isFrozen(bound)).toBe(true);
  });
});
describe('explicit geometry', () => {
  for (const mirrorX of [false, true]) for (const rotation of [0, 90, 180, 270] as const) it(`mirror ${mirrorX}, clockwise ${rotation} preserves port identity`, () => {
    const i = { ...instance(), transform: { mirrorX, rotation, position: { x: 100, y: 100 } } };
    const expected = rotation === 0 ? [-20, 0] : rotation === 90 ? [0, -20] : rotation === 180 ? [20, 0] : [0, 20];
    expect(portPosition(i, 'p1')).toEqual({ x: 100 + expected[0]! * (mirrorX ? -1 : 1), y: 100 + expected[1]! * (mirrorX ? -1 : 1) });
    expect(portPosition(i, 'p2')).toEqual(transformPoint({ x: 20, y: 0 }, i.transform));
    expect(portPosition(i, '1')).toBeUndefined();
  });
  it('rejects derived coordinate overflow and invalid terminal labels, not off-page objects', () => {
    const item = instance();
    expect(codes(withInstances([{ ...item, transform: { ...item.transform, position: { x: 1_000_000, y: 0 } } }]))).toContain('COORDINATE_BOUNDS');
    expect(validateProject(withInstances([{ ...item, transform: { ...item.transform, position: { x: -5000, y: -4000 } } }])).ok).toBe(true);
    expect(codes(withInstances([{ ...item, markings: { ...item.markings, terminalLabels: { bogus: 'A' } } }]))).toContain('UNKNOWN_TERMINAL_LABEL');
    expect(boundedPoint({ x: 1_000_001, y: 0 })).toBe(false);
  });
  it('checks references, same-sheet endpoints, nonzero orthogonal routes; crossings never join', () => {
    const p = withInstances([instance()]); const s = p.sheets[0]!;
    const wire = { id: 'w', from: { kind: 'port' as const, instanceId: 'i', portId: 'p1' }, to: { kind: 'dangling' as const, position: { x: -100, y: 0 } }, waypoints: [] };
    const document = (sheet: Sheet) => ({ ...p, sheets: [sheet] });
    expect(validateProject(document({ ...s, wires: [wire] })).ok).toBe(true);
    expect(wirePoints(s, wire)).toEqual([{ x: -20, y: 0 }, { x: -100, y: 0 }]);
    expect(codes(document({ ...s, wires: [{ ...wire, to: { kind: 'dangling', position: { x: -20, y: 0 } } }] }))).toContain('INVALID_WIRE_ROUTE');
    expect(codes(document({ ...s, wires: [{ ...wire, waypoints: [{ x: 4, y: 5 }] }] }))).toContain('INVALID_WIRE_ROUTE');
    expect(codes(document({ ...s, wires: [{ ...wire, from: { ...wire.from, instanceId: 'elsewhere' } }] }))).toContain('MISSING_INSTANCE');
    expect(codes(document({ ...s, wires: [{ ...wire, from: { ...wire.from, portId: 'bad' } }] }))).toContain('MISSING_PORT');
    expect(codes(document({ ...s, wires: [{ ...wire, from: { kind: 'junction', junctionId: 'absent' } }] }))).toContain('MISSING_JUNCTION');
    const crossing: Sheet = { ...s, instances: [], wires: [
      { id: 'a', from: { kind: 'dangling', position: { x: -10, y: 0 } }, to: { kind: 'dangling', position: { x: 10, y: 0 } }, waypoints: [] },
      { id: 'b', from: { kind: 'dangling', position: { x: 0, y: -10 } }, to: { kind: 'dangling', position: { x: 0, y: 10 } }, waypoints: [] }
    ] };
    const saved = good(validateProject(document(crossing))); expect(saved.sheets[0]!.junctions).toEqual([]);
    expect(saved.sheets[0]!.wires).toEqual(crossing.wires);
  });
});
it('seeded permutations preserve canonical content, index association and deterministic errors', () => {
  fc.assert(fc.property(fc.shuffledSubarray(selfhold.devices, { minLength: selfhold.devices.length, maxLength: selfhold.devices.length }), fc.shuffledSubarray(selfhold.sheets[0]!.instances, { minLength: selfhold.sheets[0]!.instances.length, maxLength: selfhold.sheets[0]!.instances.length }), (devices, instances) => {
    const p = { ...selfhold, devices, sheets: [{ ...selfhold.sheets[0]!, instances, wires: [...selfhold.sheets[0]!.wires].reverse(), junctions: [...selfhold.sheets[0]!.junctions].reverse() }] };
    expect(good(serializeProject(p))).toBe(good(serializeProject(selfhold)));
    expect(good(sameDesign(p, { ...selfhold, revision: 999 }))).toBe(true);
    expect(runReadiness(good(validateProject(p)))).toEqual([]);
    const invalid = { ...p, devices: [...devices, defaultDevice('zz', devices[0]!.name, 'relay')] } as Project;
    const permuted = { ...invalid, devices: [...invalid.devices].reverse() };
    expect(documentDiagnostics(invalid)).toEqual(documentDiagnostics(permuted));
  }), { seed: 20261115, numRuns: 200 });
});
