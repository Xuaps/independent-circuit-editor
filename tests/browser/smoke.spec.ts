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
