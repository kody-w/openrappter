import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyMigrationReplay(filename, evidenceDirectory, expected) {
  const scratch = path.join(evidenceDirectory, 'browser-scratch');
  const profile = path.join(evidenceDirectory, 'isolated-browser-profile');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = scratch;
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block',
    env: { ...process.env, TMPDIR: scratch },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'],
  });
  const results = [];
  try {
    await context.route(/^https?:/u, route => route.abort());
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      const errors = [], failed = [], network = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => failed.push(request.url()));
      page.on('request', request => { if (/^https?:/u.test(request.url())) network.push(request.url()); });
      const url = pathToFileURL(filename); url.searchParams.set('scoutTheme', theme);
      await page.goto(url.href, { waitUntil: 'load' });
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('#roots-count').textContent(), '0');
      for (let repetition = 0; repetition < 2; repetition++) {
        await page.getByRole('button', { name: 'Next event', exact: true }).click();
        assert.match(await page.locator('#position').textContent(), /Event 2 /);
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.waitForTimeout(280);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        assert(!/Event 2 /.test(await page.locator('#position').textContent()));
        await page.getByRole('button', { name: 'Reset', exact: true }).click();
        assert.equal(await page.locator('#roots-count').textContent(), '0');
      }
      await page.getByRole('button', { name: 'Next event', exact: true }).focus();
      await page.keyboard.press('Space');
      assert.match(await page.locator('#position').textContent(), /Event 2 /);
      await page.getByLabel('Observed migration event').focus();
      await page.keyboard.press('ArrowRight');
      assert.match(await page.locator('#position').textContent(), /Event 3 /);
      await page.getByRole('button', { name: 'Reset', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.match(await page.locator('#position').textContent(), /Event 1 /);
      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      await page.getByLabel('Observed migration event').evaluate(input => {
        input.value = input.max; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.equal(await page.locator('#roots-count').textContent(), String(expected.roots));
      assert.equal(await page.locator('#scopes-count').textContent(), String(expected.scopes));
      assert.equal(await page.locator('#pointers-count').textContent(), String(expected.pointers));
      assert.equal(await page.locator('#artifacts-count').textContent(), String(expected.artifacts));
      assert.equal(await page.locator('#items .pointer').count(), expected.items);
      const geometry = await page.evaluate(() => ({
        width: window.innerWidth, document: document.documentElement.scrollWidth,
        variable: getComputedStyle(document.documentElement).getPropertyValue('--cp-bg').trim(),
        body: getComputedStyle(document.body).backgroundColor,
      }));
      assert(geometry.document <= geometry.width, `Replay overflows ${theme} ${viewport.width}`);
      assert(geometry.variable.length > 0);
      const screenshot = path.join(evidenceDirectory, `migration-${theme}-${viewport.width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      assert.deepEqual(network, []);
      results.push({ theme, viewport, coldLoad: 'passed', offlineReload: 'passed', interactionsRepeated: 2,
        keyboard: 'passed', overflowPixels: geometry.document - geometry.width, errors, failed, network,
        screenshot: path.basename(screenshot) });
      await page.close();
      await context.setOffline(false);
    }
  } finally { await context.close(); }
  const report = { schema: 'rapp-work.migration-replay-browser/1', runtime: 'Playwright-managed pinned Chromium, isolated profile',
    selfContained: true, liveBrowserProfilesTouched: false, variants: results };
  await writeFile(path.join(evidenceDirectory, 'browser-verification.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
