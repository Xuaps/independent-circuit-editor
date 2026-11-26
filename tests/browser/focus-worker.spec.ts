import { moreFiles } from './helpers/authoring';
import { test, expect } from '@playwright/test';
import { blankSelfhold, open, place, connect, bind, graph, observeBrowser } from './helpers/authoring';

test('pointer cancel/lost capture, repeated keys and window focus-loss event release controls; paused releases stay pending', async ({ page }) => {
  const errors = observeBrowser(page); const { start, coil } = await blankSelfhold(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const button = page.locator(`[data-actuator="${start.id}"]`), pressed = page.locator(`[data-observable="${start.deviceId}/pressed"]`);
  await button.scrollIntoViewIfNeeded(); const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await expect(pressed).toContainText('true');
  await button.dispatchEvent('pointercancel', { pointerId: 1 }); await expect(pressed).toContainText('false'); await page.mouse.up();
  await page.mouse.down(); await expect(pressed).toContainText('true');
  await button.evaluate(el => el.releasePointerCapture(1)); await page.mouse.move(box.x + 10, box.y + 5);
  await expect(pressed).toContainText('false'); await page.mouse.up();

  await button.focus(); await page.keyboard.down(' '); await page.keyboard.down(' '); await expect(pressed).toContainText('true');
  // Headless tabs do not reliably change OS focus. Exercise the browser lifecycle event boundary, not app state.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('heading', { name: 'Simulation — Paused' })).toBeVisible(); await expect(pressed).toContainText('false');
  await expect(page.locator(`[data-observable="${coil.deviceId}/energized"]`)).toContainText('true'); // selfhold is not emergency stop
  await page.keyboard.up(' ');
  await button.focus(); await page.keyboard.down('Enter'); await page.keyboard.up('Enter'); await expect(page.getByTestId('pending-intents')).toContainText('press'); await expect(pressed).toContainText('false');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'hidden');
  });
  await expect(page.getByTestId('pending-intents')).toContainText('release');
  await page.getByRole('button', { name: 'Step +1 ms', exact: true }).click(); await expect(pressed).toContainText('false');
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click(); expect(errors.errors).toEqual([]);
});

for (const [kind, code, quality] of [['short', 'SOURCE_SHORT', 'faulted'], ['series', 'UNSUPPORTED_TOPOLOGY', 'unsupported'], ['feedback', 'NONCONVERGENT', 'faulted']] as const) {
  test(`actual worker reports ${kind} as ${quality}, not off success, with repair selection`, async ({ page }) => {
    const errors = observeBrowser(page); await open(page); const source = await place(page, 'DC source', 100, 100);
    if (kind === 'short') await connect(page, `${source.id}/plus`, `${source.id}/minus`);
    if (kind === 'series') {
      const a = await place(page, 'Lamp', 300, 100), b = await place(page, 'Lamp', 500, 100);
      await connect(page, `${source.id}/plus`, `${a.id}/p1`); await connect(page, `${a.id}/p2`, `${b.id}/p1`); await connect(page, `${b.id}/p2`, `${source.id}/minus`);
    }
    if (kind === 'feedback') {
      const coil = await place(page, 'Relay coil', 500, 100), nc = await place(page, 'Relay NC contact', 300, 100); await bind(page, coil.deviceId!);
      await connect(page, `${source.id}/plus`, `${nc.id}/p1`); await connect(page, `${nc.id}/p2`, `${coil.id}/a1`); await connect(page, `${coil.id}/a2`, `${source.id}/minus`);
    }
    const before = await graph(page); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Faulted' })).toBeVisible();
    await expect(page.locator('.simulation [role="alert"]')).toContainText(code); await expect(page.locator('.simulation')).toContainText(quality);
    await page.locator('.simulation [role="alert"] button').click(); await expect(page.locator('.authoring')).toContainText('Selected');
    await page.getByRole('button', { name: 'Stop simulation', exact: true }).click(); expect(await graph(page)).toEqual(before); expect(errors.errors).toEqual([]);
  });
}

test('actual worker Pause and Stop remain usable behind an unresolved native Save picker promise', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: () => new Promise(() => {}) }); });
  await open(page); page.once('dialog', d => d.accept('Discard')); await moreFiles(page); await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible(); const before = await graph(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.locator('[data-observable="device_relay/energized"]')).toContainText('false');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('group', { name: 'Design files' })).toContainText('Busy');
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Paused' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Editing' })).toBeVisible();
  expect(await graph(page)).toEqual(before);
  await expect(page.locator('.file-feedback > summary')).toHaveText('File action in progress');
  await expect(page.getByTestId('file-status')).not.toContainText('Last successful native save:');
});
