import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createScenarioRun, runScenario, validateScenario } from '../../src/core/scenario';
import { observe, verifyScenario } from '../../src/core/verification';
import { decodeScenario } from '../../src/core/persistence';
import type { ObservableValue, Probe, Project, Scenario } from '../../src/core/domain/types';
import { scenario, selfhold } from '../fixtures/scenarios/build';

const inherited = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'] as const;
const expectedValues: readonly ObservableValue[] = [
  { quality: 'known', value: true }, { quality: 'known', value: false },
  { quality: 'unknown', code: 'OBSERVATION_UNAVAILABLE' },
  { quality: 'unsupported', code: 'UNSUPPORTED_TOPOLOGY' },
  { quality: 'faulted', code: 'SOURCE_SHORT' }
];
const targets = [{ kind: 'device', id: 'device3' }, { kind: 'instance', id: 'instance3' }] as const;
function withProbe(p: Project, probe: Probe, expected?: ObservableValue): Scenario {
  const s = scenario(p);
  return { ...s, probes: expected ? [] : [probe], expect: {
    outcome: { stage: 'run', status: 'completed' },
    observations: expected ? [{ ...probe, expected }] : []
  } };
}
function rejectedEverywhere(p: Project, s: Scenario, code = 'INVALID_PROBE') {
  // Shape-valid requests must fail at the semantic boundary, not be silently
  // filtered into a successful modeled result (including unavailable assertions).
  expect(decodeScenario(JSON.stringify(s)).ok).toBe(true);
  const before = structuredClone({ p, s });
  for (const result of [validateScenario(p, s), createScenarioRun(p, s, 'run'), runScenario(p, s, 'run'), verifyScenario(p, s, 'run')]) {
    expect(result).toMatchObject({ ok: false, category: 'invalid-document', diagnostics: [{ code }] });
    expect('value' in result).toBe(false);
  }
  expect({ p, s }).toEqual(before);
}

describe('declared observable membership at actual scenario entry points', () => {
  for (const target of targets) {
    it.each(inherited)(`${target.kind} probe rejects inherited %s without executing or mutating input`, observable => {
      const p = selfhold();
      rejectedEverywhere(p, withProbe(p, { atMs: 0, target, observable }));
    });
    for (const expected of expectedValues) {
      it.each(inherited)(`${target.kind} expected ${JSON.stringify(expected)} rejects inherited %s`, observable => {
        const p = selfhold();
        rejectedEverywhere(p, withProbe(p, { atMs: 0, target, observable }, expected));
      });
    }
  }
  it.each(inherited)('accepts legal entity ID %s with genuine device and instance channels', id => {
    // Remap references as data, not labels: IDs are globally unique, so test
    // device and instance renaming separately rather than reusing one ID.
    for (const target of targets) {
      const p = JSON.parse(JSON.stringify(selfhold(), (_key, value: unknown) => value === target.id ? id : value)) as Project;
      const probe: Probe = { atMs: 10, target: { ...target, id }, observable: target.kind === 'device' ? 'energized' : 'powered' };
      const s = withProbe(p, probe, { quality: 'known', value: true });
      expect(validateScenario(p, s).ok).toBe(true);
      const driver = createScenarioRun(p, s, 'run');
      if (!driver.ok) throw Error(JSON.stringify(driver));
      while (!driver.value.done()) expect(driver.value.drive(1).ok).toBe(true);
      const run = runScenario(p, s, 'run');
      if (!run.ok) throw Error(JSON.stringify(run));
      expect(driver.value.report()).toEqual(run.value);
      expect(observe(run.value, probe)).toEqual({ quality: 'known', value: true });
      expect(verifyScenario(p, s, 'run')).toMatchObject({ ok: true, value: { verificationOutcome: 'passed' } });
    }
  });
  it('preserves exact channel case, target existence and Boolean expected types', () => {
    const p = selfhold();
    for (const target of targets) {
      const observable = target.kind === 'device' ? 'energized' : 'powered';
      rejectedEverywhere(p, withProbe(p, { atMs: 0, target, observable: observable.toUpperCase() }));
      rejectedEverywhere(p, withProbe(p, { atMs: 0, target: { ...target, id: 'constructor' }, observable }));
      // Null is schema-allowed scalar data, but not the channel's declared Boolean type.
      rejectedEverywhere(p, withProbe(p, { atMs: 0, target, observable }, { quality: 'known', value: null }), 'EXPECTED_TYPE');
      for (const value of [false, true]) {
        const s = withProbe(p, { atMs: value ? 10 : 0, target, observable }, { quality: 'known', value });
        expect(verifyScenario(p, s, 'run')).toMatchObject({ ok: true, value: { verificationOutcome: 'passed' } });
      }
    }
  });
  it('valid channels with unavailable expectations retain mismatch semantics, never pass', () => {
    const p = selfhold();
    for (const target of targets) for (const expected of expectedValues.filter(v => v.quality !== 'known')) {
      const s = withProbe(p, { atMs: 0, target, observable: target.kind === 'device' ? 'energized' : 'powered' }, expected);
      expect(validateScenario(p, s).ok).toBe(true);
      expect(verifyScenario(p, s, 'run')).toMatchObject({ ok: true, value: { verificationOutcome: 'failed', observed: { runOutcome: 'completed' } } });
    }
  });
  it('rejects arbitrary undeclared channel names independently of target kind and expectation quality, seed20261119/200', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'), { maxLength: 40 }).map(chars => chars.join('')), fc.boolean(), fc.integer({ min: 0, max: expectedValues.length }), (suffix, instance, quality) => {
      const p = selfhold(), target = targets[instance ? 1 : 0];
      rejectedEverywhere(p, withProbe(p, { atMs: 0, target, observable: `undeclared${suffix}` }, expectedValues[quality]));
    }), { seed: 20261119, numRuns: 200 });
  });
});
