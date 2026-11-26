import { validateShapeBounded } from '../../contracts/validation';
import { getDefinition } from '../catalog';
import { budgets, isolateData, type Limits } from '../persistence/json';
import { boundedPoint, orthogonalSegment, portPosition, transformPoint } from './geometry';
import { diagnostic, freeze, snapshot, type Device, type Diagnostic, type Endpoint, type Instance, type Project, type Result, type Sheet } from './types';
function ordered(items: readonly Diagnostic[]): readonly Diagnostic[] {
  return freeze([...items].sort((a, b) => compare(a.code, b.code) || compare(a.objectIds.join('\0'), b.objectIds.join('\0')) || compare(a.message, b.message)));
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** The only exposed index is a frozen closure facade; private Maps never escape. */
export function projectIndex(project: Project) {
  const data = snapshot(project);
  const devices = new Map(data.devices.map(d => [d.id, d]));
  const instances = new Map(data.sheets.flatMap(s => s.instances.map(i => [i.id, i] as const)));
  const sheets = new Map(data.sheets.map(s => [s.id, s]));
  const junctions = new Map(data.sheets.flatMap(s => s.junctions.map(j => [j.id, j] as const)));
  const wires = new Map(data.sheets.flatMap(s => s.wires.map(w => [w.id, w] as const)));
  const annotations = new Map(data.sheets.flatMap(s => s.annotations.map(a => [a.id, a] as const)));
  const bindings = new Map<string, Instance[]>();
  for (const instance of instances.values()) if (instance.deviceId !== null) {
    const list = bindings.get(instance.deviceId) ?? []; list.push(instance); bindings.set(instance.deviceId, list);
  }
  return Object.freeze({
    snapshot: () => data,
    device: (id: string): Device | undefined => devices.get(id),
    instance: (id: string): Instance | undefined => instances.get(id),
    sheet: (id: string): Sheet | undefined => sheets.get(id),
    junction: (id: string) => junctions.get(id),
    wire: (id: string) => wires.get(id),
    annotation: (id: string) => annotations.get(id),
    boundInstances: (id: string): readonly Instance[] => Object.freeze([...(bindings.get(id) ?? [])].sort((a, b) => compare(a.id, b.id)))
  });
}
/** Requires shape-validated, bounded DTO; safe draft invariants only, never electrical evaluation. */
export function documentDiagnostics(project: Project, lower: Partial<Limits> = {}): readonly Diagnostic[] {
  const errors: Diagnostic[] = [];
  const ids = new Set<string>(), names = new Set<string>();
  let entities = 0;
  function id(value: string) {
    entities++;
    if (ids.has(value)) errors.push(diagnostic('DUPLICATE_ID', [value]));
    ids.add(value);
  }
  id(project.projectId);
  const devices = new Map<string, Device>();
  for (const device of [...project.devices].sort((a, b) => compare(a.id, b.id) || compare(JSON.stringify(a), JSON.stringify(b)))) {
    id(device.id); devices.set(device.id, device);
    const name = device.name.toLowerCase();
    if (names.has(name)) errors.push(diagnostic('DUPLICATE_DEVICE_NAME', [device.id], `Duplicate device name: ${name}`));
    names.add(name);
  }
  for (const sheet of [...project.sheets].sort((a, b) => compare(a.id, b.id))) {
    id(sheet.id);
    const sortedInstances = [...sheet.instances].sort((a, b) => compare(a.id, b.id) || compare(JSON.stringify(a), JSON.stringify(b)));
    const instances = new Map(sortedInstances.map(i => [i.id, i]));
    const junctions = new Map([...sheet.junctions].sort((a, b) => compare(a.id, b.id) || compare(JSON.stringify(a), JSON.stringify(b))).map(j => [j.id, j]));
    for (const instance of sortedInstances) {
      id(instance.id);
      const definition = getDefinition(instance.definition.id, instance.definition.version);
      if (!definition) { errors.push(diagnostic('UNKNOWN_DEFINITION', [instance.id])); continue; }
      if (instance.deviceId !== null) {
        const device = devices.get(instance.deviceId);
        if (!device) errors.push(diagnostic('MISSING_DEVICE', [instance.id, instance.deviceId]));
        else if (device.kind !== definition.deviceKind) errors.push(diagnostic('INCOMPATIBLE_DEVICE', [instance.id, device.id]));
      }
      for (const key of Object.keys(instance.markings.terminalLabels)) if (!definition.ports.some(p => p.id === key)) errors.push(diagnostic('UNKNOWN_TERMINAL_LABEL', [instance.id], `Unknown terminal label key: ${key}`));
      const { min, max } = definition.designer.bounds;
      const corners = [min, max, { x: min.x, y: max.y }, { x: max.x, y: min.y }];
      if (corners.some(p => !boundedPoint(transformPoint(p, instance.transform)))) errors.push(diagnostic('COORDINATE_BOUNDS', [instance.id], 'Derived symbol bounds exceed coordinate ceiling'));
      for (const port of definition.ports) {
        const point = portPosition(instance, port.id);
        if (point && !boundedPoint(point)) errors.push(diagnostic('COORDINATE_BOUNDS', [instance.id], `Derived port out of bounds: ${port.id}`));
      }
    }
    for (const junction of sheet.junctions) id(junction.id);
    for (const annotation of sheet.annotations) id(annotation.id);
    function endpoint(endpoint: Endpoint, wireId: string) {
      if (endpoint.kind === 'dangling') return endpoint.position;
      if (endpoint.kind === 'junction') {
        const junction = junctions.get(endpoint.junctionId);
        if (!junction) errors.push(diagnostic('MISSING_JUNCTION', [wireId, endpoint.junctionId]));
        return junction?.position;
      }
      const instance = instances.get(endpoint.instanceId);
      if (!instance) { errors.push(diagnostic('MISSING_INSTANCE', [wireId, endpoint.instanceId])); return; }
      const point = portPosition(instance, endpoint.portId);
      if (!point) errors.push(diagnostic('MISSING_PORT', [wireId, instance.id], `Unknown port: ${endpoint.portId}`));
      return point;
    }
    for (const wire of sheet.wires) {
      id(wire.id);
      const from = endpoint(wire.from, wire.id), to = endpoint(wire.to, wire.id);
      if (from && to) {
        const points = [from, ...wire.waypoints, to];
        for (let n = 1; n < points.length; n++) if (!orthogonalSegment(points[n - 1]!, points[n]!)) {
          errors.push(diagnostic('INVALID_WIRE_ROUTE', [wire.id])); break;
        }
      }
    }
  }
  if (entities > budgets(lower).ids) errors.push(diagnostic('RESOURCE_LIMIT', [], 'Aggregate ID ceiling exceeded'));
  return ordered(errors);
}
/** Shape success is NOT a domain cast until document invariants pass. No partial replacement on failure. */
export function validateProject(input: unknown, lower: Partial<Limits> = {}): Result<Project> {
  const isolated = isolateData(input, lower);
  if (!isolated.ok) return isolated;
  return projectFromDecoded(isolated.value, lower);
}
/** Internal codec entry: parser already enforced resource and Unicode bounds. */
export function projectFromDecoded(data: unknown, lower: Partial<Limits> = {}): Result<Project> {
  const shape = validateShapeBounded('project', data);
  if (!shape.valid) return { ok: false, category: 'unsupported-shape', diagnostics: [diagnostic('INVALID_SHAPE', [], 'Unsupported project structure or version')] };
  const project = data as Project;
  const diagnostics = documentDiagnostics(project, lower);
  if (diagnostics.length) return { ok: false, category: diagnostics.some(d => d.code === 'RESOURCE_LIMIT') ? 'resource-limit' : 'invalid-document', diagnostics };
  return { ok: true, value: snapshot(project), diagnostics: [] };
}
/** Run PREFLIGHT only: no source-short, power, current, series or settling claims. */
export function runReadiness(project: Project): readonly Diagnostic[] {
  const errors = [...documentDiagnostics(project)];
  if (errors.length) return ordered(errors);
  const owners = new Map<string, Instance[]>(); let sources = 0;
  const used = new Set<string>();
  for (const sheet of project.sheets) for (const instance of sheet.instances) {
    const definition = getDefinition(instance.definition.id, instance.definition.version)!;
    if (instance.deviceId === null) { errors.push(diagnostic('UNBOUND_INSTANCE', [instance.id])); continue; }
    used.add(instance.deviceId);
    if (definition.role === 'controller') {
      const list = owners.get(instance.deviceId) ?? []; list.push(instance); owners.set(instance.deviceId, list);
      if (definition.deviceKind === 'dcSupply') sources++;
    }
  }
  if (sources !== 1) errors.push(diagnostic('SOURCE_COUNT', [], 'Exactly one placed bound source is required'));
  for (const id of [...used].sort(compare)) {
    const count = owners.get(id)?.length ?? 0;
    if (count !== 1) errors.push(diagnostic(count === 0 ? 'MISSING_CONTROLLER' : 'DUPLICATE_CONTROLLER', [id]));
  }
  return ordered(errors);
}
/** Caller owns identity generation; no random/time/host state. */
export function createProject(projectId: string, sheetId: string, title = ''): Result<Project> {
  return validateProject({ format: 'circuit-project', formatVersion: 1, projectId, revision: 0, modelSet: { id: 'core.dc', version: 1 }, title, devices: [], sheets: [{ id: sheetId, name: 'Sheet 1', page: { width: 1000, height: 800, unit: 'du' }, instances: [], junctions: [], wires: [], annotations: [] }] });
}
