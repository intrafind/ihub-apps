// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The library kit in the browser (#3822): an HTML artifact's
 * `<script data-ihub-lib="chart.js">` becomes the library's source in the
 * preview's `srcdoc` (the CSP stays offline) and in a downloaded file, while
 * the Code view keeps the stored markup. With the kit off the marker stays.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetchSource = jest.fn();
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchArtifactLibrarySource: id => mockFetchSource(id)
}));
const mockPlatform = { current: {} };
jest.mock('../../../client/src/shared/contexts/platformConfigContextValue', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: mockPlatform.current })
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  // Escaped like the real highlighter, so markup shows as text.
  highlightCode: code => code.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const ArtifactPreview =
  require('../../../client/src/features/chat/components/ArtifactPreview').default;
const {
  downloadableArtifactBlob,
  resetArtifactLibraryCache,
  withArtifactLibraries
} = require('../../../client/src/features/chat/utils/artifactLibraryKit');

const PAGE =
  '<!doctype html><html><head><script data-ihub-lib="chart.js"></script></head>' +
  '<body><canvas id="c"></canvas><script>new Chart(document.getElementById("c"), {})</script></body></html>';
const artifact = { id: 'a1', kind: 'code', mimeType: 'text/plain', name: 'sales.html', bytes: 1 };
const blobOf = text => ({
  size: text.length,
  type: 'text/plain',
  text: () => Promise.resolve(text)
});

beforeEach(() => {
  resetArtifactLibraryCache();
  mockFetchSource.mockReset();
  mockFetchSource.mockImplementation(id => Promise.resolve(`/* ${id} source */ window.Chart = 1;`));
});

async function srcdocOf(name) {
  const frame = await screen.findByTitle(name);
  return frame.getAttribute('srcdoc');
}

test('inlines the library into the preview, with no CDN in its CSP', async () => {
  mockPlatform.current = { artifacts: { scriptHosts: [], libraryKit: { enabled: true } } };
  render(
    <ArtifactPreview
      artifact={artifact}
      getBlob={() => Promise.resolve(blobOf(PAGE))}
      viewMode="preview"
    />
  );
  await waitFor(async () => expect(await srcdocOf('sales.html')).toContain('chart.js source'));
  const srcdoc = await srcdocOf('sales.html');
  expect(srcdoc).toContain('<script data-ihub-lib-inlined="chart.js@4.5.1">');
  expect(srcdoc).not.toContain('data-ihub-lib="chart.js"');
  expect(srcdoc).toContain("script-src 'unsafe-inline' 'unsafe-eval';");
  expect(mockFetchSource).toHaveBeenCalledWith('chart.js');
});

test('keeps the stored markup in the Code view', async () => {
  mockPlatform.current = { artifacts: { scriptHosts: [], libraryKit: { enabled: true } } };
  const { container } = render(
    <ArtifactPreview
      artifact={artifact}
      getBlob={() => Promise.resolve(blobOf(PAGE))}
      viewMode="code"
    />
  );
  await waitFor(() => expect(container.textContent).toContain('data-ihub-lib="chart.js"'));
  expect(container.textContent).not.toContain('chart.js source');
  expect(container.querySelector('iframe')).toBeNull();
});

test('leaves the marker alone while the kit is off, or the server does not know it', async () => {
  for (const config of [{ artifacts: { libraryKit: { enabled: false } } }, { artifacts: {} }]) {
    mockPlatform.current = config;
    const { unmount } = render(
      <ArtifactPreview
        artifact={artifact}
        getBlob={() => Promise.resolve(blobOf(PAGE))}
        viewMode="preview"
      />
    );
    expect(await srcdocOf('sales.html')).toContain('data-ihub-lib="chart.js"');
    unmount();
  }
  expect(mockFetchSource).not.toHaveBeenCalled();
});

test('a library that cannot be fetched is left out, the page still runs', async () => {
  mockFetchSource.mockImplementation(() => Promise.reject(new Error('offline')));
  const html = await withArtifactLibraries(PAGE, { enabled: true });
  expect(html).not.toContain('data-ihub-lib');
  expect(html).toContain('new Chart');
});

test('an empty source is not kept: the next preview fetches it again', async () => {
  mockFetchSource.mockImplementationOnce(() => Promise.resolve(''));
  const first = await withArtifactLibraries(PAGE, { enabled: true });
  expect(first).not.toContain('chart.js source');
  const second = await withArtifactLibraries(PAGE, { enabled: true });
  expect(second).toContain('chart.js source');
  expect(mockFetchSource).toHaveBeenCalledTimes(2);
});

test('fetches each library once per page', async () => {
  await withArtifactLibraries(PAGE, { enabled: true });
  await withArtifactLibraries(PAGE, { enabled: true });
  expect(mockFetchSource).toHaveBeenCalledTimes(1);
});

describe('downloads', () => {
  // jsdom's Blob has no text(): read the result the way old browsers did.
  const read = blob =>
    new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });

  test('an .html file leaves with the library inlined', async () => {
    const saved = await downloadableArtifactBlob(blobOf(PAGE), 'sales.html', { enabled: true });
    const text = await read(saved);
    expect(text).toContain('chart.js source');
    expect(text).not.toContain('data-ihub-lib="');
  });

  test('other files, files without a marker and an off kit keep their blob', async () => {
    const md = blobOf(PAGE);
    expect(await downloadableArtifactBlob(md, 'notes.md', { enabled: true })).toBe(md);
    const plain = blobOf('<p>hi</p>');
    expect(await downloadableArtifactBlob(plain, 'p.html', { enabled: true })).toBe(plain);
    const off = blobOf(PAGE);
    expect(await downloadableArtifactBlob(off, 'sales.html', { enabled: false })).toBe(off);
  });

  test('a name cut after ".html " still counts as HTML', async () => {
    const saved = await downloadableArtifactBlob(blobOf(PAGE), 'sales.html ', { enabled: true });
    expect(await read(saved)).toContain('chart.js source');
  });

  test('is refused, not handed over half done, when a library cannot be fetched', async () => {
    mockFetchSource.mockImplementation(() => Promise.reject(new Error('offline')));
    await expect(
      downloadableArtifactBlob(blobOf(PAGE), 'sales.html', { enabled: true })
    ).rejects.toMatchObject({ code: 'library-unavailable', missing: ['chart.js'] });
  });
});

test('shows the Code view at once while the libraries are still on their way', async () => {
  let release;
  mockFetchSource.mockImplementation(
    () => new Promise(resolve => (release = () => resolve('/* chart.js source */')))
  );
  mockPlatform.current = { artifacts: { scriptHosts: [], libraryKit: { enabled: true } } };
  const { container, rerender } = render(
    <ArtifactPreview
      artifact={artifact}
      getBlob={() => Promise.resolve(blobOf(PAGE))}
      viewMode="code"
    />
  );
  await waitFor(() => expect(container.textContent).toContain('data-ihub-lib="chart.js"'));
  // The preview waits for the kit instead of running the page without its library.
  rerender(
    <ArtifactPreview
      artifact={artifact}
      getBlob={() => Promise.resolve(blobOf(PAGE))}
      viewMode="preview"
    />
  );
  expect(screen.queryByTitle('sales.html')).toBeNull();
  release();
  await waitFor(async () => expect(await srcdocOf('sales.html')).toContain('chart.js source'));
});
