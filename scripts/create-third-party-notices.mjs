import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const lockPath = 'package-lock.json';
const outputPath = 'public/THIRD_PARTY_NOTICES.txt';
const lock = JSON.parse(await readFile(lockPath, 'utf8'));

if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
  throw new Error('Expected package-lock.json lockfileVersion 3 with a root package entry');
}

const lockedPackages = lock.packages;
const rootDependencies = lockedPackages[''].dependencies ?? {};

function dependencyNames(entry) {
  const optionalDependencies = new Set(Object.keys(entry.optionalDependencies ?? {}));
  const required = new Set([
    ...Object.keys(entry.dependencies ?? {}).filter(name => !optionalDependencies.has(name)),
    ...Object.keys(entry.peerDependencies ?? {}).filter(name => !entry.peerDependenciesMeta?.[name]?.optional),
  ]);
  const optional = new Set([
    ...optionalDependencies,
    ...Object.keys(entry.peerDependencies ?? {}).filter(name => entry.peerDependenciesMeta?.[name]?.optional),
  ]);
  return { required: [...required].sort(), optional: [...optional].filter(name => !required.has(name)).sort() };
}

function parentPackagePath(packagePath) {
  const nested = packagePath.lastIndexOf('/node_modules/');
  return nested === -1 ? '' : packagePath.slice(0, nested);
}

function resolveLockedPackage(fromPackagePath, dependencyName) {
  let current = fromPackagePath;
  while (true) {
    const candidate = current
      ? posix.join(current, 'node_modules', dependencyName)
      : posix.join('node_modules', dependencyName);
    if (lockedPackages[candidate]) return candidate;
    if (!current) return undefined;
    current = parentPackagePath(current);
  }
}

const productionPackagePaths = new Set();
const pending = Object.keys(rootDependencies).sort().map(name => ({ from: '', name, optional: false }));
while (pending.length > 0) {
  const dependency = pending.shift();
  const packagePath = resolveLockedPackage(dependency.from, dependency.name);
  if (!packagePath) {
    if (dependency.optional) continue;
    throw new Error(`Locked production dependency ${dependency.name} cannot be resolved from ${dependency.from || '<root>'}`);
  }
  if (productionPackagePaths.has(packagePath)) continue;
  productionPackagePaths.add(packagePath);

  const entry = lockedPackages[packagePath];
  if (entry.dev === true) {
    throw new Error(`Production dependency ${packagePath} is marked dev-only in ${lockPath}`);
  }
  const names = dependencyNames(entry);
  pending.push(...names.required.map(name => ({ from: packagePath, name, optional: false })));
  pending.push(...names.optional.map(name => ({ from: packagePath, name, optional: true })));
}

async function licenseFiles(packagePath) {
  const entries = (await readdir(packagePath)).sort();
  const primary = entries.filter(name => /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(name));
  if (primary.length === 0) throw new Error(`No license text file found for ${packagePath}`);
  return [...new Set([...primary, ...entries.filter(name => /^notice(?:$|[._-])/i.test(name))])];
}

const packages = [];
for (const packagePath of [...productionPackagePaths].sort()) {
  const installedPath = packagePath;
  const metadata = JSON.parse(await readFile(join(installedPath, 'package.json'), 'utf8'));
  const locked = lockedPackages[packagePath];
  if (!metadata.name || !metadata.version || metadata.version !== locked.version) {
    throw new Error(`Installed metadata does not match the lock for ${packagePath}`);
  }
  if (typeof metadata.license !== 'string' || metadata.license.trim() === '') {
    throw new Error(`Missing declared license metadata for ${metadata.name}@${metadata.version}`);
  }

  const texts = [];
  for (const file of await licenseFiles(installedPath)) {
    const filePath = join(installedPath, file);
    if (!(await stat(filePath)).isFile()) continue;
    const text = (await readFile(filePath, 'utf8')).replaceAll('\r\n', '\n').trim();
    if (!text) throw new Error(`Empty license notice file ${filePath}`);
    texts.push({ file, text });
  }
  if (texts.length === 0) throw new Error(`No readable license text found for ${metadata.name}@${metadata.version}`);
  packages.push({ name: metadata.name, version: metadata.version, license: metadata.license, texts });
}

packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
const divider = '='.repeat(78);
const sections = packages.map(pkg => [
  divider,
  `${pkg.name}@${pkg.version}`,
  `Declared license: ${pkg.license}`,
  ...pkg.texts.flatMap(({ file, text }) => ['', `--- ${file} ---`, text]),
].join('\n'));
const output = [
  'THIRD-PARTY SOFTWARE NOTICES',
  '',
  `Production npm packages covered: ${packages.length}`,
  'Generated deterministically from package-lock.json and the installed package license files.',
  'This notice is provided for license attribution and is not legal advice or legal certification.',
  '',
  ...sections,
  '',
].join('\n');

await writeFile(outputPath, output, 'utf8');
console.log(`Wrote ${outputPath} with notices for ${packages.length} production npm packages:`);
for (const pkg of packages) console.log(`- ${pkg.name}@${pkg.version} (${pkg.license})`);
