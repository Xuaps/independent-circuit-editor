import { advanced, inspectProject, moreFiles, reveal } from './helpers/authoring';
import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let decode: typeof import('../../src/core/persistence').decodeProject;
let oracleDir: string;
test.beforeAll(async () => { oracleDir = await mkdtemp(join(tmpdir(), 'browser-file-codec-')); const outfile = join(oracleDir, 'codec.mjs'); await build({ stdin: { contents: "export {decodeProject} from './src/core/persistence';", resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm' }); decode = (await import(pathToFileURL(outfile).href)).decodeProject; });
test.afterAll(async () => { if (oracleDir) await rm(oracleDir, { recursive: true, force: true }); });
const key = 'independent-circuit:recovery:v1';
async function start(page: Page) { await page.goto('/'); await inspectProject(page); }
async function graph(page: Page) { return JSON.parse((await page.getByTestId('project-json').textContent())!); }
async function place(page: Page) { await page.getByRole('button', { name: 'Lamp', exact: true }).click(); await advanced(page); await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Objects (1 symbols)' })).toBeVisible(); }
async function prompt(page: Page, choice: string) { page.once('dialog', d => d.accept(choice)); }
// Register before triggering, and await accept itself (not just dialog emission).
async function chooseForAction(page: Page, choice: string, action: () => Promise<unknown>) {
  const handled = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('prompt');
    expect(dialog.message()).toContain('Unsaved or unconfirmed work');
    await dialog.accept(choice);
  });
  await Promise.all([handled, action()]);
}
async function filesIdle(page: Page) {
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeEnabled();
  await expect(page.locator('.authoring')).not.toHaveAttribute('inert', '');
}
async function fallback(page: Page) { await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); }); }
const upload = (page: Page, text: string, name = 'not-a-circuit.txt') => page.getByLabel('Open circuit file', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

test('real Download copy/reopen full graph; Save fallback never silently authorizes replacement', async ({ page }) => {
  await fallback(page); await start(page); await place(page); const original = await graph(page);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download copy', exact: true }).click(); const item = await download;
  expect(item.suggestedFilename()).toMatch(/\.circuit\.json$/); const bytes = await readFile((await item.path())!); expect(JSON.parse(bytes.toString())).toEqual(original); const loaded = decode(new Uint8Array(bytes)); expect(loaded.ok).toBe(true); if (loaded.ok) expect(loaded.value).toEqual(original);
  await expect(page.getByTestId('file-status')).toContainText('NOT confirmed saved');
  await expect(page.locator('.file-feedback > summary')).toHaveText('Unsaved changes');
  await prompt(page, 'Save'); const second = page.waitForEvent('download'); await page.getByRole('button', { name: 'New', exact: true }).click(); await second; expect(await graph(page)).toEqual(original);
  await prompt(page, 'Cancel'); await page.getByRole('button', { name: 'New', exact: true }).click(); expect(await graph(page)).toEqual(original);
  await prompt(page, 'Discard'); await page.getByRole('button', { name: 'New', exact: true }).click(); expect((await graph(page)).sheets[0].instances).toHaveLength(0);
  await prompt(page, 'Discard'); await upload(page, bytes.toString()); await expect(page.getByRole('heading', { name: 'Objects (1 symbols)' })).toBeVisible(); expect(await graph(page)).toEqual(original);
});

test('invalid/future/duplicate/oversized opens preserve design and undo history; example uses guard', async ({ page }) => {
  await fallback(page); await start(page); await place(page); const before = await graph(page);
  for (const [text, code] of [
    ['{', 'MALFORMED_JSON'],
    ['{"format":1,"format":2}', 'DUPLICATE_KEY'],
    [JSON.stringify({ ...before, formatVersion: 2 }), 'INVALID_SHAPE'],
    [' '.repeat(10485761), 'RESOURCE_LIMIT'],
  ] as const) {
    const uploadDir = code === 'RESOURCE_LIMIT' ? await mkdtemp(join(tmpdir(), 'browser-oversized-upload-')) : undefined;
    try {
      if (uploadDir) {
        const filePath = join(uploadDir, 'not-a-circuit.txt');
        await writeFile(filePath, text);
        await page.getByLabel('Open circuit file', { exact: true }).setInputFiles(filePath);
      } else {
        await upload(page, text);
      }
      // Each failure differs from the preceding status: stale generic "failed" is not completion.
      await expect(page.getByTestId('file-status')).toContainText(`File action canceled or failed: Error: ${code}`);
      await filesIdle(page);
      expect(await graph(page)).toEqual(before); await expect(page.getByRole('button', { name: 'Undo (1)', exact: true })).toBeEnabled();
    } finally {
      if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    }
  }
  const example = page.getByRole('button', { name: 'Load example', exact: true });
  await moreFiles(page); await chooseForAction(page, 'Cancel', () => example.click());
  await expect(page.getByTestId('file-status')).toContainText('Switch canceled; drawing and history preserved.');
  await filesIdle(page);
  expect(await graph(page)).toEqual(before);
  await moreFiles(page); await chooseForAction(page, 'Discard', () => example.click());
  await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();
  await filesIdle(page);
  const expected = JSON.parse(await readFile('examples/p0/selfhold.circuit.json', 'utf8')); expect(await graph(page)).toEqual(expected);
});

test('recovery reload requires explicit decision; restore unconfirmed and discard isolates app key', async ({ page }) => {
  await fallback(page); await start(page); await place(page); const before = await graph(page);
  await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).not.toBeNull();
  await page.reload(); await expect(page.getByRole('button', { name: 'Restore recovery', exact: true })).toBeVisible();
  await expect(page.locator('.authoring')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Restore recovery', exact: true }).click(); await expect(page.getByTestId('file-status')).toContainText('unconfirmed');
  await inspectProject(page); expect(await graph(page)).toEqual(before); await expect(page.getByRole('button', { name: 'Undo (0)', exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.setItem('unrelated', 'keep')); await page.reload(); await page.getByRole('button', { name: 'Discard recovery', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('unrelated'))).toBe('keep'); await expect(page.getByRole('heading', { name: 'Objects (0 symbols)' })).toBeVisible();
});

test('corrupt recovery preserved until explicit discard, denied/quota visible without blocking authoring', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('independent-circuit:recovery:v1', '{broken'));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Restore recovery', exact: true })).toBeDisabled(); expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe('{broken');
  await page.getByRole('button', { name: 'Discard recovery', exact: true }).click(); await place(page);
});
for (const phase of ['denied', 'quota']) test(`recovery ${phase} remains visible and editing/download usable`, async ({ page }) => {
  await fallback(page); await page.addInitScript(phase => { if (phase === 'denied') Storage.prototype.getItem = () => { throw new DOMException('denied', 'SecurityError'); }; else Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; }, phase);
  await start(page); await place(page); await expect(page.getByTestId('file-status')).toContainText('Recovery unavailable');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download copy', exact: true }).click(); await download;
});

for (const failure of ['cancel', 'create', 'write', 'close', 'success']) test(`native adapter mock ${failure}: confirmation/locking and preserved history`, async ({ page }) => {
  await page.addInitScript(failure => {
    let closes = 0;
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      if (failure === 'cancel') throw new DOMException('cancel', 'AbortError');
      return { name: 'mock.circuit.json', createWritable: async () => { if (failure === 'create') throw Error('create failure'); return ({ write: async (data: string) => { (window as unknown as { written: string }).written = data; await new Promise(r => setTimeout(r, 150)); if (failure === 'write') throw Error('write failure'); }, close: async () => { closes++; if (failure === 'close' || closes > 1) throw Error(`close failure (attempt ${closes})`); }, abort: async () => {} }); } };
    } });
  }, failure);
  const summary = page.locator('.file-feedback > summary');
  const detail = page.getByTestId('file-status');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await start(page);
  if (failure === 'success') await expect(summary).toHaveText('Not confirmed saved');
  await place(page); const before = await graph(page);
  await save.click();
  if (failure !== 'cancel' && failure !== 'create') await expect(page.locator('.authoring')).toHaveAttribute('inert', '');
  await expect(detail).toContainText(failure === 'success' ? 'mock.circuit.json' : 'failed');
  expect(await graph(page)).toEqual(before); await expect(page.getByRole('button', { name: 'Undo (1)', exact: true })).toBeEnabled();
  if (failure === 'success') {
    expect(JSON.parse(await page.evaluate(() => (window as unknown as { written: string }).written))).toEqual(before);
    expect(await page.evaluate(k => localStorage.getItem(k), key)).toBeNull();
    await expect(summary).toHaveText('Confirmed saved');
    await page.getByRole('button', { name: 'Undo (1)', exact: true }).click(); await expect(page.getByTestId('design-status')).toContainText('Unsaved changes');
    await expect(summary).toHaveText('Unsaved changes');
    await summary.click();
    await expect(detail).toBeVisible();
    await expect(detail).toHaveText('Last successful native save: mock.circuit.json. Only APPLIED form changes included.');
    await summary.click();
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).not.toBeNull();
    await page.getByRole('button', { name: 'Redo (1)', exact: true }).click(); await expect(page.getByTestId('design-status')).toContainText('Content baseline unchanged');
    await expect(summary).toHaveText('Confirmed saved');
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).toBeNull();
    await save.click();
    await expect(detail).toContainText('close failure (attempt 2)');
    await expect(summary).toHaveText('Confirmed saved · Check file status');
    await page.getByRole('button', { name: 'Undo (1)', exact: true }).click();
    await save.click();
    await expect(detail).toContainText('close failure (attempt 3)');
    await expect(summary).toHaveText('Unsaved changes · Check file status');
  } else {
    await expect(page.getByTestId('design-status')).toContainText('Unsaved changes');
    if (failure === 'close') await expect(summary).toHaveText('Unsaved changes · Check file status');
  }
});

test('pending older recovery timer cannot overwrite new generation; another tab disables this tab recovery writes', async ({ page }) => {
  await fallback(page); await start(page); await place(page);
  await prompt(page, 'Discard'); await page.getByRole('button', { name: 'New', exact: true }).click(); const blank = await graph(page);
  await page.waitForTimeout(450); expect(JSON.parse((await page.evaluate(k => localStorage.getItem(k), key))!)).toEqual(blank);
  await page.evaluate(k => window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: 'other' })), key);
  await expect(page.getByTestId('file-status')).toContainText('Another tab'); await place(page); await page.waitForTimeout(450);
  expect(JSON.parse((await page.evaluate(k => localStorage.getItem(k), key))!)).toEqual(blank);
});

test('native open adapter cancellation/future/slow read preserves file association and locks authoring until validated intent', async ({ page }) => {
  const sample = await readFile('examples/p0/selfhold.circuit.json', 'utf8');
  await page.addInitScript(sample => {
    let opens = 0, saves = 0;
    const handle = { name: 'associated.circuit.json', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    Object.defineProperty(window, 'showSaveFilePicker', { value: async () => { saves++; (window as unknown as { picks: number }).picks = saves; return handle; } });
    Object.defineProperty(window, 'showOpenFilePicker', { value: async () => {
      opens++; if (opens === 1) throw new DOMException('canceled', 'AbortError');
      return [{ ...handle, name: 'selected.circuit.json', getFile: async () => { await new Promise(r => setTimeout(r, 350)); return new File([opens === 2 ? sample.replace('"formatVersion": 1', '"formatVersion": 2') : sample], 'selected.circuit.json'); } }];
    } });
  }, sample);
  await start(page); await place(page); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByTestId('file-status')).toContainText('Last successful native save: associated.circuit.json.'); const original = await graph(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.getByTestId('file-status')).toContainText('failed'); expect(await graph(page)).toEqual(original);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.authoring')).toHaveAttribute('inert', ''); await expect(page.getByTestId('file-status')).toContainText('File action canceled or failed: Error: INVALID_SHAPE'); await filesIdle(page); expect(await graph(page)).toEqual(original);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByTestId('file-status')).toContainText('Last successful native save: associated.circuit.json.'); expect(await page.evaluate(() => (window as unknown as { picks: number }).picks)).toBe(1);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.authoring')).toHaveAttribute('inert', ''); await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible(); expect(await graph(page)).toEqual(JSON.parse(sample));
});

test('Save in switch prompt requires real mocked close confirmation; later New gets a new baseline', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: async () => ({ name: 'mock.json', createWritable: async () => ({ write: async () => {}, close: async () => {} }) }) }));
  await start(page); await place(page); await prompt(page, 'Save'); await page.getByRole('button', { name: 'New', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Objects (0 symbols)' })).toBeVisible(); await expect(page.getByTestId('file-status')).toContainText('unconfirmed');
});

test('actual full graph upload/download/reopen preserves renamed hidden ID-bound design and no host/runtime fields', async ({ page }) => {
  await fallback(page); await start(page);
  const sample = JSON.parse(await readFile('examples/p0/selfhold.circuit.json', 'utf8'));
  sample.title = '../../hostile title'; sample.devices.find((d: { id: string }) => d.id === 'device_relay').name = 'RenamedRelay';
  sample.sheets[0].instances.find((i: { id: string }) => i.id === 'instance_hold').markings.showDeviceName = false;
  sample.sheets[0].instances.find((i: { id: string }) => i.id === 'instance_lamp').label = '<script>& inert';
  await prompt(page, 'Discard'); await upload(page, JSON.stringify(sample)); await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible(); expect(await graph(page)).toEqual(sample);
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download copy', exact: true }).click(); const downloaded = await event; expect(downloaded.suggestedFilename()).not.toMatch(/[<>/\\]/);
  const bytes = await readFile((await downloaded.path())!); const decoded = decode(new Uint8Array(bytes)); expect(decoded.ok).toBe(true); if (decoded.ok) expect(decoded.value).toEqual(sample);
  expect(Object.keys(JSON.parse(bytes.toString())).sort()).toEqual(['devices', 'format', 'formatVersion', 'modelSet', 'projectId', 'revision', 'sheets', 'title']);
  await prompt(page, 'Discard'); await page.getByRole('button', { name: 'New', exact: true }).click();
  await prompt(page, 'Discard'); await upload(page, bytes.toString()); await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible(); expect(await graph(page)).toEqual(sample);
});

test('selection/pan/hover do not repeatedly write design recovery', async ({ page }) => {
  await fallback(page);
  await page.addInitScript(() => { const set = Storage.prototype.setItem; (window as unknown as { recoveryWrites: number }).recoveryWrites = 0; Storage.prototype.setItem = function(k, v) { if (k === 'independent-circuit:recovery:v1') (window as unknown as { recoveryWrites: number }).recoveryWrites++; return set.call(this, k, v); }; });
  await start(page); await place(page); await page.waitForTimeout(450);
  const count = await page.evaluate(() => (window as unknown as { recoveryWrites: number }).recoveryWrites); expect(count).toBe(1);
  await advanced(page); await page.getByRole('button', { name: 'Pan right', exact: true }).click(); await reveal(page, 'Shared devices'); await page.getByRole('button', { name: 'Linked symbols for H1', exact: true }).click(); await page.getByRole('button', { name: 'Zoom in', exact: true }).hover(); await page.waitForTimeout(450);
  expect(await page.evaluate(() => (window as unknown as { recoveryWrites: number }).recoveryWrites)).toBe(count);
});
