import { getDefinition, type DefinitionId } from '../catalog';
import { runReadiness, validateProject } from '../domain/project';
import { diagnostic, freeze, type Endpoint, type ModelSet, type Result } from '../domain/types';

export const terminalKey = (instanceId: string, portId: string): string => JSON.stringify(['port', instanceId, portId]);
export type Node = Readonly<{ id: string; kind: 'port' | 'junction' | 'dangling'; objectId: string; portId?: string; side?: 'from' | 'to' }>;
export type Pair = Readonly<{ instanceId: string; deviceId: string; definitionId: DefinitionId; definitionVersion: 1; a: string; b: string }>;
export type Net = Readonly<{ id: string; nodeIds: readonly string[]; wireIds: readonly string[] }>;
export type Compiled = Readonly<{
  projectId: string; revision: number; modelSet: ModelSet; nodes: readonly Node[];
  wires: readonly Readonly<{ id: string; a: string; b: string }>[];
  source: Pair; contacts: readonly Pair[]; loads: readonly Pair[]; nets: readonly Net[];
  terminal: (instanceId: string, portId: string) => Node | undefined;
  node: (id: string) => Node | undefined; net: (nodeId: string) => Net | undefined;
  wireNet: (wireId: string) => Net | undefined;
}>;
const trusted = new WeakSet<object>();
export function isCompiled(input: unknown): input is Compiled { return typeof input === 'object' && input !== null && trusted.has(input); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Canonical groups independent of union representatives. Maps remain private. */
export function conductorNets(nodes: readonly Node[], wires: Compiled['wires'], closed: readonly Pair[] = []): readonly Net[] {
  const parent = new Map(nodes.map(n => [n.id, n.id]));
  const sizes = new Map(nodes.map(n => [n.id, 1]));
  function root(id: string): string {
    let r = id;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    while (id !== r) { const next = parent.get(id)!; parent.set(id, r); id = next; }
    return r;
  }
  function join(a: string, b: string) {
    let x = root(a), y = root(b); if (x === y) return;
    if (sizes.get(x)! < sizes.get(y)!) [x, y] = [y, x];
    parent.set(y, x); sizes.set(x, sizes.get(x)! + sizes.get(y)!);
  }
  for (const w of wires) join(w.a, w.b);
  for (const c of closed) join(c.a, c.b);
  const groups = new Map<string, string[]>();
  for (const n of nodes) { const r = root(n.id), list = groups.get(r) ?? []; list.push(n.id); groups.set(r, list); }
  const wireGroups = new Map<string, string[]>();
  for (const w of wires) { const r = root(w.a), list = wireGroups.get(r) ?? []; list.push(w.id); wireGroups.set(r, list); }
  return freeze([...groups.entries()].map(([r, ids]) => {
    ids.sort(compare); return { id: `net:${ids[0]!}`, nodeIds: ids, wireIds: (wireGroups.get(r) ?? []).sort(compare) };
  }).sort((a, b) => compare(a.id, b.id)));
}
/** Checked bounded input-only ingress, followed by run preflight, never electrical evaluation. */
export function compileProject(input: unknown): Result<Compiled> {
  const checked = validateProject(input); if (!checked.ok) return checked;
  const p = checked.value, diagnostics = runReadiness(p);
  if (diagnostics.length) return freeze({ ok: false, category: 'invalid-document', diagnostics });
  const nodes: Node[] = [], contacts: Pair[] = [], loads: Pair[] = [], sources: Pair[] = [];
  for (const sheet of p.sheets) {
    for (const i of sheet.instances) {
      const d = getDefinition(i.definition.id, i.definition.version)!;
      for (const port of d.ports) nodes.push({ id: terminalKey(i.id, port.id), kind: 'port', objectId: i.id, portId: port.id });
      const pair: Pair = { instanceId: i.id, deviceId: i.deviceId!, definitionId: d.id, definitionVersion: d.version, a: terminalKey(i.id, d.ports[0]!.id), b: terminalKey(i.id, d.ports[1]!.id) };
      if (d.ports.every(port => port.role === 'switched')) contacts.push(pair);
      else if (d.ports.every(port => port.role === 'load')) loads.push(pair);
      else if (d.ports.some(port => port.role === 'positive') && d.ports.some(port => port.role === 'return')) {
        sources.push({ ...pair, a: terminalKey(i.id, d.ports.find(port => port.role === 'positive')!.id), b: terminalKey(i.id, d.ports.find(port => port.role === 'return')!.id) });
      } else return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('UNSUPPORTED_CONTRIBUTION', [i.id])] };
    }
    for (const j of sheet.junctions) nodes.push({ id: JSON.stringify(['junction', j.id]), kind: 'junction', objectId: j.id });
  }
  function endpoint(e: Endpoint, wireId: string, side: 'from' | 'to'): string {
    if (e.kind === 'port') return terminalKey(e.instanceId, e.portId);
    if (e.kind === 'junction') return JSON.stringify(['junction', e.junctionId]);
    const id = JSON.stringify(['dangling', wireId, side]); nodes.push({ id, kind: 'dangling', objectId: wireId, side }); return id;
  }
  const wires = p.sheets.flatMap(s => s.wires.map(w => ({ id: w.id, a: endpoint(w.from, w.id, 'from'), b: endpoint(w.to, w.id, 'to') }))).sort((a, b) => compare(a.id, b.id));
  nodes.sort((a, b) => compare(a.id, b.id));
  contacts.sort((a, b) => compare(a.instanceId, b.instanceId)); loads.sort((a, b) => compare(a.instanceId, b.instanceId));
  const nets = conductorNets(nodes, wires), byNode = new Map(nodes.map(n => [n.id, n])), byNet = new Map<string, Net>(), byWire = new Map<string, Net>();
  for (const net of nets) { for (const n of net.nodeIds) byNet.set(n, net); for (const w of net.wireIds) byWire.set(w, net); }
  const value: Compiled = freeze({ projectId: p.projectId, revision: p.revision, modelSet: p.modelSet, nodes, wires, contacts, loads, source: sources[0]!, nets,
    terminal: (i, port) => byNode.get(terminalKey(i, port)), node: id => byNode.get(id), net: id => byNet.get(id), wireNet: id => byWire.get(id) });
  trusted.add(value);
  return freeze({ ok: true, value, diagnostics: [] });
}
