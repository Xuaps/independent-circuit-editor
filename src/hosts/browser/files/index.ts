import { decodeProject, HARD_LIMITS, serializeProject } from '../../../core/persistence';
import type { Project } from '../../../core/domain/types';
export interface WriteHandle { name: string; createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> }
export interface BrowserFiles {
  pickSave?: () => Promise<WriteHandle>;
  pickOpen?: () => Promise<WriteHandle & { getFile(): Promise<File> }>;
  download(text: string, name: string, type?: string): void;
}
export function safeName(name: string, extension = '.circuit.json') {
  return (name.replace(/\.circuit\.json$|\.svg$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'circuit') + extension;
}
export function download(text: string, name: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  // Keep the URL alive until the browser has consumed the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export function browserFiles(): BrowserFiles {
  const host = window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<WriteHandle>; showOpenFilePicker?: () => Promise<(WriteHandle & { getFile(): Promise<File> })[]> };
  return { download, ...(host.showOpenFilePicker ? { pickOpen: async () => { const handles = await host.showOpenFilePicker!(); if (!handles[0]) throw new Error('Open canceled'); return handles[0]; } } : {}), ...(host.showSaveFilePicker ? { pickSave: () => host.showSaveFilePicker!({ suggestedName: 'circuit.circuit.json', types: [{ description: 'Own circuit design', accept: { 'application/json': ['.json'] } }] }) } : {}) };
}
export function canonical(project: Project) { const r = serializeProject(project); if (!r.ok) throw new Error(r.diagnostics.map(d => d.code).join(', ')); return r.value; }
export async function readFile(file: File) {
  if (file.size > HARD_LIMITS.bytes) throw new Error('RESOURCE_LIMIT: file exceeds 10 MiB');
  const result = decodeProject(new Uint8Array(await file.arrayBuffer()));
  if (!result.ok) throw new Error(result.diagnostics.map(d => d.code).join(', '));
  return result.value;
}
export async function writeConfirmed(handle: WriteHandle, text: string) {
  const writable = await handle.createWritable();
  try { await writable.write(text); await writable.close(); }
  catch (error) { try { await writable.abort?.(); } catch { /* Original failure remains authoritative. */ } throw error; }
}
