import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { bind, blankSelfhold, graph, moreFiles, observeBrowser, open, place, runtimeMenu } from './helpers/authoring';

const missingDcSourceGuidance = 'No DC source is placed. Use Stop simulation to unlock editing, then choose DC source in Build and place one.';

test('blank Run reports SOURCE_COUNT and guides Stop, source placement and successful retry', async ({ page }) => {
  const errors = observeBrowser(page);
  await open(page);
  const blank = await graph(page);
  expect(blank.sheets[0]!.instances).toEqual([]);

  const run = page.getByRole('button', { name: 'Run', exact: true });
  const stop = page.getByRole('button', { name: 'Stop simulation', exact: true });
  const dcSource = page.getByRole('button', { name: 'DC source', exact: true });
  const simulation = page.getByRole('region', { name: 'Simulation', exact: true });
  const readiness = simulation.getByRole('region', { name: 'Design readiness', exact: true });
  const worker = page.waitForEvent('worker');
  await run.click();
  expect((await worker).url()).toContain('worker');
  await expect(simulation.getByRole('heading', { name: 'Simulation — Faulted' })).toBeVisible();
  await expect(simulation.getByRole('alert')).toHaveText('SOURCE_COUNT');
  await expect(dcSource).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Junction tool', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
  expect(await graph(page)).toEqual(blank);
  await expect(readiness.getByText(missingDcSourceGuidance, { exact: true })).toBeVisible();
  await expect(readiness.getByRole('button')).toHaveCount(0);

  await stop.click();
  await expect(dcSource).toBeEnabled();
  await expect(readiness).toHaveCount(0);
  expect(await graph(page)).toEqual(blank);
  const source = await place(page, 'DC source', 100, 100);
  const repaired = await graph(page);
  expect(repaired.sheets[0]!.instances).toEqual([expect.objectContaining({
    id: source.id, definition: { id: 'core.dc.supply', version: 1 }, deviceId: expect.any(String),
  })]);

  await run.click();
  await expect(simulation.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
  await simulation.getByText('Live values and electrical details', { exact: true }).click();
  await expect(simulation.locator(`[data-observable="${source.deviceId}/enabled"]`)).toContainText('enabled: true');
  await expect(readiness).toHaveCount(0);
  await expect(simulation.getByRole('alert')).toHaveCount(0);
  expect(await graph(page)).toEqual(repaired);
  await stop.click();
  await expect(run).toBeVisible();
  expect(errors.errors).toEqual([]);
  expect(errors.external).toEqual([]);
});

for (const sourceCase of ['two bound sources', 'one unbound source'] as const) {
  test(`Run reports SOURCE_COUNT without missing-source guidance for ${sourceCase}`, async ({ page }) => {
    await open(page);
    const first = await place(page, 'DC source', 100, 100);
    expect(first.deviceId).toEqual(expect.any(String));
    const expectedBindings = [{ id: first.id, deviceId: first.deviceId }];
    if (sourceCase === 'two bound sources') {
      const second = await place(page, 'DC source', 300, 100);
      expect(second.deviceId).toEqual(expect.any(String));
      expect(second.deviceId).not.toBe(first.deviceId);
      expectedBindings.push({ id: second.id, deviceId: second.deviceId });
    } else {
      await bind(page, '');
      expectedBindings[0]!.deviceId = null;
    }
    const design = await graph(page);
    const instances = design.sheets[0]!.instances;
    expect(instances).toHaveLength(expectedBindings.length);
    expect(instances).toEqual(expect.arrayContaining(expectedBindings.map(binding => expect.objectContaining({
      ...binding, definition: { id: 'core.dc.supply', version: 1 },
    }))));

    const simulation = page.getByRole('region', { name: 'Simulation', exact: true });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(simulation.getByRole('heading', { name: 'Simulation — Faulted' })).toBeVisible();
    await expect(simulation.getByRole('alert')).toHaveText(sourceCase === 'two bound sources' ? 'SOURCE_COUNT' : 'SOURCE_COUNT, UNBOUND_INSTANCE');
    await expect(simulation.getByRole('region', { name: 'Design readiness', exact: true })).toHaveCount(0);
    expect(await graph(page)).toEqual(design);
  });
}

test('startup fault guides selection and repair of an unassigned relay contact', async ({ page }) => {
  const errors = observeBrowser(page);
  await open(page);
  page.once('dialog', d => d.accept('Discard'));
  await moreFiles(page);
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Objects (7 symbols)' })).toBeVisible();

  const contact = page.locator('[data-instance="instance_hold"]');
  const otherContact = page.locator('[data-instance="instance_pilot"]');
  const boundDevice = page.getByRole('combobox', { name: 'Bound device', exact: true });
  const applyBinding = page.getByRole('button', { name: 'Apply binding', exact: true });
  await contact.locator('> rect').first().click();
  await expect(boundDevice).toHaveValue('device_relay');
  await bind(page, '');
  const unassignedDesign = await graph(page);
  expect(unassignedDesign.sheets[0]!.instances.find(i => i.id === 'instance_hold')?.deviceId).toBeNull();
  await otherContact.locator('> rect').first().click();
  await expect(otherContact).toHaveClass('selected');
  await expect(contact).not.toHaveClass('selected');

  const run = page.getByRole('button', { name: 'Run', exact: true });
  const stop = page.getByRole('button', { name: 'Stop simulation', exact: true });
  const simulation = page.getByRole('region', { name: 'Simulation', exact: true });
  const readiness = simulation.getByRole('region', { name: 'Design readiness', exact: true });
  const worker = page.waitForEvent('worker');
  await run.click();
  expect((await worker).url()).toContain('worker');
  await expect(simulation.getByRole('heading', { name: 'Simulation — Faulted' })).toBeVisible();
  await expect(simulation.getByRole('alert')).toHaveText('UNBOUND_INSTANCE');
  await expect(readiness).toBeVisible();
  await expect(readiness.getByText('This contact is not bound to a relay device.')).toBeVisible();
  await expect(readiness).toContainText(/Stop simulation.*Bound device.*Apply binding/);
  await expect(readiness.getByRole('button')).toHaveCount(1);
  await readiness.getByRole('button', { name: /^Select Relay NO contact · Self-hold/ }).click();
  await expect(contact).toHaveClass('selected');
  await expect(otherContact).not.toHaveClass('selected');
  await expect(boundDevice).toBeDisabled();
  await expect(applyBinding).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Undo / })).toBeDisabled();
  expect(await graph(page)).toEqual(unassignedDesign);

  await stop.click();
  await expect(run).toBeVisible();
  await expect(readiness).toHaveCount(0);
  await expect(contact).toHaveClass('selected');
  await expect(boundDevice).toBeEnabled();
  await expect(boundDevice).toHaveValue('');
  await bind(page, 'device_relay');
  expect((await graph(page)).sheets[0]!.instances.find(i => i.id === 'instance_hold')?.deviceId).toBe('device_relay');

  await run.click();
  await expect(simulation.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
  const energized = page.locator('[data-observable="device_relay/energized"]');
  await expect(energized).toContainText('false');
  await page.locator('[data-actuator="instance_start"]').press('Space');
  await expect(energized).toContainText('true');
  await expect(readiness).toHaveCount(0);
  await expect(simulation.getByRole('alert')).toHaveCount(0);
  await stop.click();
  await expect(run).toBeVisible();
  await expect(energized).toContainText('unknown (STOPPED)');
  expect(errors.errors).toEqual([]);
  expect(errors.external).toEqual([]);
});

test('blank-authored selfhold runs in actual worker; locks edits, pending Step, Resume, design-only save, Stop/history/Reset', async ({ page }) => {
  const errors = observeBrowser(page); const workers: string[] = []; page.on('worker', w => workers.push(w.url()));
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  const { start, stop, coil, lamp } = await blankSelfhold(page);
  const footer = page.locator('footer.history-bar');
  const scopeCue = footer.getByText('Educational simulation · ideal 24 V DC · Not for real electrical installations.', { exact: true });
  await expect(page.getByText('Your circuit starts here', { exact: true })).toHaveCount(0);
  await expect(footer.getByText('DESIGN · applied changes only · Potential is not current', { exact: true })).toBeVisible();
  await expect(scopeCue).toBeVisible();
  const design = await graph(page), undo = await page.getByRole('button', { name: /^Undo / }).textContent();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
  await expect(footer.getByText('LIVE · acknowledged worker state · Potential is not current', { exact: true })).toBeVisible();
  await expect(scopeCue).toBeVisible();
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
