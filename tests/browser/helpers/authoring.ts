import { expect, type Page } from '@playwright/test';
import type { Project } from '../../../src/core/domain/types';
export async function graph(page: Page): Promise<Project> { return JSON.parse((await page.getByTestId('project-json').textContent())!); }
/** Open only the public disclosure needed by an operation; never expand every panel. */
export async function reveal(page: Page, name: string) {
  const direct = page.locator('summary').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  if (await direct.locator('..').getAttribute('open') === null) await direct.click();
}
export async function advanced(page: Page) { await reveal(page, 'Advanced workspace'); }
export async function moreFiles(page: Page) { await reveal(page, 'More files'); }
export async function runtimeMenu(page: Page) { await reveal(page, 'Runtime'); }
export async function inspectProject(page: Page) {
  if (await page.getByTestId('project-json').count()) return;
  await advanced(page); await reveal(page, 'History and project data');
  await page.getByRole('button', { name: 'Inspect project JSON', exact: true }).click();
  await page.getByText('Advanced workspace', { exact: true }).click();
}
export async function open(page: Page) { await page.goto('/'); await inspectProject(page); }
export async function place(page: Page, name: string, x: number, y: number) {
  await page.getByRole('button', { name, exact: true }).click();
  await advanced(page);
  await page.getByLabel('Cursor X', { exact: true }).fill(String(x)); await page.getByLabel('Cursor Y', { exact: true }).fill(String(y));
  const before = (await graph(page)).revision; await page.getByRole('button', { name: 'Place at coordinates', exact: true }).click();
  await expect.poll(async () => (await graph(page)).revision).toBe(before + 1);
  await page.getByText('Advanced workspace', { exact: true }).click();
  return (await graph(page)).sheets[0]!.instances.find(i => i.transform.position.x === x && i.transform.position.y === y)!;
}
export async function connect(page: Page, from: string, to: string) {
  await reveal(page, 'Explicit wiring');
  await page.getByRole('combobox', { name: 'Wire from', exact: true }).selectOption(from); await page.getByRole('combobox', { name: 'Wire to', exact: true }).selectOption(to);
  const before = (await graph(page)).revision; await page.getByRole('button', { name: 'Connect endpoints', exact: true }).click();
  await expect.poll(async () => (await graph(page)).revision).toBe(before + 1);
}
export async function node(page: Page, x: number, y: number) {
  await place(page, 'Junction tool', x, y);
  return (await graph(page)).sheets[0]!.junctions.find(j => j.position.x === x && j.position.y === y)!.id;
}
export async function bind(page: Page, deviceId: string) {
  await page.getByRole('combobox', { name: 'Bound device', exact: true }).selectOption(deviceId);
  const before = (await graph(page)).revision;
  await page.getByRole('button', { name: 'Apply binding', exact: true }).click();
  await expect.poll(async () => (await graph(page)).revision).toBe(before + 1);
}
export function observeBrowser(page: Page) {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('request', r => { if (new URL(r.url()).hostname !== '127.0.0.1') external.push(r.url()); });
  return { errors, external };
}
export async function blankSelfhold(page: Page, missingReturn = false) {
  await open(page);
  const source = await place(page, 'DC source', 100, 100), stop = await place(page, 'NC pushbutton (Stop)', 300, 100), start = await place(page, 'NO pushbutton', 500, 100), coil = await place(page, 'Relay coil', 700, 100);
  const hold = await place(page, 'Relay NO contact', 500, 300); await bind(page, coil.deviceId!);
  const lamp = await place(page, 'Lamp', 700, 400);
  for (const [a, ap, b, bp] of [[source, 'plus', stop, 'p1'], [source, 'minus', coil, 'a2'], [stop, 'p2', start, 'p1'], [start, 'p2', coil, 'a1'], [start, 'p1', hold, 'p1'], [hold, 'p2', coil, 'a1'], [coil, 'a1', lamp, 'p1'], [coil, 'a2', lamp, 'p2']] as const) { if (missingReturn && a === coil && ap === 'a2' && b === lamp) continue; await connect(page, `${a.id}/${ap}`, `${b.id}/${bp}`); }
  return { source, stop, start, coil, hold, lamp };
}
