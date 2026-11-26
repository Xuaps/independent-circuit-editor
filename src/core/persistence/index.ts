import { validateShapeBounded } from '../../contracts/validation';
import { projectFromDecoded, validateProject } from '../domain/project';
import { diagnostic, snapshot, type Operations, type Project, type Result, type Scenario } from '../domain/types';
import { budgets, parseStrict, type Limits } from './json';
export { HARD_LIMITS, parseStrict } from './json';
export function decodeProject(input: string | Uint8Array, lower: Partial<Limits> = {}): Result<Project> {
  const parsed = parseStrict(input, lower);
  return parsed.ok ? projectFromDecoded(parsed.value, lower) : parsed;
}
/** Decode surfaces only: no operation interpretation, target resolution or scenario execution. */
export function decodeOperations(input: string | Uint8Array, lower: Partial<Limits> = {}): Result<Operations> { return decodeShape('operations', input, lower); }
export function decodeScenario(input: string | Uint8Array, lower: Partial<Limits> = {}): Result<Scenario> { return decodeShape('scenario', input, lower); }
function decodeShape<K extends 'operations' | 'scenario'>(kind: K, input: string | Uint8Array, lower: Partial<Limits>): Result<K extends 'operations' ? Operations : Scenario> {
  const parsed = parseStrict(input, lower);
  if (!parsed.ok) return parsed;
  const shape = validateShapeBounded(kind, parsed.value);
  if (!shape.valid) return { ok: false, category: 'unsupported-shape', diagnostics: [diagnostic('INVALID_SHAPE', [], `Unsupported ${kind} structure or version`)] };
  if (kind === 'operations') {
    // Count entity creation records, not ID references or repeated port/definition IDs.
    const operations = (parsed.value as Operations).operations;
    const entities = operations.filter(op => ['device.create', 'instance.place', 'junction.create', 'wire.add', 'annotation.add'].includes(op.op)).length;
    if (entities > budgets(lower).ids) return { ok: false, category: 'resource-limit', diagnostics: [diagnostic('RESOURCE_LIMIT', [], 'Aggregate created-entity ID ceiling exceeded')] };
  }
  return { ok: true, value: snapshot(parsed.value) as K extends 'operations' ? Operations : Scenario, diagnostics: [] };
}
const unordered = new Set(['devices', 'sheets', 'instances', 'junctions', 'wires', 'annotations']);
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const items = unordered.has(key) ? [...value].sort((a: { id: string }, b: { id: string }) => compare(a.id, b.id)) : value;
    return items.map(item => canonical(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(value).sort(compare)) out[k] = canonical((value as Record<string, unknown>)[k], k);
    return out;
  }
  return value;
}
/** Canonical editable design only; schema rejects runtime/host/plugin fields rather than stripping. */
export function serializeProject(input: unknown, lower: Partial<Limits> = {}): Result<string> {
  const result = validateProject(input, lower);
  if (!result.ok) return result;
  const text = JSON.stringify(canonical(result.value));
  // Canonical escaping may enlarge wire bytes; do not produce an unreadable oversized save.
  const checked = parseStrict(text, lower);
  return checked.ok ? { ok: true, value: text, diagnostics: [] } : checked;
}
export function semanticDesignKey(input: unknown): Result<string> {
  const result = validateProject(input);
  if (!result.ok) return result;
  const { revision: _revision, ...content } = result.value;
  return { ok: true, value: JSON.stringify(canonical(content)), diagnostics: [] };
}
export function sameDesign(a: unknown, b: unknown): Result<boolean> {
  const first = semanticDesignKey(a); if (!first.ok) return first;
  const second = semanticDesignKey(b); if (!second.ok) return second;
  return { ok: true, value: first.value === second.value, diagnostics: [] };
}
