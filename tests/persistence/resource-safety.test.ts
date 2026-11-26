import { describe, expect, it, vi } from 'vitest';
import { isolateData, HARD_LIMITS } from '../../src/core/persistence/json';
import { decodeOperations, decodeProject, decodeScenario } from '../../src/core/persistence';
import { validateProject } from '../../src/core/domain/project';
import empty from '../../design/contracts/examples/empty.circuit.json';
import scenario from '../../design/contracts/examples/start-stop.scenario.json';
import type { Result } from '../../src/core/domain/types';
function resource(result: Result<unknown>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw Error('Expected resource rejection');
  expect(result.category).toBe('resource-limit');
  expect(result.diagnostics[0]?.code).toBe('RESOURCE_LIMIT');
}
describe('decoded-data budgets before encoding/descriptor copying', () => {
  it.each([
    ['repeated strings', ['x'.repeat(40), 'x'.repeat(40)]],
    ['escaping', ['\u0000'.repeat(10), '\u0000'.repeat(10)]],
    ['multibyte', ['😀'.repeat(10), 'é'.repeat(30)]],
    ['nested', { a: [{ b: 'x'.repeat(80) }] }],
    ['oversized key', { ['é'.repeat(80)]: 0 }],
  ])('rejects %s without stringify or bulk descriptors', (_name, value) => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    let result: Result<unknown>; let stringifications = -1, bulkCopies = -1;
    try {
      result = isolateData(value, { bytes: 80 });
      stringifications = stringify.mock.calls.length; bulkCopies = descriptors.mock.calls.length;
    } finally { stringify.mockRestore(); descriptors.mockRestore(); }
    expect(stringifications).toBe(0); expect(bulkCopies).toBe(0);
    resource(result!);
  });
  it('rejects the actual repeated-reference amplification before producing a wire string', () => {
    const repeated = Array(32).fill('x'.repeat(1024 * 1024));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      resource(isolateData(repeated));
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });
  it.each([null, false, -0, 1e-7, 0.25, '', 'é😀\n\u0000"\\', { 'é😀\u0000': [true, null, 1e30 / 1e30] }, [{ a: 'x' }, ['é']]])('accounts exact encoded bytes for %j', value => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(isolateData(value, { bytes }).ok).toBe(true);
    resource(isolateData(value, { bytes: bytes - 1 }));
  });
  it('checks object entry budget before obtaining any descriptors', () => {
    const value = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, 0]));
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    let result: Result<unknown>;
    try {
      result = isolateData(value, { nodes: 1000 });
      expect(descriptor).not.toHaveBeenCalled();
    } finally { descriptor.mockRestore(); }
    resource(result!);
    expect(isolateData(value, { nodes: 1001 }).ok).toBe(true);
    resource(isolateData({ x: value }, { nodes: 1001 }));
  });
  it('stops descriptor traversal as soon as cumulative bytes exceed budget', () => {
    const value = { a: 'x'.repeat(40), b: 'x'.repeat(40), c: 0 };
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try {
      resource(isolateData(value, { bytes: 70 }));
      expect(descriptor.mock.calls.filter(([target]) => target === value).map(([, key]) => key)).toEqual(['a', 'b']);
    } finally { descriptor.mockRestore(); }
  });
  it('retains Unicode, numeric, accessor, prototype and isolation policy', () => {
    const getter = vi.fn(() => 0), toJSON = vi.fn(() => null);
    const accessor = Object.defineProperty({}, 'x', { get: getter, enumerable: true });
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    for (const value of [accessor, hidden, { toJSON }, { n: Infinity }, { n: NaN }, { n: 9007199254740992 }, { s: '\ud800' }, { s: '\udc00' }, Object.create({ x: 0 }), { [Symbol('x')]: 0 }]) expect(isolateData(value).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled();
    const value = JSON.parse('{"__proto__":{"x":"😀"},"constructor":[-0,0.25]}') as Record<string, unknown>;
    const result = isolateData(value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Expected JSON data');
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(result.value).toEqual(JSON.parse(JSON.stringify(value)));
    Object.defineProperty(value, 'constructor', { value: [], enumerable: true });
    expect((result.value as Record<string, unknown>).constructor).toEqual([0, 0.25]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(HARD_LIMITS.bytes).toBe(10 * 1024 * 1024);
  });
});
describe('hostile actual codec/domain shape paths', () => {
  it.each([1, 100, 500])('rejects %i malformed operation items without cloning diagnostic expansion', count => {
    const malformed = { format: 'circuit-operations', formatVersion: 1, target: { projectId: 'p', expectedRevision: 0 }, operations: Array.from({ length: count }, () => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 0]))) };
    const text = JSON.stringify(malformed);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const result = decodeOperations(text);
      expect(result.ok).toBe(false);
      if (result.ok) throw Error('Expected shape rejection');
      expect(result.category).toBe('unsupported-shape'); expect(result.diagnostics).toHaveLength(1);
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore(); }
  });
  it('project and scenario hostile rejection also avoids detailed-error clones', () => {
    const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 0]));
    const project = { ...empty, devices: Array(500).fill(fields) };
    const text = JSON.stringify(project);
    const scenarioText = JSON.stringify({ ...scenario, inputs: Array(500).fill(fields) });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      for (const result of [decodeProject(text), validateProject(project), decodeScenario(scenarioText)]) {
        expect(result.ok).toBe(false);
        if (result.ok) throw Error('Expected shape rejection');
        expect(result.category).toBe('unsupported-shape'); expect(result.diagnostics).toHaveLength(1);
      }
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore(); }
  });
});
