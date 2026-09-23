/**
 * Unit tests for WebVTT and "any text file" (text/*) uploads.
 *
 *   - `.vtt` (Microsoft Teams transcripts) is accepted like any other listed
 *     text format and read as plain text
 *   - `text/*` in `fileUpload.supportedFormats` leaves the picker unfiltered,
 *     accepts text files of unknown type/extension, and rejects binary files
 *   - without `text/*`, unlisted formats are still rejected
 *   - `text/*` never unlocks a format-specific extractor the admin did not
 *     enable — an unlisted .docx is read as text and refused as binary
 */

import '@testing-library/jest-dom';
import { render, fireEvent, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key)
  })
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const {
  processGenericTextFile,
  getExtensionDisplay
} = require('../../../client/src/features/upload/utils/fileProcessing');

const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Alice>Hello team</v>\n';

function renderUploader(supportedFormats) {
  const onFileSelect = jest.fn();
  const utils = render(
    <UnifiedUploader
      onFileSelect={onFileSelect}
      config={{
        imageUploadEnabled: false,
        audioUploadEnabled: false,
        videoUploadEnabled: false,
        fileUpload: { enabled: true, supportedFormats }
      }}
    >
      <div />
    </UnifiedUploader>
  );
  const input = utils.container.querySelector('input[type="file"]');
  const upload = file => fireEvent.change(input, { target: { files: [file] } });
  return { ...utils, input, upload, onFileSelect };
}

describe('WebVTT uploads', () => {
  it('accepts a .vtt transcript and passes its text through', async () => {
    const { upload, onFileSelect, input } = renderUploader(['text/plain', 'text/vtt']);
    expect(input.getAttribute('accept')).toContain('.vtt');

    upload(new File([VTT], 'meeting.vtt', { type: 'text/vtt' }));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data.content).toBe(VTT);
    expect(data.displayType).toBe('VTT');
  });

  it('accepts a .vtt reported without a MIME type via its extension', async () => {
    const { upload, onFileSelect } = renderUploader(['text/vtt']);
    upload(new File([VTT], 'meeting.vtt', { type: '' }));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(onFileSelect.mock.calls[0][0].content).toBe(VTT);
  });
});

describe('"any text file" uploads', () => {
  it('rejects an unlisted text format when text/* is not allowed', async () => {
    const { upload, onFileSelect, findByText } = renderUploader(['text/plain']);
    upload(new File(['key: value\n'], 'config.yaml', { type: '' }));
    expect(await findByText(/Unsupported file format/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('leaves the picker unfiltered and accepts text of unknown type', async () => {
    const { upload, onFileSelect, input } = renderUploader(['text/plain', 'text/*']);
    expect(input.hasAttribute('accept')).toBe(false);

    upload(new File(['2026-09-23 INFO started\n'], 'server.log', { type: '' }));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data.content).toBe('2026-09-23 INFO started\n');
    expect(data.displayType).toBe('LOG');
    expect(data.fileType).toBe('text/plain');
  });

  it('refuses binary content', async () => {
    const { upload, onFileSelect, findByText } = renderUploader(['text/*']);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]);
    upload(new File([bytes], 'image.bin', { type: 'application/octet-stream' }));
    expect(await findByText(/Unsupported file format/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('does not run the DOCX extractor for an unlisted .docx', async () => {
    const { upload, onFileSelect, findByText } = renderUploader(['text/*']);
    // A ZIP local-file header, as every .docx starts with one.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    upload(
      new File([bytes], 'report.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      })
    );
    expect(await findByText(/Unsupported file format/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('processGenericTextFile returns text and rejects binary', async () => {
    await expect(processGenericTextFile(new File(['plain'], 'a.txt'))).resolves.toEqual({
      content: 'plain'
    });
    await expect(
      processGenericTextFile(new File([new Uint8Array([0, 1, 2])], 'a.bin'))
    ).rejects.toThrow('unsupported-format');
  });

  it('getExtensionDisplay upper-cases the extension', () => {
    expect(getExtensionDisplay('notes.yaml')).toBe('YAML');
    expect(getExtensionDisplay('Makefile')).toBe('TXT');
    expect(getExtensionDisplay('.env')).toBe('TXT');
  });
});
