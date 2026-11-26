import { operationsFor, applyOperations, validateOperations } from '../commands';
import { isolateData } from '../persistence/json';
import { endpointPosition } from '../domain/geometry';
import { diagnostic, snapshot, type Endpoint, type Operation, type Operations, type Point, type Project, type Result, type Transform } from '../domain/types';
export type Relocation = Readonly<{ id: string; position: Point }>;
export type RelocationPlan = Readonly<{ batch: Operations; junctionMapping: Readonly<Record<string, string>> }>;
/** EXPLICIT identity replacement, not an identity-preserving junction transform. Every incident endpoint is remapped. */
export function planRelocateJunctions(project: Project, replacements: Readonly<Record<string, Relocation>>, transforms: Readonly<Record<string, Transform>> = {}): Result<RelocationPlan> {
  const isolated = isolateData({ replacements, transforms }); if (!isolated.ok) return isolated;
  ({ replacements, transforms } = isolated.value as { replacements: typeof replacements; transforms: typeof transforms });
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements) || !transforms || typeof transforms !== 'object' || Array.isArray(transforms)) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('INVALID_GESTURE')] };
  const sheet = project.sheets[0]!, oldIds = Object.keys(replacements), instanceIds = Object.keys(transforms);
  const fail = (code: string): Result<never> => ({ ok: false, category: 'invalid-document', diagnostics: [diagnostic(code)] });
  if (!oldIds.length || oldIds.some(id => !sheet.junctions.some(j => j.id === id)) || instanceIds.some(id => !sheet.instances.some(i => i.id === id))) return fail('MISSING_TARGET');
  const ops: Operation[] = [], mapping: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const old of oldIds) {
    const replacement = replacements[old]!; if (!replacement?.id) return fail('MISSING_REPLACEMENT_ID');
    mapping[old] = replacement.id;
    ops.push({ op: 'junction.create', sheetId: sheet.id, junction: replacement });
  }
  for (const id of instanceIds) ops.push({ op: 'instance.transform', instanceId: id, transform: transforms[id]! });
  const checked = validateOperations({ format: 'circuit-operations', formatVersion: 1, target: { projectId: project.projectId, expectedRevision: project.revision }, operations: ops });
  if (!checked.ok) return checked;
  const moved = { ...sheet, junctions: sheet.junctions.filter(j => !oldIds.includes(j.id)).concat(oldIds.map(id => replacements[id]!)), instances: sheet.instances.map(i => Object.hasOwn(transforms, i.id) ? { ...i, transform: transforms[i.id]! } : i) };
  const remap = (e: Endpoint): Endpoint => e.kind === 'junction' && Object.hasOwn(mapping, e.junctionId) ? { kind: 'junction', junctionId: mapping[e.junctionId]! } : e;
  const hit = (e: Endpoint) => e.kind === 'junction' ? oldIds.includes(e.junctionId) : e.kind === 'port' && instanceIds.includes(e.instanceId);
  for (const w of sheet.wires) if (hit(w.from) || hit(w.to)) {
    const from = remap(w.from), to = remap(w.to), a = endpointPosition(moved, from), b = endpointPosition(moved, to);
    if (!a || !b) return fail('MISSING_ENDPOINT');
    if (a.x === b.x && a.y === b.y) return fail('DEGENERATE_ROUTE');
    ops.push({ op: 'wire.replace', wireId: w.id, from, to, waypoints: a.x === b.x || a.y === b.y ? [] : [{ x: b.x, y: a.y }] });
  }
  for (const old of oldIds) ops.push({ op: 'junction.remove', junctionId: old });
  const batch = operationsFor(project, ops), result = applyOperations(project, batch);
  return result.ok ? { ok: true, value: snapshot({ batch, junctionMapping: mapping }), diagnostics: [] } : result;
}
