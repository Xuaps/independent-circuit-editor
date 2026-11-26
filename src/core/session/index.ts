import { createEditor } from '../editor';
import { createEngine, validTime, type Engine, type RuntimeLimits } from '../engine';
import { diagnostic, snapshot, type Result } from '../domain/types';
import { isolateData } from '../persistence/json';
/** Sole persistent edit facade for run hosts: no unrestricted editor object escapes. */
export function createSession(input: unknown) {
  const created = createEditor(input); if (!created.ok) return created;
  const editor = created.value;
  let engine: Engine | undefined, mode: 'Editing' | 'Running' | 'Paused' | 'Faulted' = 'Editing', generation = 0;
  const reject = (code: string) => ({ ok: false as const, category: 'invalid-document' as const, diagnostics: [diagnostic(code)] });
  function synchronize() { if (engine && engine.view().status !== 'active' && mode !== 'Editing') mode = 'Faulted'; }
  function view() { synchronize(); return snapshot({ mode, generation, design: editor.snapshot(), dirty: editor.dirty(), history: editor.history(), runtime: engine?.view() ?? null }); }
  function edit<T>(action: () => T): T | ReturnType<typeof reject> { return mode === 'Editing' ? action() : reject('EDIT_LOCKED'); }
  function run(runId: string, limits: Partial<RuntimeLimits> = {}, initial: unknown = []) {
    if (mode !== 'Editing') return reject('MODE');
    if (typeof runId !== 'string') return reject('INVALID_RUNTIME_OPTIONS');
    const isolated = isolateData(initial); if (!isolated.ok) return isolated;
    if (!Array.isArray(isolated.value)) return reject('INVALID_REQUEST');
    if (generation >= Number.MAX_SAFE_INTEGER) return reject('GENERATION_LIMIT');
    const identity = `${runId}_g${generation + 1}`;
    const candidate = createEngine(editor.snapshot(), identity, limits); if (!candidate.ok) return candidate;
    // Validate initial intent on a private engine before installing it. No pre-input rest solve.
    for (const row of isolated.value) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'actions,atMs,sequence') return reject('INVALID_REQUEST');
      const t = row as Record<string, unknown>;
      if (t.atMs !== 0) return reject('TIME_RANGE');
      const accepted = candidate.value.request({ ...t, runId: identity, revision: editor.snapshot().revision });
      if (!accepted.ok) return accepted;
    }
    engine = candidate.value; generation++; mode = 'Running';
    engine.drive(0, 100000); synchronize();
    return { ok: true as const, value: view(), diagnostics: [] };
  }
  function inputAction(request: unknown) {
    if (mode !== 'Running' && mode !== 'Paused') return reject('MODE');
    // Online inputs are always current-time intents, not a wall-clock event scheduler.
    const isolated = isolateData(request); if (!isolated.ok) return isolated;
    const data = isolated.value;
    if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).atMs !== engine!.view().timeMs) return reject('TIME_RANGE');
    const accepted = engine!.request(data); if (!accepted.ok) return accepted;
    if (mode === 'Running') { engine!.drive(engine!.view().timeMs, 1); synchronize(); }
    return accepted;
  }
  function pause() { if (mode !== 'Running') return reject('MODE'); mode = 'Paused'; return { ok: true as const, value: view(), diagnostics: [] }; }
  function drive(untilMs: number, units = 1) {
    if (mode !== 'Running') return reject('MODE');
    const result = engine!.drive(untilMs, units); synchronize(); return result;
  }
  function resume() {
    if (mode !== 'Paused') return reject('MODE');
    mode = 'Running'; const result = engine!.drive(engine!.view().timeMs, 100000); synchronize(); return result;
  }
  function step() {
    if (mode !== 'Paused') return reject('MODE');
    const target = engine!.view().timeMs + 1;
    if (!validTime(target)) return reject('TIME_RANGE');
    const result = engine!.drive(target, 100000); synchronize(); return result;
  }
  function releaseAndPause(sequence: number) {
    if (mode !== 'Running' && mode !== 'Paused') return reject('MODE');
    const result = engine!.releaseAll(sequence); if (!result.ok) return result;
    if (mode === 'Running') { engine!.drive(engine!.view().timeMs, 100000); synchronize(); if (mode === 'Running') mode = 'Paused'; }
    return result;
  }
  function stop(reset = false): Result<ReturnType<typeof view>> {
    engine?.clear(reset ? 'reset' : 'stop');
    if (reset) engine = undefined;
    generation = Math.min(Number.MAX_SAFE_INTEGER, generation + 1); mode = 'Editing';
    return { ok: true, value: view(), diagnostics: [] };
  }
  return { ok: true as const, value: Object.freeze({ view, run, input: inputAction, drive, pause, resume, step, releaseAndPause,
    stop: () => stop(), reset: () => stop(true),
    cancel: () => { if (mode === 'Running' || mode === 'Paused') { engine!.clear('cancel'); synchronize(); } return view(); },
    apply: (ops: unknown) => edit(() => editor.apply(ops)), dryRun: (ops: unknown) => edit(() => editor.dryRun(ops)),
    undo: () => edit(editor.undo), redo: () => edit(editor.redo), markSaved: editor.markSaved,
    design: editor.snapshot
  }), diagnostics: [] };
}
