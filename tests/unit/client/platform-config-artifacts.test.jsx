// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An HTML artifact's preview loads scripts and stylesheets only from the CDN hosts in
 * `platformConfig.artifacts.scriptHosts` (the preview's CSP is built from them). The real
 * `PlatformConfigProvider` assembles that object by hand from `/api/configs/platform`; when it
 * dropped `artifacts`, the CSP carried no host, so `<script src="https://cdn.jsdelivr.net/…chart.js">`
 * was blocked ("violates … script-src 'unsafe-inline' 'unsafe-eval'") and every chart stayed
 * blank, although the server and the web-artifacts skill allow that CDN. This goes through the
 * real provider and the real preview.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPlatform = { current: {} };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAuthStatus: () => Promise.resolve({ authMode: 'local', authMethods: {} }),
  fetchUIConfig: () => Promise.resolve({}),
  fetchPlatformConfig: () => Promise.resolve(mockPlatform.current),
  invalidateAuthStatusCache: () => {},
  invalidatePlatformConfigCache: () => {},
  invalidateUIConfigCache: () => {}
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code,
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const {
  PlatformConfigProvider
} = require('../../../client/src/shared/contexts/PlatformConfigContext');
const ArtifactPreview =
  require('../../../client/src/features/chat/components/ArtifactPreview').default;

const DASHBOARD = '<!doctype html><html><body><canvas id="c"></canvas></body></html>';
const artifact = { id: 'a1', kind: 'file', mimeType: 'text/html', name: 'stocks.html', bytes: 70 };
const getBlob = () =>
  Promise.resolve({ size: DASHBOARD.length, text: () => Promise.resolve(DASHBOARD) });

const renderPreview = () =>
  render(
    <PlatformConfigProvider>
      <ArtifactPreview artifact={artifact} getBlob={getBlob} viewMode="preview" />
    </PlatformConfigProvider>
  );

/** The `script-src` directive of the CSP the preview iframe was given. */
async function scriptSrcOfPreview() {
  const frame = await screen.findByTitle('stocks.html');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
    frame.getAttribute('srcdoc')
  )[1];
  return csp.split('; ').find(directive => directive.startsWith('script-src'));
}

test('lets the preview load scripts from the CDN hosts the server sends', async () => {
  mockPlatform.current = {
    artifacts: { scriptHosts: ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'] }
  };
  renderPreview();
  await waitFor(async () =>
    expect(await scriptSrcOfPreview()).toBe(
      "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com"
    )
  );
});

test('keeps the preview offline when the admin allows no CDN host', async () => {
  mockPlatform.current = { artifacts: { scriptHosts: [] } };
  renderPreview();
  expect(await scriptSrcOfPreview()).toBe("script-src 'unsafe-inline' 'unsafe-eval'");
});
