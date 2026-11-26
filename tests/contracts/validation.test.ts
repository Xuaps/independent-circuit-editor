import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { validateCommonValue, validateShape, type ContractKind } from '../../src/contracts/validation';
import { limitedMetadata } from '../../src/contracts/metadata';
const example = (file: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../design/contracts/examples/${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const cases: [ContractKind, string][] = [
  ['project', 'empty.circuit.json'], ['project', 'selfhold.circuit.json'], ['project', 'unfinished.circuit.json'],
  ['operations', 'build-selfhold.operations.json'], ['scenario', 'start-stop.scenario.json'], ['response', 'error-response.example.json']
];
describe('offline immutable v1 shape adapters (not execution)', () => {
  test.each([null, 42, 'not an object'])('common container is not an input document: %s', value => {
    expectTypeOf<Extract<ContractKind, 'common'>>().toEqualTypeOf<never>();
    expect(() => {
      // Deliberately exercise unchecked JS callers while also checking that
      // TypeScript rejects the original unsound public call during typecheck.
      // @ts-expect-error common is a definition container, not ContractKind
      validateShape('common', value);
    }).toThrow('Unsupported input contract: common');
    for (const kind of ['project', 'operations', 'scenario', 'profile', 'response', 'hostError'] as const) {
      expect(validateShape(kind, value).valid).toBe(false);
    }
  });
  test.each(cases)('%s accepts existing %s without mutation', (kind, file) => {
    const data = example(file), before = structuredClone(data);
    expect(validateShape(kind, data).valid).toBe(true);
    expect(data).toEqual(before);
  });
  test.each(cases)('%s rejects unknown fields in %s', (kind, file) => {
    expect(validateShape(kind, { ...example(file), accidentalField: true }).valid).toBe(false);
  });
  test.each(cases)('%s rejects future version in %s', (kind, file) => {
    const data = example(file);
    data[kind === 'response' ? 'apiVersion' : 'formatVersion'] = 999;
    expect(validateShape(kind, data).valid).toBe(false);
  });
  test('does not coerce, supply defaults or strip fields and retains error receipts', () => {
    const data = example('empty.circuit.json');
    data.revision = '0'; data.surprise = true; delete data.title;
    const before = structuredClone(data);
    const result = validateShape('project', data);
    expect(result.valid).toBe(false);
    expect(data).toEqual(before);
    if (result.valid) throw new Error('Expected malformed shape');
    const errors = structuredClone(result.errors);
    expect(errors.some(e => e.keyword === 'type')).toBe(true);
    expect(errors.some(e => e.keyword === 'required')).toBe(true);
    expect(errors.some(e => e.keyword === 'additionalProperties')).toBe(true);
    validateShape('project', example('empty.circuit.json'));
    expect(result.errors).toEqual(errors);
  });
  test('untrusted schema URLs and executable data are not interpreted', () => {
    expect(validateShape('project', { ...example('empty.circuit.json'), $schema: 'https://example.invalid/schema', behavior: 'throw new Error()' }).valid).toBe(false);
  });
  test('profile is seven-definition immutable limited metadata, not implementation status', () => {
    expect(validateShape('profile', limitedMetadata).valid).toBe(true);
    expect(limitedMetadata.definitions).toHaveLength(7);
    expect(limitedMetadata.status).toBe('proposed-not-implemented');
    expect(Object.isFrozen(limitedMetadata.definitions[0]?.ports)).toBe(true);
    expect(validateShape('profile', { ...limitedMetadata, status: 'implemented' }).valid).toBe(false);
  });
  test('response tags constrain result and success/failure envelopes', () => {
    const list = { apiVersion: 1, command: 'library.list', ok: true, exitCode: 0, diagnostics: [], result: { profile: limitedMetadata } };
    expect(validateShape('response', list).valid).toBe(true);
    expect(validateShape('response', { ...list, command: 'inspect' }).valid).toBe(false);
    expect(validateShape('response', { ...list, result: null }).valid).toBe(false);
    expect(validateShape('response', { ...list, ok: false, exitCode: 2 }).valid).toBe(false);
  });
  test.each(['unknown', 'unsupported', 'faulted'])('%s quality cannot smuggle false', quality => {
    expect(validateCommonValue('observableValue', { quality, code: 'UNAVAILABLE' }).valid).toBe(true);
    expect(validateCommonValue('observableValue', { quality, code: 'UNAVAILABLE', value: false }).valid).toBe(false);
    expect(validateCommonValue('observableValue', { quality }).valid).toBe(false);
  });
  test('known null is shape-valid but not a claim of Boolean observable semantics', () => {
    expect(validateCommonValue('observableValue', { quality: 'known', value: null }).valid).toBe(true);
    expect(validateCommonValue('observableValue', { quality: 'known' }).valid).toBe(false);
    expect(validateCommonValue('observableValue', { quality: 'known', value: false, code: 'UNAVAILABLE' }).valid).toBe(false);
  });
  test('narrow host error is separate from known-command wire schema', () => {
    const data = { apiVersion: 1, command: null, ok: false, exitCode: 2, result: null, diagnostics: [{ code: 'UNKNOWN_COMMAND', severity: 'error', message: 'Unknown command', objectIds: [] }] };
    expect(validateShape('hostError', data).valid).toBe(true);
    expect(validateShape('response', data).valid).toBe(false);
    for (const patch of [{ command: 'inspect' }, { exitCode: 7 }, { diagnostics: [] }, { result: {} }, { extra: true }, { diagnostics: [{ ...data.diagnostics[0], severity: 'warning' }] }]) {
      expect(validateShape('hostError', { ...data, ...patch }).valid).toBe(false);
    }
    expect(validateCommonValue('diagnostic', { ...data.diagnostics[0], revision: 1 }).valid).toBe(false);
  });
});
