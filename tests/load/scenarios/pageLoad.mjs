// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the SPA fetches when a user opens iHub in a tab (or reloads): auth
 * status, UI/platform config, translations, styles, the app list, the opened
 * app, models and prompts, and the AI-use notice. Run before a session with
 * probability `pageLoadProbability`, so the request mix per user — and with it
 * the rate-limit demand — resembles a browser, not only the chat calls.
 * Requests are fired in parallel like the browser does.
 */

export async function pageLoad(ctx) {
  const { client, config } = ctx;
  const lang = config.language || 'en';
  const paths = [
    ['page.authStatus', '/api/auth/status'],
    ['page.configUi', '/api/configs/ui'],
    ['page.configPlatform', '/api/configs/platform'],
    ['page.translations', `/api/translations/${lang}`],
    ['page.styles', '/api/styles'],
    ['page.apps', '/api/apps'],
    ['page.app', `/api/apps/${encodeURIComponent(config.appId)}`],
    ['page.models', '/api/models'],
    ['page.prompts', '/api/prompts'],
    ['page.aiNotice', '/api/eu-ai-act/acknowledgements/me']
  ];
  await Promise.all(
    paths.map(([name, path]) => client.request('GET', path, { name }).catch(() => null))
  );
}
