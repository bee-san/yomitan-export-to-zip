// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import {archiveFileName, convertExport} from '../../src/convert.js';
import {concatParts} from '../../src/zip-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const fixture = (name) => join(FIXTURES, `${name}.json`);

const EXPORT_ORDER = ['valid-dictionary1', 'Rich Metadata Dictionary', 'Frequency Only', '  Weird/Title: "quotes" <tags> ..\\..  ', 'Legacy V1 Dictionary', 'valid-dictionary1 (copy)'];

async function loadAndScan(page, name = 'multi-six') {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture(name));
    await expect(page.locator('#status')).toHaveText(/Found \d+ dictionar/, {timeout: 30_000});
}

async function convert(page) {
    await page.getByRole('button', {name: 'Convert to ZIP files'}).click();
    await expect(page.locator('#status')).toHaveText(/Conversion finished/, {timeout: 60_000});
}

const archiveNames = (page) => page.locator('#dictionary-rows tr').evaluateAll((rows) => rows.map((r) => (r.querySelector('a.download')?.download ?? r.querySelector('.archive-name')?.textContent)));

async function expectNoAxeViolations(page, label) {
    const results = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`), label).toEqual([]);
}

test('converts a multi-dictionary export in the browser and downloads byte-identical archives', async ({page}) => {
    await loadAndScan(page);
    await expect(page.locator('#status')).toHaveText('Found 6 dictionaries. Order them, then convert.');
    expect(await archiveNames(page)).toEqual(EXPORT_ORDER.map((t, i) => archiveFileName(i + 1, 6, t)));
    await convert(page);

    // Reference bytes from the Node implementation: the browser must produce exactly the same archives.
    const reference = await convertExport(new Uint8Array(readFileSync(fixture('multi-six'))));
    const links = page.locator('a.download');
    await expect(links).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
        const [download] = await Promise.all([page.waitForEvent('download'), links.nth(i).click()]);
        expect(download.suggestedFilename()).toBe(archiveFileName(i + 1, 6, EXPORT_ORDER[i]));
        const bytes = new Uint8Array(readFileSync(await download.path()));
        const expected = concatParts(reference.archives.find((a) => a.title === EXPORT_ORDER[i]).parts);
        expect(Buffer.compare(bytes, expected), `${download.suggestedFilename()} bytes`).toBe(0);
    }
    await expect(page.locator('#report-list li.warning')).toHaveCount(1);
    await expect(page.locator('#report-list li.warning')).toContainText('Legacy V1 Dictionary: Stored as a format 1');
});

test('conversion runs in a Web Worker', async ({page}) => {
    const scripts = [];
    page.on('request', (r) => scripts.push(new URL(r.url()).pathname));
    const workers = [];
    page.on('worker', (w) => workers.push(w.url()));
    await loadAndScan(page, 'single-rich-meta');
    expect(scripts.some((p) => p.endsWith('/src/worker.js'))).toBe(true);
    expect(workers.some((u) => u.endsWith('/src/worker.js'))).toBe(true);
});

test('sorting by name and moving rows renumbers archives consistently', async ({page}) => {
    await loadAndScan(page);
    await page.getByRole('button', {name: 'Sort by name A→Z'}).click();
    const asc = [...EXPORT_ORDER].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base', numeric: true}));
    expect(await archiveNames(page)).toEqual(asc.map((t, i) => archiveFileName(i + 1, 6, t)));
    await expect(page.locator('#status')).toHaveText('Sorted by dictionary name, A to Z.');

    await page.getByRole('button', {name: 'Sort by name Z→A'}).click();
    expect(await archiveNames(page)).toEqual([...asc].reverse().map((t, i) => archiveFileName(i + 1, 6, t)));

    await page.getByRole('button', {name: 'Export order'}).click();
    expect(await archiveNames(page)).toEqual(EXPORT_ORDER.map((t, i) => archiveFileName(i + 1, 6, t)));

    await page.getByRole('button', {name: 'Move Frequency Only up'}).click();
    const moved = [EXPORT_ORDER[0], EXPORT_ORDER[2], EXPORT_ORDER[1], ...EXPORT_ORDER.slice(3)];
    expect(await archiveNames(page)).toEqual(moved.map((t, i) => archiveFileName(i + 1, 6, t)));
    await expect(page.locator('#dictionary-rows tr td.position')).toHaveText(['1', '2', '3', '4', '5', '6']);
    await expect(page.getByRole('button', {name: 'Move valid-dictionary1 up', exact: true})).toBeDisabled();
    await expect(page.getByRole('button', {name: 'Move valid-dictionary1 (copy) down'})).toBeDisabled();

    // Ordering after conversion only renames: the download name follows the new position.
    await convert(page);
    await page.getByRole('button', {name: 'Sort by name A→Z'}).click();
    const first = page.locator('a.download').first();
    await expect(first).toHaveAttribute('download', archiveFileName(1, 6, asc[0]));
    const [download] = await Promise.all([page.waitForEvent('download'), first.click()]);
    expect(download.suggestedFilename()).toBe(archiveFileName(1, 6, asc[0]));
    const reference = await convertExport(new Uint8Array(readFileSync(fixture('multi-six'))));
    expect(Buffer.compare(new Uint8Array(readFileSync(await download.path())), concatParts(reference.archives.find((a) => a.title === asc[0]).parts))).toBe(0);
});

test('download all triggers one download per archive with the numbered names', async ({page}) => {
    await loadAndScan(page, 'multi-six');
    await convert(page);
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.getByRole('button', {name: 'Download all'}).click();
    await expect.poll(() => downloads.length, {timeout: 20_000}).toBe(6);
    expect(downloads).toEqual(EXPORT_ORDER.map((t, i) => archiveFileName(i + 1, 6, t)));
});

test('no user data leaves the browser: only same-origin static assets are requested, and conversion works offline', async ({page, context}) => {
    const requests = [];
    page.on('request', (r) => requests.push({url: r.url(), method: r.method(), postData: r.postData()}));
    await page.goto('./');
    const origin = new URL(page.url()).origin;
    const basePath = new URL(page.url()).pathname.replace(/[^/]*$/, '');
    const loaded = requests.length;
    expect(requests.every((r) => r.url.startsWith(origin) && r.method === 'GET' && r.postData === null)).toBe(true);

    // Wait for module loading to settle, then cut the network entirely.
    await page.waitForLoadState('networkidle');
    await context.setOffline(true);
    await page.setInputFiles('#file-input', fixture('multi-six'));
    await expect(page.locator('#status')).toHaveText(/Found 6 dictionaries/, {timeout: 30_000});
    await convert(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('a.download').first().click()]);
    expect(readFileSync(await download.path()).length).toBeGreaterThan(0);
    await context.setOffline(false);

    const afterLoad = requests.slice(loaded).filter((r) => !r.url.startsWith('blob:'));
    // Everything after the initial page load is at most the lazily loaded worker module graph.
    for (const r of afterLoad) {
        expect(r.url.startsWith(origin), r.url).toBe(true);
        expect(r.method).toBe('GET');
        expect(r.postData).toBeNull();
        expect(new URL(r.url).pathname.startsWith(basePath), r.url).toBe(true);
        expect(new URL(r.url).pathname.slice(basePath.length)).toMatch(/^(?:src\/[a-z-]+\.js|vendor\/fflate\.js)$/);
    }
    expect(requests.some((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:'))).toBe(false);

    // The page's CSP forbids any network connection from script.
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    const fetchBlocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'allowed', () => 'blocked'));
    expect(fetchBlocked).toBe('blocked');
});

test('has no axe accessibility violations before, during and after conversion', async ({page}) => {
    await page.goto('./');
    await expectNoAxeViolations(page, 'initial');
    await page.setInputFiles('#file-input', fixture('multi-six'));
    await expect(page.locator('#status')).toHaveText(/Found 6/);
    await expectNoAxeViolations(page, 'after scan');
    await convert(page);
    await expectNoAxeViolations(page, 'after conversion');
    await page.setInputFiles('#file-input', fixture('single-legacy-v1'));
    await expect(page.locator('#status')).toHaveText(/Found 1/);
    await expectNoAxeViolations(page, 'after re-scan with warning');
});

test('is operable with the keyboard alone', async ({page}) => {
    await page.goto('./');
    await page.keyboard.press('Tab'); // skip link
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#file-input')).toBeFocused();
    await page.setInputFiles('#file-input', fixture('multi-six'));
    await expect(page.locator('#status')).toHaveText(/Found 6/);

    await page.getByRole('button', {name: 'Export order'}).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', {name: 'Sort by name A→Z'})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#status')).toHaveText(/A to Z/);

    // Move a row down with the keyboard and keep focus on that row's control.
    const down = page.getByRole('button', {name: 'Move Frequency Only down'});
    await down.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: 'Move Frequency Only down'})).toBeFocused();
    await expect(page.locator('#dictionary-rows tr').nth(2)).toContainText('Frequency Only');

    await page.getByRole('button', {name: 'Convert to ZIP files'}).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#status')).toHaveText(/Conversion finished/, {timeout: 60_000});
    await expect(page.getByRole('button', {name: 'Download all'})).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', {name: 'Start over'})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#file-input')).toBeFocused();
    await expect(page.locator('#dictionaries-section')).toBeHidden();
});

test('works on a narrow screen without horizontal overflow', async ({page}) => {
    await page.setViewportSize({width: 360, height: 740});
    await loadAndScan(page);
    await convert(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const rowDisplay = await page.locator('#dictionary-rows tr').first().evaluate((el) => getComputedStyle(el).display);
    expect(rowDisplay).toBe('block');
    await expect(page.locator('a.download')).toHaveCount(6);
    await expectNoAxeViolations(page, 'narrow');
});

test('rejects wrong, truncated and empty files with visible messages', async ({page}) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', {name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello')});
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error')).toContainText('does not look like a JSON file');

    const truncated = readFileSync(fixture('multi-six')).subarray(0, 60_000);
    await page.setInputFiles('#file-input', {name: 'yomitan-dictionaries-cut.json', mimeType: 'application/json', buffer: truncated});
    // Scanning succeeds on the head of the file; conversion must fail cleanly.
    await expect(page.locator('#status')).toHaveText(/Found 6/);
    await page.getByRole('button', {name: 'Convert to ZIP files'}).click();
    await expect(page.locator('#error')).toContainText('truncated', {timeout: 30_000});
    await expect(page.locator('a.download')).toHaveCount(0);

    await page.setInputFiles('#file-input', {name: 'yomitan-settings-2026.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({version: 0, options: {}}))});
    await expect(page.locator('#error')).toContainText('settings backups');

    await page.setInputFiles('#file-input', fixture('empty-database'));
    await expect(page.locator('#error')).toContainText('contains no dictionaries');
    await expect(page.locator('#convert-section')).toBeHidden();
});
