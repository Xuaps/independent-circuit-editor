import { limitedMetadata } from '../../contracts/metadata';
import { getDefinition } from '../catalog';
import { validateProject } from '../domain/project';
import { diagnostic, snapshot, type Diagnostic, type Probe, type Project, type Result, type Scenario } from '../domain/types';
import { createEngine, runtimeLimits, type Engine, type Frame, type RuntimeLimits } from '../engine';
import { decodeScenario } from '../persistence';
import { isolateData } from '../persistence/json';
export type RunReport = Readonly<{
  project: Scenario['target']; validationOutcome: 'accepted' | 'rejected';
  runOutcome: 'notStarted' | 'running' | 'completed' | 'faulted' | 'resourceLimited' | 'interrupted';
  untilMs: number; finalTimeMs: number | null; lastCommittedTimeMs: number | null;
  trace: Readonly<{ complete: boolean; entries: readonly Frame[] }>;
  diagnostics: readonly Diagnostic[];
}>;
export function validateScenario(project: Project, input: unknown): Result<Scenario> {
  let decoded: Result<Scenario>;
  if (typeof input === 'string' || input instanceof Uint8Array) decoded = decodeScenario(input);
  else {
    const isolated = isolateData(input); if (!isolated.ok) return isolated;
    decoded = decodeScenario(JSON.stringify(isolated.value));
  }
  if (!decoded.ok) return decoded;
  const s = decoded.value;
  const fail = (code: string): Result<Scenario> => ({ ok: false, category: 'invalid-document', diagnostics: [diagnostic(code)] });
  if (s.target.projectId !== project.projectId || s.target.revision !== project.revision || s.target.modelSet.id !== project.modelSet.id || s.target.modelSet.version !== project.modelSet.version) return fail('SCENARIO_TARGET');
  const instances = new Map(project.sheets.flatMap(sh => sh.instances).map(i => [i.id, i]));
  const devices = new Map(project.devices.map(d => [d.id, d]));
  let time = 0, sequence = 0;
  for (const t of s.inputs) {
    if (t.atMs < time || t.atMs > s.untilMs || t.sequence <= sequence) return fail('SCENARIO_ORDER');
    time = t.atMs; sequence = t.sequence;
    const seen = new Set<string>();
    for (const a of t.actions) {
      const instance = instances.get(a.instanceId), def = instance && getDefinition(instance.definition.id, instance.definition.version);
      if (!def || !def.actions.includes(a.action) || seen.has(a.instanceId)) return fail('INVALID_ACTION');
      seen.add(a.instanceId);
    }
  }
  // Request-controlled dictionary keys require own membership AND a supported
  // declared scalar type. All P0 channels are Boolean; inherited Object members
  // (or future unsupported type declarations) must never authorize a probe.
  function declaredType(channels: Readonly<Record<string, unknown>> | undefined, name: string): 'boolean' | undefined {
    return channels && Object.hasOwn(channels, name) && channels[name] === 'boolean' ? 'boolean' : undefined;
  }
  function probeType(probe: Probe): 'boolean' | undefined {
    if (probe.target.kind === 'device') {
      const device = devices.get(probe.target.id);
      return declaredType(device ? limitedMetadata.deviceObservables[device.kind] : undefined, probe.observable);
    }
    const i = instances.get(probe.target.id);
    return declaredType(i ? getDefinition(i.definition.id, i.definition.version)?.observables : undefined, probe.observable);
  }
  for (const probe of [...s.probes, ...(s.expect?.observations ?? [])]) {
    const type = probeType(probe);
    if (probe.atMs > s.untilMs || !type) return fail('INVALID_PROBE');
  }
  for (const probe of s.expect?.observations ?? []) if (probe.expected.quality === 'known' && typeof probe.expected.value !== probeType(probe)) return fail('EXPECTED_TYPE');
  return { ok: true, value: s, diagnostics: [] };
}
/** Streams <=10000 inputs one at a time, never into the 1024 online queue.
 * A drive unit is one bounded settling transaction, not one millisecond. */
export function createScenarioRun(projectInput: unknown, scenarioInput: unknown, runId: string, lower: Partial<RuntimeLimits> = {}) {
  const project = validateProject(projectInput); if (!project.ok) return project;
  const scenario = validateScenario(project.value, scenarioInput); if (!scenario.ok) return scenario;
  const s = scenario.value;
  if (!runtimeLimits(lower)) return { ok: false as const, category: 'invalid-document' as const, diagnostics: [diagnostic('INVALID_RUNTIME_OPTIONS')] };
  const engineResult = createEngine(project.value, runId, { ...lower,
    maxEvents: Math.min(s.limits.maxEvents, lower.maxEvents ?? 100000),
    maxDeltaCycles: Math.min(s.limits.maxDeltaCycles, lower.maxDeltaCycles ?? 128),
    maxTraceEntries: Math.min(s.limits.maxTraceEntries, lower.maxTraceEntries ?? 100000)
  });
  // Only genuine compilation/preflight rejection is a validation-negative modeled result.
  if (!engineResult.ok && (engineResult.category === 'resource-limit' || engineResult.diagnostics.some(d => d.code === 'INVALID_RUNTIME_OPTIONS'))) return engineResult;
  const engine: Engine | undefined = engineResult.ok ? engineResult.value : undefined;
  let cursor = 0, initialized = false, finished = !engine;
  const preflight = engineResult.ok ? [] : engineResult.diagnostics.map(d => ({ ...d, objectIds: d.objectIds.slice(0,100), message: d.objectIds.length > 100 ? `${d.code}: showing 100 of ${d.objectIds.length} implicated objects` : d.message }));
  function report(): RunReport {
    const v = engine?.view();
    return snapshot({ project: s.target, validationOutcome: engine ? 'accepted' : 'rejected',
      runOutcome: !engine ? 'notStarted' : v!.status === 'active' ? (finished ? 'completed' : 'running') : v!.status === 'stopped' ? 'interrupted' : v!.status,
      untilMs: s.untilMs, finalTimeMs: v?.timeMs ?? null, lastCommittedTimeMs: v?.lastCommittedTimeMs ?? null,
      trace: { complete: !engine || (finished && (v!.status === 'active' || v!.status === 'faulted')),
        // An earlier same-time commit is history, not the final observation of a failed timestamp.
        entries: v ? (v.status === 'active' && (finished || s.inputs[cursor]?.atMs !== v.timeMs) ? v.history : v.history.filter(f => f.atMs < v.timeMs)) : [] }, diagnostics: v?.diagnostics ?? preflight });
  }
  function drive(units = 1): Result<{ done: boolean; processed: number }> {
    if (!Number.isSafeInteger(units) || units < 1 || units > 100000) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('WORK_RANGE')] };
    let processed = 0;
    while (!finished && processed < units) {
      const next = s.inputs[cursor];
      if (!initialized && (!next || next.atMs !== 0)) {
        engine!.drive(0); initialized = true; processed++;
      } else if (next) {
        const accepted = engine!.request({ ...next, runId, revision: s.target.revision });
        if (!accepted.ok) {
          // Semantic ingress was already validated; a lower trusted resource bound can still reject.
          engine!.clear('cancel'); finished = true; return accepted;
        }
        engine!.drive(next.atMs); initialized = true; cursor++; processed++;
      } else {
        engine!.drive(s.untilMs); finished = true;
      }
      if (engine!.view().status !== 'active') finished = true;
    }
    if (!finished && cursor === s.inputs.length && initialized && engine!.view().status === 'active') { engine!.drive(s.untilMs); finished = true; }
    return { ok: true, value: { done: finished, processed }, diagnostics: [] };
  }
  return { ok: true as const, value: Object.freeze({ drive, report, scenario: s, done: () => finished,
    cancel: () => { if (!finished) { engine!.clear('cancel'); finished = true; } return report(); }
  }), diagnostics: [] };
}
export type ScenarioDriver = Extract<ReturnType<typeof createScenarioRun>, { ok: true }>['value'];
/** Convenience bounded synchronous host-neutral runner; cooperative hosts use createScenarioRun. */
export function runScenario(project: unknown, scenario: unknown, runId: string, lower: Partial<RuntimeLimits> = {}): Result<RunReport> {
  const run = createScenarioRun(project, scenario, runId, lower); if (!run.ok) return run;
  while (!run.value.done()) { const step = run.value.drive(64); if (!step.ok) return step; }
  return { ok: true, value: run.value.report(), diagnostics: [] };
}
