/**
 * Upload size limits are per file type.
 *
 * The Uploader let every file in against one limit, the largest of all types.
 * With a video limit of 50 GB that would be the limit of every document and
 * image, so each file is now held to the limit of its own type, and the message
 * names that limit. The largest limit stays the gate in front of that.
 */

import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

// The real text, interpolation included
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
  extractAudioFromVideo: jest.fn(),
  processDocumentFile: jest.fn(),
  processImageFile: jest.fn()
}));

// The format picker loads the platform's MIME type list from the API; it is not under test.
jest.mock('../../../client/src/features/admin/components/MimeTypeSelector', () => () => null);

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const TranscriptionSection =
  require('../../../client/src/features/admin/components/app-form/TranscriptionSection').default;
const UploadConfigSection =
  require('../../../client/src/features/admin/components/app-form/UploadConfigSection').default;
const fileProcessing = require('../../../client/src/features/upload/utils/fileProcessing');

const { extractAudioFromVideo, processDocumentFile, processImageFile } = fileProcessing;

const MB = 1024 * 1024;
const GB = 1024 * MB;

const WAV = {
  base64: 'data:audio/wav;base64,AAAA',
  blob: new Blob(['wav'], { type: 'audio/wav' }),
  format: 'audio/wav',
  sampleRate: 16000,
  channels: 1,
  duration: 2,
  size: 3
};

// A file that says it is `bytes` large without being so
const sized = (name, type, bytes) => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
};

const config = (extra = {}) => ({
  imageUpload: {
    enabled: true,
    resizeImages: false,
    supportedFormats: ['image/png'],
    maxFileSizeMB: 2
  },
  audioUpload: { enabled: true, supportedFormats: ['audio/wav'], maxFileSizeMB: 20 },
  videoUpload: {
    enabled: true,
    extractAudio: true,
    supportedFormats: ['video/mp4', 'video/webm'],
    maxFileSizeMB: 51200
  },
  fileUpload: { enabled: true, supportedFormats: ['text/plain'], maxFileSizeMB: 1 },
  ...extra
});

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

function renderUploader(uploadConfig = config()) {
  const onFileSelect = jest.fn();
  const utils = render(<Harness onFileSelect={onFileSelect} config={uploadConfig} />);
  const input = utils.container.querySelector('input[type="file"]');
  return {
    ...utils,
    onFileSelect,
    upload: file => fireEvent.change(input, { target: { files: [file] } })
  };
}

beforeEach(() => {
  extractAudioFromVideo.mockReset();
  extractAudioFromVideo.mockResolvedValue(WAV);
  processDocumentFile.mockReset();
  processDocumentFile.mockResolvedValue({ content: 'text', pageImages: undefined });
  processImageFile.mockReset();
  processImageFile.mockResolvedValue({
    preview: { type: 'image', url: 'data:image/png;base64,AA', fileName: 'a.png' },
    data: { type: 'image', base64: 'data:image/png;base64,AA', fileName: 'a.png' }
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('each file is held to the limit of its type', () => {
  test('a document over the document limit is refused, whatever the video limit is', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(sized('notes.txt', 'text/plain', 1.5 * MB));

    expect(await screen.findByText('File too large. Maximum size is 1MB.')).toBeInTheDocument();
    expect(processDocumentFile).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('a document within its limit is taken', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(sized('notes.txt', 'text/plain', 0.9 * MB));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(processDocumentFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/File too large/)).not.toBeInTheDocument();
  });

  test('an image over the image limit is refused with the image limit', async () => {
    const { upload } = renderUploader();

    upload(sized('photo.png', 'image/png', 3 * MB));

    expect(await screen.findByText('File too large. Maximum size is 2MB.')).toBeInTheDocument();
    expect(processImageFile).not.toHaveBeenCalled();
  });

  test('audio over the audio limit is refused with the audio limit', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(sized('talk.wav', 'audio/wav', 30 * MB));

    expect(await screen.findByText('File too large. Maximum size is 20MB.')).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('a video of 3 GB is taken, its limit being 50 GB', async () => {
    const { upload, onFileSelect } = renderUploader();
    const video = sized('keynote.mp4', 'video/mp4', 3 * GB);

    upload(video);

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(extractAudioFromVideo).toHaveBeenCalledWith(video, expect.any(Object));
    expect(screen.queryByText(/File too large/)).not.toBeInTheDocument();
  });

  test('a video over its own limit is refused with it', async () => {
    const small = config({
      videoUpload: {
        enabled: true,
        extractAudio: true,
        supportedFormats: ['video/mp4'],
        maxFileSizeMB: 100
      },
      fileUpload: { enabled: true, supportedFormats: ['text/plain'], maxFileSizeMB: 100 }
    });
    const { upload } = renderUploader({ ...small, maxFileSizeMB: undefined });

    upload(sized('keynote.mp4', 'video/mp4', 150 * MB));

    expect(await screen.findByText('File too large. Maximum size is 100MB.')).toBeInTheDocument();
    expect(extractAudioFromVideo).not.toHaveBeenCalled();
  });

  test('a file over the largest limit is stopped at the gate, with that limit', async () => {
    const { upload } = renderUploader();

    upload(sized('huge.mp4', 'video/mp4', 60 * GB));

    expect(await screen.findByText('File too large. Maximum size is 51200MB.')).toBeInTheDocument();
    expect(extractAudioFromVideo).not.toHaveBeenCalled();
  });

  test('the message of the gate does not keep the limit of an earlier refusal', async () => {
    const { upload } = renderUploader();

    upload(sized('notes.txt', 'text/plain', 5 * MB));
    expect(await screen.findByText('File too large. Maximum size is 1MB.')).toBeInTheDocument();

    upload(sized('huge.mp4', 'video/mp4', 60 * GB));
    expect(await screen.findByText('File too large. Maximum size is 51200MB.')).toBeInTheDocument();
    expect(screen.queryByText('File too large. Maximum size is 1MB.')).not.toBeInTheDocument();
  });

  test('a type without a limit of its own is held to the overall one, as before', async () => {
    const { upload, onFileSelect } = renderUploader({
      maxFileSizeMB: 10,
      fileUpload: { enabled: true, supportedFormats: ['text/plain'] }
    });

    upload(sized('notes.txt', 'text/plain', 8 * MB));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
  });
});

describe('videos that are not turned into audio', () => {
  const noExtraction = () =>
    config({
      videoUpload: {
        enabled: true,
        extractAudio: false,
        supportedFormats: ['video/mp4'],
        maxFileSizeMB: 51200
      }
    });

  test('are refused beyond what can be read into memory, without reading them', async () => {
    const readers = jest.spyOn(window, 'FileReader');
    const { upload, onFileSelect } = renderUploader(noExtraction());

    upload(sized('keynote.mp4', 'video/mp4', 3 * GB));

    expect(await screen.findByText(/too large to be attached as it is/)).toBeInTheDocument();
    expect(screen.getByText(/Turn on audio extraction/)).toBeInTheDocument();
    expect(readers).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('are taken below that', async () => {
    const { upload, onFileSelect } = renderUploader(noExtraction());

    upload(new File(['tiny video'], 'clip.mp4', { type: 'video/mp4' }));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(onFileSelect.mock.calls[0][0]).toMatchObject({ type: 'video', fileName: 'clip.mp4' });
  });
});

describe('the messages of the extraction errors', () => {
  test.each([
    [
      'video-unsupported-large-container',
      'Videos larger than 2 GB are supported as MP4 or MOV. Convert this video to MP4 or MOV, or use a smaller file.'
    ],
    [
      'video-large-audio-unsupported',
      'The audio of this large video could not be read. Videos larger than 2 GB need AAC or uncompressed (PCM) audio in an MP4 or MOV file, and a browser that can play that audio.'
    ]
  ])('%s is explained', async (code, message) => {
    extractAudioFromVideo.mockRejectedValue(new Error(code));
    const { upload } = renderUploader();

    upload(sized('keynote.webm', 'video/webm', 3 * GB));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  test('both languages have the new texts', () => {
    const en = require('../../../shared/i18n/en.json');
    const de = require('../../../shared/i18n/de.json');
    for (const key of [
      'videoUnsupportedLargeContainer',
      'videoLargeAudioUnsupported',
      'videoTooLargeToAttach'
    ]) {
      expect(typeof en.errors[key]).toBe('string');
      expect(typeof de.errors[key]).toBe('string');
      expect(de.errors[key]).not.toBe(en.errors[key]);
    }
    expect(en.errors.fileTooLarge).toContain('{{maxSize}}');
    expect(de.errors.fileTooLarge).toContain('{{maxSize}}');
    expect(en.admin.apps.edit.maxVideoSizeHelp).toContain('51200');
    expect(de.admin.apps.edit.maxVideoSizeHelp).toContain('51200');
  });
});

describe('the app editor', () => {
  const renderSection = upload => {
    const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
    return render(
      <UploadConfigSection
        app={{ upload: { enabled: true, ...upload } }}
        onChange={() => {}}
        t={t}
        parseNumberOrUndefined={value => Number(value)}
      />
    );
  };

  test('lets a video be up to 50 GB and says what that depends on', () => {
    const { container } = renderSection({ videoUpload: { enabled: true } });

    const size = container.querySelector('input[type="number"]');
    expect(size).toHaveAttribute('max', '51200');
    expect(size).toHaveValue(50);
    expect(screen.getByText(/Up to 51200 MB \(50 GB\)/)).toBeInTheDocument();
    expect(screen.getByText(/Each file type has its own limit/)).toBeInTheDocument();
  });

  test('keeps the bounds of the other types', () => {
    const bounds = {
      audioUpload: '2000',
      imageUpload: '50',
      fileUpload: '100'
    };
    for (const [type, max] of Object.entries(bounds)) {
      const { container, unmount } = renderSection({ [type]: { enabled: true } });
      expect(container.querySelector('input[type="number"]')).toHaveAttribute('max', max);
      expect(screen.queryByText(/Up to 51200 MB/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('the transcription length in the app editor', () => {
  const renderTranscription = transcription => {
    const onChange = jest.fn();
    const utils = render(
      <TranscriptionSection
        app={{ transcription: { enabled: true, ...transcription } }}
        onChange={onChange}
        t={(key, fallback) => (typeof fallback === 'string' ? fallback : key)}
        currentLanguage="en"
        transcriptionModels={[]}
        parseNumberOrUndefined={value => Number(value)}
      />
    );
    return { ...utils, onChange, length: utils.container.querySelector('input[max="7200"]') };
  };

  test('is an hour for an app that does not set it', () => {
    const { length, onChange } = renderTranscription({});
    expect(length).toHaveValue(3600);
    // Showing the default does not write it into the app
    expect(onChange).not.toHaveBeenCalled();
  });

  test('is what the app set', () => {
    expect(renderTranscription({ maxDurationSeconds: 900 }).length).toHaveValue(900);
  });
});
