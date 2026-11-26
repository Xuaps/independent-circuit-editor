import { runtimeMenu } from './helpers/authoring';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { blankSelfhold, graph, observeBrowser } from './helpers/authoring';

test('blank-authored selfhold runs in actual worker; locks edits, pending Step, Resume, design-only save, Stop/history/Reset', async ({ page }) => {
  const errors = observeBrowser(page); const workers: string[] = []; page.on('worker', w => workers.push(w.url()));
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  const { start, stop, coil, lamp } = await blankSelfhold(page);
  const design = await graph(page), undo = await page.getByRole('button', { name: /^Undo / }).textContent();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
  const energized = page.locator(`[data-observable="${coil.deviceId}/energized"]`), lit = page.locator(`[data-observable="${lamp.id}/lit"]`);
  await expect(energized).toContainText('false'); await expect(lit).toContainText('false'); expect(workers).toHaveLength(1); expect(workers[0]).toContain('worker');
  await expect(page.getByRole('button', { name: 'Lamp', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: /^Undo / })).toBeDisabled(); await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
  const startButton = page.locator(`[data-actuator="${start.id}"]`), stopButton = page.locator(`[data-actuator="${stop.id}"]`);
  await startButton.focus(); await page.keyboard.down(' '); await expect(energized).toContainText('true'); await page.keyboard.up(' '); await expect(lit).toContainText('true');
  await expect(page.locator(`[data-observable="${start.deviceId}/pressed"]`)).toContainText('false');
  await stopButton.focus(); await page.keyboard.down('Enter'); await expect(lit).toContainText('false'); await page.keyboard.up('Enter'); await expect(energized).toContainText('false');
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Paused' })).toBeVisible();
  const time = Number((await page.getByTestId('runtime-clock').textContent())!.match(/\d+/)![0]);
  await startButton.focus(); await page.keyboard.down(' '); await page.keyboard.up(' ');
  await expect(page.getByTestId('pending-intents')).toContainText('Pending intent (2)'); await expect(energized).toContainText('false');
  await page.getByRole('button', { name: 'Step +1 ms', exact: true }).click(); await expect(page.getByTestId('runtime-clock')).toHaveText(`Virtual time: ${time + 1} ms`); await expect(energized).toContainText('true'); await expect(page.getByTestId('pending-intents')).toContainText('(0)');
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download copy', exact: true }).click(); const download = await event;
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(design); expect(await graph(page)).toEqual(design);
  await expect(page.locator('header')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Editing' })).toBeVisible();
  expect(await graph(page)).toEqual(design); await expect(page.getByRole('button', { name: /^Undo / })).toHaveText(undo!); await expect(page.getByTestId('runtime-trace')).not.toHaveText('[]'); await expect(energized).toContainText('unknown (STOPPED)');
  await runtimeMenu(page); await page.getByRole('button', { name: 'Reset runtime', exact: true }).click(); await expect(page.getByTestId('runtime-trace')).toHaveCount(0); await expect(page.getByTestId('runtime-clock')).toHaveText('Virtual time: 0 ms'); expect(await graph(page)).toEqual(design);
  expect(errors.errors).toEqual([]); expect(errors.external).toEqual([]);
});

test('missing lamp return keeps coil energized while lamp off and displays positive/floating potential', async ({ page }) => {
  const { lamp, coil, start } = await blankSelfhold(page, true);
  await page.getByRole('button', { name: 'Run', exact: true }).click(); const button = page.locator(`[data-actuator="${start.id}"]`); await button.focus(); await page.keyboard.press(' ');
  await expect(page.locator(`[data-observable="${coil.deviceId}/energized"]`)).toContainText('true'); await expect(page.locator(`[data-observable="${lamp.id}/lit"]`)).toContainText('false');
  await expect(page.locator(`[data-port="${lamp.id}/p1"]`).locator('..')).toHaveAttribute('data-potential', 'positive'); await expect(page.locator(`[data-port="${lamp.id}/p2"]`).locator('..')).toHaveAttribute('data-potential', 'floating');
});
