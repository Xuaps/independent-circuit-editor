import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, place, graph, inspectProject } from './helpers/authoring';

const key = 'independent-circuit:recovery:v1';
const directory = join(tmpdir(), 'cadesimu-ui03');
const record = (page: Page) => page.evaluate(k => localStorage.getItem(k), key);
const modal = (page: Page) => page.getByRole('dialog');
async function geometry(page: Page) {
  return { header: await page.locator('.project-bar').boundingBox(), workspace: await page.locator('.workspace').boundingBox(), canvas: await page.getByRole('img', { name: 'Circuit drawing canvas' }).boundingBox() };
}
async function insideDialog(page: Page) {
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
}
async function authoredRecovery(page: Page) {
  await open(page);
  const lamp = await place(page, 'Lamp', 300, 250);
  await page.getByLabel('Symbol label', { exact: true }).fill('Own lamp <not markup>');
  await page.getByRole('button', { name: 'Apply presentation', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === lamp.id)!.label).toBe('Own lamp <not markup>');
  const design = await graph(page);
  // Wait for the app's real recovery debounce/serialization, not an arbitrary timeout or seeded DTO.
  await expect.poll(async () => { const text = await record(page); return text ? JSON.parse(text) : null; }).toEqual(design);
  return { design, bytes: (await record(page))! };
}

test.beforeAll(async () => { await mkdir(directory, { recursive: true }); });
for (const viewport of [
  { width: 1440, height: 900, dpr: 1 },
  { width: 1024, height: 768, dpr: 1 },
  { width: 1437, height: 849, dpr: 2 }
]) test.describe(`returning session ${viewport.width}x${viewport.height} DPR${viewport.dpr}`, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr });
  test('focused native recovery, stable geometry, safe keyboard/backdrop and exact explicit Restore', async ({ page }) => {
    await page.goto('/'); await expect(page.getByRole('heading', { name: 'Select a symbol', exact: true })).toBeVisible();
    const baseline = await geometry(page);
    const { design, bytes } = await authoredRecovery(page);
    await page.reload();
    await expect(modal(page)).toHaveAccessibleName('Recover your unsaved design');
    await expect(modal(page)).toContainText('Recovery is not a confirmed saved file');
    await expect(modal(page).locator('dd').first()).toHaveText(design.title);
    await expect(modal(page).locator('dd').nth(1)).toHaveText(String(design.revision));
    await expect(modal(page).locator('dd').nth(2)).toHaveText('1');
    expect(await page.locator('.recovery-dialog').evaluate(el => el.matches(':modal'))).toBe(true);
    expect(await geometry(page)).toEqual(baseline);
    expect(await record(page)).toBe(bytes);
    await expect(page.locator('.authoring')).toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
    await expect(modal(page).getByRole('heading', { name: 'Recover your unsaved design' })).toBeFocused();
    await page.keyboard.press('Enter'); // Informative initial focus must not activate either choice.
    await expect(modal(page)).toBeVisible(); expect(await record(page)).toBe(bytes);
    for (let n = 0; n < 5; n++) { await page.keyboard.press('Tab'); await insideDialog(page); }
    for (let n = 0; n < 5; n++) { await page.keyboard.press('Shift+Tab'); await insideDialog(page); }
    await page.keyboard.press('Escape'); await expect(modal(page)).toBeVisible(); expect(await record(page)).toBe(bytes);
    await page.mouse.click(8, viewport.height / 2); await expect(modal(page)).toBeVisible(); await insideDialog(page);
    expect(await record(page)).toBe(bytes); expect(await geometry(page)).toEqual(baseline);
    const prefix = `${viewport.width}x${viewport.height}-dpr${viewport.dpr}`;
    await page.screenshot({ path: join(directory, `${prefix}-pending.png`) });
    await modal(page).getByRole('button', { name: 'Restore recovery', exact: true }).click();
    await expect(modal(page)).toHaveCount(0);
    await expect(page.locator('.authoring')).not.toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await inspectProject(page); expect(await graph(page)).toEqual(design);
    await expect(page.getByTestId('file-status')).toContainText('Recovered design — unconfirmed');
    await expect(page.getByRole('button', { name: 'Undo (0)', exact: true })).toBeDisabled();
    await expect(page.getByTestId('runtime-trace')).toHaveCount(0);
    expect(await record(page)).toBe(bytes); // Restore does not clear/rewrite the original recovery record.
    await page.getByRole('button', { name: 'Lamp', exact: true }).focus(); await expect(page.getByRole('button', { name: 'Lamp', exact: true })).toBeFocused();
    await page.screenshot({ path: join(directory, `${prefix}-restored.png`) });
  });
});

test('explicit Discard removes only the app record; no modal/inert leftovers and authoring usable', async ({ page }) => {
  const { bytes } = await authoredRecovery(page);
  await page.evaluate(() => localStorage.setItem('unrelated-ui03', 'keep'));
  await page.reload(); await expect(modal(page)).toBeVisible(); expect(await record(page)).toBe(bytes);
  await modal(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  await expect(modal(page)).toHaveCount(0); expect(await record(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('unrelated-ui03'))).toBe('keep');
  await expect(page.locator('.authoring')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Objects (0 symbols)' })).toBeVisible();
  await page.screenshot({ path: join(directory, 'discarded-blank.png') });
  await inspectProject(page); expect((await graph(page)).sheets[0]!.instances).toHaveLength(0);
  await place(page, 'NO pushbutton', 200, 200); await expect(page.getByRole('button', { name: 'Undo (1)', exact: true })).toBeEnabled();
});

test('corrupt fixture: disabled Restore, preserved raw bytes through cancel/backdrop, explicit discard only', async ({ page }) => {
  // Trusted corrupt-storage fixture only; no valid project/runtime is injected.
  const corrupt = '{ UI03 corrupt <script>alert(1)</script>';
  await page.addInitScript(({ key, corrupt }) => { localStorage.setItem(key, corrupt); localStorage.setItem('unrelated-ui03', 'keep'); }, { key, corrupt });
  await page.goto('/'); await expect(modal(page)).toHaveAccessibleName('Recovery cannot be opened');
  await expect(modal(page).getByRole('button', { name: 'Restore recovery', exact: true })).toBeDisabled();
  await expect(modal(page)).toContainText('stored bytes are preserved');
  await page.keyboard.press('Shift+Tab'); await expect(modal(page).getByRole('button', { name: 'Discard recovery', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(modal(page).getByRole('button', { name: 'Discard recovery', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await page.mouse.click(8, 250); await expect(modal(page)).toBeVisible(); expect(await record(page)).toBe(corrupt);
  await page.screenshot({ path: join(directory, 'corrupt-pending.png') });
  await modal(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  expect(await record(page)).toBeNull(); expect(await page.evaluate(() => localStorage.getItem('unrelated-ui03'))).toBe('keep');
  await expect(modal(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Lamp', exact: true })).toBeEnabled();
});

test('denied discard remains visible/pending with exact bytes and locks; retry after storage access returns', async ({ page }) => {
  const { design, bytes } = await authoredRecovery(page);
  // Narrow trusted storage-denial fixture; the recoverable design itself was authored publicly above.
  await page.addInitScript(() => {
    const remove = Storage.prototype.removeItem;
    (window as unknown as { denyRecoveryRemoval: boolean }).denyRecoveryRemoval = true;
    Storage.prototype.removeItem = function(key) {
      if (key === 'independent-circuit:recovery:v1' && (window as unknown as { denyRecoveryRemoval: boolean }).denyRecoveryRemoval) throw new DOMException('UI03 removal denied', 'SecurityError');
      return remove.call(this, key);
    };
  });
  await page.reload(); await expect(modal(page)).toBeVisible();
  await modal(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  await expect(modal(page).getByRole('alert')).toContainText('Recovery discard failed');
  await expect(page.locator('.authoring')).toHaveAttribute('inert', ''); await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  expect(await record(page)).toBe(bytes);
  await page.keyboard.press('Escape'); await expect(modal(page)).toBeVisible();
  await page.screenshot({ path: join(directory, 'discard-denied.png') });
  await page.evaluate(() => { (window as unknown as { denyRecoveryRemoval: boolean }).denyRecoveryRemoval = false; });
  // Choosing Restore instead after a failed Discard still restores the ORIGINAL exact design.
  await modal(page).getByRole('button', { name: 'Restore recovery', exact: true }).click();
  await expect(modal(page)).toHaveCount(0); await inspectProject(page); expect(await graph(page)).toEqual(design); expect(await record(page)).toBe(bytes);
});

test('foreign-tab change while pending cannot discard another tab record; reload reviews the new record', async ({ page, context }) => {
  await authoredRecovery(page); await page.reload(); await expect(modal(page)).toBeVisible();
  const other = await context.newPage(); await other.goto('/'); await expect(modal(other)).toBeVisible();
  await modal(other).getByRole('button', { name: 'Restore recovery', exact: true }).click();
  await inspectProject(other); await place(other, 'NC pushbutton (Stop)', 500, 250); const newer = await graph(other);
  await expect.poll(async () => { const text = await record(other); return text ? JSON.parse(text) : null; }).toEqual(newer);
  const bytes = await record(other);
  await expect(modal(page).getByRole('alert')).toContainText('Another tab changed recovery');
  await modal(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  await expect(modal(page)).toBeVisible(); expect(await record(page)).toBe(bytes);
  await page.reload(); await expect(modal(page)).toBeVisible();
  await expect(modal(page).locator('dd').nth(2)).toHaveText('2');
  await modal(page).getByRole('button', { name: 'Restore recovery', exact: true }).click();
  await inspectProject(page); expect(await graph(page)).toEqual(newer);
});

test('own public file title is escaped in the recovery summary and exact design restores', async ({ page }) => {
  const { design } = await authoredRecovery(page);
  const ownFile = { ...design, title: 'Own <img src=x onerror=alert(1)> & recovery' };
  page.once('dialog', dialog => dialog.accept('Discard'));
  await page.getByLabel('Open circuit file', { exact: true }).setInputFiles({ name: 'ui03-own-design.circuit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ownFile)) });
  await expect.poll(async () => { const text = await record(page); return text ? JSON.parse(text) : null; }).toEqual(ownFile);
  await page.reload(); await expect(modal(page)).toBeVisible();
  await expect(modal(page).locator('dd').first()).toHaveText(ownFile.title);
  await expect(modal(page).locator('img,script')).toHaveCount(0);
  await modal(page).getByRole('button', { name: 'Restore recovery', exact: true }).click();
  await inspectProject(page); expect(await graph(page)).toEqual(ownFile);
});
