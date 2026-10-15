/**
 * Audio uploads whose MIME type differs from the one the configuration lists (#2834).
 *
 * QuickTime's "Export As → Audio Only" writes an `.m4a` (AAC in an MP4 container). Chrome and
 * Safari on macOS report it as `audio/x-m4a`, other setups as `audio/m4a` or no type at all —
 * the formats an app lists say `audio/mp4`. The uploader accepted the file through its extension
 * fallback, but routed it by exact MIME type, so it fell through to document processing and was
 * refused as binary ("Unsupported file format") although MP4 is listed.
 *
 *   - `canonicalMimeType` maps aliases and empty/generic types (via the file extension) to the
 *     configured type, and leaves everything else alone
 *   - the uploaders route, store and send such files under the canonical type
 */

import '@testing-library/jest-dom';
import { render, fireEvent, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest. `mockServerConfig` switches between the
// shipped mimetypes config and a failed load (the built-in defaults).
let mockServerConfig = null;
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    if (mockServerConfig) return mockServerConfig;
    throw new Error('offline');
  }),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key)
  })
}));

// Records what the uploader hands to its render prop (the attachment preview is not rendered
// anywhere else).
let mockLastPreview = null;
jest.mock('../../../client/src/features/upload/components/Uploader', () => {
  const React = require('react');
  const Actual = jest.requireActual(
    '../../../client/src/features/upload/components/Uploader'
  ).default;
  return {
    __esModule: true,
    default: props =>
      React.createElement(Actual, {
        ...props,
        children: api => {
          mockLastPreview = api.preview;
          return props.children(api);
        }
      })
  };
});

const shippedMimeTypes = require('../../../server/defaults/config/mimetypes.json');
const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const {
  processCloudFile,
  isCloudFileSupported
} = require('../../../client/src/features/upload/utils/cloudFileProcessing');

// The `ftyp` box every MP4/M4A file starts with; its NUL bytes make it binary to a text reader.
const M4A_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00
]);

const m4a = (name, type) => new File([M4A_BYTES], name, { type });

// A fresh fileProcessing module with the given server config (null: the load fails and the
// built-in defaults apply).
const loadFileProcessing = async serverConfig => {
  mockServerConfig = serverConfig;
  let module;
  jest.isolateModules(() => {
    module = require('../../../client/src/features/upload/utils/fileProcessing');
  });
  await module.loadMimetypesConfig();
  return module;
};

describe.each([
  ['the shipped mimetypes config', shippedMimeTypes],
  ['the built-in defaults', null]
])('canonicalMimeType with %s', (_label, serverConfig) => {
  let canonicalMimeType;
  beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ({ canonicalMimeType } = await loadFileProcessing(serverConfig));
  });
  afterAll(() => jest.restoreAllMocks());

  it.each([
    ['audio/x-m4a', 'audio/mp4'],
    ['audio/m4a', 'audio/mp4'],
    ['audio/x-wav', 'audio/wav'],
    ['audio/wave', 'audio/wav'],
    ['audio/vnd.wave', 'audio/wav'],
    ['audio/x-flac', 'audio/flac'],
    ['Audio/X-M4A', 'audio/mp4']
  ])('maps the alias %s to %s', (alias, canonical) => {
    expect(canonicalMimeType(alias, 'whatever.bin')).toBe(canonical);
  });

  it('takes the type of an .m4a from its extension when the browser reports none', () => {
    expect(canonicalMimeType('', 'talk.m4a')).toBe('audio/mp4');
    expect(canonicalMimeType('', 'TALK.M4A')).toBe('audio/mp4');
    expect(canonicalMimeType('application/octet-stream', 'talk.m4a')).toBe('audio/mp4');
    expect(canonicalMimeType(undefined, 'talk.m4a')).toBe('audio/mp4');
  });

  it('takes the type of a .wav or .webm from its extension when the browser reports none', () => {
    expect(canonicalMimeType('', 'take.wav')).toBe('audio/wav');
    expect(canonicalMimeType('', 'clip.webm')).toBe('video/webm');
  });

  it('keeps the reported type of an extension shared by audio and video', () => {
    expect(canonicalMimeType('', 'clip.mp4')).toBe('');
    expect(canonicalMimeType('video/mp4', 'clip.mp4')).toBe('video/mp4');
    expect(canonicalMimeType('audio/mp4', 'clip.mp4')).toBe('audio/mp4');
  });

  it('leaves known, unknown and non-media types untouched', () => {
    expect(canonicalMimeType('audio/mpeg', 'song.mp3')).toBe('audio/mpeg');
    expect(canonicalMimeType('audio/webm;codecs=opus', 'rec.webm')).toBe('audio/webm;codecs=opus');
    expect(canonicalMimeType('application/x-custom', 'talk.m4a')).toBe('application/x-custom');
    expect(canonicalMimeType('video/mp4', 'talk.m4a')).toBe('video/mp4');
    expect(canonicalMimeType('application/pdf', 'report.pdf')).toBe('application/pdf');
    expect(canonicalMimeType('', 'notes.txt')).toBe('');
    expect(canonicalMimeType('', 'report.docx')).toBe('');
    expect(canonicalMimeType('', 'README')).toBe('');
    expect(canonicalMimeType('', '.m4a')).toBe('');
    expect(canonicalMimeType('', undefined)).toBe('');
  });
});

describe('withDataUrlMimeType', () => {
  let withDataUrlMimeType;
  beforeAll(async () => {
    ({ withDataUrlMimeType } = await loadFileProcessing(shippedMimeTypes));
  });

  it('rewrites the MIME type of the data URL prefix', () => {
    expect(withDataUrlMimeType('data:audio/x-m4a;base64,AAAA', 'audio/mp4')).toBe(
      'data:audio/mp4;base64,AAAA'
    );
    expect(withDataUrlMimeType('data:application/octet-stream;base64,AAAA', 'audio/mp4')).toBe(
      'data:audio/mp4;base64,AAAA'
    );
    expect(withDataUrlMimeType('data:;base64,AAAA', 'audio/mp4')).toBe(
      'data:audio/mp4;base64,AAAA'
    );
  });

  it('leaves a data URL that already carries the type, and an unknown type, alone', () => {
    expect(withDataUrlMimeType('data:audio/mp4;base64,AAAA', 'audio/mp4')).toBe(
      'data:audio/mp4;base64,AAAA'
    );
    expect(withDataUrlMimeType('data:application/octet-stream;base64,AAAA', '')).toBe(
      'data:application/octet-stream;base64,AAAA'
    );
  });
});

describe('UnifiedUploader with audio files', () => {
  beforeAll(async () => {
    // The server config the app really loads; UnifiedUploader reads it on mount.
    mockServerConfig = shippedMimeTypes;
    await require('../../../client/src/features/upload/utils/fileProcessing').loadMimetypesConfig();
  });
  beforeEach(() => {
    mockLastPreview = null;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  function renderUploader(config = {}) {
    const onFileSelect = jest.fn();
    const utils = render(
      <UnifiedUploader
        onFileSelect={onFileSelect}
        config={{
          imageUploadEnabled: false,
          videoUploadEnabled: false,
          fileUploadEnabled: false,
          ...config
        }}
      >
        <div />
      </UnifiedUploader>
    );
    const input = utils.container.querySelector('input[type="file"]');
    const upload = file => fireEvent.change(input, { target: { files: [file] } });
    return { ...utils, input, upload, onFileSelect };
  }

  it.each([['audio/x-m4a'], ['audio/m4a'], ['audio/mp4'], [''], ['application/octet-stream']])(
    'processes an .m4a reported as %p as audio/mp4',
    async type => {
      const { upload, onFileSelect } = renderUploader();

      upload(m4a('talk.m4a', type));

      await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
      const data = onFileSelect.mock.calls[0][0];
      expect(data.type).toBe('audio');
      expect(data.fileType).toBe('audio/mp4');
      expect(data.fileName).toBe('talk.m4a');
      expect(data.base64.startsWith('data:audio/mp4;base64,')).toBe(true);
    }
  );

  it('labels an .m4a "M4A" instead of "MP4"', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(m4a('talk.m4a', 'audio/x-m4a'));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());

    expect(mockLastPreview).toMatchObject({ type: 'audio', fileType: 'M4A' });
  });

  it('keeps the "MP4" label for an .mp4 audio file', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(m4a('talk.mp4', 'audio/mp4'));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());

    expect(mockLastPreview).toMatchObject({ fileType: 'MP4' });
  });

  it('processes audio/x-wav as audio/wav', async () => {
    const { upload, onFileSelect } = renderUploader();

    upload(
      new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'take.wav', { type: 'audio/x-wav' })
    );

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data.fileType).toBe('audio/wav');
    expect(data.base64.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('still refuses an .m4a when audio upload is disabled', async () => {
    const { upload, onFileSelect, findByText } = renderUploader({
      audioUploadEnabled: false,
      fileUploadEnabled: true,
      supportedFormats: ['text/plain']
    });

    upload(m4a('talk.m4a', 'audio/x-m4a'));

    expect(await findByText(/Unsupported file format/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('still refuses an .m4a when the app does not list audio/mp4', async () => {
    const { upload, onFileSelect, findByText } = renderUploader({
      audioUpload: { enabled: true, supportedFormats: ['audio/mpeg', 'audio/wav'] }
    });

    upload(m4a('talk.m4a', 'audio/x-m4a'));

    expect(await findByText(/Unsupported file format/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('keeps accepting an alias the app lists verbatim, stored as the canonical type', async () => {
    const { upload, onFileSelect } = renderUploader({
      audioUpload: { enabled: true, supportedFormats: ['audio/x-m4a'] }
    });

    upload(m4a('talk.m4a', 'audio/x-m4a'));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data.type).toBe('audio');
    expect(data.fileType).toBe('audio/mp4');
  });

  it('takes the type of a video without one from its extension', async () => {
    const { upload, onFileSelect } = renderUploader({
      videoUploadEnabled: true,
      extractAudioFromVideo: false
    });

    upload(new File([M4A_BYTES], 'clip.mov', { type: '' }));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data.type).toBe('video');
    expect(data.fileType).toBe('video/quicktime');
    expect(data.base64.startsWith('data:video/quicktime;base64,')).toBe(true);
  });

  it('names M4A next to MP4 in the list of supported formats', async () => {
    const { upload, findByText } = renderUploader();

    upload(new File(['x'], 'notes.xyz', { type: 'application/x-custom' }));

    expect(await findByText(/Please use: .*M4A, MP4/)).toBeInTheDocument();
  });
});

describe('cloud files', () => {
  beforeEach(() => {
    mockServerConfig = shippedMimeTypes;
  });

  it('attaches an audio/x-m4a download as audio/mp4', async () => {
    const processed = await processCloudFile(m4a('talk.m4a', 'audio/x-m4a'));

    expect(processed).toMatchObject({
      type: 'audio',
      fileName: 'talk.m4a',
      fileType: 'audio/mp4'
    });
    expect(processed.base64.startsWith('data:audio/mp4;base64,')).toBe(true);
  });

  it('lists m4a files of the cloud storage as supported', () => {
    expect(isCloudFileSupported('audio/mp4')).toBe(true);
    expect(isCloudFileSupported('audio/x-m4a')).toBe(true);
    expect(isCloudFileSupported('application/octet-stream', 'talk.m4a')).toBe(true);
    expect(isCloudFileSupported('application/octet-stream', 'talk.bin')).toBe(false);
    expect(isCloudFileSupported('application/x-custom', 'talk.m4a')).toBe(false);
  });
});
