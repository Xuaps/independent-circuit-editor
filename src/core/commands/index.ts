import { validateShapeBounded } from '../../contracts/validation';
import { validateProject } from '../domain/project';
import { getDefinition } from '../catalog';
import { portPosition, transformPoint } from '../domain/geometry';
import { diagnostic, snapshot, type Diagnostic, type Operation, type Operations, type Project, type Result } from '../domain/types';
import { decodeOperations } from '../persistence';
import { isolateData } from '../persistence/json';

export type Change = Readonly<{ operationIndex: number; op: Operation['op']; objectIds: readonly string[]; changed: boolean }>;
export type Applied = Readonly<{ project: Project; changes: readonly Change[] }>;
export function operationsFor(project: Project, operations: readonly Operation[]): Operations {
  return snapshot({ format: 'circuit-operations', formatVersion: 1, target: { projectId: project.projectId, expectedRevision: project.revision }, operations });
}
export function validateOperations(input: unknown): Result<Operations> {
  if (typeof input === 'string' || input instanceof Uint8Array) return decodeOperations(input);
  const data = isolateData(input); if (!data.ok) return data;
  if (!validateShapeBounded('operations', data.value).valid) return failure('INVALID_SHAPE', undefined, [], 'unsupported-shape');
  return { ok: true, value: snapshot(data.value as Operations), diagnostics: [] };
}
function failure(code: string, operationIndex?: number, objectIds: readonly string[] = [], category: 'invalid-document' | 'resource-limit' | 'unsupported-shape' = 'invalid-document'): Result<never> {
  const d = diagnostic(code, objectIds);
  return { ok: false, category, diagnostics: [operationIndex === undefined ? d : { ...d, operationIndex }] };
}
/** Validated bounded DTOs only: object keys are unordered; every array remains ordered. */
function contentKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(contentKey).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${contentKey((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
/** Ordered local targets must exist; references and route/name/parameter consistency are deferred to the complete candidate. */
export function applyOperations(project: Project, input: unknown): Result<Applied> {
  const batch = validateOperations(input); if (!batch.ok) return batch;
  if (batch.value.target.projectId !== project.projectId) return failure('PROJECT_MISMATCH');
  if (batch.value.target.expectedRevision !== project.revision) return failure('REVISION_CONFLICT');
  if (project.revision >= Number.MAX_SAFE_INTEGER) return failure('REVISION_OVERFLOW');
  const candidate = structuredClone(project) as Mutable<Project>;
  const reserved = new Set([project.projectId, ...project.devices.map(d => d.id), ...project.sheets.flatMap(s => [s.id, ...s.instances.map(x => x.id), ...s.junctions.map(x => x.id), ...s.wires.map(x => x.id), ...s.annotations.map(x => x.id)])]);
  const wireGeometry = new Map<string, number>(), portGeometry = new Map<string, Map<string, number>>(), junctionGeometry = new Map<string, number>();
  // Bounded dependency provenance: no generic last-entity-touch fallback.
  const created = new Map<string, number>(), removed = new Map<string, number>(), bindings = new Map<string, number>();
  const terminalKeys = new Map<string, Map<string, number>>(), bounds = new Map<string, number>();
  const endpoints = new Map<string, Map<'from' | 'to', number>>();
  const parametersTouched = new Map<string, number>(), namesTouched = new Map<string, number>(); const changes: Change[] = [];
  const deviceShape = (device: Project['devices'][number]) => validateShapeBounded('project', { ...project, devices: [device], sheets: project.sheets.map(s => ({ ...s, instances: [], wires: [], junctions: [], annotations: [] })) }).valid;
  const footprint = (instance: Project['sheets'][number]['instances'][number] | undefined) => {
    if (!instance) return undefined;
    const definition = getDefinition(instance.definition.id, instance.definition.version);
    if (!definition) return undefined;
    const { min, max } = definition.designer.bounds;
    return contentKey({
      corners: [min, max, { x: min.x, y: max.y }, { x: max.x, y: min.y }].map(p => transformPoint(p, instance.transform)).map(contentKey).sort(),
      ports: definition.ports.map(p => [p.id, portPosition(instance, p.id)])
    });
  };
  for (const [n, op] of batch.value.operations.entries()) {
    const sheet = 'sheetId' in op ? candidate.sheets.find(s => s.id === op.sheetId) : undefined;
    if ('sheetId' in op && !sheet) return failure('MISSING_SHEET', n, [op.sheetId]);
    const id = 'device' in op ? op.device.id : 'instance' in op ? op.instance.id : 'junction' in op ? op.junction.id : 'wire' in op ? op.wire.id : 'annotation' in op ? op.annotation.id : 'deviceId' in op && op.op !== 'instance.bind' ? op.deviceId : 'instanceId' in op ? op.instanceId : 'junctionId' in op ? op.junctionId : 'wireId' in op ? op.wireId : 'annotationId' in op ? op.annotationId : 'sheetId' in op ? op.sheetId : '';
    const creation = ['device.create', 'instance.place', 'junction.create', 'wire.add', 'annotation.add'].includes(op.op);
    if (creation) { if (reserved.has(id)) return failure('DUPLICATE_ID', n, [id]); reserved.add(id); }
    const device = candidate.devices.find(d => d.id === id);
    const owner = candidate.sheets.find(s => [...s.instances, ...s.junctions, ...s.wires, ...s.annotations].some(x => x.id === id));
    const instance = owner?.instances.find(i => i.id === id);
    if (!creation && op.op !== 'page.replace' && !device && !owner) return failure('MISSING_TARGET', n, [id]);
    // A globally existing entity of the wrong type is not a valid command target.
    if (op.op.startsWith('device.') && !creation && !device || op.op.startsWith('instance.') && !creation && !instance || op.op.startsWith('wire.') && !creation && !owner?.wires.some(w => w.id === id) || op.op === 'junction.remove' && !owner?.junctions.some(j => j.id === id) || op.op === 'annotation.remove' && !owner?.annotations.some(a => a.id === id)) return failure('MISSING_TARGET', n, [id]);
    const entity = () => {
      const location = sheet ?? owner;
      return candidate.devices.find(x => x.id === id) ?? location?.instances.find(x => x.id === id) ?? location?.junctions.find(x => x.id === id) ?? location?.wires.find(x => x.id === id) ?? location?.annotations.find(x => x.id === id) ?? (op.op === 'page.replace' ? sheet?.page : undefined);
    };
    const before = contentKey(entity());
    const oldBinding = instance?.deviceId, oldKeys = new Set(Object.keys(instance?.markings.terminalLabels ?? {}));
    const oldBounds = footprint(instance), oldName = device?.name.toLowerCase(), oldParameters = contentKey(device?.parameters);
    const oldParameterShape = device && op.op === 'device.parameters.replace' ? deviceShape(device) : true;
    const oldWire = owner?.wires.find(w => w.id === id);
    const oldEndpoints = { from: contentKey(oldWire?.from), to: contentKey(oldWire?.to) };
    const oldPorts = instance ? getDefinition(instance.definition.id)?.ports.map(p => [p.id, contentKey(portPosition(instance, p.id))] as const) : [];
    switch (op.op) {
      case 'device.create': candidate.devices.push(structuredClone(op.device) as Mutable<typeof op.device>); break;
      case 'device.rename': device!.name = op.name; break;
      case 'device.parameters.replace': Object.assign(device!, { parameters: structuredClone(op.parameters) }); break;
      case 'device.remove': candidate.devices = candidate.devices.filter(d => d.id !== id); break;
      case 'instance.place': sheet!.instances.push(structuredClone(op.instance) as Mutable<typeof op.instance>); break;
      case 'instance.bind': instance!.deviceId = op.deviceId; break;
      case 'instance.transform': instance!.transform = structuredClone(op.transform); break;
      case 'instance.presentation.replace': instance!.label = op.label; instance!.markings = structuredClone(op.markings) as Mutable<typeof op.markings>; break;
      case 'instance.remove': owner!.instances = owner!.instances.filter(i => i.id !== id); break;
      case 'junction.create': sheet!.junctions.push(structuredClone(op.junction)); break;
      case 'junction.remove': owner!.junctions = owner!.junctions.filter(j => j.id !== id); break;
      case 'wire.add': sheet!.wires.push(structuredClone(op.wire) as Mutable<typeof op.wire>); break;
      case 'wire.replace': Object.assign(owner!.wires.find(w => w.id === id)!, structuredClone({ from: op.from, to: op.to, waypoints: op.waypoints })); break;
      case 'wire.remove': owner!.wires = owner!.wires.filter(w => w.id !== id); break;
      case 'annotation.add': sheet!.annotations.push(structuredClone(op.annotation)); break;
      case 'annotation.remove': owner!.annotations = owner!.annotations.filter(a => a.id !== id); break;
      case 'page.replace': sheet!.page = structuredClone(op.page); break;
      default: { const exhaustive: never = op; return exhaustive; }
    }
    const changed = before !== contentKey(entity());
    // Latest actual geometry dependency change, never a presentation edit or semantic no-op.
    if (changed && (op.op === 'wire.add' || op.op === 'wire.replace')) wireGeometry.set(id, n);
    if (changed && (op.op === 'junction.create' || op.op === 'junction.remove')) junctionGeometry.set(id, n);
    if (op.op === 'instance.transform' || op.op === 'instance.place' || op.op === 'instance.remove') {
      const current = candidate.sheets.flatMap(s => s.instances).find(i => i.id === id);
      const ports = current ? getDefinition(current.definition.id)?.ports.map(p => p.id) ?? [] : oldPorts?.map(([port]) => port) ?? [];
      for (const port of ports) if (oldPorts?.find(([key]) => key === port)?.[1] !== (current ? contentKey(portPosition(current, port)) : undefined)) {
        if (!portGeometry.has(id)) portGeometry.set(id, new Map());
        portGeometry.get(id)!.set(port, n);
      }
    }
    if (creation) created.set(id, n);
    if (op.op === 'device.remove' || op.op === 'instance.remove' || op.op === 'junction.remove') removed.set(id, n);
    if (op.op === 'instance.bind' && oldBinding !== instance!.deviceId) bindings.set(id, n);
    if (op.op === 'instance.place') bindings.set(id, n);
    const currentInstance = op.op === 'instance.place' ? sheet!.instances.find(i => i.id === id) : instance;
    if (currentInstance && (op.op === 'instance.place' || op.op === 'instance.presentation.replace')) {
      for (const key of Object.keys(currentInstance.markings.terminalLabels)) if (!oldKeys.has(key)) {
        if (!terminalKeys.has(id)) terminalKeys.set(id, new Map());
        terminalKeys.get(id)!.set(key, n);
      }
    }
    if ((op.op === 'instance.place' || op.op === 'instance.transform') && oldBounds !== footprint(currentInstance)) bounds.set(id, n);
    if (op.op === 'wire.add' || op.op === 'wire.replace') {
      const wire = (sheet ?? owner)!.wires.find(w => w.id === id)!;
      for (const side of ['from', 'to'] as const) if (oldEndpoints[side] !== contentKey(wire[side])) {
        if (!endpoints.has(id)) endpoints.set(id, new Map());
        endpoints.get(id)!.set(side, n);
      }
    }
    if (op.op === 'device.parameters.replace' || op.op === 'device.create') {
      const current = candidate.devices.find(d => d.id === id)!;
      if (oldParameters !== contentKey(current.parameters)) {
        // A changed already-invalid owning record is ambiguous; a no-op keeps its provenance.
        parametersTouched.delete(id);
        if (oldParameterShape && !deviceShape(current)) parametersTouched.set(id, n);
      }
    }
    if ((op.op === 'device.rename' || op.op === 'device.create') && oldName !== candidate.devices.find(d => d.id === id)!.name.toLowerCase()) namesTouched.set(id, n);
    changes.push({ operationIndex: n, op: op.op, objectIds: [id], changed });
  }
  candidate.revision++;
  const final = validateProject(candidate);
  if (!final.ok) {
    const diagnostics: Diagnostic[] = final.diagnostics.map(d => {
      const latest = (...indices: (number | undefined)[]) => {
        const known = indices.filter((i): i is number => i !== undefined);
        return known.length ? Math.max(...known) : undefined;
      };
      // A diagnostic without a field/endpoint identity must not select among different causes.
      const unanimous = (indices: (number | undefined)[]) => indices.length && indices.every(i => i !== undefined && i === indices[0]) ? indices[0] : undefined;
      let index: number | undefined;
      const [id, reference] = d.objectIds;
      const instance = candidate.sheets.flatMap(s => s.instances).find(i => i.id === id);
      switch (d.code) {
        case 'UNKNOWN_DEFINITION': index = created.get(id!); break; // Definition references are immutable.
        case 'MISSING_DEVICE': index = latest(bindings.get(id!), removed.get(reference!)); break;
        case 'INCOMPATIBLE_DEVICE': index = latest(bindings.get(id!), created.get(reference!)); break;
        case 'UNKNOWN_TERMINAL_LABEL': {
          const definition = instance && getDefinition(instance.definition.id, instance.definition.version);
          if (instance && definition) index = unanimous(Object.keys(instance.markings.terminalLabels).filter(k => !definition.ports.some(p => p.id === k)).map(k => terminalKeys.get(id!)?.get(k)));
          break;
        }
        case 'COORDINATE_BOUNDS': index = bounds.get(id!); break;
        case 'DUPLICATE_DEVICE_NAME': {
          const name = candidate.devices.find(x => x.id === id)?.name.toLowerCase();
          index = latest(...candidate.devices.filter(x => x.name.toLowerCase() === name).map(x => namesTouched.get(x.id)));
          break;
        }
        case 'INVALID_SHAPE': {
          // Only owning device parameters admit generic payloads at command ingress.
          index = unanimous(candidate.devices.filter(x => !deviceShape(x)).map(x => parametersTouched.get(x.id)));
          break;
        }
        case 'MISSING_INSTANCE': case 'MISSING_JUNCTION': case 'MISSING_PORT': {
          for (const sheet of candidate.sheets) {
            const wire = sheet.wires.find(w => w.id === id); if (!wire) continue;
            const causes: (number | undefined)[] = [];
            for (const side of ['from', 'to'] as const) {
              const end = wire[side];
              const matches = d.code === 'MISSING_JUNCTION' ? end.kind === 'junction' && end.junctionId === reference && !sheet.junctions.some(j => j.id === reference)
                : end.kind === 'port' && end.instanceId === reference && (d.code === 'MISSING_INSTANCE' ? !sheet.instances.some(i => i.id === reference) : sheet.instances.some(i => i.id === reference && !portPosition(i, end.portId)));
              if (matches) causes.push(latest(endpoints.get(id!)?.get(side), d.code === 'MISSING_PORT' ? created.get(reference!) : removed.get(reference!)));
            }
            index = unanimous(causes);
          }
          break;
        }
        // DUPLICATE_ID is rejected locally. Aggregate RESOURCE_LIMIT and unknown categories
        // have no safe field attribution. Never guess from an unrelated entity touch.
      }
      if (d.code === 'INVALID_WIRE_ROUTE') {
        const indices: number[] = [];
        for (const sheet of candidate.sheets) for (const wire of sheet.wires) if (d.objectIds.includes(wire.id)) {
          const direct = wireGeometry.get(wire.id); if (direct !== undefined) indices.push(direct);
          for (const end of [wire.from, wire.to]) {
            const index = end.kind === 'port' ? portGeometry.get(end.instanceId)?.get(end.portId) : end.kind === 'junction' ? junctionGeometry.get(end.junctionId) : undefined;
            if (index !== undefined) indices.push(index);
          }
        }
        return indices.length ? { ...d, operationIndex: Math.max(...indices) } : d;
      }
      return index === undefined ? d : { ...d, operationIndex: index };
    });
    return snapshot({ ...final, diagnostics });
  }
  return { ok: true, value: snapshot({ project: final.value, changes }), diagnostics: [] };
}
