// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The composer with text recognition switched on for the app's chats (#3986): an attached image
 * becomes a document that carries the file for the server, which recognizes its text — also in an
 * app without image upload and with a model without vision. Without it, an image goes the picture
 * path as before. The file chip says what happened, and why an image was not sent.
 */

import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return text.replace(/{{(\w+)}}/g, (_, name) => values[name] ?? '');
    }
  })
}));
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  ...jest.requireActual('../../../client/src/features/upload/utils/fileProcessing'),
  processDocumentFile: jest.fn(),
  processImageFile: jest.fn()
}));
jest.mock('../../../client/src/shared/components/Icon', () => () => null);
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const AttachedFilesList =
  require('../../../client/src/features/upload/components/AttachedFilesList').default;
const fileProcessing = require('../../../client/src/features/upload/utils/fileProcessing');
const { useFileUploadHandler } = require('../../../client/src/shared/hooks/useFileUploadHandler');
const { ORIGINAL_FILE } = require('../../../client/src/features/chat/utils/chatFileUpload');

const { processDocumentFile, processImageFile } = fileProcessing;

const textOnlyModel = { id: 'text-only', supportsVision: false };
const visionModel = { id: 'vision', supportsVision: true };
const transcriptionModel = { id: 'whisper', modelType: 'transcription' };

const docsApp = { upload: { enabled: true, fileUpload: { enabled: true } } };
const visionApp = {
  upload: { enabled: true, imageUpload: { enabled: true }, fileUpload: { enabled: true } }
};

function configFor(app, model, options) {
  const { result } = renderHook(() => useFileUploadHandler());
  return result.current.createUploadConfig(app, model, options);
}

function Harness({ onFileSelect, ...props }) {
  const [selected, setSelected] = useState(null);
  return (
    <UnifiedUploader
      {...props}
      fileData={selected}
      onFileSelect={data => {
        setSelected(data);
        onFileSelect(data);
      }}
    >
      <div />
    </UnifiedUploader>
  );
}

function renderUploader(config) {
  const onFileSelect = jest.fn();
  const utils = render(<Harness onFileSelect={onFileSelect} config={config} />);
  const input = utils.container.querySelector('input[type="file"]');
  return {
    input,
    onFileSelect,
    upload: file => fireEvent.change(input, { target: { files: [file] } })
  };
}

const PNG = () => new File(['png'], 'scan.png', { type: 'image/png' });

beforeEach(() => {
  processDocumentFile.mockReset();
  processDocumentFile.mockRejectedValue(new Error('unsupported-format'));
  processImageFile.mockReset();
  processImageFile.mockResolvedValue({
    preview: { type: 'image', url: 'data:image/png;base64,AA', fileName: 'scan.png' },
    data: { type: 'image', base64: 'data:image/png;base64,AA', fileName: 'scan.png' }
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createUploadConfig with text recognition', () => {
  test('takes images as documents in an app without image upload, on a model without vision', () => {
    const config = configFor(docsApp, textOnlyModel, { recognizeImages: true });
    expect(config.textRecognition).toMatchObject({ images: true });
    expect(config.textRecognition.formats).toEqual(
      expect.arrayContaining(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    );
  });

  test('is off unless the chat asks for it, and for a transcription model', () => {
    expect(configFor(docsApp, textOnlyModel).textRecognition).toMatchObject({
      images: false,
      formats: []
    });
    expect(
      configFor(docsApp, transcriptionModel, { recognizeImages: true }).textRecognition.images
    ).toBe(false);
  });
});

describe('the uploader routes an image', () => {
  test('to the server as a document when the chat recognizes text', async () => {
    const { upload, onFileSelect, input } = renderUploader(
      configFor(docsApp, textOnlyModel, { recognizeImages: true })
    );
    expect(input.getAttribute('accept')).toContain('image/png');
    const file = PNG();
    upload(file);
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const entry = [onFileSelect.mock.calls.at(-1)[0]].flat()[0];
    expect(entry).toMatchObject({
      type: 'document',
      fileName: 'scan.png',
      fileType: 'image/png',
      displayType: 'PNG',
      content: '',
      recognizeOnUpload: true
    });
    expect(entry[ORIGINAL_FILE]).toBe(file);
    expect(processImageFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/not supported by the selected model/)).not.toBeInTheDocument();
  });

  test('also when the app has image upload and the model has vision', async () => {
    const { upload, onFileSelect } = renderUploader(
      configFor(visionApp, visionModel, { recognizeImages: true })
    );
    upload(PNG());
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect([onFileSelect.mock.calls.at(-1)[0]].flat()[0]).toMatchObject({
      type: 'document',
      recognizeOnUpload: true
    });
    expect(processImageFile).not.toHaveBeenCalled();
  });

  test('as a picture, as before, when the chat does not recognize text', async () => {
    const { upload, onFileSelect } = renderUploader(configFor(visionApp, visionModel));
    upload(PNG());
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(processImageFile).toHaveBeenCalled();
    expect([onFileSelect.mock.calls.at(-1)[0]].flat()[0]).toMatchObject({ type: 'image' });
  });

  test('not at all in an app without image upload when the chat does not recognize text', () => {
    const { input } = renderUploader(configFor(docsApp, textOnlyModel));
    expect(input.getAttribute('accept') || '').not.toContain('image/png');
  });
});

describe('the file chip', () => {
  const pending = {
    type: 'document',
    fileName: 'scan.png',
    fileSize: 3,
    content: '',
    recognizeOnUpload: true
  };

  test('says the text is on its way, then what was recognized, with the model in the tooltip', () => {
    const { rerender } = render(
      <AttachedFilesList
        files={[{ ...pending, uploadState: 'uploading' }]}
        onRemoveFile={jest.fn()}
      />
    );
    expect(screen.getByTestId('attached-file-content')).toHaveTextContent(
      'Its text is recognized when it is saved to the chat'
    );
    rerender(
      <AttachedFilesList
        files={[
          {
            ...pending,
            uploadState: 'done',
            fileId: 'f1',
            serverStored: true,
            recognized: { modelId: 'vision-1', pages: 1 }
          }
        ]}
        onRemoveFile={jest.fn()}
      />
    );
    const line = screen.getByTestId('attached-file-content');
    expect(line).toHaveTextContent('Text recognized from 1 page(s)');
    expect(line).toHaveAttribute('title', 'Recognized by vision-1');
  });

  test('says an image whose text could not be recognized is not sent', () => {
    render(
      <AttachedFilesList
        files={[{ ...pending, uploadState: 'error', uploadError: 'OCR_NO_TEXT' }]}
        onRemoveFile={jest.fn()}
      />
    );
    expect(screen.getByTestId('attached-file-upload-error')).toHaveTextContent(
      'No text was found in this image; it is not sent'
    );
  });

  test('keeps the "sent with the message" wording for a scanned PDF the server could not read', () => {
    render(
      <AttachedFilesList
        files={[
          {
            type: 'document',
            fileName: 'scan.pdf',
            fileSize: 3,
            content: '',
            pageImages: ['data:image/png;base64,AA'],
            uploadState: 'error',
            uploadError: 'OCR_FAILED'
          }
        ]}
        onRemoveFile={jest.fn()}
      />
    );
    expect(screen.getByTestId('attached-file-upload-error')).toHaveTextContent(
      'The text of the scanned pages could not be recognized; the file is sent with the message only'
    );
  });
});
