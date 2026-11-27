import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page, type Response } from '@playwright/test';
import { graph, inspectProject, moreFiles } from '../browser/helpers/authoring';

const canonicalURL = 'https://circuits.xuaps.com/';
const fixturePath = 'selfhold.circuit.json';
const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const sourcePattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const timeout = 5_000;

type Entry = { path: string; bytes: number; sha256: string };
type Artifact = { index: Entry; workerURL: string; expectedDesign: unknown };
type Stage = 'config' | 'artifact' | 'browser-root' | 'startup' | 'controlled-reload'
  | 'load-example' | 'run-selfhold' | 'stop' | 'download' | 'reopen' | 'browser-errors';
type Reason = 'target' | 'identity-input' | 'manifest-response' | 'manifest-digest'
  | 'manifest-source' | 'manifest-entries' | 'asset-response' | 'asset-digest'
  | 'document-response' | 'document-digest' | 'origin-boundary' | 'controller' | 'fixture-design'
  | 'discard-prompt' | 'relay-initial' | 'start-held' | 'relay-trigger' | 'relay-released'
  | 'download-file' | 'download-design' | 'reopened-design' | 'console-error';

class SmokeFailure extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

function check(condition: unknown, reason: Reason): asserts condition {
  if (!condition) throw new SmokeFailure(reason);
}

function safeEnv(name: string, format: RegExp) {
  const value = process.env[name];
  return value && format.test(value) ? value : undefined;
}

const source = safeEnv('EXPECTED_SOURCE_SHA', sourcePattern);
const manifestDigest = safeEnv('EXPECTED_MANIFEST_SHA', digestPattern);
const runId = safeEnv('GITHUB_RUN_ID', /^[0-9]{1,20}$/);
const attempt = safeEnv('GITHUB_RUN_ATTEMPT', /^[0-9]{1,10}$/);

async function stage<T>(name: Stage, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    // Do not attach the cause: Playwright and browser errors may include raw data.
    const reason = error instanceof SmokeFailure ? error.reason : 'check-failed';
    throw new Error(`hosted-smoke ${name}/${reason} source=${source ?? 'unknown'} manifest=${manifestDigest ?? 'unknown'} run=${runId ?? 'local'} attempt=${attempt ?? 'local'}`);
  }
}

async function requireCheck(assertion: () => Promise<unknown>, reason: Reason) {
  try { await assertion(); }
  catch { throw new SmokeFailure(reason); }
}

function matches(body: Buffer, entry: Entry) {
  return body.length === entry.bytes && sha256(body) === entry.sha256;
}

function isSafePath(path: unknown): path is string {
  return typeof path === 'string' && path.split('/').every(part =>
    /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

// A browser route only sees the first URL of a redirect chain and may miss
// service-worker fetches. Restrict browser egress at the transport instead.
// TLS is tunneled to the sole HTTPS endpoint without terminating it here.
async function withOriginPage(browser: Browser, base: string, journey: (page: Page, denied: () => boolean) => Promise<void>) {
  const target = new URL(base);
  const port = target.port || '443';
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  let blocked = false;
  const proxy = createServer((incoming, outgoing) => {
    const url = URL.parse(incoming.url ?? '');
    const method = incoming.method;
    if (target.protocol !== 'http:' || url?.origin !== target.origin || url.username || url.password
      || (method !== 'GET' && method !== 'HEAD')) {
      blocked = true;
      outgoing.writeHead(403).end();
      return;
    }
    const { 'proxy-authorization': _auth, 'proxy-connection': _connection, ...headers } = incoming.headers;
    const upstream = httpRequest(url, { method, headers: { ...headers, host: target.host }, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.setTimeout(2 * timeout, () => upstream.destroy());
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    upstream.end();
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, client, head) => {
    if (target.protocol !== 'https:' || request.url !== `${target.hostname}:${port}`) {
      blocked = true;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect(Number(port), target.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  let context: BrowserContext | undefined;
  try {
    const page = await stage('browser-root', async () => {
      await once(proxy.listen(0, '127.0.0.1'), 'listening');
      const address = proxy.address();
      check(address && typeof address !== 'string', 'origin-boundary');
      context = await browser.newContext({
        proxy: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' },
        ignoreHTTPSErrors: target.hostname === '127.0.0.1',
      });
      context.setDefaultTimeout(timeout);
      context.setDefaultNavigationTimeout(2 * timeout);
      return context.newPage();
    });
    await journey(page, () => blocked);
  } finally {
    try { await context?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }
}

async function verifyDocument(navigate: () => Promise<Response | null>, base: string, entry: Entry, denied: () => boolean) {
  try {
    const response = await navigate();
    check(response && response.ok() && response.url() === base, 'document-response');
    check(matches(await response.body(), entry), 'document-digest');
  } finally { check(!denied(), 'origin-boundary'); }
}

async function withDiscard(page: Page, action: () => Promise<void>) {
  const prompt = page.waitForEvent('dialog', { timeout }).then(async dialog => {
    if (dialog.type() !== 'prompt' || !dialog.message().includes('Unsaved or unconfirmed work')) {
      await dialog.dismiss();
      throw new SmokeFailure('discard-prompt');
    }
    await dialog.accept('Discard');
  });
  await Promise.all([prompt, action()]);
}

test('hosted artifact, editor startup and bundled circuit round trip', async ({ browser, request }) => {
  const base = await stage('config', () => {
    const target = process.env.HOSTED_BASE_URL;
    check(target && (target === canonicalURL || (process.env.HOSTED_ALLOW_LOOPBACK === '1'
      && /^https?:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(target) && URL.parse(target)?.port)), 'target');
    check(source && manifestDigest, 'identity-input');
    return target;
  });

  const artifact: Artifact = await stage('artifact', async () => {
    const options = { maxRedirects: 0, timeout, ignoreHTTPSErrors: new URL(base).hostname === '127.0.0.1' };
    const response = await request.get(new URL('build-manifest.json', base).href, options);
    check(response.ok(), 'manifest-response');
    const body = await response.body();
    check(sha256(body) === manifestDigest, 'manifest-digest');
    const manifest = JSON.parse(body.toString('utf8')) as { schema?: unknown; sourceRevision?: unknown; files?: unknown };
    check(manifest.sourceRevision === source, 'manifest-source');
    check(manifest.schema === 1 && Array.isArray(manifest.files), 'manifest-entries');
    const entries = new Map<string, Entry>();
    for (const entry of manifest.files) {
      check(entry && isSafePath(entry.path) && !entries.has(entry.path) && Number.isSafeInteger(entry.bytes)
        && entry.bytes >= 0 && typeof entry.sha256 === 'string' && digestPattern.test(entry.sha256), 'manifest-entries');
      entries.set(entry.path, entry);
    }
    const index = entries.get('index.html');
    const workers = [...entries.keys()].filter(path => /^assets\/worker-[\w-]+\.js$/.test(path));
    check(index && workers.length === 1 && entries.has(fixturePath)
      && entries.has('service-worker.js') && entries.has('THIRD_PARTY_NOTICES.txt'), 'manifest-entries');
    let fixture: Buffer | undefined;
    for (const entry of entries.values()) {
      const asset = await request.get(new URL(entry.path, base).href, options);
      check(asset.ok(), 'asset-response');
      const bytes = await asset.body();
      check(matches(bytes, entry), 'asset-digest');
      if (entry.path === fixturePath) fixture = bytes;
    }
    check(fixture, 'fixture-design');
    // Compare JSON data, not formatting or object-key order. The bundled fixture's
    // ID collections are already in canonical order, as in the editor's export.
    const expectedDesign: unknown = JSON.parse(fixture.toString('utf8'));
    return { index, workerURL: new URL(workers[0]!, base).href, expectedDesign };
  });

  await withOriginPage(browser, base, (page, denied) => runJourney(page, base, artifact, denied));
});

async function runJourney(page: Page, base: string, { index, workerURL, expectedDesign }: Artifact, denied: () => boolean) {
  let browserError = false;
  page.on('pageerror', () => { browserError = true; });
  page.on('console', message => { if (message.type() === 'error') browserError = true; });
  const heading = page.getByRole('heading', { name: 'Independent Circuit Editor', exact: true });

  await stage('browser-root', async () => {
    // Force the file-input/download fallback only in this disposable context.
    await page.addInitScript(() => {
      for (const capability of ['showSaveFilePicker', 'showOpenFilePicker']) {
        Object.defineProperty(window, capability, { value: undefined, configurable: true });
      }
    });
    await verifyDocument(() => page.goto(base, { waitUntil: 'commit' }), base, index, denied);
  });

  await stage('startup', async () => {
    await expect(heading).toBeVisible();
    await expect(page.getByRole('img', { name: 'Circuit drawing canvas' })).toBeVisible();
  });

  await stage('controlled-reload', async () => {
    const serviceWorkerURL = new URL('service-worker.js', base).href;
    const hasController = () => page.evaluate(async url => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const controller = navigator.serviceWorker.controller;
      return controller?.state === 'activated' && controller === registration?.active && controller.scriptURL === url;
    }, serviceWorkerURL);
    await requireCheck(() => expect.poll(hasController, { timeout }).toBe(true), 'controller');
    // This is an online reload; the predeploy suite exercises genuine offline use.
    await verifyDocument(() => page.reload({ waitUntil: 'commit' }), base, index, denied);
    check(await hasController(), 'controller');
    await expect(heading).toBeVisible();
  });

  const newDesign = page.getByRole('button', { name: 'New', exact: true });
  const fileStatus = page.getByTestId('file-status');
  const objects = page.getByRole('heading', { name: 'Objects (7 symbols)', exact: true });
  await stage('load-example', async () => {
    await moreFiles(page);
    await withDiscard(page, () => page.getByRole('button', { name: 'Load example', exact: true }).click());
    await expect(objects).toBeVisible();
    await expect(newDesign).toBeEnabled();
    await inspectProject(page);
    check(isDeepStrictEqual(await graph(page), expectedDesign), 'fixture-design');
  });

  await stage('run-selfhold', async () => {
    await Promise.all([
      page.waitForEvent('worker', { predicate: worker => worker.url() === workerURL, timeout }),
      page.getByRole('button', { name: 'Run', exact: true }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Simulation — Running', exact: true })).toBeVisible();
    const relay = page.locator('[data-observable="device_relay/energized"]');
    const pressed = page.locator('[data-observable="device_start/pressed"]');
    await requireCheck(() => expect(relay).toContainText(/energized: false$/), 'relay-initial');
    await page.locator('[data-actuator="instance_start"]').focus();
    await page.keyboard.down(' ');
    try {
      await requireCheck(() => expect(pressed).toContainText(/pressed: true$/), 'start-held');
      await requireCheck(() => expect(relay).toContainText(/energized: true$/), 'relay-trigger');
    } finally { await page.keyboard.up(' '); }
    await requireCheck(() => expect(pressed).toContainText(/pressed: false$/), 'relay-released');
    await requireCheck(() => expect(relay).toContainText(/energized: true$/), 'relay-released');
  });

  await stage('stop', async () => {
    await page.getByRole('button', { name: 'Stop simulation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Simulation — Editing', exact: true })).toBeVisible();
    await expect(newDesign).toBeEnabled();
  });

  const downloadBytes = await stage('download', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      page.getByRole('button', { name: 'Download copy', exact: true }).click(),
    ]);
    const path = await download.path();
    check(path && await download.failure() === null, 'download-file');
    const bytes = await readFile(path);
    check(isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), expectedDesign), 'download-design');
    await expect(fileStatus).toContainText('Download copy requested — NOT confirmed saved');
    return bytes;
  });

  await stage('reopen', async () => {
    // Make the UI prove it read the file, rather than merely retaining the loaded design.
    await withDiscard(page, () => newDesign.click());
    await expect(page.getByRole('heading', { name: 'Objects (0 symbols)', exact: true })).toBeVisible();
    await expect(newDesign).toBeEnabled();
    await withDiscard(page, () => page.getByLabel('Open circuit file', { exact: true }).setInputFiles({
      name: 'hosted-selfhold.circuit.json', mimeType: 'application/json', buffer: downloadBytes,
    }));
    await expect(fileStatus).toContainText('Design opened');
    await expect(objects).toBeVisible();
    await expect(newDesign).toBeEnabled();
    await inspectProject(page);
    check(isDeepStrictEqual(await graph(page), expectedDesign), 'reopened-design');
  });

  await stage('browser-errors', () => {
    check(!denied(), 'origin-boundary');
    check(!browserError, 'console-error');
  });
}
