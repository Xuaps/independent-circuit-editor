import { conductorNets, isCompiled, type Compiled, type Net } from '../compiler';
import { diagnostic, freeze, type Diagnostic } from '../domain/types';
import { isolateData } from '../persistence/json';
import { classifyLoads, GRAPH_LIMITS } from './classifier';
export type ContactState = Readonly<{ instanceId: string; closed: Readonly<{ quality: 'known'; value: boolean }> }>;
export type Potential = 'positive' | 'return' | 'floating';
export type ElectricalResult = Readonly<{ ok: false; kind: 'invalid-input' | 'fault' | 'unsupported' | 'resource-limit'; diagnostics: readonly Diagnostic[] }> | Readonly<{
  ok: true; nets: readonly (Net & Readonly<{ potential: Potential }>)[];
  loads: readonly Readonly<{ instanceId: string; deviceId: string; powered: boolean; a: Potential; b: Potential }>[];
  diagnostics: readonly Diagnostic[];
}>;
/** A complete array of known Boolean closures, keyed by instance ID, not device/name.
 * Missing/extra/duplicate/unavailable states fail; NO/NC inversion belongs to behavior. */
export function evaluateElectrical(compiled: Compiled, input: unknown, workLimit: number = GRAPH_LIMITS.work): ElectricalResult {
  const fail = (kind: 'invalid-input' | 'fault' | 'unsupported' | 'resource-limit', code: string, ids: readonly string[] = []): ElectricalResult => freeze({ ok: false, kind, diagnostics: [diagnostic(code, ids)] });
  if (!isCompiled(compiled)) return fail('invalid-input', 'INVALID_COMPILED');
  if (compiled.nodes.length > GRAPH_LIMITS.vertices || compiled.loads.length + compiled.wires.length + compiled.contacts.length > GRAPH_LIMITS.edges) return fail('resource-limit', 'RESOURCE_LIMIT');
  if (!Number.isSafeInteger(workLimit) || workLimit < 0 || workLimit < compiled.nodes.length + compiled.wires.length + compiled.contacts.length) return fail('resource-limit', 'RESOURCE_LIMIT');
  const isolated = isolateData(input);
  if (!isolated.ok) return fail(isolated.category === 'resource-limit' ? 'resource-limit' : 'invalid-input', isolated.category === 'resource-limit' ? 'RESOURCE_LIMIT' : 'INVALID_CONTACT_STATE');
  const data = isolated.value;
  if (!Array.isArray(data) || data.length !== compiled.contacts.length) return fail('invalid-input', 'INVALID_CONTACT_STATE');
  const states = new Map<string, boolean>(), expected = new Set(compiled.contacts.map(c => c.instanceId));
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'closed,instanceId' || typeof row.instanceId !== 'string' || !expected.has(row.instanceId) || states.has(row.instanceId)) return fail('invalid-input', 'INVALID_CONTACT_STATE');
    const c = row.closed;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).sort().join(',') !== 'quality,value' || c.quality !== 'known' || typeof c.value !== 'boolean') return fail('invalid-input', 'INVALID_CONTACT_STATE');
    states.set(row.instanceId, c.value);
  }
  const nets = conductorNets(compiled.nodes, compiled.wires, compiled.contacts.filter(c => states.get(c.instanceId)));
  const membership = new Map<string, number>();
  nets.forEach((net, index) => { for (const n of net.nodeIds) membership.set(n, index); });
  const positive = membership.get(compiled.source.a)!, negative = membership.get(compiled.source.b)!;
  if (positive === negative) return fail('fault', 'SOURCE_SHORT', [compiled.source.instanceId]);
  const classification = classifyLoads(nets.length, compiled.loads.map(l => [membership.get(l.a)!, membership.get(l.b)!] as const), positive, negative, Math.min(workLimit, GRAPH_LIMITS.work) - compiled.nodes.length - compiled.wires.length - compiled.contacts.length);
  if (classification === 'resource-limit') return fail('resource-limit', 'RESOURCE_LIMIT');
  if (classification !== 'supported') return fail('unsupported', 'UNSUPPORTED_TOPOLOGY', compiled.loads.map(l => l.instanceId));
  const potential = (n: number): Potential => n === positive ? 'positive' : n === negative ? 'return' : 'floating';
  return freeze({ ok: true, nets: nets.map((n, i) => ({ ...n, potential: potential(i) })), loads: compiled.loads.map(l => {
    const a = potential(membership.get(l.a)!), b = potential(membership.get(l.b)!);
    return { instanceId: l.instanceId, deviceId: l.deviceId, powered: (a === 'positive' && b === 'return') || (a === 'return' && b === 'positive'), a, b };
  }), diagnostics: [] });
}
