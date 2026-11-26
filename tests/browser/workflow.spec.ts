import { runtimeMenu } from './helpers/authoring';
import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project, Scenario } from '../../src/core/domain/types';
import { blankSelfhold, graph, observeBrowser } from './helpers/authoring';
const execute = promisify(execFile);
async function cli(args: string[]) {
  const { stdout, stderr } = await execute(process.execPath, [resolve('dist/cli/index.js'), ...args], { timeout: 30000, killSignal: 'SIGKILL' });
  expect(stdout.trim().split('\n')).toHaveLength(1);
  const response = JSON.parse(stdout);
  expect(response.ok, stdout + stderr).toBe(true);
  return response;
}
async function replace(page: Page, bytes: Buffer, symbols: number) {
  // Registration precedes action; await dialog acceptance and completed file transaction.
  const handled = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('prompt'); expect(dialog.message()).toContain('Unsaved or unconfirmed work');
    await dialog.accept('Discard');
  });
  await Promise.all([handled, page.getByLabel('Open circuit file', { exact: true }).setInputFiles({ name: 'roundtrip.circuit.json', mimeType: 'application/json', buffer: bytes })]);
  await expect(page.getByTestId('file-status')).toContainText('Design opened');
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: `Objects (${symbols} symbols)` })).toBeVisible();
}

test('public blank → worker lifecycle → real download/reopen → built CLI verify → CLI-created design opens in GUI', async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), 'circuit-workflow-'));
  const observed = observeBrowser(page);
  // Only native capability detection is mocked: the Blob/download and file input are real.
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  try {
    const { start, stop, coil, lamp } = await blankSelfhold(page);
    const design = await graph(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Simulation — Running' })).toBeVisible();
    const lit = page.locator(`[data-observable="${lamp.id}/lit"]`);
    const startButton = page.locator(`[data-actuator="${start.id}"]`), stopButton = page.locator(`[data-actuator="${stop.id}"]`);
    await expect(lit).toContainText('false');
    await startButton.focus(); await page.keyboard.down(' '); await expect(lit).toContainText('true'); await page.keyboard.up(' ');
    await expect(page.locator(`[data-observable="${start.deviceId}/pressed"]`)).toContainText('false'); await expect(lit).toContainText('true');
    await stopButton.focus(); await page.keyboard.down('Enter'); await expect(lit).toContainText('false'); await page.keyboard.up('Enter');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Simulation — Paused' })).toBeVisible();
    const time = Number((await page.getByTestId('runtime-clock').textContent())!.match(/\d+/)![0]);
    await startButton.focus(); await page.keyboard.press(' ');
    await expect(page.getByTestId('pending-intents')).toContainText('(2)');
    await page.getByRole('button', { name: 'Step +1 ms', exact: true }).click();
    await expect(page.getByTestId('runtime-clock')).toHaveText(`Virtual time: ${time + 1} ms`); await expect(lit).toContainText('true');
    await page.getByRole('button', { name: 'Stop simulation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Simulation — Editing' })).toBeVisible();
    await expect(page.getByTestId('runtime-trace')).not.toHaveText('[]');
    await runtimeMenu(page); await page.getByRole('button', { name: 'Reset runtime', exact: true }).click(); await expect(page.getByTestId('runtime-trace')).toHaveCount(0);
    expect(await graph(page)).toEqual(design);
    const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download copy', exact: true }).click();
    const download = await downloading; expect(await download.failure()).toBeNull();
    const bytes = await readFile((await download.path())!);
    const saved: Project = JSON.parse(bytes.toString('utf8')); expect(saved).toEqual(design);
    await expect(page.getByTestId('file-status')).toContainText('NOT confirmed saved');
    await replace(page, bytes, 6); expect(await graph(page)).toEqual(saved);
    await writeFile(join(dir, 'gui.json'), bytes);
    const instances = saved.sheets[0]!.instances;
    const savedStart = instances.find(i => i.id === start.id)!, savedStop = instances.find(i => i.id === stop.id)!;
    const savedCoil = instances.find(i => i.id === coil.id)!, savedLamp = instances.find(i => i.id === lamp.id)!;
    expect([savedStart, savedStop, savedCoil, savedLamp].every(Boolean)).toBe(true);
    const scenario: Scenario = {
      format: 'circuit-scenario', formatVersion: 1,
      target: { projectId: saved.projectId, revision: saved.revision, modelSet: saved.modelSet }, untilMs: 50,
      limits: { maxEvents: 1000, maxDeltaCycles: 128, maxTraceEntries: 1000 },
      inputs: [savedStart, savedStart, savedStop, savedStop].map((instance, n) => ({ atMs: (n + 1) * 10, sequence: n + 1, actions: [{ instanceId: instance.id, action: n % 2 ? 'release' : 'press', payload: {} }] })),
      probes: [], expect: { outcome: { stage: 'run', status: 'completed' }, observations: [0, 10, 20, 30, 40].flatMap(atMs => [
        { atMs, target: { kind: 'device' as const, id: savedCoil.deviceId! }, observable: 'energized', expected: { quality: 'known' as const, value: atMs === 10 || atMs === 20 } },
        { atMs, target: { kind: 'instance' as const, id: savedLamp.id }, observable: 'lit', expected: { quality: 'known' as const, value: atMs === 10 || atMs === 20 } }
      ]) }
    };
    // Identities and revision come from the complete GUI-saved DTO, not canned IDs.
    expect(saved.sheets[0]!.instances.map(i => i.id)).toEqual(expect.arrayContaining([start.id, stop.id, coil.id, lamp.id]));
    await writeFile(join(dir, 'scenario.json'), JSON.stringify(scenario));
    expect((await cli(['inspect', join(dir, 'gui.json')])).result.project).toEqual(saved);
    const verified = await cli(['verify', join(dir, 'gui.json'), '--scenario', join(dir, 'scenario.json')]);
    expect(verified.result.verificationOutcome).toBe('passed');
    expect(await cli(['verify', join(dir, 'gui.json'), '--scenario', join(dir, 'scenario.json')])).toEqual(verified);
    await cli(['new', '--output', join(dir, 'blank.json'), '--project-id', 'project_selfhold', '--sheet-id', 'sheet_control', '--title', 'Relay self-hold']);
    await cli(['edit', 'apply', join(dir, 'blank.json'), '--operations', resolve('examples/p0/build-selfhold.operations.json'), '--output', join(dir, 'cli.json')]);
    await cli(['verify', join(dir, 'cli.json'), '--scenario', resolve('examples/p0/start-stop.scenario.json')]);
    const cliBytes = await readFile(join(dir, 'cli.json'));
    await replace(page, cliBytes, 7);
    const cliDesign: Project = JSON.parse(cliBytes.toString('utf8')); expect(await graph(page)).toEqual(cliDesign);
    expect(observed.errors).toEqual([]); expect(observed.external).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
