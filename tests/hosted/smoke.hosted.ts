import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const baseURL = process.env.HOSTED_BASE_URL;
const expectedSourceSHA = process.env.EXPECTED_SOURCE_SHA;
const expectedManifestSHA = process.env.EXPECTED_MANIFEST_SHA;
if (!baseURL) throw new Error('HOSTED_BASE_URL is required');
if (!expectedSourceSHA) throw new Error('EXPECTED_SOURCE_SHA is required');
if (!expectedManifestSHA) throw new Error('EXPECTED_MANIFEST_SHA is required');

test('deployed root site serves the application and offline assets', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  const response = await page.goto(baseURL, { waitUntil: 'networkidle' });
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Independent Circuit Editor' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Circuit drawing canvas' })).toBeVisible();

  for (const path of ['selfhold.circuit.json', 'service-worker.js', 'THIRD_PARTY_NOTICES.txt']) {
    const asset = await request.get(new URL(path, baseURL).href);
    expect(asset.ok(), `${path} should be served`).toBe(true);
  }

  const manifestResponse = await request.get(new URL('build-manifest.json', baseURL).href);
  expect(manifestResponse.ok(), 'build-manifest.json should be served').toBe(true);
  const manifestBytes = await manifestResponse.body();
  expect(createHash('sha256').update(manifestBytes).digest('hex'), 'build-manifest.json SHA-256').toBe(expectedManifestSHA);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    sourceRevision?: unknown;
    files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
  };
  expect(manifest.sourceRevision).toBe(expectedSourceSHA);
  expect(Array.isArray(manifest.files)).toBe(true);

  for (const file of manifest.files ?? []) {
    expect(typeof file.path).toBe('string');
    expect(typeof file.bytes).toBe('number');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);

    const assetPath = file.path as string;
    const asset = await request.get(new URL(assetPath, baseURL).href);
    expect(asset.ok(), `${assetPath} should be served`).toBe(true);
    const body = await asset.body();
    expect(body.byteLength, `${assetPath} byte count`).toBe(file.bytes);
    expect(createHash('sha256').update(body).digest('hex'), `${assetPath} SHA-256`).toBe(file.sha256);
  }

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Independent Circuit Editor' })).toBeVisible();
  expect(errors).toEqual([]);
});
