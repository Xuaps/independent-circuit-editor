import { defaultDevice, getDefinition } from '../../../src/core/catalog';
import { portPosition } from '../../../src/core/domain/geometry';
import type { Device, Instance, Project, Wire } from '../../../src/core/domain/types';
/** Independently authored fixture builder; explicit terminal wires, not geometric inference. */
export function topology(types: readonly string[], links: readonly (readonly [number, number, number, number])[]): Project {
  const devices: Device[] = [], instances: Instance[] = [];
  types.forEach((type, n) => {
    const d = getDefinition(type)!;
    devices.push(defaultDevice(`device${n}`, `D${n}`, d.deviceKind));
    instances.push({ id: `instance${n}`, definition: { id: type, version: 1 }, variant: 'default', deviceId: `device${n}`, parameters: {}, transform: { position: { x: 100 + n * 80, y: 100 + n * 60 }, rotation: 0, mirrorX: false }, label: '', markings: { showDeviceName: true, showLabel: true, showTerminals: true, terminalLabels: {} } });
  });
  const wires: Wire[] = links.map(([ai, ap, bi, bp], n) => {
    const a = instances[ai]!, b = instances[bi]!, pa = getDefinition(a.definition.id)!.ports[ap]!.id, pb = getDefinition(b.definition.id)!.ports[bp]!.id;
    const p = portPosition(a, pa)!, q = portPosition(b, pb)!;
    return { id: `wire${n}`, from: { kind: 'port', instanceId: a.id, portId: pa }, to: { kind: 'port', instanceId: b.id, portId: pb }, waypoints: p.x === q.x || p.y === q.y ? [] : [{ x: q.x, y: p.y }] };
  });
  return { format: 'circuit-project', formatVersion: 1, projectId: 'project', revision: 0, modelSet: { id: 'core.dc', version: 1 }, title: 'Own topology', devices, sheets: [{ id: 'sheet', name: 'Own sheet', page: { width: 1000, height: 800, unit: 'du' }, instances, wires, junctions: [], annotations: [] }] };
}
export const supply = 'core.dc.supply', lamp = 'core.lamp', button = 'core.pushbutton.no';
export function selfhold(): Project {
  const p = structuredClone(topology([supply, 'core.pushbutton.nc', button, 'core.relay.coil', 'core.relay.contact.no', 'core.relay.contact.no', lamp], [
    [0,0,1,0], [1,1,2,0], [2,1,3,0], [3,1,0,1], [1,1,4,0], [4,1,3,0], [0,0,5,0], [5,1,6,0], [6,1,0,1]
  ]));
  return { ...p, sheets: [{ ...p.sheets[0]!, instances: p.sheets[0]!.instances.map((i,n) => n === 4 || n === 5 ? { ...i, deviceId: 'device3' } : i) }], devices: p.devices.filter(d => d.id !== 'device4' && d.id !== 'device5') };
}
