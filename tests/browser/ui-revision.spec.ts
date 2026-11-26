import { advanced, moreFiles, reveal, runtimeMenu } from './helpers/authoring';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, graph, place, bind, blankSelfhold } from './helpers/authoring';

async function example(page: Page) {
  await open(page); page.once('dialog', d => d.accept('Discard'));
  await moreFiles(page); await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();
}
const symbol = (page: Page, id: string) => page.locator(`[data-instance="${id}"]`);
const closure = (s: Locator) => s.locator('[data-closed]');
const observed = (page: Page, id: string, name: string) => page.locator(`[data-observable="${id}/${name}"]`);
async function hold(page: Page, s: Locator) { const box = (await s.locator('rect').first().boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); }

test('real drawn Start/NC Stop geometry, relay pair, coil/lamp, capture, keyboard, pause and design-only export', async ({ page }) => {
  await example(page);
  const nc = await place(page, 'Relay NC contact', 550, 430); await bind(page, 'device_relay');
  await page.getByRole('button', { name: 'Select / Cancel (Escape)', exact: true }).click();
  const baseline = await graph(page), undo = await page.getByRole('button', { name: /^Undo / }).textContent();
  const dirty = await page.getByTestId('design-status').textContent();
  const start = symbol(page, 'instance_start'), stop = symbol(page, 'instance_stop'), relay = symbol(page, 'instance_hold');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(closure(start)).toHaveAttribute('data-closed', 'false'); await expect(closure(stop)).toHaveAttribute('data-closed', 'true');
  await expect(closure(symbol(page, nc.id))).toHaveAttribute('data-closed', 'true');
  await hold(page, start); await expect(observed(page, 'device_start', 'pressed')).toContainText('true');
  await expect(closure(start)).toHaveAttribute('data-closed', 'true'); await expect(start.locator('[data-blade]')).toHaveAttribute('transform', 'rotate(0 -9 0)');
  await expect(start.locator('[data-actuator-head]')).toHaveAttribute('transform', 'translate(0 6)');
  await expect(closure(relay)).toHaveAttribute('data-closed', 'true'); await expect(closure(symbol(page, nc.id))).toHaveAttribute('data-closed', 'false');
  await expect(symbol(page, 'instance_coil').locator('[data-powered]')).toBeVisible(); await expect(symbol(page, 'instance_lamp').locator('[data-lit-rays]')).toBeVisible();
  await page.mouse.move(5, 5); await page.mouse.up(); await expect(observed(page, 'device_start', 'pressed')).toContainText('false');
  await expect(closure(start)).toHaveAttribute('data-closed', 'false'); await expect(observed(page, 'device_relay', 'energized')).toContainText('true');
  await stop.focus(); await page.keyboard.down('Enter'); await expect(observed(page, 'device_stop', 'pressed')).toContainText('true');
  await expect(closure(stop)).toHaveAttribute('data-closed', 'false'); await expect(stop.locator('[data-blade]')).toHaveAttribute('transform', 'rotate(-38 -9 0)');
  await expect(observed(page, 'instance_lamp', 'lit')).toContainText('false'); await expect(symbol(page, 'instance_lamp').locator('[data-lit-rays]')).toHaveCount(0);
  await page.keyboard.up('Enter'); await expect(closure(stop)).toHaveAttribute('data-closed', 'true');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await start.focus(); await page.keyboard.down(' '); await expect(page.getByTestId('pending-intents')).toContainText('press');
  await expect(closure(start)).toHaveAttribute('data-closed', 'false'); await expect(start.locator('[data-pending]')).toBeVisible();
  await page.getByRole('button', { name: 'Step +1 ms', exact: true }).click(); // focus loss queues release, still real engine Step
  await expect(observed(page, 'device_relay', 'energized')).toContainText('true'); await page.keyboard.up(' ');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const download = page.waitForEvent('download'); await moreFiles(page); await page.getByRole('button', { name: 'Export design SVG', exact: true }).click();
  const svg = await readFile((await (await download).path())!, 'utf8'); expect(svg).not.toMatch(/runtime-glyph|data-powered|data-lit-rays|data-quality-badge|Pending input/);
  expect(await graph(page)).toEqual(baseline); await expect(page.getByTestId('design-status')).toHaveText(dirty!);
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click();
  expect(await page.getByRole('button', { name: /^Undo / }).textContent()).toEqual(undo); expect(await graph(page)).toEqual(baseline);
  await expect(closure(stop)).toHaveAttribute('data-closed', 'true');
});

test('drawn cancellation/lost capture/focus, passive ports, panel parity and Stop/Reset generation', async ({ page }) => {
  await example(page); const baseline = await graph(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const start = symbol(page, 'instance_start'), pressed = observed(page, 'device_start', 'pressed');
  await expect(pressed).toContainText('false');
  await start.click({ button: 'right' }); await expect(pressed).toContainText('false');
  await page.locator('[data-port="instance_start/p1"]').click(); await expect(pressed).toContainText('false');
  await symbol(page, 'instance_coil').click(); await expect(observed(page, 'device_relay', 'energized')).toContainText('false');
  await hold(page, start); await expect(pressed).toContainText('true'); await start.dispatchEvent('pointercancel', { pointerId: 1 }); await expect(pressed).toContainText('false'); await page.mouse.up();
  await hold(page, start); await expect(pressed).toContainText('true'); await start.evaluate(el => el.releasePointerCapture(1)); await page.mouse.move(5, 5); await expect(pressed).toContainText('false'); await page.mouse.up();
  await start.focus(); await page.keyboard.down(' '); await expect(pressed).toContainText('true'); await page.keyboard.press('Escape'); await expect(pressed).toContainText('false'); await page.keyboard.up(' ');
  await start.focus(); await page.keyboard.down(' '); await expect(pressed).toContainText('true'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect(pressed).toContainText('false'); await expect(page.getByRole('heading', { name: 'Simulation — Paused' })).toBeVisible(); await page.keyboard.up(' ');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const panel = page.locator('[data-actuator="instance_start"]'); await panel.focus(); await page.keyboard.down('Enter'); await expect(closure(start)).toHaveAttribute('data-closed', 'true'); await page.keyboard.up('Enter'); await expect(closure(start)).toHaveAttribute('data-closed', 'false');
  await hold(page, start); await expect(pressed).toContainText('true');
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).focus(); await page.keyboard.press('Enter'); await page.mouse.up();
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(pressed).toContainText('false'); await expect(observed(page, 'device_relay', 'energized')).toContainText('false');
  await start.focus(); await page.keyboard.down(' '); await expect(pressed).toContainText('true'); await runtimeMenu(page); await page.getByRole('button', { name: 'Reset runtime', exact: true }).click(); await page.keyboard.up(' ');
  expect(await graph(page)).toEqual(baseline); await expect(page.getByTestId('runtime-clock')).toHaveText('Virtual time: 0 ms');
});

test('missing return is known unlit geometry, and fault glyph is explicit', async ({ page }) => {
  const { lamp, start, source } = await blankSelfhold(page, true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await symbol(page, start.id).focus(); await page.keyboard.down(' '); await expect(observed(page, lamp.id, 'lit')).toContainText('false'); await page.keyboard.up(' ');
  await expect(symbol(page, lamp.id).locator('[data-on]')).toHaveAttribute('data-on', 'false'); await expect(symbol(page, lamp.id).locator('[data-lit-rays]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop simulation', exact: true }).click();
  await reveal(page, 'Explicit wiring'); await page.getByRole('combobox', { name: 'Wire from', exact: true }).selectOption(`${source.id}/plus`); await page.getByRole('combobox', { name: 'Wire to', exact: true }).selectOption(`${source.id}/minus`); await page.getByRole('button', { name: 'Connect endpoints', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Simulation — Faulted' })).toBeVisible();
  await expect(symbol(page, lamp.id).locator('[data-quality-badge]')).toHaveAttribute('data-quality-badge', 'faulted'); await expect(symbol(page, lamp.id).locator('title')).toContainText('SOURCE_SHORT');
});

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) test(`canvas-first viewport ${size.width}x${size.height}, reduced motion and screenshots`, async ({ page }) => {
  await page.setViewportSize(size); await page.emulateMedia({ reducedMotion: 'reduce' }); await example(page);
  const canvas = page.getByRole('img', { name: 'Circuit drawing canvas' });
  for (const running of [false, true]) {
    if (running) { await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(observed(page, 'device_relay', 'energized')).toContainText('false'); }
    const box = (await canvas.boundingBox())!; expect(box.y).toBeLessThan(300); expect(box.height).toBeGreaterThan(260); expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await expect(page.getByRole('button', { name: running ? 'Stop simulation' : 'Run', exact: true })).toBeInViewport();
    if (running) { const start = symbol(page, 'instance_start'); await start.focus(); await page.keyboard.down(' '); await expect(closure(start)).toHaveAttribute('data-closed', 'true'); expect(await start.locator('[data-blade]').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s'); await page.keyboard.up(' '); }
    const dir = join(tmpdir(), 'cadesimu-ui02', 'regression'); await mkdir(dir, { recursive: true }); await page.screenshot({ path: join(dir, `${size.width}-${running ? 'run' : 'edit'}.png`) });
  }
});

test('placement repeats until Escape and wire remains persistent after explicit endpoints', async ({ page }) => {
  await open(page); const canvas = page.getByRole('img', { name: 'Circuit drawing canvas' });
  await page.getByRole('button', { name: 'NO pushbutton', exact: true }).click(); await canvas.focus(); await page.keyboard.press('Enter'); for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.length).toBe(2); await page.keyboard.press('Escape');
  await advanced(page); await expect(page.getByRole('button', { name: 'Place at coordinates', exact: true })).toBeDisabled();
  const p = await graph(page), [a, b] = p.sheets[0]!.instances;
  await page.locator(`[data-port="${a!.id}/p1"]`).click(); await page.locator(`[data-port="${b!.id}/p2"]`).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.wires.length).toBe(1); await expect(page.locator('.drawing')).toContainText('Tool: wire');
});
