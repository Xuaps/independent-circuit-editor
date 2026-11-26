import { applyOperations, type Applied } from '../commands';
import { validateProject } from '../domain/project';
import { diagnostic, snapshot, type Project, type Result } from '../domain/types';
import { semanticDesignKey, serializeProject } from '../persistence';
export const HISTORY_LIMITS = Object.freeze({ count: 100, bytes: 32 * 1024 * 1024 });
type Entry = Readonly<{ before: Project; after: Project; bytes: number }>;
export type HistoryStatus = Readonly<{ undoCount: number; redoCount: number; retainedBytes: number; trimmed: number }>;
export function createEditor(input: unknown, lower: Partial<{ count: number; bytes: number }> = {}) {
  const validated = validateProject(input); if (!validated.ok) return validated;
  const count = lower.count ?? HISTORY_LIMITS.count, bytes = lower.bytes ?? HISTORY_LIMITS.bytes;
  if (!Number.isSafeInteger(count) || count < 1 || count > HISTORY_LIMITS.count || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > HISTORY_LIMITS.bytes) return { ok: false as const, category: 'resource-limit' as const, diagnostics: [diagnostic('RESOURCE_LIMIT')] };
  let project = validated.value, saved = key(project), undo: Entry[] = [], redo: Entry[] = [], trimmed = 0;
  function status(): HistoryStatus { return snapshot({ undoCount: undo.length, redoCount: redo.length, retainedBytes: [...undo, ...redo].reduce((sum, e) => sum + e.bytes, 0), trimmed }); }
  function apply(input: unknown, dryRun = false): Result<Applied & { history: HistoryStatus }> {
    const result = applyOperations(project, input); if (!result.ok) return result;
    const size = encodedSize(project) + encodedSize(result.value.project);
    if (size > bytes) return { ok: false, category: 'resource-limit', diagnostics: [diagnostic('RESOURCE_LIMIT', [], 'Transaction exceeds retained history budget')] };
    if (dryRun) return { ok: true, value: snapshot({ ...result.value, history: status() }), diagnostics: [] };
    const entry = snapshot({ before: project, after: result.value.project, bytes: size });
    const next = [...undo, entry]; let removed = 0, total = next.reduce((sum, e) => sum + e.bytes, 0);
    while (next.length > count || total > bytes) { total -= next.shift()!.bytes; removed++; }
    undo = next; redo = []; trimmed += removed; project = result.value.project;
    return { ok: true, value: snapshot({ ...result.value, history: status() }), diagnostics: [] };
  }
  function travel(direction: 'undo' | 'redo'): Result<Project> {
    const source = direction === 'undo' ? undo : redo, entry = source.at(-1);
    if (!entry) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('HISTORY_EMPTY')] };
    if (project.revision >= Number.MAX_SAFE_INTEGER) return { ok: false, category: 'invalid-document', diagnostics: [diagnostic('REVISION_OVERFLOW')] };
    const next = validateProject({ ...(direction === 'undo' ? entry.before : entry.after), revision: project.revision + 1 });
    if (!next.ok) return next;
    if (direction === 'undo') { undo = undo.slice(0, -1); redo = [...redo, entry]; } else { redo = redo.slice(0, -1); undo = [...undo, entry]; }
    project = next.value; return { ok: true, value: project, diagnostics: [] };
  }
  return { ok: true as const, value: Object.freeze({ snapshot: () => project, history: status, dirty: () => key(project) !== saved, markSaved: () => { saved = key(project); }, apply: (input: unknown) => apply(input), dryRun: (input: unknown) => apply(input, true), undo: () => travel('undo'), redo: () => travel('redo') }), diagnostics: [] };
}
function key(project: Project): string { const result = semanticDesignKey(project); if (!result.ok) throw new Error('Validated content invariant'); return result.value; }
function encodedSize(project: Project): number { const result = serializeProject(project); if (!result.ok) return Infinity; return new TextEncoder().encode(result.value).byteLength; }
