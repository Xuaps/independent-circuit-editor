import { test, expect } from '@playwright/test';
test('blank local authoring workspace renders without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const external: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Independent Circuit Editor' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Blank project.');
  await expect(page.getByRole('img', { name: 'Circuit drawing canvas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Objects (0 symbols)' })).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test.describe('editor issue reporting', () => {
  test.use({ serviceWorkers: 'block' });

  test('compact editor exposes a safe issue-report link without contacting the tracker', async ({ page, context, baseURL }) => {
    const issuesUrl = 'https://github.com/Xuaps/independent-circuit-editor/issues';
    const editorOrigin = new URL(baseURL!).origin;
    const offOrigin: string[] = [];
    await context.route(url => url.origin !== editorOrigin, async route => {
      offOrigin.push(route.request().url());
      await route.abort();
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Independent Circuit Editor', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Blank project.');
    const canvas = page.getByRole('img', { name: 'Circuit drawing canvas', exact: true });
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: 'Lamp', exact: true }).click();
    await canvas.click();
    await expect(page.getByRole('heading', { name: 'Objects (1 symbols)', exact: true })).toBeVisible();
    await expect(page.getByTestId('design-status')).toContainText('Unsaved changes');
    const readDraft = () => page.evaluate(() => localStorage.getItem('independent-circuit:recovery:v1') ?? '');
    await expect.poll(readDraft).toContain('"core.lamp"');
    const draft = await readDraft();
    expect(offOrigin, 'No off-origin requests during load and ordinary editing').toEqual([]);

    const report = page.getByRole('link', { name: 'Report an issue', exact: true });
    await expect(report, 'Report an issue should be visible after local editing').toBeVisible();
    await expect(report).toBeInViewport({ ratio: 1 });
    await expect(report).toHaveJSProperty('tagName', 'A');
    await expect(report).toHaveAttribute('href', issuesUrl);
    await expect(report).toHaveAttribute('target', '_blank');
    await expect(report).toHaveAttribute('rel', /(?:^|\s)noopener(?:\s|$)/);
    await expect(report).toHaveAttribute('rel', /(?:^|\s)noreferrer(?:\s|$)/);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.print-design')).toBeVisible();
    await expect(page.locator(`a[href="${issuesUrl}"]`)).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    await expect(canvas).toBeVisible();
    expect(await readDraft()).toBe(draft);
    expect(offOrigin).toEqual([]);
  });
});
