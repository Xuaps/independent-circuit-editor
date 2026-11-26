/// <reference lib="webworker" />
import { createSession } from '../../../core/session';
import { sameContext, type Context, type Publication, type Request } from './protocol';
const scope = self as unknown as DedicatedWorkerGlobalScope;
let session: Extract<ReturnType<typeof createSession>, { ok: true }>['value'] | undefined;
let context: Context | undefined, sequence = 0, publication = 0, inputSequence = 0;
let anchor = 0, virtual = 0, lastPost = 0;
let startupError: string | null = null;
function reanchor() { anchor = performance.now(); virtual = session?.view().runtime?.timeMs ?? 0; }
function publish(error: string | null = startupError) {
  if (!session || !context) return;
  const v = session.view();
  const message: Publication = { context, sequence, publication: ++publication, mode: error && v.mode === 'Editing' ? 'Faulted' : v.mode, runtime: v.runtime ? { ...v.runtime, history: v.runtime.history.slice(-64) } : null, error };
  scope.postMessage(message); lastPost = performance.now();
}
scope.onmessage = ({ data }: MessageEvent<Request>) => {
  if (!data || !Number.isSafeInteger(data.sequence) || data.sequence !== sequence + 1) return;
  if (!context) {
    if (data.command?.kind !== 'start' || data.context.projectId !== data.command.project.projectId || data.context.revision !== data.command.project.revision) return;
    const created = createSession(data.command.project); if (!created.ok) return;
    context = data.context; session = created.value; sequence = data.sequence;
    const result = session.run(context.runId); startupError = result.ok ? null : result.diagnostics.map(d => d.code).join(', '); reanchor(); publish(); return;
  }
  if (!sameContext(data.context, context) || !session || data.command.kind === 'start') return;
  sequence = data.sequence;
  let result: { ok: boolean; diagnostics: readonly { code: string }[] };
  switch (data.command.kind) {
    case 'pause': result = session.pause(); break;
    case 'resume': result = session.resume(); break;
    case 'step': result = session.step(); break;
    case 'release': result = session.releaseAndPause(++inputSequence); break;
    case 'input': {
      const runtime = session.view().runtime;
      result = session.input({ runId: runtime?.runId, revision: context.revision, sequence: ++inputSequence, atMs: runtime?.timeMs, actions: [{ instanceId: data.command.instanceId, action: data.command.action, payload: {} }] }); break;
    }
  }
  // Preserve the continuous Running anchor across input and rejected commands:
  // core time may still be at the previous tick, so rebasing here loses wall time.
  // Successful lifecycle controls establish a fresh paused/resumed/stepped boundary.
  if (result.ok && data.command.kind !== 'input') reanchor();
  publish(result.ok ? null : result.diagnostics.map(d => d.code).join(', '));
};
setInterval(() => {
  if (!session) return;
  if (session.view().mode === 'Running') session.drive(Math.min(86400000, virtual + Math.floor(performance.now() - anchor)), 1);
  // Bounded tail + clock coalescing. Paused heartbeat also detects crashed/hung transports.
  if (performance.now() - lastPost >= 100) publish();
}, 25);
