import { advanced, inspectProject, moreFiles } from './helpers/authoring';
import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let oracle: typeof import('../../src/core/persistence') & typeof import('../../src/core/domain/geometry') & typeof import('../../src/core/catalog');
let oracleDir: string;
test.beforeAll(async () => {
  oracleDir = await mkdtemp(join(tmpdir(), 'export-oracle-'));
  const outfile = join(oracleDir, 'oracle.mjs');
  await build({ stdin: { contents: "export {decodeProject} from './src/core/persistence'; export {portPosition} from './src/core/domain/geometry'; export {getDefinition} from './src/core/catalog';", resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm' });
  oracle = await import(pathToFileURL(outfile).href);
});
test.afterAll(async () => { if (oracleDir) await rm(oracleDir, { recursive: true, force: true }); });

test('real production service worker precache controls page and restarts offline with example', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.locator('.file-feedback > summary').click(); await expect(page.getByText('Offline ready', { exact: false })).toBeVisible();
  const cache = await page.evaluate(async () => { const keys = await caches.keys(); const own = keys.filter(k => k.startsWith('independent-circuit-static-')); return { own, paths: await Promise.all(own.map(async k => (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname))), controlled: !!navigator.serviceWorker.controller }; });
  expect(cache.controlled).toBe(true); expect(cache.own).toHaveLength(1); expect(cache.own[0]).toMatch(/[a-f0-9]{20}$/);
  expect(cache.paths[0]).toContain('/index.html'); expect(cache.paths[0]).toContain('/selfhold.circuit.json'); expect(cache.paths[0]?.every(p => ['/', '/index.html', '/selfhold.circuit.json'].includes(p) || p.startsWith('/assets/'))).toBe(true);
  await page.evaluate(async () => { await (await caches.open('unrelated-cache')).put('/other', new Response('keep')); });
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('heading', { name: 'Independent Circuit Editor' })).toBeVisible(); await page.locator('.file-feedback > summary').click(); await expect(page.getByText('Offline ready', { exact: false })).toBeVisible();
  page.once('dialog', d => d.accept('Discard')); await moreFiles(page); await page.getByRole('button', { name: 'Load example', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();
  expect(cache.paths[0]?.some(p => /assets\/worker-.*\.js$/.test(p))).toBe(true);
  const runtimeWorkers: string[] = []; page.on('worker', w => runtimeWorkers.push(w.url()));
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('[data-observable="device_relay/energized"]')).toContainText('false');
  await page.locator('[data-actuator="instance_start"]').focus(); await page.keyboard.press(' ');
  await expect(page.locator('[data-observable="device_relay/energized"]')).toContainText('true');
  expect(runtimeWorkers.some(p => /worker-.*\.js/.test(p))).toBe(true);
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click();
  expect(await page.evaluate(() => caches.has('unrelated-cache'))).toBe(true); expect(errors).toEqual([]);
  // Real registration of the same built worker at a distinct script URL exercises
  // conservative waiting/activation, not a mocked service worker or changed asset build.
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Lamp', exact: true }).click(); await advanced(page); await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click();
  await expect(page.locator('header')).toContainText('Unsaved changes');
  await page.evaluate(async () => { await navigator.serviceWorker.register('/service-worker.js?waiting-policy'); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Objects (8 symbols)' })).toBeVisible(); await expect(page.locator('header')).toContainText('Unsaved changes');
});

test('actual standalone SVG download parses hostile labels as inert text; design print hides authoring and overlays', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Text tool', exact: true }).click(); await page.getByLabel('Annotation text', { exact: true }).fill('<script onload="evil()">& text'); await advanced(page); await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click();
  const event = page.waitForEvent('download'); await moreFiles(page); await page.getByRole('button', { name: 'Export design SVG', exact: true }).click(); const downloaded = await event; const text = await readFile((await downloaded.path())!, 'utf8');
  const inspected = await page.evaluate(text => { const doc = new DOMParser().parseFromString(text, 'image/svg+xml'); return { errors: doc.querySelectorAll('parsererror').length, text: doc.documentElement.textContent, dangerous: doc.querySelectorAll('script,foreignObject,image,[href],[onload]').length, family: doc.querySelector('g')?.getAttribute('font-family') }; }, text);
  expect(inspected.errors).toBe(0); expect(inspected.dangerous).toBe(0); expect(inspected.text).toContain('<script onload="evil()">& text'); expect(inspected.family).toBe('sans-serif'); expect(text).not.toMatch(/selected|data-port|onpointer|foreignObject/);
  await moreFiles(page); await page.getByRole('button', { name: 'Design print preview', exact: true }).click(); await expect(page.locator('.print-design')).toBeVisible();
  await page.emulateMedia({ media: 'print' }); await expect(page.locator('.authoring')).toBeHidden(); await expect(page.locator('.file-panel>fieldset')).toBeHidden(); await expect(page.locator('.print-design')).toBeVisible();
  await expect(page.locator('.print-design')).toContainText('page clipped'); expect(await page.locator('.print-design .selected').count()).toBe(0);
});

test('valid uploaded Unicode/control text and prototype-like IDs export portable XML with exact finite geometry and unchanged saved data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || m.text().includes('<title>')) errors.push(m.text()); });
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  const input = JSON.parse(await readFile('examples/p0/selfhold.circuit.json', 'utf8'));
  const text = 'A\u0001\u000b\ufffe\uffff <>&"\t\n\r é漢😀';
  const safe = 'A���� <>&"\t\n\n é漢😀'; // XML parsers normalize literal CR to LF.
  input.title = text;
  // Device names are schema-restricted identifiers; free user text lives in the fields below.
  const ids = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const sheet = input.sheets[0];
  for (const [n, id] of ids.entries()) {
    const instance = sheet.instances[n], old = instance.id;
    instance.id = id;
    instance.label = text;
    instance.markings.showDeviceName = true;
    instance.markings.showLabel = true;
    instance.markings.showTerminals = true;
    for (const w of sheet.wires) for (const e of [w.from, w.to]) if (e.kind === 'port' && e.instanceId === old) e.instanceId = id;
    for (const port of oracle.getDefinition(instance.definition.id)!.ports) instance.markings.terminalLabels[port.id] = text;
  }
  sheet.annotations.push({ id: 'xml_controls', position: { x: 20, y: 20 }, text });
  // These arrays are unordered design collections; use the codec's canonical ID order for comparison.
  sheet.instances.sort((a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const decoded = oracle.decodeProject(JSON.stringify(input));
  if (!decoded.ok) throw Error(JSON.stringify(decoded.diagnostics));
  expect(decoded.ok).toBe(true);
  const p = decoded.value;
  await page.goto('/');
  page.once('dialog', d => d.accept('Discard'));
  await page.getByLabel('Open circuit file', { exact: true }).setInputFiles({ name: 'unicode.circuit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) });
  await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();
  await inspectProject(page);
  expect(JSON.parse((await page.getByTestId('project-json').textContent())!)).toEqual(p);
  // Actual canvas body and port coordinates must match stored transforms for all legal IDs.
  for (const instance of p.sheets[0]!.instances.filter(i => ids.includes(i.id))) {
    const { x, y } = instance.transform.position;
    await expect(page.locator(`.drawing g[transform="translate(${x} ${y}) rotate(${instance.transform.rotation}) scale(${instance.transform.mirrorX ? -1 : 1} 1)"]`)).toHaveCount(1);
    for (const port of oracle.getDefinition(instance.definition.id)!.ports) {
      const a = oracle.portPosition(instance, port.id)!;
      await expect(page.locator(`[data-port="${instance.id}/${port.id}"]`)).toHaveAttribute('cx', String(a.x));
      await expect(page.locator(`[data-port="${instance.id}/${port.id}"]`)).toHaveAttribute('cy', String(a.y));
    }
  }
  const event = page.waitForEvent('download');
  await moreFiles(page); await page.getByRole('button', { name: 'Export design SVG', exact: true }).click();
  const svg = await readFile((await (await event).path())!, 'utf8');
  expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  const parsed = await page.evaluate(svg => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return { errors: doc.querySelectorAll('parsererror').length, title: doc.querySelector('title')?.textContent, texts: [...doc.querySelectorAll('text')].map(t => t.textContent), transforms: [...doc.querySelectorAll('g[transform]')].map(g => g.getAttribute('transform')), circles: [...doc.querySelectorAll('circle[cx]')].map(c => [c.getAttribute('cx'), c.getAttribute('cy')]), dangerous: [...doc.querySelectorAll('*')].flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name) || /href/i.test(a.name))).length + doc.querySelectorAll('script,foreignObject,image').length };
  }, svg);
  expect(parsed.errors).toBe(0); expect(parsed.dangerous).toBe(0);
  expect(parsed.title).toBe(`${safe} — design only, page clipped, not physical scale`);
  expect(parsed.texts.filter(t => t === safe).length).toBeGreaterThanOrEqual(13);
  for (const i of p.sheets[0]!.instances) {
    expect(parsed.transforms).toContain(`translate(${i.transform.position.x} ${i.transform.position.y}) rotate(${i.transform.rotation}) scale(${i.transform.mirrorX ? -1 : 1} 1)`);
    for (const port of oracle.getDefinition(i.definition.id)!.ports) { const a = oracle.portPosition(i, port.id)!; expect(parsed.circles).toContainEqual([String(a.x), String(a.y)]); }
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download copy', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const saved = oracle.decodeProject(new Uint8Array(bytes));
  expect(saved.ok).toBe(true); if (saved.ok) expect(saved.value).toEqual(p);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('independent-circuit:recovery:v1'))).not.toBeNull();
  const recovered = await page.evaluate(() => localStorage.getItem('independent-circuit:recovery:v1'));
  expect(JSON.parse(recovered!)).toEqual(p);
  expect(errors).toEqual([]);
});
