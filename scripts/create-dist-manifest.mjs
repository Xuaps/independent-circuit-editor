import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist/ui');
const output = path.join(root, 'build-manifest.json');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile() && target !== output) files.push(target);
  }
  return files;
}

const files = [];
for (const file of (await walk(root)).sort()) {
  const bytes = await readFile(file);
  const metadata = await stat(file);
  files.push({
    path: path.relative(root, file).split(path.sep).join('/'),
    bytes: metadata.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const manifest = {
  schema: 1,
  sourceRevision: process.env.GITHUB_SHA || null,
  node: process.version,
  files,
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Recorded ${files.length} deployable files in ${path.relative(process.cwd(), output)}.`);
