import { isolateData } from '../persistence/json';
import { getDefinition } from '../catalog';
import { applyOperations, operationsFor, validateOperations } from '../commands';
import { endpointPosition, wirePoints } from '../domain/geometry';
import { diagnostic, type Endpoint, type Operation, type Operations, type Point, type Project, type Result, type Transform } from '../domain/types';
function fail(code = 'INVALID_GESTURE'): Result<never> { return { ok: false, category: 'invalid-document', diagnostics: [diagnostic(code)] }; }
function finish(project: Project, operations: readonly Operation[]): Result<Operations> {
  const batch = operationsFor(project, operations), checked = applyOperations(project, batch);
  return checked.ok ? { ok: true, value: batch, diagnostics: [] } : checked;
}
/** Deterministic horizontal-first elbow; no obstacle or connectivity inference. */
function route(a: Point, b: Point): readonly Point[] | undefined {
  if (a.x === b.x && a.y === b.y) return undefined;
  return a.x === b.x || a.y === b.y ? [] : [{ x: b.x, y: a.y }];
}
export function planTransforms(project: Project, transforms: Readonly<Record<string, Transform>>): Result<Operations> {
  const isolated = isolateData(transforms); if (!isolated.ok) return isolated;
  if (!isolated.value || typeof isolated.value !== 'object' || Array.isArray(isolated.value)) return fail();
  transforms = isolated.value as typeof transforms;
  const ops: Operation[] = []; const selected = new Set(Object.keys(transforms));
  if (!selected.size) return fail();
  const sheet = project.sheets[0]!;
  for (const id of selected) { if (!sheet.instances.some(i => i.id === id)) return fail('MISSING_TARGET'); ops.push({ op: 'instance.transform', instanceId: id, transform: transforms[id]! }); }
  const checked = validateOperations({ format: 'circuit-operations', formatVersion: 1, target: { projectId: project.projectId, expectedRevision: project.revision }, operations: ops });
  if (!checked.ok) return checked;
  const moved = { ...sheet, instances: sheet.instances.map(i => selected.has(i.id) ? { ...i, transform: transforms[i.id]! } : i) };
  for (const wire of sheet.wires) if ([wire.from, wire.to].some(e => e.kind === 'port' && selected.has(e.instanceId))) {
    const a = endpointPosition(moved, wire.from), b = endpointPosition(moved, wire.to); if (!a || !b) return fail();
    const waypoints = route(a, b); if (!waypoints) return fail('DEGENERATE_ROUTE');
    ops.push({ op: 'wire.replace', wireId: wire.id, from: wire.from, to: wire.to, waypoints });
  }
  return finish(project, ops);
}
export type CopyOptions = Readonly<{ ids: Readonly<Record<string, string>>; deviceNames: Readonly<Record<string, string>>; offset: Point }>;
/** Selection IDs are instances, wires or junctions. All new identities/names are caller-controlled. */
export function planCopy(project: Project, selection: readonly string[], options: CopyOptions): Result<Operations> {
  const sheet = project.sheets[0]!, chosen = new Set(selection), ops: Operation[] = [];
  if (!chosen.size || chosen.size !== selection.length || selection.some(id => ![...sheet.instances, ...sheet.wires, ...sheet.junctions].some(x => x.id === id))) return fail();
  const id = (old: string) => Object.hasOwn(options.ids, old) ? options.ids[old] : undefined;
  const name = (old: string) => Object.hasOwn(options.deviceNames, old) ? options.deviceNames[old] : undefined;
  if (selection.some(old => !id(old))) return fail('MISSING_COPY_ID');
  const translate = (p: Point): Point => ({ x: p.x + options.offset.x, y: p.y + options.offset.y });
  const devices = new Set(sheet.instances.filter(i => chosen.has(i.id) && getDefinition(i.definition.id)?.role === 'controller' && i.deviceId !== null).map(i => i.deviceId!));
  for (const old of devices) {
    const device = project.devices.find(d => d.id === old)!;
    if (!id(old) || !name(old)) return fail('MISSING_COPY_DEVICE');
    ops.push({ op: 'device.create', device: { ...device, id: id(old)!, name: name(old)! } });
  }
  for (const i of sheet.instances) if (chosen.has(i.id)) ops.push({ op: 'instance.place', sheetId: sheet.id, instance: { ...i, id: id(i.id)!, deviceId: i.deviceId !== null && devices.has(i.deviceId) ? id(i.deviceId)! : null, transform: { ...i.transform, position: translate(i.transform.position) } } });
  for (const j of sheet.junctions) if (chosen.has(j.id)) ops.push({ op: 'junction.create', sheetId: sheet.id, junction: { id: id(j.id)!, position: translate(j.position) } });
  function end(e: Endpoint): Endpoint | undefined {
    if (e.kind === 'port' && chosen.has(e.instanceId)) return { ...e, instanceId: id(e.instanceId)! };
    if (e.kind === 'junction' && chosen.has(e.junctionId)) return { ...e, junctionId: id(e.junctionId)! };
    const position = endpointPosition(sheet, e); return position ? { kind: 'dangling', position: translate(position) } : undefined;
  }
  for (const w of sheet.wires) if (chosen.has(w.id)) {
    const from = end(w.from), to = end(w.to); if (!from || !to) return fail();
    ops.push({ op: 'wire.add', sheetId: sheet.id, wire: { id: id(w.id)!, from, to, waypoints: w.waypoints.map(translate) } });
  }
  return finish(project, ops);
}
/** Split only at an explicit interior point on the chosen wire; unrelated crossings are untouched. */
export function planSplit(project: Project, wireId: string, point: Point, junctionId: string, tailId: string): Result<Operations> {
  const sheet = project.sheets[0]!, wire = sheet.wires.find(w => w.id === wireId); if (!wire) return fail('MISSING_TARGET');
  const points = wirePoints(sheet, wire); if (!points) return fail();
  if ([points[0]!, points.at(-1)!].some(p => p.x === point.x && p.y === point.y)) return fail('DEGENERATE_SPLIT');
  let segment = -1;
  for (let n = 0; n < points.length - 1; n++) { const a = points[n]!, b = points[n + 1]!; if (point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) { segment = n; break; } }
  if (segment < 0) return fail('POINT_NOT_ON_WIRE');
  const node: Endpoint = { kind: 'junction', junctionId };
  const left = points.slice(1, segment + 1).filter(p => p.x !== point.x || p.y !== point.y);
  const right = points.slice(segment + 1, -1).filter(p => p.x !== point.x || p.y !== point.y);
  return finish(project, [{ op: 'junction.create', sheetId: sheet.id, junction: { id: junctionId, position: point } }, { op: 'wire.replace', wireId, from: wire.from, to: node, waypoints: left }, { op: 'wire.add', sheetId: sheet.id, wire: { id: tailId, from: node, to: wire.to, waypoints: right } }]);
}
/** Explicit join of a named wire end to a named endpoint. Also serves disconnect via dangling endpoint. */
export function planJoin(project: Project, wireId: string, side: 'from' | 'to', endpoint: Endpoint): Result<Operations> {
  const sheet = project.sheets[0]!, wire = sheet.wires.find(w => w.id === wireId); if (!wire) return fail('MISSING_TARGET');
  const from = side === 'from' ? endpoint : wire.from, to = side === 'to' ? endpoint : wire.to;
  const a = endpointPosition(sheet, from), b = endpointPosition(sheet, to); if (!a || !b) return fail('MISSING_ENDPOINT');
  const waypoints = route(a, b); if (!waypoints) return fail('DEGENERATE_ROUTE');
  return finish(project, [{ op: 'wire.replace', wireId, from, to, waypoints }]);
}
export function planDetach(project: Project, wireId: string, side: 'from' | 'to'): Result<Operations> {
  const sheet = project.sheets[0]!, wire = sheet.wires.find(w => w.id === wireId); if (!wire) return fail('MISSING_TARGET');
  const position = endpointPosition(sheet, wire[side]); return position ? planJoin(project, wireId, side, { kind: 'dangling', position }) : fail();
}
/** Confirmed policy: selected devices unbind observers; incident wires are detached or explicitly removed. No reconnection. */
export function planDelete(project: Project, selection: readonly string[], policy: 'detach' | 'remove-wires'): Result<Operations> {
  const chosen = new Set(selection), sheet = project.sheets[0]!, ops: Operation[] = [];
  const known = new Set([...project.devices, ...sheet.instances, ...sheet.junctions, ...sheet.wires, ...sheet.annotations].map(x => x.id));
  if (!chosen.size || selection.some(id => !known.has(id))) return fail('MISSING_TARGET');
  for (const wire of sheet.wires) {
    const hit = (e: Endpoint) => e.kind === 'port' ? chosen.has(e.instanceId) : e.kind === 'junction' && chosen.has(e.junctionId);
    if (chosen.has(wire.id) || policy === 'remove-wires' && (hit(wire.from) || hit(wire.to))) { ops.push({ op: 'wire.remove', wireId: wire.id }); continue; }
    if (hit(wire.from) || hit(wire.to)) {
      const detach = (e: Endpoint): Endpoint => hit(e) ? { kind: 'dangling', position: endpointPosition(sheet, e)! } : e;
      ops.push({ op: 'wire.replace', wireId: wire.id, from: detach(wire.from), to: detach(wire.to), waypoints: wire.waypoints });
    }
  }
  for (const i of sheet.instances) if (chosen.has(i.id)) ops.push({ op: 'instance.remove', instanceId: i.id }); else if (i.deviceId !== null && chosen.has(i.deviceId)) ops.push({ op: 'instance.bind', instanceId: i.id, deviceId: null });
  for (const j of sheet.junctions) if (chosen.has(j.id)) ops.push({ op: 'junction.remove', junctionId: j.id });
  for (const a of sheet.annotations) if (chosen.has(a.id)) ops.push({ op: 'annotation.remove', annotationId: a.id });
  for (const d of project.devices) if (chosen.has(d.id)) ops.push({ op: 'device.remove', deviceId: d.id });
  return finish(project, ops);
}
