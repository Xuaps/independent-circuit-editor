import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HARD_LIMITS } from '../../core/persistence';

/** Trusted adapter injection is for host tests only; never selected by project data. */
export type FileSystem = Pick<typeof fs, 'open' | 'lstat' | 'realpath' | 'link' | 'unlink'>;
export class HostError extends Error {
  constructor(public readonly code: string, message = code) { super(message); }
}
export async function readBounded(file: string, io: FileSystem = fs): Promise<Uint8Array> {
  const chunks: Buffer[] = []; let bytes = 0;
  // O_NONBLOCK prevents opening a FIFO from hanging before its type is checked.
  const handle = file === '-' ? undefined : await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (handle && !(await handle.stat()).isFile()) throw new HostError('INPUT_TYPE', 'Only regular files or explicit stdin (-) are supported');
    if (handle) {
      while (true) {
        const chunk = Buffer.alloc(Math.min(65536, HARD_LIMITS.bytes + 1 - bytes));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > HARD_LIMITS.bytes) throw new HostError('RESOURCE_LIMIT');
        chunks.push(chunk.subarray(0, bytesRead));
      }
    } else {
      for await (const chunk of process.stdin) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += data.length;
        if (bytes > HARD_LIMITS.bytes) { process.stdin.pause(); throw new HostError('RESOURCE_LIMIT'); }
        chunks.push(data);
      }
    }
    return Buffer.concat(chunks, bytes);
  } finally { await handle?.close(); }
}
async function absent(file: string, io: FileSystem) {
  try { await io.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new HostError('OUTPUT_EXISTS');
}
export async function publishExclusive(file: string, text: string, inputs: readonly string[] = [], io: FileSystem = fs): Promise<readonly string[]> {
  const output = path.resolve(file);
  if (output.length > 4096) throw new HostError('OUTPUT_PATH');
  const parent = await io.realpath(path.dirname(output));
  const resolved = path.join(parent, path.basename(output));
  for (const input of inputs.filter(i => i !== '-')) {
    if (path.resolve(input) === output || await io.realpath(input) === resolved) throw new HostError('OUTPUT_ALIAS');
  }
  // This rejects symlink/hardlink aliases as well as every other existing output.
  await absent(resolved, io);
  const stage = path.join(parent, `.circuit-${randomUUID()}.tmp`);
  let owned = false, published = false;
  const warnings: string[] = [];
  try {
    const handle = await io.open(stage, 'wx', 0o600); owned = true;
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    // Commit point: hard-link creation is exclusive. No rename/overwrite fallback.
    await io.link(stage, resolved); published = true;
  } finally {
    if (owned) {
      try { await io.unlink(stage); } catch (error) {
        if (published) warnings.push('STAGING_CLEANUP');
        else throw new HostError('STAGING_CLEANUP', `Publication failed; owned staging cleanup also failed: ${(error as NodeJS.ErrnoException).code ?? 'IO'}`);
      }
    }
  }
  return warnings;
}
