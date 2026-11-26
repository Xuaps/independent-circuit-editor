import { describe, expect, it, vi } from 'vitest';
import { validateShape, validateShapeBounded, type BoundedContractKind } from '../../src/contracts/validation';
import common from '../../design/contracts/v1/common.schema.json';
import project from '../../design/contracts/v1/project.schema.json';
import operations from '../../design/contracts/v1/operations.schema.json';
import scenario from '../../design/contracts/v1/scenario.schema.json';
import empty from '../../design/contracts/examples/empty.circuit.json';
import ops from '../../design/contracts/examples/build-selfhold.operations.json';
import scenarioExample from '../../design/contracts/examples/start-stop.scenario.json';
// Certificate for the actual reachable immutable schemas, not an assumption that
// allErrors:false universally bounds errors. No contains/not/if/dependentSchemas/
// recursive refs/allOf admitted. First invalid array item/property exits; fixed
// oneOf/anyOf sums all branch failures plus its own error. propertyNames can add
// one error to its subschema. Every other scalar check yields at most one error.
type Schema = Record<string, unknown>;
const roots: Record<string, Schema> = { [common.$id]: common, [project.$id]: project, [operations.$id]: operations, [scenario.$id]: scenario };
function errorBound(schema: Schema, active = new Set<Schema>()): number {
  expect(active.has(schema)).toBe(false);
  const next = new Set(active).add(schema);
  const allowed = new Set(['$id', '$schema', '$defs', '$ref', 'type', 'const', 'enum', 'minimum', 'maximum', 'pattern', 'maxLength', 'minItems', 'maxItems', 'maxProperties', 'required', 'additionalProperties', 'properties', 'propertyNames', 'items', 'oneOf', 'anyOf']);
  for (const key of Object.keys(schema)) expect(allowed.has(key), `Unsupported error-expansion keyword ${key}`).toBe(true);
  const bounds = [1];
  if (typeof schema.$ref === 'string') {
    const [id, fragment] = schema.$ref.split('#');
    let target = roots[id!]!;
    expect(target).toBeDefined();
    for (const key of (fragment ?? '').split('/').filter(Boolean)) target = target[key] as Schema;
    bounds.push(errorBound(target, next));
  }
  for (const key of ['oneOf', 'anyOf']) if (schema[key]) bounds.push(1 + (schema[key] as Schema[]).reduce((sum, child) => sum + errorBound(child, next), 0));
  if (schema.properties) for (const child of Object.values(schema.properties as Record<string, Schema>)) bounds.push(errorBound(child, next));
  if (schema.items) bounds.push(errorBound(schema.items as Schema, next));
  if (schema.propertyNames) bounds.push(1 + errorBound(schema.propertyNames as Schema, next));
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') bounds.push(errorBound(schema.additionalProperties as Schema, next));
  return Math.max(...bounds);
}
const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 0]));
const malformedOperations = (count: number) => ({ ...ops, operations: Array(count).fill(fields) });
describe('bounded input-only Ajv path over identical immutable schemas', () => {
  it('certifies fixed schema error bounds independent of input item/property counts', () => {
    expect(errorBound(project)).toBeLessThanOrEqual(128);
    expect(errorBound(operations)).toBeLessThanOrEqual(128);
    expect(errorBound(scenario)).toBeLessThanOrEqual(128);
  });
  it.each([['project', empty], ['operations', ops], ['scenario', scenarioExample]] as const)('%s still accepts valid data without mutation', (kind, value) => {
    const before = structuredClone(value);
    expect(validateShapeBounded(kind, value)).toEqual({ valid: true, errorCount: 0 });
    expect(value).toEqual(before);
    for (const invalid of [{ ...value, extra: true }, { ...value, formatVersion: 999 }]) expect(validateShapeBounded(kind, invalid).valid).toBe(false);
  });
  it.each([1, 100, 500, 10000])('errors for %i bad operations stay within schema constant, no clone', count => {
    const value = malformedOperations(count);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    let result: ReturnType<typeof validateShapeBounded>; let clones = -1;
    try { result = validateShapeBounded('operations', value); clones = clone.mock.calls.length; }
    finally { clone.mockRestore(); }
    expect(result!.valid).toBe(false); expect(result!.errorCount).toBeGreaterThan(0);
    expect(result!.errorCount).toBeLessThanOrEqual(errorBound(operations));
    expect(result).toEqual(validateShapeBounded('operations', malformedOperations(1)));
    expect(clones).toBe(0);
  });
  it.each([
    ['operations', ops, 'operations', 10000],
    ['project', empty, 'devices', 2000],
    ['project', empty, 'sheets', 1],
    ['scenario', scenarioExample, 'inputs', 10000],
    ['scenario', scenarioExample, 'probes', 10000],
  ] as const)('%s %s per-schema maxItems rejects before inspecting any item', (kind, base, key, maximum) => {
    let reads = 0;
    const array = new Proxy(Array(maximum + 1).fill(fields), { get(target, name, receiver) { if (typeof name === 'string' && /^\d+$/.test(name)) reads++; return Reflect.get(target, name, receiver); } });
    const result = validateShapeBounded(kind, { ...base, [key]: array });
    expect(result.valid).toBe(false); expect(result.errorCount).toBe(1); expect(reads).toBe(0);
  });
  it('maxProperties rejects parameter records before reading property values', () => {
    let reads = 0;
    const parameters = new Proxy(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 0])), {
      get(target, name, receiver) { reads++; return Reflect.get(target, name, receiver); },
    });
    const value = { ...ops, operations: [{ op: 'device.parameters.replace', deviceId: 'd', parameters }] };
    const result = validateShapeBounded('operations', value);
    expect(result.valid).toBe(false); expect(result.errorCount).toBeLessThanOrEqual(errorBound(operations)); expect(reads).toBe(0);
  });
  it('project/scenario nested alternatives have bounded errors and trusted diagnostics remain detailed', () => {
    for (const [kind, value] of [
      ['project', { ...empty, devices: Array(500).fill(fields) }],
      ['scenario', { ...scenarioExample, expect: { outcome: fields } }],
    ] as const) {
      const bounded = validateShapeBounded(kind, value);
      expect(bounded.valid).toBe(false); expect(bounded.errorCount).toBeLessThanOrEqual(errorBound(kind === 'project' ? project : scenario));
    }
    const value = { ...empty, title: 0, revision: '0', extra: true };
    const trusted = validateShape('project', value);
    expect(trusted.valid).toBe(false);
    if (trusted.valid) throw Error('Expected rejection');
    expect(trusted.errors.length).toBeGreaterThan(validateShapeBounded('project', value).errorCount);
  });
  it('does not expose response contains or unconstrained common via bounded API', () => {
    for (const kind of ['common', 'response', 'profile', 'hostError']) expect(() => validateShapeBounded(kind as BoundedContractKind, {})).toThrow('Unsupported bounded contract');
  });
});
