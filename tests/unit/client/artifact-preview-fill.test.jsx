// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ArtifactPreview sizes (#3184): in `panel` mode it is the framed card of the
 * Files drawer; in `fill` mode its parent decides, and there is no frame.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      String(typeof defaultValue === 'string' ? defaultValue : key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name) => String(options?.[name] ?? '')
      )
  })
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code.replace(/</g, '&lt;'),
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({
  sanitizeMermaidSvg: svg => svg
}));

const ArtifactPreview =
  require('../../../client/src/features/chat/components/ArtifactPreview').default;

if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = jest.fn(() => 'blob:mock');
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = jest.fn();

const blobOf = text => {
  const blob = new Blob([text]);
  blob.text = async () => text;
  return blob;
};
const html = { id: 'h', name: 'page.html', kind: 'code', mimeType: 'text/html' };
const csv = { id: 'c', name: 'data.csv', kind: 'document', mimeType: 'text/csv' };
const png = { id: 'p', name: 'pic.png', kind: 'image', mimeType: 'image/png' };
const svg = { id: 's', name: 'shape.svg', kind: 'code', mimeType: 'text/plain' };
const getBlob = jest.fn(async () => blobOf('<p>x</p>'));

describe('ArtifactPreview sizing', () => {
  it('panel mode keeps its fixed share of the window and its frame', async () => {
    render(<ArtifactPreview artifact={html} getBlob={getBlob} />);
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe');
      expect(el).not.toBeNull();
      return el;
    });
    expect(frame.className).toContain('h-[65vh]');
    expect(frame.className).toContain('rounded-md');
    expect(screen.queryByTestId('artifact-preview-fill')).not.toBeInTheDocument();
    // The mode toggle of its own.
    expect(screen.getByRole('group', { name: 'Preview mode' })).toBeInTheDocument();
  });

  it('fill mode takes what its parent gives: no fixed height, frame or rounding', async () => {
    render(<ArtifactPreview artifact={html} getBlob={getBlob} mode="fill" />);
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe');
      expect(el).not.toBeNull();
      return el;
    });
    expect(frame.className).toContain('flex-1');
    expect(frame.className).toContain('border-0');
    expect(frame.className).not.toContain('h-[65vh]');
    expect(frame.className).not.toContain('rounded');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const root = screen.getByTestId('artifact-preview-fill');
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('w-full');
    expect(root).toHaveAttribute('data-artifact-type', 'html');
  });

  it('fill mode with a controlled view mode draws no toggle of its own', async () => {
    const onViewModeChange = jest.fn();
    const { rerender } = render(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        mode="fill"
        viewMode="preview"
        onViewModeChange={onViewModeChange}
      />
    );
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(screen.queryByRole('group', { name: 'Preview mode' })).not.toBeInTheDocument();

    rerender(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        mode="fill"
        viewMode="code"
        onViewModeChange={onViewModeChange}
      />
    );
    expect(await screen.findByLabelText('Content of page.html')).toHaveTextContent('<p>x</p>');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('panel mode owns its toggle when uncontrolled', async () => {
    render(<ArtifactPreview artifact={html} getBlob={getBlob} />);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(await screen.findByLabelText('Content of page.html')).toBeInTheDocument();
  });

  it('fill mode centres a picture, contained, with no frame', async () => {
    render(<ArtifactPreview artifact={png} getBlob={getBlob} mode="fill" />);
    const img = await screen.findByRole('img', { name: 'pic.png' });
    expect(img.className).toContain('object-contain');
    expect(img.className).toContain('max-h-full');
    expect(img.className).not.toContain('rounded');
  });

  it('fill mode scales an SVG to fit and scrolls a table', async () => {
    const { unmount } = render(<ArtifactPreview artifact={svg} getBlob={getBlob} mode="fill" />);
    await waitFor(() => expect(screen.getByTestId('artifact-preview-fill')).toBeInTheDocument());
    const holder = await waitFor(() => {
      const el = document.querySelector('[class*="max-h-full"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(holder.className).toContain('items-center');
    unmount();

    getBlob.mockResolvedValueOnce(blobOf('a,b\n1,2'));
    render(<ArtifactPreview artifact={csv} getBlob={getBlob} mode="fill" />);
    const table = await screen.findByRole('table');
    expect(table.parentElement.className).toContain('overflow-auto');
    expect(table.parentElement.className).toContain('flex-1');
  });
});
