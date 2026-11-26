import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
function offline(): Plugin {
  return { name: 'own-static-offline', apply: 'build', generateBundle(_options, bundle) {
    const assets = ['/', '/index.html', '/selfhold.circuit.json', ...Object.keys(bundle).filter(p => p.startsWith('assets/')).map(p => '/' + p)];
    const hash = createHash('sha256');
    for (const [name, item] of Object.entries(bundle).sort()) hash.update(name).update(item.type === 'chunk' ? item.code : item.source);
    hash.update(readFileSync('public/selfhold.circuit.json'));
    const source = readFileSync('src/service-worker.ts', 'utf8'); hash.update(source);
    const version = hash.digest('hex').slice(0, 20);
    const code = transformSync(source.replaceAll('__ASSETS__', JSON.stringify(assets)).replaceAll('__VERSION__', JSON.stringify(version)).replace(/declare const .*?;\n/g, ''), { loader: 'ts', format: 'esm', target: 'es2022' }).code;
    this.emitFile({ type: 'asset', fileName: 'service-worker.js', source: code });
  } };
}
export default defineConfig({ plugins: [offline()], server: { host: '127.0.0.1' }, preview: { host: '127.0.0.1' }, build: { outDir: 'dist/ui' } });
