import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
test('boundary gate rejects static, reexport, dynamic, host and package leaks', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { checkSource, checkRepository } from './implementation/validation/import-boundaries.mjs';
    for (const source of [
      "import React from 'react'", "export * from '../ui/app'",
      "import('../ui/app')", "require('react-dom')", "import(name)",
      "document.title = 'bad'", "new Worker('x')", "fetch('https://example.invalid')",
      "const data = { document }", "globalThis.document.title = 'bad'",
      "globalThis['fetch']('https://example.invalid')", "self.document.title = 'bad'",
      "function encode(document: object) { return document; } document.title = 'bad'",
      "{ let fetch = () => 1; fetch(); } fetch('bad')",
      "const data = { [document.title]: 1 }", "window.location.href", "navigator.language",
      "type T = import('../ui/app').T", "import fs from 'node:fs'"
    ]) assert.ok(checkSource('src/core/example.ts', source).length, source);
    assert.ok(checkSource('src/cli/index.ts', "import '../worker/host'").length);
    for (const source of [
      "export function encode(document: object) { return JSON.stringify(document); }",
      "const document = {}; JSON.stringify(document)",
      "function encode({ document }: { document: object }) { return { document }; }",
      "function encode({ document: value }: { document: object }) { return value; }",
      "const data = { document: 'text', fetch: 42, window() { return 1; } }; data.document; data['fetch']",
      "interface Data { document: string; fetch: number } type Worker = { window: string };",
      "function encode(globalThis: { document: string }) { return globalThis.document; }",
      "function encode(self: { document: string }) { return self.document; }",
      "try { throw 1; } catch (document) { JSON.stringify(document); }",
      "const fetch = () => 1; const data = { fetch }; fetch()"
    ]) assert.deepEqual(checkSource('src/core/example.ts', source), [], source);
    assert.deepEqual(checkSource('src/core/example.ts', "import { x } from '../contracts/types'"), []);
    assert.deepEqual(checkSource('src/cli/index.ts', "import fs from 'node:fs'"), []);
    for (const file of ['src/core/model.ts', 'src/contracts/model.ts']) {
      assert.ok(checkSource(file, "import '../../hosts/node/files'").length);
      assert.ok(checkSource(file, "import '../../cli/index'").length);
    }
    for (const source of ["import '../../ui/app'", "import '../browser/files'", "import '../../cli/index'", "import React from 'react'", "import Ajv from 'ajv'", "fetch('url')"]) assert.ok(checkSource('src/hosts/node/files.ts', source).length);
    assert.deepEqual(checkSource('src/cli/index.ts', "import '../hosts/node/files'"), []);
    assert.deepEqual(checkSource('src/hosts/node/files.ts', "import './other'; import '../../core/persistence'; import '../../contracts/validation'; import fs from 'node:fs'"), []);
    assert.ok(checkSource('src/cli/index.ts', "import '../hosts/browser/files'").length);
    assert.deepEqual(checkRepository(), []);
    console.log('boundary negative and positive fixtures passed');
  `], { encoding: 'utf8' });
  expect(output).toContain('fixtures passed');
});
test('CLI bundle gate rejects UI/React/worker inputs and accepts core inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circuit-boundaries-'));
  const meta = join(dir, 'meta.json');
  try {
    for (const file of ['src/ui/app.tsx', 'node_modules/react/index.js', 'src/worker/host.ts', 'src/hosts/browser/files.ts', 'src/core/model.ts', 'src/hosts/node/files.ts']) {
      writeFileSync(meta, JSON.stringify({ inputs: { [file]: {} } }));
      const result = spawnSync(process.execPath, ['implementation/validation/import-boundaries.mjs', '--bundle', meta], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(['src/core/model.ts', 'src/hosts/node/files.ts'].includes(file) ? 0 : 1);
      if (result.status === 1) expect(result.stderr).toContain(`CLI bundle contains forbidden input ${file}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
