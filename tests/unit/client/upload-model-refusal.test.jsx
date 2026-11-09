// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An image or a sound file the selected model cannot take is refused as that, so the user picks
 * another model; a type the app does not offer at all gets the generic answer that lists the
 * formats it does accept.
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
jest.mock('../../../client/src/features/admin/components/MimeTypeSelector', () => () => null);
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const { capabilityRefusal } = require('../../../client/src/features/upload/utils/uploadGate');
const fileProcessing = require('../../../client/src/features/upload/utils/fileProcessing');
const { useFileUploadHandler } = require('../../../client/src/shared/hooks/useFileUploadHandler');

const { processDocumentFile, processImageFile } = fileProcessing;

const textOnlyModel = { id: 'text-only', supportsVision: false, supportsAudio: false };
const richModel = { id: 'rich', supportsVision: true, supportsAudio: true };
const transcriptionModel = { id: 'whisper', modelType: 'transcription' };

const appWith = (upload = {}) => ({
  upload: {
    enabled: true,
    imageUpload: { enabled: true },
    audioUpload: { enabled: true },
    fileUpload: { enabled: true, supportedFormats: ['text/plain'] },
    ...upload
  }
});

/** The config the page hands the uploader for this app and model. */
function configFor(app, model) {
  const { result } = renderHook(() => useFileUploadHandler());
  return result.current.createUploadConfig(app, model);
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

function renderUploader(app, model) {
  const onFileSelect = jest.fn();
  const utils = render(<Harness onFileSelect={onFileSelect} config={configFor(app, model)} />);
  const input = utils.container.querySelector('input[type="file"]');
  return {
    onFileSelect,
    upload: file => fireEvent.change(input, { target: { files: [file] } })
  };
}

const PNG = () => new File(['png'], 'photo.png', { type: 'image/png' });
const WAV = () => new File(['wav'], 'memo.wav', { type: 'audio/wav' });

beforeEach(() => {
  processDocumentFile.mockReset();
  // What the real extractor does with a type it cannot read
  processDocumentFile.mockRejectedValue(new Error('unsupported-format'));
  processImageFile.mockReset();
  processImageFile.mockResolvedValue({
    preview: { type: 'image', url: 'data:image/png;base64,AA', fileName: 'photo.png' },
    data: { type: 'image', base64: 'data:image/png;base64,AA', fileName: 'photo.png' }
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createUploadConfig says why a kind is off', () => {
  test('the app allows images and sound and the model takes neither: blocked by the model', () => {
    const config = configFor(appWith(), textOnlyModel);
    expect(config.imageUpload).toMatchObject({ enabled: false, blockedByModel: true });
    expect(config.audioUpload).toMatchObject({ enabled: false, blockedByModel: true });
  });

  test('a model that takes both: nothing is blocked', () => {
    const config = configFor(appWith(), richModel);
    expect(config.imageUpload).toMatchObject({ enabled: true, blockedByModel: false });
    expect(config.audioUpload).toMatchObject({ enabled: true, blockedByModel: false });
  });

  test('the app switches images off itself: not down to the model', () => {
    const config = configFor(appWith({ imageUpload: { enabled: false } }), richModel);
    expect(config.imageUpload).toMatchObject({ enabled: false, blockedByModel: false });
  });

  test('a transcription model takes audio only: images are blocked by the model', () => {
    const config = configFor(appWith(), transcriptionModel);
    expect(config.imageUpload).toMatchObject({ enabled: false, blockedByModel: true });
    expect(config.audioUpload).toMatchObject({ enabled: true, blockedByModel: false });
  });
});

describe('capabilityRefusal', () => {
  const kind = extra => ({
    enabled: false,
    blockedByModel: true,
    offered: ['image/png'],
    ...extra
  });
  const listed = formats => formats.includes('image/png');

  test('refuses a file of a kind the model blocks and the app offers', () => {
    expect(capabilityRefusal(listed, { image: kind() })).toBe('image-upload-disabled');
  });

  test('says nothing when the kind is enabled, when the app does not offer it, or the file is not of it', () => {
    expect(capabilityRefusal(listed, { image: kind({ enabled: true }) })).toBeNull();
    expect(capabilityRefusal(listed, { image: kind({ blockedByModel: false }) })).toBeNull();
    expect(capabilityRefusal(listed, { image: kind({ blockedByModel: undefined }) })).toBeNull();
    expect(capabilityRefusal(listed, { image: kind({ offered: ['image/gif'] }) })).toBeNull();
    expect(capabilityRefusal(listed, {})).toBeNull();
  });

  test('names the kind of the file', () => {
    const audio = formats => formats.includes('audio/wav');
    expect(
      capabilityRefusal(audio, {
        image: kind(),
        audio: kind({ offered: ['audio/wav'] })
      })
    ).toBe('audio-upload-disabled');
  });
});

describe('the uploader on a model that cannot take the file', () => {
  test('an image on a model without vision is refused because of the model', async () => {
    const { upload, onFileSelect } = renderUploader(appWith(), textOnlyModel);
    upload(PNG());
    expect(
      await screen.findByText(/Image upload is not supported by the selected model/)
    ).toBeVisible();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('a sound file on a model without audio is refused because of the model', async () => {
    const { upload, onFileSelect } = renderUploader(appWith(), textOnlyModel);
    upload(WAV());
    expect(
      await screen.findByText(/Audio upload is not supported by the selected model/)
    ).toBeVisible();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('a model that takes images accepts one', async () => {
    const { upload, onFileSelect } = renderUploader(appWith(), richModel);
    upload(PNG());
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(screen.queryByText(/not supported by the selected model/)).not.toBeInTheDocument();
  });

  test('an app that does not offer images gets the generic answer, not the model blamed', async () => {
    const { upload, onFileSelect } = renderUploader(
      appWith({ imageUpload: { enabled: false } }),
      richModel
    );
    upload(PNG());
    expect(await screen.findByText(/Unsupported file format/)).toBeVisible();
    expect(screen.queryByText(/not supported by the selected model/)).not.toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});
