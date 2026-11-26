import { runtimeController } from '../../hosts/browser/simulation/controller';
import type { Command, RuntimeState, WorkerFactory } from '../../hosts/browser/simulation/protocol';
import { createSession } from '../../core/session';
import { createProject, runReadiness } from '../../core/domain/project';
import { defaultDevice, getDefinition } from '../../core/catalog';
import { operationsFor } from '../../core/commands';
import { planCopy, planDelete, planDetach, planJoin, planSplit, planTransforms } from '../../core/editor/planners';
import { planRelocateJunctions } from '../../core/editor/relocation';
import { endpointPosition } from '../../core/domain/geometry';
import { serializeProject } from '../../core/persistence';
import { diagnostic, freeze, type Endpoint, type Instance, type Operation, type Point, type Project, type Result, type Transform } from '../../core/domain/types';

export type Intent =
 | { kind: 'place'; definition: string; position: Point; rotation?: Transform['rotation']; mirrorX?: boolean }
 | { kind: 'apply'; operations: readonly Operation[] }
 | { kind: 'transform'; transforms: Readonly<Record<string, Transform>> }
 | { kind: 'copy'; ids: readonly string[] }
 | { kind: 'delete'; ids: readonly string[]; policy: 'detach' | 'remove-wires' }
 | { kind: 'wire'; from: Endpoint; to: Endpoint }
 | { kind: 'split'; wireId: string; point: Point; from?: Endpoint }
 | { kind: 'join'; wireId: string; side: 'from' | 'to'; endpoint: Endpoint }
 | { kind: 'detach'; wireId: string; side: 'from' | 'to' }
 | { kind: 'relocate'; id: string; position: Point }
 | { kind: 'junction'; position: Point }
 | { kind: 'annotation'; position: Point; text: string }
 | { kind: 'undo' | 'redo' };
export type EditorView = ReturnType<Extract<ReturnType<typeof createSession>, { ok: true }>['value']['view']>;
export type EditReceipt = { ok: boolean; diagnostics: readonly import('../../core/domain/types').Diagnostic[]; selection?: readonly string[] };
/** Replaceable transport port. Cached snapshots + ordered async messages; session is never exposed. */
export interface FileTransaction {
  design(): Project;
  replace(project?: Project): void;
  confirmSaved(): void;
}
export interface EditorClient {
  run(): Promise<void>;
  control(command: Exclude<Command, { kind: 'start' }>): void;
  stop(reset?: boolean): void;
  runtimeError(): string | null;
  /** Locks authoring immediately, drains prior edits, then serializes the whole host transaction. */
  fileTransaction<T>(action: (port: FileTransaction) => Promise<T>): Promise<T>;
  getSnapshot(): EditorView;
  subscribe(listener: () => void): () => void;
  dispatch(intent: Intent): Promise<EditReceipt>;
  inspect(): string;
  preflight(): ReturnType<typeof runReadiness>;
}
export const freshId = () => `u_${crypto.randomUUID()}`;
export function createLocalClient(input?: Project, id: () => string = freshId, workerFactory?: WorkerFactory): EditorClient {
  const blank = input ? { ok: true as const, value: input } : createProject(id(), id(), 'Untitled circuit');
  if (!blank.ok) throw new Error('Invalid blank project');
  const created = createSession(blank.value); if (!created.ok) throw new Error('Invalid editor project');
  let session = created.value;
  const listeners = new Set<() => void>();
  let persistent = session.view(), cached = persistent, queue = Promise.resolve(), fileBusy = false, locked = false, document = 0, runTicket = 0;
  let runtime: RuntimeState = { mode: 'Editing', runtime: null, error: null };
  const publish = (refresh = true) => { if (refresh) persistent = session.view(); cached = freeze({ ...persistent, mode: runtime.mode, runtime: runtime.runtime }); for (const listener of listeners) listener(); };
  const controller = runtimeController(next => { runtime = next; locked = next.mode !== 'Editing'; publish(false); }, workerFactory);
  const fail = (code: string): Result<never> => ({ ok: false, category: 'invalid-document', diagnostics: [diagnostic(code)] });
  function name(project: Project, prefix: string, extra: string[] = []) {
    const used = new Set([...project.devices.map(d => d.name.toLowerCase()), ...extra.map(n => n.toLowerCase())]);
    let n = 1; while (used.has(`${prefix}${n}`.toLowerCase())) n++; return `${prefix}${n}`;
  }
  function execute(intent: Intent): EditReceipt {
    const p = session.design(), s = p.sheets[0]!;
    const apply = (operations: readonly Operation[]) => session.apply(operationsFor(p, operations));
    const planned = (r: Result<import('../../core/domain/types').Operations>) => r.ok ? session.apply(r.value) : r;
    let result: { ok: boolean; diagnostics: readonly import('../../core/domain/types').Diagnostic[] };
    let selection: readonly string[] | undefined;
    switch (intent.kind) {
      case 'place': {
        const def = getDefinition(intent.definition); if (!def) { result = fail('UNKNOWN_DEFINITION'); break; }
        const instanceId = id(), deviceId = def.role === 'controller' ? id() : null;
        const instance: Instance = { id: instanceId, definition: { id: def.id, version: 1 }, variant: 'default', deviceId, parameters: {}, transform: { position: intent.position, rotation: intent.rotation ?? 0, mirrorX: intent.mirrorX ?? false }, label: '', markings: { showDeviceName: true, showLabel: true, showTerminals: true, terminalLabels: {} } };
        const prefix = { dcSupply: 'G', pushButton: 'S', relay: 'K', lamp: 'H' }[def.deviceKind];
        result = apply([...(deviceId ? [{ op: 'device.create' as const, device: defaultDevice(deviceId, name(p, prefix), def.deviceKind) }] : []), { op: 'instance.place', sheetId: s.id, instance }]); selection = [instanceId]; break;
      }
      case 'apply': result = apply(intent.operations); break;
      case 'transform': result = planned(planTransforms(p, intent.transforms)); break;
      case 'undo': result = session.undo(); break;
      case 'redo': result = session.redo(); break;
      case 'delete': result = planned(planDelete(p, intent.ids, intent.policy)); selection = []; break;
      case 'copy': {
        const ids: Record<string, string> = Object.create(null) as Record<string, string>, names: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const old of intent.ids) ids[old] = id();
        for (const i of s.instances.filter(i => intent.ids.includes(i.id))) if (i.deviceId && getDefinition(i.definition.id)?.role === 'controller' && !Object.hasOwn(ids, i.deviceId)) {
          ids[i.deviceId] = id(); names[i.deviceId] = name(p, p.devices.find(d => d.id === i.deviceId)!.name.replace(/\d+$/, '') || 'D', Object.values(names));
        }
        result = planned(planCopy(p, intent.ids, { ids, deviceNames: names, offset: { x: 80, y: 80 } })); selection = intent.ids.map(old => ids[old]!); break;
      }
      case 'junction': { const node = id(); result = apply([{ op: 'junction.create', sheetId: s.id, junction: { id: node, position: intent.position } }]); selection = [node]; break; }
      case 'annotation': { const node = id(); result = apply([{ op: 'annotation.add', sheetId: s.id, annotation: { id: node, position: intent.position, text: intent.text } }]); selection = [node]; break; }
      case 'wire': {
        const a = endpointPosition(s, intent.from), b = endpointPosition(s, intent.to);
        if (!a || !b) { result = fail('MISSING_ENDPOINT'); break; }
        const wireId = id(); result = apply([{ op: 'wire.add', sheetId: s.id, wire: { id: wireId, from: intent.from, to: intent.to, waypoints: a.x === b.x || a.y === b.y ? [] : [{ x: b.x, y: a.y }] } }]); selection = [wireId]; break;
      }
      case 'split': {
        const junctionId = id(), tailId = id(), split = planSplit(p, intent.wireId, intent.point, junctionId, tailId);
        if (!split.ok) { result = split; break; }
        const ops = [...split.value.operations];
        if (intent.from) {
          const a = endpointPosition(s, intent.from), b = intent.point;
          if (!a) { result = fail('MISSING_ENDPOINT'); break; }
          ops.push({ op: 'wire.add', sheetId: s.id, wire: { id: id(), from: intent.from, to: { kind: 'junction', junctionId }, waypoints: a.x === b.x || a.y === b.y ? [] : [{ x: b.x, y: a.y }] } });
        }
        result = apply(ops); selection = [junctionId]; break;
      }
      case 'detach': result = planned(planDetach(p, intent.wireId, intent.side)); break;
      case 'join': result = planned(planJoin(p, intent.wireId, intent.side, intent.endpoint)); break;
      case 'relocate': {
        const replacement = id(), r = planRelocateJunctions(p, { [intent.id]: { id: replacement, position: intent.position } });
        result = r.ok ? session.apply(r.value.batch) : r;
        if (r.ok) selection = [r.value.junctionMapping[intent.id]!]; break;
      }
    }
    if (result.ok) publish();
    return { ok: result.ok, diagnostics: result.diagnostics, ...(result.ok && selection ? { selection } : {}) };
  }
  return Object.freeze({
    run: () => {
      if (locked || fileBusy) return Promise.reject(new Error('Stop/finish file action before Run'));
      locked = true; const ticket = ++runTicket;
      // Accepted authoring has already been queued; only later intents are fenced.
      const next = queue.then(() => { if (ticket !== runTicket) return; controller.start(session.design(), document); });
      queue = next.then(() => undefined, () => undefined); return next;
    },
    control: (command: Exclude<Command, { kind: 'start' }>) => controller.command(command),
    stop: (reset = false) => { ++runTicket; controller.stop(reset); },
    runtimeError: () => runtime.error,
    getSnapshot: () => cached, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    fileTransaction: <T,>(action: (port: FileTransaction) => Promise<T>): Promise<T> => {
      if (fileBusy) return Promise.reject(new Error('Another file transaction is busy'));
      fileBusy = true;
      const next = queue.then(async () => {
        let active = true;
        const check = () => { if (!active) throw new Error('Expired file transaction'); };
        try { return await action(Object.freeze({ design: () => { check(); return session.design(); }, confirmSaved: () => { check(); session.markSaved(); publish(); }, replace: (project?: Project) => {
          check(); if (locked) throw new Error('Stop before replacing design');
          const candidate = project ? { ok: true as const, value: project } : createProject(id(), id(), 'Untitled circuit');
          if (!candidate.ok) throw new Error('Invalid blank project');
          const checked = createSession(candidate.value); if (!checked.ok) throw new Error('Invalid replacement project');
          session = checked.value; document++; ++runTicket; controller.stop(true); publish();
        } })); } finally { active = false; }
      }).finally(() => { fileBusy = false; });
      queue = next.then(() => undefined, () => undefined); return next;
    },
    dispatch: (intent: Intent) => { if (locked || fileBusy) return Promise.resolve({ ok: false, diagnostics: [diagnostic(locked ? 'EDIT_LOCKED' : 'FILE_BUSY')] }); const next = queue.then(() => execute(intent)); queue = next.then(() => undefined, () => undefined); return next; },
    inspect: () => { const r = serializeProject(session.design()); return r.ok ? r.value : r.diagnostics.map(d => d.code).join('\n'); },
    preflight: () => runReadiness(session.design()) });
}
