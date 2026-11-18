// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { ARTIFACT_LIBRARIES, inlineArtifactLibraries } from '../../shared/artifactLibraries.js';
import { artifactPreviewCsp, prepareHtmlPreview } from '../../shared/artifactPreview.js';

/**
 * The library kit for HTML artifacts (#3822): with `artifacts.scriptHosts: []`
 * and every request to another host blocked, a hand-written Chart.js dashboard
 * still renders, because iHub inlines the library instead of loading it from a
 * CDN. Checked in a shared chat's Artifacts panel (the SPA, share routes
 * intercepted), in the markup the share embed page frames, and for every
 * example the `web-artifacts` skill gives the model.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARE_ID = 'e2e-library-kit-share';
const ARTIFACT_ID = 'd1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A dashboard as the skill writes it: the kit marker, no CDN. */
const DASHBOARD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Sales</title>
<script data-ihub-lib="chart.js"></script></head>
<body><div style="height:240px"><canvas id="c" aria-label="Sales"></canvas></div>
<script>
  const chart = new Chart(document.getElementById('c'), {
    type: 'bar',
    data: { labels: ['North', 'South'], datasets: [{ label: 'Sales', data: [12, 9] }] },
    options: { animation: false, maintainAspectRatio: false }
  });
  document.body.dataset.chart = Chart.version + ':' + chart.data.datasets[0].data.length;
</script></body></html>`;

const sourceOf = id =>
  readFileSync(
    path.join(root, 'server', 'artifactLibraries', ARTIFACT_LIBRARIES.find(l => l.id === id).file),
    'utf8'
  );

/** Abort every request that does not go to the app itself, and record it. */
async function blockTheInternet(page) {
  const blocked = [];
  await page.context().route('**/*', route => {
    const { protocol, hostname } = new URL(route.request().url());
    if (!/^https?:$/.test(protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      return route.fallback();
    }
    blocked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  return blocked;
}

/**
 * A frame document as the embed page builds it (`routes/shareEmbedPage.js`):
 * the kit inlined, the preview CSP with no CDN host, in a sandboxed srcdoc.
 */
function embedLikePage(markup) {
  const inlined = inlineArtifactLibraries(markup, sourceOf).html;
  const srcdoc = prepareHtmlPreview(inlined, { scriptHosts: [] })
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${artifactPreviewCsp([])}">` +
    '</head><body style="margin:0">' +
    `<iframe sandbox="allow-scripts" title="artifact" style="width:900px;height:700px;border:0" srcdoc="${srcdoc}"></iframe>` +
    '</body></html>'
  );
}

test.describe('Library kit: charts without a CDN', () => {
  test('a Chart.js dashboard renders in a shared chat with no script host and no internet', async ({
    page
  }) => {
    const blocked = await blockTheInternet(page);

    // The admin allows no CDN host; the kit is on.
    await page.route(/\/api\/configs\/platform(\?|$)/, async route => {
      const response = await route.fetch();
      const json = await response.json();
      json.artifacts = { ...json.artifacts, scriptHosts: [], libraryKit: { enabled: true } };
      return route.fulfill({ response, json });
    });

    const artifact = {
      id: ARTIFACT_ID,
      kind: 'code',
      mimeType: 'text/plain',
      name: 'sales.html',
      bytes: DASHBOARD.length,
      createdAt: '2026-11-18T10:00:00.000Z'
    };
    await page.route(new RegExp(`/api/shares/${SHARE_ID}(/|$|\\?)`), async route => {
      const { pathname } = new URL(route.request().url());
      const rest = pathname.slice(pathname.indexOf(SHARE_ID) + SHARE_ID.length);
      if (rest === '') {
        return route.fulfill({
          json: {
            share: {
              id: SHARE_ID,
              mode: 'authenticated',
              title: 'Sales dashboard',
              sharedBy: 'Ada',
              createdAt: '2026-11-18T10:05:00.000Z',
              app: { name: { en: 'Chat', de: 'Chat' }, color: '#4f46e5', icon: 'chat-bubble' }
            },
            messages: [
              { id: 'm1', role: 'user', content: 'Make a sales dashboard.' },
              { id: 'm2', role: 'assistant', content: 'Here it is.', artifacts: [artifact] }
            ],
            version: 1
          }
        });
      }
      if (rest === '/artifacts') return route.fulfill({ json: { items: [artifact] } });
      if (rest === `/artifacts/${ARTIFACT_ID}`) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: DASHBOARD
        });
      }
      return route.fulfill({ status: 404, json: { detail: 'Not found', code: 'NOT_FOUND' } });
    });

    const sources = [];
    page.on('request', request => {
      if (request.url().includes('/api/artifact-libraries/')) sources.push(request.url());
    });

    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('open-artifacts').click();
    await page
      .getByRole('list', { name: 'Files of this chat' })
      .getByRole('button', { name: /sales\.html/ })
      .click();

    const frame = page.frameLocator('iframe[title="sales.html"]');
    await expect(frame.locator('body')).toHaveAttribute('data-chart', '4.5.1:2');
    const srcdoc = await page.locator('iframe[title="sales.html"]').getAttribute('srcdoc');
    expect(srcdoc).toContain("script-src 'unsafe-inline' 'unsafe-eval';");
    // No script host in the policy: the library is inline, not loaded.
    expect(srcdoc).not.toMatch(/script-src[^;]*https:/);
    expect(sources.some(url => url.includes('/api/artifact-libraries/chart.js/source'))).toBe(true);
    expect(blocked.filter(url => /cdn|unpkg/.test(url))).toEqual([]);
  });

  test('the embed page markup renders the chart offline', async ({ page }) => {
    const blocked = await blockTheInternet(page);
    await page.setContent(embedLikePage(DASHBOARD));
    const frame = page.frameLocator('iframe[title="artifact"]');
    await expect(frame.locator('body')).toHaveAttribute('data-chart', '4.5.1:2');
    expect(blocked).toEqual([]);
  });
});

test.describe('Library kit: the web-artifacts skill examples run offline', () => {
  const markdown = readFileSync(
    path.join(root, 'server', 'systemSkills', 'web-artifacts', 'references', 'examples.md'),
    'utf8'
  );
  const examples = [...markdown.matchAll(/```html\n([\s\S]*?)\n```/g)].map(match => match[1]);

  const checks = [
    // 1: Chart.js — the chart exists on the canvas.
    async frame => {
      await expect
        .poll(() => frame.evaluate(() => Boolean(window.Chart?.getChart('chart'))))
        .toBe(true);
    },
    // 2: Alpine.js — the result is computed and follows the slider.
    async frame => {
      const monthly = frame.locator('b').first();
      await expect(monthly).toHaveText(/€/);
      const before = await monthly.textContent();
      // A range input cannot be filled: set it the way a drag does.
      await frame.locator('#amount').evaluate(input => {
        input.value = '400000';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(monthly).not.toHaveText(before);
    },
    // 3: plain JavaScript — the rows are there.
    async frame => {
      await expect(frame.locator('tbody tr')).toHaveCount(5);
    },
    // 4: D3 — four steps, and a click shows the detail.
    async frame => {
      await expect(frame.locator('g.node')).toHaveCount(4);
      await frame.locator('g.node').nth(1).click();
      await expect(frame.locator('#panel strong')).toHaveText('Credit check');
    }
  ];

  examples.forEach((example, index) => {
    test(`example ${index + 1} runs without errors and without the network`, async ({ page }) => {
      const blocked = await blockTheInternet(page);
      const errors = [];
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(embedLikePage(example));
      const handle = await page.locator('iframe[title="artifact"]').elementHandle();
      const frame = await handle.contentFrame();
      await checks[index](frame);
      expect(errors).toEqual([]);
      expect(blocked).toEqual([]);
    });
  });
});
