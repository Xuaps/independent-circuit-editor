import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import empty from '../../design/contracts/examples/empty.circuit.json';
import unfinished from '../../design/contracts/examples/unfinished.circuit.json';
import selfhold from '../../design/contracts/examples/selfhold.circuit.json';
import operations from '../../design/contracts/examples/build-selfhold.operations.json';
import scenario from '../../design/contracts/examples/start-stop.scenario.json';
import { decodeOperations, decodeProject, decodeScenario, HARD_LIMITS, parseStrict, sameDesign, serializeProject } from '../../src/core/persistence';
import { isolateData } from '../../src/core/persistence/json';
import { createProject, validateProject } from '../../src/core/domain/project';
import type { Result } from '../../src/core/domain/types';
function good<T>(result: Result<T>): T { if (!result.ok) throw Error(JSON.stringify(result)); return result.value; }
function code(result: Result<unknown>): string { if (result.ok) throw Error('Unexpected success'); return result.diagnostics[0]!.code; }
describe('strict bounded JSON, no interpretation', () => {
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"\\u0061":1,"a":2}}', '{"__proto__":1,"__proto__":2}'])('rejects decoded duplicate keys: %s', text => expect(code(parseStrict(text))).toBe('DUPLICATE_KEY'));
  it.each(['', '[1,]', '{"a":1,}', '{a:1}', '{"a" 1}', '{"a":}', '01', '+1', 'NaN', 'Infinity', '1.', '1e', 'true false', '/*comment*/null', '//comment\n1', '"\\x20"', '"\\u123"', '"unterminated', '"line\nbreak"'])('rejects malformed punctuation/tokens %s', text => expect(code(parseStrict(text))).toBe('MALFORMED_JSON'));
  it.each(['1e999', '-1e999', '9007199254740992', '9007199254740993', '9007199254740991.1', '1.00000000000000001', '1e-999', '-1e-999'])('rejects overflow/unsafe or rounded integer %s', text => expect(code(parseStrict(text))).toBe('UNSAFE_NUMBER'));
  it.each(['9007199254740991', '-9007199254740991', '1.0', '100e-2', '-0', '0e9999', '0.25'])('accepts representable numeric value %s', text => expect(parseStrict(text).ok).toBe(true));
  it('fatal UTF-8 rejects overlong, truncated, surrogate and out-of-range sequences', () => {
    for (const bytes of [[0xc0, 0x80], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) expect(code(parseStrict(new Uint8Array(bytes)))).toBe('MALFORMED_ENCODING');
  });
  it('accepts one leading BOM consistently and never emits one', () => {
    for (const text of [JSON.stringify(empty), '\ufeff' + JSON.stringify(empty)]) {
      expect(decodeProject(text).ok).toBe(true); expect(decodeProject(new TextEncoder().encode(text)).ok).toBe(true);
    }
    for (const text of ['\ufeff\ufeffnull', ' \ufeffnull']) {
      expect(parseStrict(text).ok).toBe(false); expect(parseStrict(new TextEncoder().encode(text)).ok).toBe(false);
    }
    expect(good(serializeProject(good(decodeProject('\ufeff' + JSON.stringify(empty))))).startsWith('\ufeff')).toBe(false);
  });
  it('rejects raw/escaped lone surrogates, accepts valid pairs without normalization', () => {
    for (const text of ['"\ud800"', '"\udc00"', '"\\ud800"', '"\\udc00"', '"\\ud800x"', '"\\ud800\\u0041"']) expect(parseStrict(text).ok).toBe(false);
    for (const text of ['"😀"', '"\\ud83d\\ude00"']) expect(good(parseStrict(text))).toBe('😀');
    expect(good(parseStrict('"e\\u0301"'))).toBe('e\u0301');
  });
  it('does not invoke eval/network or pollute prototypes for inert hostile strings/keys', () => {
    const evalSpy = vi.spyOn(globalThis, 'eval').mockImplementation(() => { throw Error('eval'); });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('network'); });
    try {
      const hostile = '<script>fetch("https://example.invalid");eval("x")</script>';
      const value = good(decodeProject(JSON.stringify({ ...empty, title: hostile })));
      expect(value.title).toBe(hostile);
      const object = good(parseStrict('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')) as Record<string, unknown>;
      expect(Object.getPrototypeOf(object)).toBeNull();
      expect(Object.hasOwn(object, '__proto__')).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(code(decodeProject('{"__proto__":1}'))).toBe('INVALID_SHAPE');
      expect(evalSpy).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    } finally { evalSpy.mockRestore(); fetchSpy.mockRestore(); }
  });
  it('counts root depth=1 and values (not keys) as nodes; hard ceilings cannot be raised', () => {
    expect(parseStrict('{"key":[0]}', { depth: 3, nodes: 3 }).ok).toBe(true);
    expect(code(parseStrict('{"key":[0]}', { depth: 2 }))).toBe('RESOURCE_LIMIT');
    expect(code(parseStrict('{"key":[0]}', { nodes: 2 }))).toBe('RESOURCE_LIMIT');
    expect(parseStrict('null', { depth: 1, nodes: 1 }).ok).toBe(true);
    expect(code(parseStrict('null', { nodes: 0 }))).toBe('RESOURCE_LIMIT');
    expect(parseStrict('['.repeat(63) + '0' + ']'.repeat(63)).ok).toBe(true);
    expect(code(parseStrict('['.repeat(64) + '0' + ']'.repeat(64), { depth: 1000 }))).toBe('RESOURCE_LIMIT');
    const atNodes = '[' + Array(HARD_LIMITS.nodes - 1).fill(0).join(',') + ']';
    expect(parseStrict(atNodes).ok).toBe(true);
    expect(code(parseStrict(atNodes.slice(0, -1) + ',0]', { nodes: 1_000_000 }))).toBe('RESOURCE_LIMIT');
  });
  it('bounds UTF-8 bytes including BOM, actual hard ceiling and smaller trusted budgets', () => {
    expect(parseStrict('"é"', { bytes: 4 }).ok).toBe(true);
    expect(code(parseStrict('"é"', { bytes: 3 }))).toBe('RESOURCE_LIMIT');
    expect(code(parseStrict(new TextEncoder().encode('"é"'), { bytes: 3 }))).toBe('RESOURCE_LIMIT');
    expect(parseStrict('\ufeff0', { bytes: 4 }).ok).toBe(true);
    expect(code(parseStrict('\ufeff0', { bytes: 3 }))).toBe('RESOURCE_LIMIT');
    const text = '"' + 'x'.repeat(HARD_LIMITS.bytes - 2) + '"';
    expect(parseStrict(text).ok).toBe(true);
    expect(code(parseStrict(text + ' ', { bytes: HARD_LIMITS.bytes + 100 }))).toBe('RESOURCE_LIMIT');
    expect(code(parseStrict(new Uint8Array(HARD_LIMITS.bytes + 1)))).toBe('RESOURCE_LIMIT');
  });
  it('isolates API data and rejects cycles, accessors, nonfinite, sparse/extended arrays and custom objects', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = { get title() { throw Error('must not run getter'); } };
    const sparse = Array(3); const extended: unknown[] & { extra?: number } = []; extended.extra = 1;
    for (const value of [cycle, accessor, new Date(), sparse, extended, { x: Infinity }, { x: undefined }]) expect(isolateData(value).ok).toBe(false);
    expect(code(isolateData({ a: { b: 1 } }, { depth: 2 }))).toBe('RESOURCE_LIMIT');
  });
});
describe('portable project codec and shape-only request surfaces', () => {
  it.each([empty, unfinished, selfhold])('round trips editable identities, bindings, geometry and revision: $projectId', input => {
    const project = good(decodeProject(JSON.stringify(input))); const text = good(serializeProject(project));
    const reopened = good(decodeProject(new TextEncoder().encode(text)));
    expect(good(sameDesign(reopened, project))).toBe(true);
    expect(reopened.revision).toBe(project.revision);
    for (const device of project.devices) expect(reopened.devices.find(d => d.id === device.id)).toEqual(device);
    for (const sheet of project.sheets) {
      const actual = reopened.sheets.find(s => s.id === sheet.id)!;
      for (const collection of ['instances', 'junctions', 'wires', 'annotations'] as const) {
        for (const entity of sheet[collection]) expect(actual[collection].find(item => item.id === entity.id)).toEqual(entity);
      }
    }
    expect(good(serializeProject(good(decodeProject(text))))).toBe(text);
    expect(good(sameDesign(input, project))).toBe(true);
  });
  it('decodes operations/scenario shapes without interpreting or running them', () => {
    expect(good(decodeOperations(JSON.stringify(operations)))).toEqual(operations);
    expect(code(decodeOperations(JSON.stringify(operations), { ids: 0 }))).toBe('RESOURCE_LIMIT');
    expect(good(decodeScenario(JSON.stringify(scenario)))).toEqual(scenario);
    expect(code(decodeOperations(JSON.stringify({ ...operations, formatVersion: 2 })))).toBe('INVALID_SHAPE');
    expect(code(decodeScenario(JSON.stringify({ ...scenario, plugin: 'https://example.invalid' })))).toBe('INVALID_SHAPE');
    expect(code(decodeScenario(JSON.stringify({ ...scenario, untilMs: 86400001 })))).toBe('INVALID_SHAPE');
    expect(code(decodeProject(JSON.stringify({ ...empty, revision: '1' })))).toBe('INVALID_SHAPE');
    expect(code(decodeProject(JSON.stringify(empty).replace('"revision":0', '"revision":0.00000000000000000000000001')))).toBe('INVALID_SHAPE');
  });
  it('aggregate IDs include project/sheet; at/beyond lowered and actual hard limits', () => {
    expect(validateProject(empty, { ids: 2 }).ok).toBe(true);
    expect(code(validateProject(empty, { ids: 1 }))).toBe('RESOURCE_LIMIT');
    const junctions = Array.from({ length: 9999 }, (_, i) => ({ id: `j${i}`, position: { x: i, y: 0 } }));
    const wires = Array.from({ length: 9999 }, (_, i) => ({ id: `w${i}`, from: { kind: 'dangling', position: { x: 0, y: i } }, to: { kind: 'dangling', position: { x: 1, y: i } }, waypoints: [] }));
    const p = { ...empty, sheets: [{ ...empty.sheets[0]!, junctions, wires }] };
    expect(validateProject(p).ok).toBe(true);
    expect(code(validateProject({ ...p, sheets: [{ ...p.sheets[0]!, annotations: [{ id: 'extra', position: { x: 0, y: 0 }, text: '' }] }] }, { ids: 99999 }))).toBe('RESOURCE_LIMIT');
    expect(code(decodeProject(JSON.stringify({ ...p, sheets: [{ ...p.sheets[0]!, junctions: Array.from({ length: 10001 }, (_, i) => ({ id: `j${i}`, position: { x: i, y: 0 } })) }] })))).toBe('INVALID_SHAPE');
  });
  it('dirty comparison excludes only revision; meaningful waypoint/operation/action ordering survives', () => {
    expect(good(sameDesign(selfhold, { ...selfhold, revision: 12 }))).toBe(true);
    expect(good(sameDesign(selfhold, { ...selfhold, title: 'different' }))).toBe(false);
    const sheet = empty.sheets[0]!;
    const wire = { id: 'w', from: { kind: 'dangling', position: { x: 0, y: 0 } }, to: { kind: 'dangling', position: { x: 20, y: 20 } }, waypoints: [{ x: 20, y: 0 }] };
    const a = { ...empty, sheets: [{ ...sheet, wires: [wire] }] };
    const b = { ...empty, sheets: [{ ...sheet, wires: [{ ...wire, waypoints: [{ x: 0, y: 20 }] }] }] };
    expect(good(sameDesign(a, b))).toBe(false);
    expect(good(decodeOperations(JSON.stringify(operations))).operations).toEqual(operations.operations);
    expect(good(decodeScenario(JSON.stringify(scenario))).inputs).toEqual(scenario.inputs);
  });
});
it('seeded arbitrary Unicode and geometry round trips, canonical idempotence and caller isolation', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0x10ffff }).filter(n => n < 0xd800 || n > 0xdfff), { maxLength: 50 }), fc.integer({ min: -999900, max: 999900 }), fc.integer({ min: -999900, max: 999900 }), (codepoints, x, y) => {
    const p = good(createProject('constructor', 'sheet', String.fromCodePoint(...codepoints)));
    const data = { ...p, sheets: [{ ...p.sheets[0]!, annotations: [{ id: 'a', position: { x, y }, text: p.title }] }] };
    const text = good(serializeProject(data)); const decoded = good(decodeProject(text));
    expect(decoded).toEqual(data); expect(good(serializeProject(decoded))).toBe(text);
    data.sheets[0]!.annotations[0]!.text = 'mutated'; expect(decoded.sheets[0]!.annotations[0]!.text).toBe(p.title);
  }), { seed: 20261115, numRuns: 200 });
});
