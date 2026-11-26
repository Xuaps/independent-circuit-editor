import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HARD_LIMITS } from '../../src/core/persistence';
import { publishExclusive, readBounded, type FileSystem } from '../../src/hosts/node/files';
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'circuit-host-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const file = (s: string) => path.join(dir, s);
it('publishes complete bytes on the actual local filesystem; only complete file remains', async () => {
  expect(await publishExclusive(file('out'), 'complete')).toEqual([]);
  expect(await fs.readFile(file('out'), 'utf8')).toBe('complete');
  expect(await fs.readdir(dir)).toEqual(['out']);
});
it('refuses existing, lexical, symlink, hardlink and resolved-parent aliases without touching bytes', async () => {
  await fs.writeFile(file('source'), 'source'); await fs.mkdir(file('parent'));
  await fs.symlink(dir, file('parent/alias')); await fs.symlink(file('source'), file('symlink')); await fs.link(file('source'), file('hardlink'));
  for (const target of ['source', 'symlink', 'hardlink', 'parent/alias/source']) await expect(publishExclusive(file(target), 'BAD', [file('source')])).rejects.toThrow();
  expect(await fs.readFile(file('source'), 'utf8')).toBe('source');
  expect((await fs.readdir(dir)).filter(s => s.startsWith('.circuit-'))).toEqual([]);
});
it('exclusive publication preserves a competing output created after the absence check', async () => {
  const io: FileSystem = { ...fs, link: async (stage, destination) => { await fs.writeFile(destination, 'competitor', { flag: 'wx' }); return fs.link(stage, destination); } };
  await expect(publishExclusive(file('out'), 'ours', [], io)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(file('out'), 'utf8')).toBe('competitor'); expect(await fs.readdir(dir)).toEqual(['out']);
});
it.each(['open','write','flush','close','publish'] as const)('injected %s failure precedes commit, leaves no output or owned stages', async phase => {
  await fs.writeFile(file('source'), 'source');
  const fail = () => { throw new Error(`injected ${phase}`); };
  const io: FileSystem = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (phase === 'open') return fail();
    const h = await fs.open(...args);
    return { writeFile: phase === 'write' ? fail : h.writeFile.bind(h), sync: phase === 'flush' ? fail : h.sync.bind(h), close: phase === 'close' ? async () => { await h.close(); fail(); } : h.close.bind(h) } as typeof h;
  }, link: phase === 'publish' ? fail : fs.link };
  await expect(publishExclusive(file('out'), 'complete', [file('source')], io)).rejects.toThrow(`injected ${phase}`);
  expect(await fs.readdir(dir)).toEqual(['source']); expect(await fs.readFile(file('source'), 'utf8')).toBe('source');
});
it('cleanup failure after commit warns and retains fully published output and only its own stage', async () => {
  const paths: string[] = [];
  const io: FileSystem = { ...fs, unlink: async p => { paths.push(String(p)); throw new Error('cleanup'); } };
  expect(await publishExclusive(file('out'), 'complete', [], io)).toEqual(['STAGING_CLEANUP']);
  expect(await fs.readFile(file('out'), 'utf8')).toBe('complete'); expect(paths).toHaveLength(1); expect(path.basename(paths[0]!)).toMatch(/^\.circuit-.*\.tmp$/);
  expect(await fs.readdir(dir)).toHaveLength(2);
});
it('cleanup failure before commit does not claim rollback of staging or successful publication', async () => {
  const io: FileSystem = { ...fs, link: async () => { throw new Error('publish'); }, unlink: async () => { throw new Error('cleanup'); } };
  await expect(publishExclusive(file('out'), 'complete', [], io)).rejects.toMatchObject({ code: 'STAGING_CLEANUP' });
  expect(await fs.readdir(dir)).toHaveLength(1); await expect(fs.stat(file('out'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('never unlinks an unowned colliding stage when exclusive open fails', async () => {
  const unlink = vi.fn(fs.unlink);
  const io: FileSystem = { ...fs, open: async (...args: Parameters<typeof fs.open>) => { await fs.writeFile(args[0], 'competitor'); return fs.open(...args); }, unlink };
  await expect(publishExclusive(file('out'), 'ours', [], io)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(unlink).not.toHaveBeenCalled(); expect(await fs.readFile(file((await fs.readdir(dir))[0]!), 'utf8')).toBe('competitor');
});
it('actual competing publishers produce exactly one complete winner', async () => {
  const results = await Promise.allSettled(['first', 'second'].map(text => publishExclusive(file('out'), text)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(['first','second']).toContain(await fs.readFile(file('out'),'utf8')); expect(await fs.readdir(dir)).toEqual(['out']);
});
it('reads bounded actual bytes; rejects directory and oversize, including a growing file without trusting stat size', async () => {
  await fs.writeFile(file('in'), 'hello'); expect(Buffer.from(await readBounded(file('in'))).toString()).toBe('hello');
  await expect(readBounded(dir)).rejects.toThrow();
  await fs.writeFile(file('big'), Buffer.alloc(HARD_LIMITS.bytes + 1));
  await expect(readBounded(file('big'))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  const io: FileSystem = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args); let left = HARD_LIMITS.bytes + 1;
    return { stat: async () => ({ isFile: () => true, size: 1 }), read: async (b: Buffer) => { const n = Math.min(left,b.length); b.fill(65); left -= n; return { bytesRead: n }; }, close: h.close.bind(h) } as typeof h;
  } };
  await expect(readBounded(file('in'),io)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
});
it('read/open failures propagate and close a handle on read error; FIFO is rejected without blocking', async () => {
  await expect(readBounded(file('missing'))).rejects.toMatchObject({code:'ENOENT'});
  const close = vi.fn(async () => {});
  const io: FileSystem = { ...fs, open: async () => ({ stat: async () => ({ isFile: () => true }), read: async () => { throw new Error('read'); }, close }) as unknown as Awaited<ReturnType<typeof fs.open>> };
  await expect(readBounded('unused', io)).rejects.toThrow('read'); expect(close).toHaveBeenCalledOnce();
  const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [file('fifo')]);
  await expect(readBounded(file('fifo'))).rejects.toMatchObject({code:'INPUT_TYPE'});
  expect(constants.O_NONBLOCK).toBeGreaterThan(0);
});
