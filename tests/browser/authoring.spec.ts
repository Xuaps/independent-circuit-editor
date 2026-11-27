import { advanced, reveal } from './helpers/authoring';
import { graph, open, place, connect, node, bind, observeBrowser } from './helpers/authoring';
import { test, expect, type Page } from '@playwright/test';
import type { Project } from '../../src/core/domain/types';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Playwright's Node ESM loader does not support the source JSON imports. Bundle
// the real shared oracle for this test host only, never inject state into the app.
let oracle: typeof import('../../src/core/domain/project') & typeof import('../../src/core/compiler') & typeof import('../../src/core/scenario') & typeof import('../../src/core/domain/geometry');
let oracleDirectory: string;
test.beforeAll(async () => {
  oracleDirectory = await mkdtemp(join(tmpdir(), 'circuit-authoring-oracle-'));
  const outfile = join(oracleDirectory, 'oracle.mjs');
  await build({ stdin: { contents: "export {validateProject, runReadiness} from './src/core/domain/project'; export {compileProject} from './src/core/compiler'; export {runScenario} from './src/core/scenario'; export {portPosition} from './src/core/domain/geometry';", resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm' });
  oracle = await import(pathToFileURL(outfile).href);
});
test.afterAll(async () => { if (oracleDirectory) await rm(oracleDirectory, { recursive: true, force: true }); });

test('blank canvas guide disappears for a junction-only sheet and returns on Undo', async ({ page }) => {
  await open(page);
  const guide = page.getByText('Your circuit starts here', { exact: true });
  const emptySheet = (await graph(page)).sheets[0]!;
  expect(emptySheet).toMatchObject({ instances: [], annotations: [], wires: [], junctions: [] });
  await expect(guide).toBeVisible();

  const id = await node(page, 200, 200);
  expect((await graph(page)).sheets[0]).toEqual({ ...emptySheet, junctions: [{ id, position: { x: 200, y: 200 } }] });
  await expect(guide).toHaveCount(0);

  await page.getByRole('button', { name: /^Undo \(/ }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]).toEqual(emptySheet);
  await expect(guide).toBeVisible();
});

test('visible blank authoring makes a complete selfhold/lamp graph with deliberate binding and junctions', async ({ page }) => {
  const browser = observeBrowser(page); await open(page);
  expect((await graph(page)).sheets[0]!.instances).toHaveLength(0);
  const supply = await place(page, 'DC source', 100, 100), stop = await place(page, 'NC pushbutton (Stop)', 300, 100), start = await place(page, 'NO pushbutton', 500, 100), coil = await place(page, 'Relay coil', 700, 100);
  const hold = await place(page, 'Relay NO contact', 500, 300); expect(hold.deviceId).toBeNull(); await bind(page, coil.deviceId!);
  const pilot = await place(page, 'Relay NO contact', 300, 500); await bind(page, coil.deviceId!);
  const lamp = await place(page, 'Lamp', 700, 500);
  const positive = await node(page, 200, 200), beforeStart = await node(page, 400, 200), afterStart = await node(page, 600, 200), ret = await node(page, 800, 400);
  const p = (id: string, port: string) => `${id}/${port}`;
  const pairs = [[p(supply.id, 'plus'), positive], [p(supply.id, 'minus'), ret], [positive, p(stop.id, 'p1')], [p(stop.id, 'p2'), beforeStart], [beforeStart, p(start.id, 'p1')], [p(start.id, 'p2'), afterStart], [beforeStart, p(hold.id, 'p1')], [p(hold.id, 'p2'), afterStart], [afterStart, p(coil.id, 'a1')], [p(coil.id, 'a2'), ret], [positive, p(pilot.id, 'p1')], [p(pilot.id, 'p2'), p(lamp.id, 'p1')], [p(lamp.id, 'p2'), ret]];
  for (const [from, to] of pairs) await connect(page, from!, to!);
  const authored = await graph(page); expect(oracle.validateProject(authored).ok).toBe(true); expect(oracle.runReadiness(authored)).toEqual([]); expect(oracle.compileProject(authored).ok).toBe(true);
  expect(authored.sheets[0]!.wires).toHaveLength(13); expect(authored.sheets[0]!.junctions).toHaveLength(4);
  // Shared headless service validates the UI-authored graph; this is NOT a GUI runtime claim.
  const scenario = { format: 'circuit-scenario', formatVersion: 1, target: { projectId: authored.projectId, revision: authored.revision, modelSet: authored.modelSet }, untilMs: 40, limits: { maxEvents: 100, maxDeltaCycles: 128, maxTraceEntries: 100 }, inputs: [
    { atMs: 10, sequence: 1, actions: [{ instanceId: start.id, action: 'press', payload: {} }] },
    { atMs: 20, sequence: 2, actions: [{ instanceId: start.id, action: 'release', payload: {} }] },
    { atMs: 30, sequence: 3, actions: [{ instanceId: stop.id, action: 'press', payload: {} }] },
    { atMs: 40, sequence: 4, actions: [{ instanceId: stop.id, action: 'release', payload: {} }] }
  ], probes: [] };
  const service = oracle.runScenario(authored, scenario, 'browser_authored'); expect(service.ok).toBe(true);
  if (service.ok) {
    expect(service.value.runOutcome).toBe('completed');
    expect(service.value.trace.entries.map(f => f.atMs)).toEqual([0, 10, 20, 30, 40]);
    for (const [index, active] of [false, true, true, false, false].entries()) {
      const frame = service.value.trace.entries[index]!;
      expect(frame.observations.find(o => o.target.id === coil.deviceId && o.target.kind === 'device' && o.observable === 'energized')!.value).toEqual({ quality: 'known', value: active });
      expect(frame.observations.find(o => o.target.id === lamp.id && o.target.kind === 'instance' && o.observable === 'lit')!.value).toEqual({ quality: 'known', value: active });
    }
  }
  await reveal(page, 'Shared devices'); await page.getByRole('button', { name: 'Linked symbols for K1', exact: true }).click();
  await reveal(page, 'Device settings and linked symbols'); await page.getByLabel('Device name', { exact: true }).fill('Main_relay'); await page.getByRole('button', { name: 'Rename device', exact: true }).click();
  await reveal(page, 'Markings and terminal labels'); await page.getByRole('checkbox', { name: 'showDeviceName', exact: true }).uncheck(); await page.getByRole('button', { name: 'Apply presentation', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === coil.id)!.markings.showDeviceName).toBe(false);
  const renamed = await graph(page); expect(renamed.devices.find(d => d.id === coil.deviceId)!.name).toBe('Main_relay'); expect(renamed.sheets[0]!.instances.filter(i => i.deviceId === coil.deviceId)).toHaveLength(3); expect(renamed.sheets[0]!.wires).toEqual(authored.sheets[0]!.wires);
  expect(browser.errors).toEqual([]); expect(browser.external).toEqual([]);
});

test('real focus/key authoring, native property typing, rejected edits and escape preserve graph', async ({ page }) => {
  const browser = observeBrowser(page); await open(page);
  await page.getByRole('button', { name: 'Relay coil', exact: true }).focus(); await page.keyboard.press('Enter');
  const canvas = page.getByRole('img', { name: 'Circuit drawing canvas' }); await canvas.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('r'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).revision).toBe(1);
  const coil = (await graph(page)).sheets[0]!.instances[0]!; expect(coil.transform.position).toEqual({ x: 110, y: 110 }); expect(coil.transform.rotation).toBe(90);
  await page.getByRole('button', { name: 'Relay NO contact', exact: true }).focus(); await page.keyboard.press('Enter'); await canvas.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).revision).toBe(2);
  await page.getByRole('combobox', { name: 'Bound device', exact: true }).focus(); await page.keyboard.press('End'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).revision).toBe(3);
  const contact = (await graph(page)).sheets[0]!.instances.find(i => i.definition.id === 'core.relay.contact.no')!; expect(contact.deviceId).toBe(coil.deviceId);
  const label = page.getByLabel('Symbol label', { exact: true }); await label.fill('W R V Delete Z <img src="https://invalid.example/x">'); await label.focus(); await page.keyboard.press('Control+z');
  expect((await graph(page)).revision).toBe(3); // native input undo, not canvas history
  await label.fill('<script>alert(1)</script>'); await page.getByRole('button', { name: 'Apply presentation', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.label).toBe('<script>alert(1)</script>');
  const typed = await graph(page); expect(typed.sheets[0]!.instances.find(i => i.id === contact.id)!.label).toBe('<script>alert(1)</script>'); await expect(page.locator('svg script')).toHaveCount(0);
  await reveal(page, 'Explicit wiring'); await page.getByRole('combobox', { name: 'Wire from', exact: true }).focus(); await page.keyboard.press('Home'); await page.keyboard.press('Tab'); await page.keyboard.press('End'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).sheets[0]!.wires.length).toBe(1);
  const attached = (await graph(page)).sheets[0]!.wires[0]!;
  // select linked contact using visible object navigation, then real canvas shortcuts
  await page.getByRole('button', { name: 'K1 · Relay NO contact', exact: true }).click(); await canvas.focus(); await page.keyboard.press('r');
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.transform.rotation).toBe(90);
  await page.keyboard.press('Control+z'); await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.transform.rotation).toBe(0);
  await page.keyboard.press('Control+Shift+z'); await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.transform.rotation).toBe(90);
  await page.getByRole('button', { name: 'Mirror X', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.transform.mirrorX).toBe(true);
  await reveal(page, 'Exact symbol position'); await page.getByLabel('Symbol X', { exact: true }).fill('300'); await reveal(page, 'Exact symbol position'); await page.getByLabel('Symbol Y', { exact: true }).fill('200'); await page.getByRole('button', { name: 'Move to position', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.find(i => i.id === contact.id)!.transform.position).toEqual({ x: 300, y: 200 });
  const transformed = await graph(page); expect(oracle.validateProject(transformed).ok).toBe(true);
  expect(transformed.sheets[0]!.wires[0]!.from).toEqual(attached.from); expect(transformed.sheets[0]!.wires[0]!.to).toEqual(attached.to);
  const beforeCancel = await graph(page); await page.getByRole('button', { name: 'Lamp', exact: true }).click(); await canvas.focus(); await page.keyboard.press('Escape'); expect(await graph(page)).toEqual(beforeCancel);
  await page.getByRole('button', { name: 'Lamp', exact: true }).click(); await advanced(page); await page.getByLabel('Cursor X', { exact: true }).fill('1.2'); await advanced(page); await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('rejected'); expect(await graph(page)).toEqual(beforeCancel);
  expect(browser.errors).toEqual([]); expect(browser.external).toEqual([]);
});

test('pointer coordinates under zoom/pan, drag, terminal click, detach/delete and history', async ({ page }) => {
  const browser = observeBrowser(page); await open(page);
  const canvas = page.getByRole('img', { name: 'Circuit drawing canvas' });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await advanced(page); await page.getByRole('button', { name: 'Pan right', exact: true }).click();
  await page.getByRole('button', { name: 'DC source', exact: true }).click();
  // File lifecycle controls add vertical content; real pointer coordinates must be in the viewport.
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  // viewBox is 100,0,800,640; use center so aspect-ratio letterboxing cancels.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await graph(page)).revision).toBe(1);
  let supply = (await graph(page)).sheets[0]!.instances[0]!; expect(supply.transform.position).toEqual({ x: 500, y: 320 });
  await page.getByRole('button', { name: 'Select / Cancel (Escape)', exact: true }).click();
  const body = page.locator(`[data-instance="${supply.id}"] rect`).first(); const bodyBox = (await body.boundingBox())!;
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2); await page.mouse.down(); await page.mouse.move(bodyBox.x + bodyBox.width / 2 + 40, bodyBox.y + bodyBox.height / 2 + 20); await page.mouse.up();
  await expect.poll(async () => (await graph(page)).revision).toBe(2); supply = (await graph(page)).sheets[0]!.instances[0]!; expect(supply.transform.position.x).toBeGreaterThan(500);
  const lamp = await place(page, 'Lamp', 700, 500);
  await page.locator(`[data-port="${supply.id}/plus"]`).click(); await page.locator(`[data-port="${lamp.id}/p1"]`).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.wires.length).toBe(1);
  const connected = await graph(page), wire = connected.sheets[0]!.wires[0]!;
  await page.getByRole('button', { name: 'Detach from end', exact: true }).click(); expect((await graph(page)).sheets[0]!.wires[0]!.from.kind).toBe('dangling');
  await page.getByRole('button', { name: /^Undo \(/ }).click(); expect((await graph(page)).sheets[0]!.wires[0]).toEqual(wire);
  await page.getByRole('button', { name: 'H1 · Lamp', exact: true }).click();
  const beforeCancel = await graph(page); page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: 'Delete selection', exact: true }).click(); expect(await graph(page)).toEqual(beforeCancel);
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.length).toBe(1); expect((await graph(page)).sheets[0]!.wires[0]!.to.kind).toBe('dangling');
  await page.getByRole('button', { name: /^Undo \(/ }).click(); expect((await graph(page)).sheets[0]).toEqual(beforeCancel.sheets[0]);
  expect(browser.errors).toEqual([]); expect(browser.external).toEqual([]);
});

test('explicit split+branch/relocation, independent copy, duplicate-name rejection and text-only safety', async ({ page }) => {
  const browser = observeBrowser(page); await open(page);
  const a = await place(page, 'Relay coil', 100, 100), b = await place(page, 'Relay coil', 700, 100);
  await reveal(page, 'Device settings and linked symbols'); await page.getByLabel('Device name', { exact: true }).fill('K1'); const before = await graph(page); await page.getByRole('button', { name: 'Rename device', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('DUPLICATE'); expect(await graph(page)).toEqual(before);
  await connect(page, `${a.id}/a1`, `${b.id}/a1`);
  // Add an unrelated vertical wire crossing the first without a node at the crossing.
  const y = oracle.portPosition(a, 'a1')!.y;
  const upper = await node(page, 400, y - 100), lower = await node(page, 400, y + 100);
  await connect(page, upper, lower);
  const crossing = (await graph(page)).sheets[0]!.wires.find(w => w.from.kind === 'junction' && w.from.junctionId === upper)!;
  expect((await graph(page)).sheets[0]!.junctions).toHaveLength(2);
  await page.getByRole('button', { name: 'Wire 1', exact: true }).click();
  await page.getByLabel('Split X', { exact: true }).fill('400');
  await page.getByLabel('Split Y', { exact: true }).fill(String(y)); await page.getByRole('combobox', { name: 'Optional branch from terminal', exact: true }).selectOption(`${a.id}/a2`);
  const beforeSplit = await graph(page); await page.getByRole('button', { name: 'Split / join explicitly', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.junctions.length).toBe(3); expect((await graph(page)).revision).toBe(beforeSplit.revision + 1); expect((await graph(page)).sheets[0]!.wires).toHaveLength(4);
  expect((await graph(page)).sheets[0]!.wires.find(w => w.id === crossing.id)).toEqual(crossing);
  const old = (await graph(page)).sheets[0]!.junctions.find(j => j.position.x === 400 && j.position.y === y)!.id;
  await page.getByLabel('Junction Y', { exact: true }).fill('300'); await page.getByRole('button', { name: 'Replace junction at position', exact: true }).click();
  const moved = await graph(page); expect(moved.sheets[0]!.junctions.some(j => j.id === old)).toBe(false); expect(moved.sheets[0]!.wires.flatMap(w => [w.from, w.to]).filter(e => e.kind === 'junction' && e.junctionId === old)).toHaveLength(0);
  await page.getByRole('button', { name: /^Undo \(/ }).click(); expect((await graph(page)).sheets[0]!.junctions.some(j => j.id === old)).toBe(true);
  await page.getByRole('button', { name: 'K1 · Relay coil', exact: true }).click(); await page.getByRole('button', { name: 'Duplicate independent', exact: true }).click();
  await expect.poll(async () => (await graph(page)).devices.length).toBe(3);
  const copied = await graph(page); expect(copied.devices).toHaveLength(3); expect(copied.sheets[0]!.instances.find(i => i.id !== a.id && i.id !== b.id)!.deviceId).not.toBe(a.deviceId);
  const contact = await place(page, 'Relay NO contact', 500, 500); await bind(page, a.deviceId!); await page.getByRole('button', { name: 'Duplicate independent', exact: true }).click();
  await expect.poll(async () => (await graph(page)).sheets[0]!.instances.filter(i => i.definition.id === 'core.relay.contact.no').length).toBe(2);
  const copiedContact = await graph(page); expect(copiedContact.sheets[0]!.instances.find(i => i.id !== contact.id && i.definition.id === 'core.relay.contact.no')!.deviceId).toBeNull();
  await page.getByRole('button', { name: 'Text tool', exact: true }).click(); await page.getByLabel('Annotation text', { exact: true }).fill('<img src="https://invalid.example/art" onerror="alert(1)">'); await advanced(page); await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click();
  await expect(page.locator('svg image, svg img, svg script')).toHaveCount(0);
  await advanced(page); await page.getByRole('button', { name: 'Move right 10', exact: true }).click(); await expect(page.getByRole('status')).toContainText('annotations cannot move');
  expect(browser.errors).toEqual([]); expect(browser.external).toEqual([]);
});

test('drag projects symbol, ports and incident wire together; Escape discards preview without design/history edits', async ({ page }) => {
  await open(page); const source = await place(page, 'DC source', 300, 300), lamp = await place(page, 'Lamp', 600, 300);
  await connect(page, `${source.id}/plus`, `${lamp.id}/p1`);
  const before = await graph(page), wire = before.sheets[0]!.wires[0]!;
  await page.getByRole('button', { name: 'Select / Cancel (Escape)', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'Circuit drawing canvas' }); await canvas.scrollIntoViewIfNeeded();
  const body = page.locator(`[data-instance="${source.id}"] rect`).first(), box = (await body.boundingBox())!;
  const port = page.locator(`[data-port="${source.id}/plus"]`), oldX = Number(await port.getAttribute('cx'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 20);
  await expect.poll(async () => Number(await port.getAttribute('cx'))).toBeGreaterThan(oldX);
  const x = await port.getAttribute('cx'), y = await port.getAttribute('cy');
  await expect(page.locator(`[data-wire="${wire.id}"] polyline`)).toHaveAttribute('points', new RegExp(`^${x},${y} `));
  expect(await graph(page)).toEqual(before);
  await canvas.focus(); await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(port).toHaveAttribute('cx', String(oldX)); expect(await graph(page)).toEqual(before);
  const again = (await body.boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2); await page.mouse.down(); await page.mouse.move(again.x + again.width / 2 + 50, again.y + again.height / 2 + 20);
  await expect.poll(async () => Number(await port.getAttribute('cx'))).toBeGreaterThan(oldX); await page.mouse.up();
  await expect.poll(async () => (await graph(page)).revision).toBe(before.revision + 1);
});
