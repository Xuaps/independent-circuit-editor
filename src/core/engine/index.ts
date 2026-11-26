import { limitedMetadata } from '../../contracts/metadata';
import { compileProject } from '../compiler';
import { validateProject } from '../domain/project';
import { diagnostic, snapshot, type Diagnostic, type Instance, type ObservableValue, type ProbeTarget, type Result, type Scenario } from '../domain/types';
import { evaluateElectrical, type ElectricalResult } from '../electrical';
import { isolateData } from '../persistence/json';
import { getModel, known } from './models';
export { models, getModel } from './models';
export const RUNTIME_LIMITS = Object.freeze({ time: 86400000, delta: 128, events: 100000, trace: 100000, interactiveTrace: 10000, traceBytes: 32 * 1024 * 1024, pending: 1024, observations: 10000 });
export type RuntimeLimits = Readonly<{ maxDeltaCycles: number; maxEvents: number; maxTraceEntries: number; traceBytes: number; pending: number }>;
export type Action = Readonly<{ instanceId: string; action: 'press' | 'release'; payload: Readonly<Record<string, never>> }>;
export type Transaction = Scenario['inputs'][number];
export type Observation = Readonly<{ target: ProbeTarget; observable: string; value: ObservableValue }>;
export type Frame = Readonly<{ atMs: number; observations: readonly Observation[] }>;
export type Status = 'active' | 'faulted' | 'resourceLimited' | 'interrupted' | 'stopped';
export type RuntimeView = Readonly<{ runId: string; revision: number; status: Status; timeMs: number; lastCommittedTimeMs: number | null; publication: number; processedEvents: number; pending: readonly Transaction[]; live: readonly Observation[]; electrical: Extract<ElectricalResult, { ok: true }> | null; history: readonly Frame[]; traceBytes: number; complete: boolean; diagnostics: readonly Diagnostic[] }>;
export const validTime = (t: number) => Number.isSafeInteger(t) && t >= 0 && t <= RUNTIME_LIMITS.time;
export function runtimeLimits(lower: Partial<RuntimeLimits> = {}): RuntimeLimits | undefined {
  const values = { maxDeltaCycles: 128, maxEvents: 100000, maxTraceEntries: 10000, traceBytes: RUNTIME_LIMITS.traceBytes, pending: 1024, ...lower };
  const caps: RuntimeLimits = { maxDeltaCycles: 128, maxEvents: 100000, maxTraceEntries: 100000, traceBytes: RUNTIME_LIMITS.traceBytes, pending: 1024 };
  for (const k of Object.keys(caps) as (keyof RuntimeLimits)[]) if (!Number.isSafeInteger(values[k]) || values[k] < 1 || values[k] > caps[k]) return undefined;
  return values;
}
function wireDiagnostics(ds: readonly Diagnostic[], atMs: number): readonly Diagnostic[] {
  return ds.map(d => ({ ...d, atMs, objectIds: d.objectIds.slice(0, 100), message: d.objectIds.length > 100 ? `${d.code}: showing 100 of ${d.objectIds.length} implicated objects (not a minimal witness)` : d.message }));
}
/** Creation validates/compiles but deliberately does not evaluate the released state.
 * First transaction at zero may open a rest-state short. Hosts must initialize before advancing. */
export function createEngine(input: unknown, runId: string, lower: Partial<RuntimeLimits> = {}) {
  const checked = validateProject(input); if (!checked.ok) return checked;
  const limits = runtimeLimits(lower);
  if (!limits || typeof runId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(runId)) return { ok: false as const, category: 'invalid-document' as const, diagnostics: [diagnostic('INVALID_RUNTIME_OPTIONS')] };
  const compiled = compileProject(checked.value); if (!compiled.ok) return compiled;
  const p = checked.value, c = compiled.value;
  const instances = p.sheets.flatMap(s => s.instances).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byInstance = new Map(instances.map(i => [i.id, i]));
  const owners = instances.filter(i => getModel(i.definition.id)!.definition.role === 'controller');
  const ownerByDevice = new Map(owners.map(i => [i.deviceId!, i]));
  const buttons = owners.filter(i => getModel(i.definition.id)!.definition.deviceKind === 'pushButton');
  let states = new Map(owners.map(i => [i.deviceId!, getModel(i.definition.id)!.initialize()]));
  let status: Status = 'active', time = 0, committed: number | null = null, publication = 0, events = 0, sequence = 0;
  let pending: Transaction[] = [], frames: Frame[] = [], retainedBytes = 0, live: readonly Observation[] = [], diagnostics: readonly Diagnostic[] = [];
  let electrical: Extract<ElectricalResult, { ok: true }> | null = null;
  const unavailable = (quality: 'unknown' | 'unsupported' | 'faulted', code: string): Observation[] => channels().map(o => ({ ...o, value: { quality, code } }));
  function channels(state = states, solved?: Extract<ElectricalResult, { ok: true }>): Observation[] {
    const result: Observation[] = [], loads = new Map(solved?.loads.map(l => [l.instanceId, l.powered]) ?? []);
    for (const d of [...p.devices].sort((a,b) => a.id < b.id ? -1 : 1)) {
      const owner = ownerByDevice.get(d.id);
      const observable = Object.keys(limitedMetadata.deviceObservables[d.kind])[0]!;
      result.push({ target: { kind: 'device', id: d.id }, observable, value: owner ? known(state.get(d.id)!) : { quality: 'unknown', code: 'UNPLACED_DEVICE' } });
    }
    for (const i of instances) {
      const model = getModel(i.definition.id)!;
      for (const [observable, value] of Object.entries(model.instanceValues(state.get(i.deviceId!)!, loads.get(i.id) ?? false))) result.push({ target: { kind: 'instance', id: i.id }, observable, value: known(value) });
    }
    return result;
  }
  live = unavailable('unknown', 'NOT_INITIALIZED');
  function view(): RuntimeView { return snapshot({ runId, revision: p.revision, status, timeMs: time, lastCommittedTimeMs: committed, publication, processedEvents: events, pending, live, electrical, history: frames, traceBytes: retainedBytes, complete: (status === 'active' && committed !== null) || status === 'faulted', diagnostics }); }
  function terminal(next: Status, code: string, atMs: number, ds: readonly Diagnostic[] = [diagnostic(code)], quality: 'unknown' | 'unsupported' | 'faulted' = 'unknown') {
    status = next; time = atMs; pending = []; electrical = null; diagnostics = wireDiagnostics(ds, atMs); live = unavailable(quality, code); publication++;
  }
  function validateActions(input: unknown, trustedRelease = false): Result<readonly Action[]> {
    const isolated = isolateData(input); if (!isolated.ok) return isolated;
    const a = isolated.value;
    const fail = (): Result<readonly Action[]> => ({ ok: false, category: 'invalid-document', diagnostics: [diagnostic('INVALID_ACTION')] });
    if (!Array.isArray(a) || !a.length || a.length > (trustedRelease ? buttons.length : 128)) return fail();
    const ids = new Set<string>();
    for (const row of a) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'action,instanceId,payload' || typeof row.instanceId !== 'string' || ids.has(row.instanceId)) return fail();
      const i = byInstance.get(row.instanceId), m = i && getModel(i.definition.id);
      if (!m || (row.action !== 'press' && row.action !== 'release') || !m.definition.actions.includes(row.action) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload) || Object.keys(row.payload).length) return fail();
      ids.add(row.instanceId);
    }
    return { ok: true, value: snapshot(a) as readonly Action[], diagnostics: [] };
  }
  function request(input: unknown, trustedRelease = false): Result<Transaction> {
    const isolated = isolateData(input); if (!isolated.ok) return isolated;
    const data = isolated.value;
    const reject = (code: string): Result<Transaction> => ({ ok: false, category: 'invalid-document', diagnostics: [diagnostic(code)] });
    if (status !== 'active') return reject('RUN_TERMINATED');
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'actions,atMs,revision,runId,sequence') return reject('INVALID_REQUEST');
    const r = data as Record<string, unknown>;
    if (r.runId !== runId || r.revision !== p.revision) return reject('STALE_RUN');
    if (typeof r.sequence !== 'number' || !Number.isSafeInteger(r.sequence) || r.sequence <= sequence) return reject('STALE_SEQUENCE');
    if (typeof r.atMs !== 'number' || !validTime(r.atMs) || r.atMs < time || r.atMs < (pending.at(-1)?.atMs ?? time) || (committed === null && r.atMs !== 0)) return reject('TIME_RANGE');
    const actions = validateActions(r.actions, trustedRelease); if (!actions.ok) return actions;
    if (pending.length >= limits!.pending) return { ok: false, category: 'resource-limit', diagnostics: [diagnostic('PENDING_LIMIT')] };
    const transaction = snapshot({ atMs: r.atMs, sequence: r.sequence, actions: actions.value });
    pending.push(transaction); sequence = r.sequence;
    return { ok: true, value: transaction, diagnostics: [] };
  }
  function settle(atMs: number, actions: readonly Transaction['actions'][number][], external: boolean): boolean {
    if (external && events >= limits!.maxEvents) { terminal('resourceLimited', 'EVENT_LIMIT', atMs); return false; }
    if (external) events++;
    let candidate = new Map(states);
    for (const a of actions) {
      const i = byInstance.get(a.instanceId)!;
      candidate.set(i.deviceId!, getModel(i.definition.id)!.action!(candidate.get(i.deviceId!)!, a.action as 'press' | 'release'));
    }
    const seen = new Set<string>();
    for (let delta = 0; delta < limits!.maxDeltaCycles; delta++) {
      // Complete meaningful P0 state: all owners, hence every closure. No counters in key.
      const key = JSON.stringify([...candidate]);
      if (seen.has(key)) { terminal('faulted', 'NONCONVERGENT', atMs, undefined, 'faulted'); return false; }
      seen.add(key);
      const closures = c.contacts.map(i => ({ instanceId: i.instanceId, closed: { quality: 'known' as const, value: getModel(i.definitionId)!.closure!(candidate.get(i.deviceId)!) } }));
      const solved = evaluateElectrical(c, closures);
      if (!solved.ok) {
        const resource = solved.kind === 'resource-limit';
        terminal(resource ? 'resourceLimited' : 'faulted', solved.diagnostics[0]!.code, atMs, solved.diagnostics, resource ? 'unknown' : solved.kind === 'unsupported' ? 'unsupported' : 'faulted'); return false;
      }
      const powers = new Map(solved.loads.map(l => [l.instanceId, l.powered]));
      const next = new Map(candidate);
      for (const i of owners) next.set(i.deviceId!, getModel(i.definition.id)!.transition(candidate.get(i.deviceId!)!, powers.get(i.id) ?? false));
      if ([...next].every(([id, v]) => candidate.get(id) === v)) {
        const observations = channels(next, solved), frame = { atMs, observations };
        const size = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
        const replace = frames.at(-1)?.atMs === atMs;
        const previousSize = replace ? new TextEncoder().encode(JSON.stringify(frames.at(-1)!)).byteLength : 0;
        if (observations.length > RUNTIME_LIMITS.observations || (!replace && frames.length >= limits!.maxTraceEntries) || retainedBytes - previousSize + size > limits!.traceBytes) { terminal('resourceLimited', 'TRACE_LIMIT', atMs); return false; }
        states = next; time = atMs; committed = atMs; live = observations; electrical = solved;
        if (replace) frames[frames.length - 1] = frame; else frames.push(frame);
        retainedBytes += size - previousSize; publication++; return true;
      }
      candidate = next;
      if (seen.has(JSON.stringify([...candidate]))) { terminal('faulted', 'NONCONVERGENT', atMs, undefined, 'faulted'); return false; }
    }
    terminal('resourceLimited', 'SETTLING_LIMIT', atMs); return false;
  }
  function initialize(): boolean {
    if (status !== 'active') return false;
    if (committed !== null) return true;
    // Pending zero-time inputs are evaluated instead of an unsolicited rest-state solve.
    if (pending.length) { const t = pending.shift()!; return settle(t.atMs, t.actions, true); }
    return settle(0, [], false);
  }
  /** At most units atomic transactions/initial solves; time jumps only once due work is exhausted. */
  function drive(untilMs: number, units = 1): Result<{ reached: boolean; processed: number }> {
    if (!validTime(untilMs) || untilMs < time || !Number.isSafeInteger(units) || units < 1 || units > 100000) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('TIME_RANGE')] };
    if (status !== 'active') return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('RUN_TERMINATED')] };
    let processed = 0;
    if (committed === null) { initialize(); processed++; }
    while (status === 'active' && processed < units && pending.length && pending[0]!.atMs <= untilMs) {
      const t = pending.shift()!; settle(t.atMs, t.actions, true); processed++;
    }
    const reached = status === 'active' && !(pending.length && pending[0]!.atMs <= untilMs);
    if (reached) time = untilMs;
    return { ok: true, value: { reached, processed }, diagnostics: [] };
  }
  function releaseAll(nextSequence: number): Result<Transaction | null> {
    if (!buttons.length) return { ok: true, value: null, diagnostics: [] };
    return request({ runId, revision: p.revision, sequence: nextSequence, atMs: time, actions: buttons.map(i => ({ instanceId: i.id, action: 'release', payload: {} })) }, true);
  }
  function clear(kind: 'stop' | 'reset' | 'cancel') {
    if (kind === 'cancel' && status !== 'active') return;
    pending = []; states = new Map(); electrical = null;
    if (kind === 'reset') { frames = []; retainedBytes = 0; committed = null; time = 0; diagnostics = []; }
    status = kind === 'cancel' ? 'interrupted' : 'stopped';
    live = unavailable('unknown', kind === 'cancel' ? 'INTERRUPTED' : 'STOPPED'); publication++;
    if (kind === 'cancel') diagnostics = wireDiagnostics([diagnostic('INTERRUPTED')], time);
  }
  return { ok: true as const, value: Object.freeze({ view, request: (r: unknown) => request(r), validateActions: (a: unknown) => validateActions(a), initialize, drive, releaseAll, clear, identity: snapshot({ projectId: p.projectId, revision: p.revision, modelSet: p.modelSet }), instance: (id: string): Instance | undefined => byInstance.get(id) }), diagnostics: [] };
}
export type Engine = Extract<ReturnType<typeof createEngine>, { ok: true }>['value'];
