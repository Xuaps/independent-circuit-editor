import type { Project } from '../../../core/domain/types';
import type { Command, Context, Publication, RuntimeState, WorkerFactory, WorkerPort } from './protocol';
import { sameContext, workerFactory } from './protocol';
/** No engine lives in this host. Stop invalidates synchronously, even if a worker hangs. */
export function runtimeController(publish: (state: RuntimeState) => void, factory: WorkerFactory = workerFactory) {
  let worker: WorkerPort | undefined, context: Context | undefined, epoch = 0, sent = 0, received = 0, publication = 0;
  let state: RuntimeState = { mode: 'Editing', runtime: null, error: null };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const update = (next: RuntimeState) => { state = next; publish(state); };
  function discard() { clearTimeout(watchdog); context = undefined; worker?.terminate(); worker = undefined; }
  function failure(message: string) {
    discard(); update({ mode: 'Faulted', runtime: state.runtime ? { ...state.runtime, status: 'interrupted', complete: false, electrical: null, pending: [], live: state.runtime.live.map(o => ({ ...o, value: { quality: 'unknown', code: 'INTERRUPTED' } })) } : null, error: message });
  }
  function arm() { clearTimeout(watchdog); watchdog = setTimeout(() => failure('Worker unresponsive; last acknowledged history only. Stop to edit/restart.'), 3000); }
  function command(command: Command) {
    if (!worker || !context) return;
    if (sent - received >= 1024) { failure('Runtime transport pending limit; last acknowledged history only. Stop to restart.'); return; }
    try { worker.postMessage({ context, sequence: ++sent, command }); } catch { failure('Runtime transport failed; last acknowledged history only. Stop to restart.'); }
  }
  return Object.freeze({
    start(project: Project, document: number) {
      discard(); sent = received = publication = 0;
      context = { epoch: ++epoch, document, projectId: project.projectId, revision: project.revision, runId: `browser_${epoch}` };
      update({ mode: 'Running', runtime: null, error: null });
      try {
        worker = factory();
        const expected = context;
        worker.onmessage = ({ data }: MessageEvent<Publication>) => {
          if (!data || !context || !sameContext(expected, context) || !sameContext(data.context, context) || !Number.isSafeInteger(data.sequence) || data.sequence < received || data.sequence > sent || !Number.isSafeInteger(data.publication) || data.publication <= publication || !['Running', 'Paused', 'Faulted'].includes(data.mode)) return;
          // Timer frames may reuse the latest acknowledged command sequence; publication is separate.
          if (data.runtime && (data.runtime.revision !== context.revision || data.runtime.runId !== `${context.runId}_g1` || !Number.isSafeInteger(data.runtime.timeMs) || data.runtime.timeMs < 0 || !Array.isArray(data.runtime.live) || !Array.isArray(data.runtime.pending) || !Array.isArray(data.runtime.history) || data.runtime.history.length > 64)) return;
          received = data.sequence; publication = data.publication;
          update({ mode: data.mode, runtime: data.runtime, error: data.error }); arm();
        };
        worker.onerror = () => { if (context && sameContext(expected, context)) failure('Runtime worker failed; last acknowledged history only. Stop to edit/restart.'); };
        arm(); command({ kind: 'start', project });
      } catch { failure('Runtime worker could not start. Stop to edit/restart.'); }
    },
    command(value: Exclude<Command, { kind: 'start' }>) { if (state.mode === 'Running' || state.mode === 'Paused') command(value); },
    stop(reset = false) {
      discard();
      update({ mode: 'Editing', error: reset ? null : state.error, runtime: reset || !state.runtime ? null : { ...state.runtime, status: 'stopped', complete: false, electrical: null, pending: [], live: state.runtime.live.map(o => ({ ...o, value: { quality: 'unknown', code: 'STOPPED' } })) } });
    }
  });
}
