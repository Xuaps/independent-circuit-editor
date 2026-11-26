import type { Project, Scenario } from '../../../src/core/domain/types';
import { selfhold, topology, supply, lamp, button } from '../topologies/build';
export { selfhold, topology, supply, lamp, button };
export const action = (instanceId: string, action: 'press' | 'release' = 'press') => ({ instanceId, action, payload: {} });
export function scenario(p: Project = selfhold()): Scenario {
  return { format: 'circuit-scenario', formatVersion: 1, target: { projectId: p.projectId, revision: p.revision, modelSet: p.modelSet }, untilMs: 50,
    limits: { maxEvents: 100000, maxDeltaCycles: 128, maxTraceEntries: 100000 },
    inputs: [10,20,30,40].map((atMs, n) => ({ atMs, sequence: n + 1, actions: [action(n < 2 ? 'instance2' : 'instance1', n % 2 ? 'release' : 'press')] })),
    probes: [], expect: { outcome: { stage: 'run', status: 'completed' }, observations: [0,10,20,30,40,50].flatMap(atMs => ['device3','device6'].map(id => ({ atMs, target: { kind: 'device' as const, id }, observable: id === 'device3' ? 'energized' : 'lit', expected: { quality: 'known' as const, value: atMs >= 10 && atMs < 30 } }))) }
  };
}
export function feedback(): Project {
  const p = topology([supply, 'core.relay.coil', 'core.relay.contact.nc'], [[0,0,2,0],[2,1,1,0],[1,1,0,1]]);
  return { ...p, devices: p.devices.slice(0,2), sheets: [{ ...p.sheets[0]!, instances: p.sheets[0]!.instances.map((i,n) => n === 2 ? { ...i, deviceId: 'device1' } : i) }] };
}
export function cascade(count = 5): Project {
  const types = [supply, 'core.relay.coil'];
  const links: [number,number,number,number][] = [[0,0,1,0],[1,1,0,1]];
  for (let n = 1; n < count; n++) { const c = types.length; types.push('core.relay.contact.no','core.relay.coil'); links.push([0,0,c,0],[c,1,c+1,0],[c+1,1,0,1]); }
  const p = topology(types, links);
  const contactIds = new Set(p.sheets[0]!.instances.filter((_,n) => n >= 2 && n % 2 === 0).map(i => i.deviceId));
  return { ...p, devices: p.devices.filter(d => !contactIds.has(d.id)), sheets: [{ ...p.sheets[0]!, instances: p.sheets[0]!.instances.map((i,n) => n >= 2 && n % 2 === 0 ? { ...i, deviceId: `device${n-1}` } : i) }] };
}
