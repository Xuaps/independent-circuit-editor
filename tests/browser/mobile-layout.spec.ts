import { expect, test, type Locator, type Page } from '@playwright/test';

type Box = { x: number; y: number; width: number; height: number };
const phoneViewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }];

async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

async function expectFullyReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport({ ratio: 1 });
}

async function expectSectionJump(page: Page, name: 'Build' | 'Drawing' | 'Inspector', target: Locator) {
  const link = page.getByRole('link', { name, exact: true });
  const fragment = name.toLowerCase();
  await expect(link).toBeVisible();
  await expect(target).toHaveAttribute('id', fragment);
  await expect(target).toHaveAttribute('tabindex', '-1');
  await link.focus();
  await expect(link).toBeFocused();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#${fragment}$`));
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
}

async function followSectionLink(page: Page, name: 'Build' | 'Drawing' | 'Inspector', target: Locator) {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(target).toBeInViewport();
}

async function expectOpenedContentContained(
  trigger: Locator,
  content: Locator,
  container: Locator,
  viewportWidth: number,
) {
  await trigger.click();
  await expect(content).toBeVisible();
  const triggerBox = await box(trigger);
  const contentBox = await box(content);
  const containerBox = await box(container);
  expect(contentBox.x, 'opened content starts inside the viewport').toBeGreaterThanOrEqual(-1);
  expect(contentBox.x + contentBox.width, 'opened content ends inside the viewport').toBeLessThanOrEqual(viewportWidth + 1);
  expect(contentBox.x, 'opened content starts inside its control group').toBeGreaterThanOrEqual(containerBox.x - 1);
  expect(contentBox.x + contentBox.width, 'opened content ends inside its control group')
    .toBeLessThanOrEqual(containerBox.x + containerBox.width + 1);
  expect(contentBox.y, 'opened content starts below its trigger').toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
  expect(contentBox.y + contentBox.height, 'opened content expands its control group instead of obscuring later controls')
    .toBeLessThanOrEqual(containerBox.y + containerBox.height + 1);
  await expectFullyReachable(content);
}

for (const viewport of phoneViewports) {
  test(`phone portrait ${viewport.width}x${viewport.height} reflows the complete blank editor`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const header = page.locator('header.project-bar');
    const build = page.getByRole('complementary', { name: 'Palette and objects', exact: true });
    const drawing = page.getByRole('region', { name: 'Drawing workspace', exact: true });
    const inspector = page.getByRole('complementary', { name: 'Inspector and wiring', exact: true });
    const footer = page.locator('footer.history-bar');
    const canvas = page.getByRole('img', { name: 'Circuit drawing canvas', exact: true });

    const regions = await Promise.all([header, build, drawing, inspector, footer].map(box));
    for (const region of regions) {
      expect(region.x, 'phone regions start inside the viewport').toBeGreaterThanOrEqual(-1);
      expect(region.x + region.width, 'phone regions do not clip past the viewport').toBeLessThanOrEqual(viewport.width + 1);
      expect(region.width, 'phone regions use the available width').toBeGreaterThanOrEqual(viewport.width - 2);
    }
    for (let index = 1; index < regions.length; index += 1) {
      expect(regions[index]!.y, 'header, Build, Drawing, Inspector and footer are vertically ordered')
        .toBeGreaterThanOrEqual(regions[index - 1]!.y + regions[index - 1]!.height - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const drawingBox = regions[2]!;
    const canvasBox = await box(canvas);
    expect(drawingBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
    expect(canvasBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
    expect(canvasBox.height, 'phone drawing stage has useful height').toBeGreaterThanOrEqual(360);

    const toolbarBox = await box(page.getByRole('navigation', { name: 'Drawing tools', exact: true }));
    const blankGuide = page.locator('.blank-canvas');
    const blankBox = await box(blankGuide);
    expect(blankBox.y, 'the blank guide starts below the wrapped toolbar').toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
    await expect(blankGuide.getByText('Choose a part in Build.', { exact: true })).toBeVisible();
    const exampleHint = blankGuide.getByText('Or explore a working circuit: More files → Load example.', { exact: true });
    await expect(exampleHint).toBeVisible();
    const statusBox = await box(drawing.locator('.drawing-status'));
    const hintLines = await exampleHint.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects(), ({ left, right, top, bottom }) => ({ left, right, top, bottom }));
    });
    await test.info().attach('blank-example-hint-geometry', {
      body: JSON.stringify({ viewport, blankBox, canvasBox, toolbarBox, statusBox, hintLines }, null, 2),
      contentType: 'application/json',
    });
    expect(hintLines.length, 'the example hint has rendered text').toBeGreaterThan(0);
    for (const line of hintLines) {
      expect(line.left, 'hint text starts inside the guide, canvas and viewport').toBeGreaterThanOrEqual(Math.max(0, blankBox.x, canvasBox.x));
      expect(line.right, 'hint text ends inside the guide, canvas and viewport')
        .toBeLessThanOrEqual(Math.min(viewport.width, blankBox.x + blankBox.width, canvasBox.x + canvasBox.width));
      expect(line.top, 'hint text starts inside the canvas row below the toolbar')
        .toBeGreaterThanOrEqual(Math.max(canvasBox.y, toolbarBox.y + toolbarBox.height));
      expect(line.bottom, 'hint text ends inside the canvas row above Drawing status')
        .toBeLessThanOrEqual(Math.min(canvasBox.y + canvasBox.height, statusBox.y));
    }
    await expect(blankGuide).not.toContainText('Choose a part on the left.');

    const files = page.getByRole('group', { name: 'Design files', exact: true });
    await expectFullyReachable(files.getByRole('button', { name: 'New', exact: true }));
    await expectFullyReachable(files.getByRole('button', { name: 'Open', exact: true }));
    await expectFullyReachable(files.getByRole('button', { name: /^(Save|Download copy)$/ }));
    await expectFullyReachable(files.getByText('More files', { exact: true }));
    await expectFullyReachable(page.getByRole('button', { name: 'Run', exact: true }));
    await expectFullyReachable(footer);
  });

  test(`phone portrait ${viewport.width}x${viewport.height} section links move context to their named targets`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    await expectSectionJump(page, 'Build', page.getByRole('complementary', { name: 'Palette and objects', exact: true }));
    await expectSectionJump(page, 'Drawing', page.getByRole('region', { name: 'Drawing workspace', exact: true }));
    await expectSectionJump(page, 'Inspector', page.getByRole('complementary', { name: 'Inspector and wiring', exact: true }));
  });

  test(`phone portrait ${viewport.width}x${viewport.height} keeps opened header menus contained and reachable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const filePanel = page.getByRole('region', { name: 'Files and recovery', exact: true });
    const moreFiles = page.locator('.file-menu > summary');
    await expectOpenedContentContained(moreFiles, page.locator('.file-menu-content'), filePanel, viewport.width);
    await moreFiles.click();

    const fileStatus = page.locator('.file-feedback > summary');
    await expectOpenedContentContained(fileStatus, page.locator('.file-feedback > div'), filePanel, viewport.width);
    await fileStatus.click();

    const modeControls = page.locator('.mode-controls');
    const runtime = page.locator('.runtime-menu > summary');
    await expectOpenedContentContained(runtime, page.getByRole('button', { name: 'Reset runtime', exact: true }), modeControls, viewport.width);
  });

  test(`phone portrait ${viewport.width}x${viewport.height} preserves selection through Run Stop and Reset`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const build = page.getByRole('complementary', { name: 'Palette and objects', exact: true });
    const drawing = page.getByRole('region', { name: 'Drawing workspace', exact: true });
    const inspector = page.getByRole('complementary', { name: 'Inspector and wiring', exact: true });
    const simulation = inspector.locator('.simulation');
    const canvas = page.getByRole('img', { name: 'Circuit drawing canvas', exact: true });

    await followSectionLink(page, 'Build', build);
    await page.getByRole('button', { name: 'DC source', exact: true }).click();
    await followSectionLink(page, 'Drawing', drawing);
    await canvas.click({ position: { x: 195, y: 180 } });
    await expect(page.getByRole('heading', { name: 'Objects (1 symbols)', exact: true })).toBeVisible();
    await expect(drawing.locator('.drawing-status')).toContainText('Selected 1');
    await expect(page.getByTestId('design-status')).toContainText('revision 1');

    await followSectionLink(page, 'Inspector', inspector);
    await expect(inspector.getByText('DC source · selected symbol', { exact: true })).toBeVisible();
    await followSectionLink(page, 'Drawing', drawing);
    await expect(drawing.locator('.drawing-status')).toContainText('Selected 1');

    const run = page.getByRole('button', { name: 'Run', exact: true });
    await expectFullyReachable(run);
    await run.click();
    await expect(inspector.getByRole('heading', { name: 'Simulation — Running', exact: true })).toBeVisible();
    await expect(page.getByTestId('runtime-trace')).toHaveCount(1);
    await expect(page.getByTestId('design-status')).toContainText('revision 1');
    await expect(drawing.locator('.drawing-status')).toContainText('Selected 1');

    await followSectionLink(page, 'Inspector', inspector);
    const stop = page.getByRole('button', { name: 'Stop simulation', exact: true });
    await expectFullyReachable(stop);
    await stop.click();
    await expect(inspector.getByRole('heading', { name: 'Simulation — Editing', exact: true })).toBeVisible();

    await page.locator('.runtime-menu > summary').click();
    const reset = page.getByRole('button', { name: 'Reset runtime', exact: true });
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(simulation).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Objects (1 symbols)', exact: true })).toBeVisible();
    await expect(inspector.getByText('DC source · selected symbol', { exact: true })).toBeVisible();
    await expect(drawing.locator('.drawing-status')).toContainText('Selected 1');
    await expect(page.getByTestId('design-status')).toContainText('revision 1');
  });
}

for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
  test(`desktop ${viewport.width}x${viewport.height} keeps Build Drawing and Inspector in a horizontal workspace`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const build = await box(page.getByRole('complementary', { name: 'Palette and objects', exact: true }));
    const drawing = await box(page.getByRole('region', { name: 'Drawing workspace', exact: true }));
    const inspector = await box(page.getByRole('complementary', { name: 'Inspector and wiring', exact: true }));

    expect(drawing.x).toBeGreaterThanOrEqual(build.x + build.width - 1);
    expect(inspector.x).toBeGreaterThanOrEqual(drawing.x + drawing.width - 1);
    expect(Math.abs(build.y - drawing.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(drawing.y - inspector.y)).toBeLessThanOrEqual(1);
    expect(drawing.width).toBeGreaterThan(0);
    await expect(page.getByRole('img', { name: 'Circuit drawing canvas', exact: true })).toBeVisible();
  });
}
