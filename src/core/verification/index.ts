import { diagnostic, snapshot, type ObservableValue, type Probe, type Result, type Scenario } from '../domain/types';
import { createScenarioRun, type RunReport } from '../scenario';
import type { RuntimeLimits } from '../engine';
export type Check = Readonly<{ id: string; passed: boolean; message: string }>;
export type Verification = Readonly<{ observed: RunReport; verificationOutcome: 'passed' | 'failed' | 'incomplete'; checks: readonly Check[]; expectedOutcome: NonNullable<Scenario['expect']>['outcome'] }>;
/** Piecewise constant settled P0 observations. A fault timestamp has no committed live state. */
export function observe(report: RunReport, probe: Probe): ObservableValue {
  if (report.validationOutcome === 'rejected' || report.finalTimeMs === null || probe.atMs > report.finalTimeMs) return { quality: 'unknown', code: 'OBSERVATION_UNAVAILABLE' };
  if (report.runOutcome !== 'completed' && probe.atMs >= report.finalTimeMs) return { quality: report.runOutcome === 'faulted' ? (report.diagnostics.some(d => d.code === 'UNSUPPORTED_TOPOLOGY') ? 'unsupported' : 'faulted') : 'unknown', code: report.diagnostics[0]?.code ?? 'INCOMPLETE' };
  let frame: RunReport['trace']['entries'][number] | undefined;
  for (const f of report.trace.entries) { if (f.atMs > probe.atMs) break; frame = f; }
  return frame?.observations.find(o => o.target.kind === probe.target.kind && o.target.id === probe.target.id && o.observable === probe.observable)?.value ?? { quality: 'unknown', code: 'OBSERVATION_UNAVAILABLE' };
}
/** Report/scenario arguments must originate from the same validated execution; identity is checked as well. */
export function verifyReport(observed: RunReport, scenario: Scenario): Verification | undefined {
  if (!scenario.expect) return undefined;
  const expected = scenario.expect.outcome;
  const complete = observed.trace.complete && !['running', 'resourceLimited', 'interrupted'].includes(observed.runOutcome) && !observed.diagnostics.some(d => d.code === 'SETTLING_LIMIT');
  const targetMatches = observed.project.projectId === scenario.target.projectId && observed.project.revision === scenario.target.revision && observed.project.modelSet.id === scenario.target.modelSet.id && observed.project.modelSet.version === scenario.target.modelSet.version && observed.untilMs === scenario.untilMs;
  const outcomeMatches = targetMatches && (expected.stage === 'validation'
    ? observed.validationOutcome === 'rejected' && observed.runOutcome === 'notStarted' && observed.diagnostics.some(d => d.code === expected.code)
    : observed.validationOutcome === 'accepted' && observed.runOutcome === expected.status && (expected.status === 'completed' || observed.diagnostics.some(d => d.code === expected.code)));
  const checks: Check[] = [{ id: 'outcome', passed: complete && outcomeMatches, message: `Expected ${expected.stage}/${expected.status}; observed ${observed.validationOutcome}/${observed.runOutcome}` }];
  let available = true;
  scenario.expect.observations.forEach((probe, index) => {
    const actual = observe(observed, probe);
    const known = actual.quality === 'known'; available &&= known;
    const passed = known && probe.expected.quality === 'known' && actual.value === probe.expected.value;
    checks.push({ id: `observation_${index}`, passed, message: known ? (passed ? 'Known observation matched' : 'Known observation mismatch') : `Required observation unavailable: ${actual.quality}/${actual.code}` });
  });
  return snapshot({ observed, expectedOutcome: expected, checks,
    verificationOutcome: !complete || !available ? 'incomplete' : checks.every(c => c.passed) ? 'passed' : 'failed' });
}
/** Convenience use case. Cooperative hosts drive createScenarioRun and call verifyReport with its scenario. */
export function verifyScenario(project: unknown, scenario: unknown, runId: string, lower: Partial<RuntimeLimits> = {}): Result<Verification> {
  const run = createScenarioRun(project, scenario, runId, lower); if (!run.ok) return run;
  if (!run.value.scenario.expect) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('EXPECT_REQUIRED')] };
  while (!run.value.done()) { const next = run.value.drive(64); if (!next.ok) return next; }
  return { ok: true, value: verifyReport(run.value.report(), run.value.scenario)!, diagnostics: [] };
}
