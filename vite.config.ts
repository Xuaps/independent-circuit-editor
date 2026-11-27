import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
function offline(): Plugin {
  return { name: 'own-static-offline', apply: 'build', generateBundle: {
    // Vite's HTML plugin emits the transformed index.html in its default-order generateBundle hook.
    order: 'post',
    handler(_options, bundle) {
      const html = bundle['index.html'];
      if (html?.type !== 'asset') this.error('Offline shell requires an emitted index.html asset');
      const htmlSha256 = createHash('sha256').update(html.source).digest('hex');
      const assets = ['/', '/index.html', '/selfhold.circuit.json', ...Object.keys(bundle).filter(p => p.startsWith('assets/')).map(p => '/' + p)];
      const hash = createHash('sha256');
      for (const [name, item] of Object.entries(bundle).sort()) hash.update(name).update(item.type === 'chunk' ? item.code : item.source);
      hash.update(readFileSync('public/selfhold.circuit.json'));
      const source = readFileSync('src/service-worker.ts', 'utf8'); hash.update(source);
      const version = hash.digest('hex').slice(0, 20);
      const worker = source.replace(/declare const .*?;\n/g, '')
        .replaceAll('__ASSETS__', JSON.stringify(assets))
        .replaceAll('__VERSION__', JSON.stringify(version))
        .replaceAll('__HTML_SHA256__', JSON.stringify(htmlSha256));
      const code = transformSync(worker, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source: code });
    }
  } };
}
export default defineConfig({ plugins: [offline()], server: { host: '127.0.0.1' }, preview: { host: '127.0.0.1' }, build: { outDir: 'dist/ui' } });
