import type { Project } from '../../../core/domain/types';
import type { RuntimeView } from '../../../core/engine';
export type Context = Readonly<{ epoch: number; document: number; projectId: string; revision: number; runId: string }>;
export type Mode = 'Editing' | 'Running' | 'Paused' | 'Faulted';
export type Command = { kind: 'start'; project: Project } | { kind: 'pause' | 'resume' | 'step' | 'release' } | { kind: 'input'; instanceId: string; action: 'press' | 'release' };
export type Request = { context: Context; sequence: number; command: Command };
export type Publication = { context: Context; sequence: number; publication: number; mode: Mode; runtime: RuntimeView | null; error: string | null };
export function sameContext(a: Context | undefined, b: Context): boolean {
  return !!a && a.epoch === b.epoch && a.document === b.document && a.projectId === b.projectId && a.revision === b.revision && a.runId === b.runId;
}
export interface WorkerPort {
  postMessage(message: Request): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<Publication>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
export type WorkerFactory = () => WorkerPort;
export const workerFactory: WorkerFactory = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'circuit-runtime' });
export type RuntimeState = Readonly<{ mode: Mode; runtime: RuntimeView | null; error: string | null }>;
