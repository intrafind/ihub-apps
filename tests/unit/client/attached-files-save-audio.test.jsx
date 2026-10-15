/**
 * Unit tests for saving the audio that was extracted from an uploaded video
 * (issue #2837).
 *
 * The attachment chips show the extraction's result as a `.wav` file the user
 * never had. Those chips get a save button; other attachments do not, because
 * the user already has the file. The WAV comes from the attachment's
 * non-enumerable `blob`, or — when a copy of the attachment lost it — from the
 * base64 data URL.
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    }
  })
}));

// The file-processing utilities (formatFileSize) transitively import the API client, which
// uses `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

// Icon pulls in runtimeBasePath, which uses `import.meta` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const AttachedFilesList =
  require('../../../client/src/features/upload/components/AttachedFilesList').default;
const {
  canSaveExtractedAudio,
  getExtractedAudioBlob,
  saveExtractedAudio
} = require('../../../client/src/features/upload/utils/extractedAudio');

const WAV_BYTES = 'RIFF-fake-wav';
const WAV_DATA_URL = `data:audio/wav;base64,${btoa(WAV_BYTES)}`;

/** An extracted-audio attachment the way UnifiedUploader builds it: `blob` is not enumerable. */
function extractedAudio({ blob, ...overrides } = {}) {
  const attachment = {
    type: 'audio',
    source: 'local',
    base64: WAV_DATA_URL,
    fileName: 'lecture.wav',
    fileSize: WAV_BYTES.length,
    fileType: 'audio/wav',
    extractedFromVideo: true,
    originalVideoName: 'lecture.mp4',
    duration: 1,
    sampleRate: 16000,
    channels: 1,
    ...overrides
  };
  Object.defineProperty(attachment, 'blob', {
    value: blob,
    enumerable: false,
    writable: true,
    configurable: true
  });
  return attachment;
}

const readAsText = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });

describe('saving extracted audio from the attachment list', () => {
  let createObjectURL;
  let revokeObjectURL;
  let anchorClicks;

  beforeEach(() => {
    jest.useFakeTimers();
    createObjectURL = jest.fn(() => 'blob:mock-wav');
    revokeObjectURL = jest.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    anchorClicks = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
      anchorClicks.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  const renderList = (files, props = {}) =>
    render(
      <AttachedFilesList
        files={files}
        onRemoveFile={jest.fn()}
        onRemoveAll={jest.fn()}
        {...props}
      />
    );

  it('shows a save button for extracted audio only', () => {
    // Four files would collapse the list by default; keep the rows visible.
    renderList(
      [
        extractedAudio({ blob: new Blob([WAV_BYTES], { type: 'audio/wav' }) }),
        {
          type: 'audio',
          source: 'local',
          base64: 'data:audio/mpeg;base64,AAAA',
          fileName: 'voice-memo.mp3',
          fileSize: 3,
          fileType: 'audio/mpeg'
        },
        { type: 'image', source: 'local', fileName: 'photo.png', fileSize: 3 },
        { type: 'document', source: 'local', fileName: 'notes.pdf', fileSize: 3 }
      ],
      { defaultCollapseThreshold: 10 }
    );

    const buttons = screen.getAllByRole('button', { name: /^Save audio/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Save audio as lecture.wav');
    expect(buttons[0]).toHaveAttribute('title', 'Save audio');
    expect(buttons[0]).toHaveAttribute('type', 'button');
    expect(within(buttons[0]).getByTestId('icon')).toHaveAttribute('data-name', 'download');
  });

  it('shows no save button when the extracted audio has no data left to save', () => {
    renderList([extractedAudio({ base64: undefined })]);

    expect(screen.queryByRole('button', { name: /^Save audio/ })).not.toBeInTheDocument();
  });

  it('saves the attachment blob as <video name>.wav and revokes the URL afterwards', () => {
    const blob = new Blob([WAV_BYTES], { type: 'audio/wav' });
    renderList([extractedAudio({ blob })]);

    fireEvent.click(screen.getByRole('button', { name: 'Save audio as lecture.wav' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBe(blob);
    expect(anchorClicks).toEqual([{ href: 'blob:mock-wav', download: 'lecture.wav' }]);

    // Revoked once the browser has had time to start the download, not before.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-wav');
    // The temporary anchor does not stay in the page.
    expect(document.body.querySelector('a[download]')).toBeNull();
  });

  it('builds the WAV from the base64 data URL when the attachment lost its blob', async () => {
    // A spread copy drops the non-enumerable property, as does a restored attachment.
    const original = extractedAudio({ blob: new Blob(['other'], { type: 'audio/wav' }) });
    const restored = { ...original };
    expect(restored.blob).toBeUndefined();
    renderList([restored]);

    fireEvent.click(screen.getByRole('button', { name: 'Save audio as lecture.wav' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const saved = createObjectURL.mock.calls[0][0];
    expect(saved).toBeInstanceOf(Blob);
    expect(saved.type).toBe('audio/wav');
    expect(await readAsText(saved)).toBe(WAV_BYTES);
    expect(anchorClicks).toEqual([{ href: 'blob:mock-wav', download: 'lecture.wav' }]);

    jest.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-wav');
  });

  it('neither submits a surrounding form nor removes the attachment', () => {
    const onSubmit = jest.fn(event => event.preventDefault());
    const onRemoveFile = jest.fn();
    render(
      <form onSubmit={onSubmit}>
        <AttachedFilesList
          files={[extractedAudio({ blob: new Blob([WAV_BYTES], { type: 'audio/wav' }) })]}
          onRemoveFile={onRemoveFile}
          onRemoveAll={jest.fn()}
        />
      </form>
    );

    const row = screen.getByRole('listitem');
    fireEvent.click(within(row).getByRole('button', { name: /^Save audio/ }));

    expect(anchorClicks).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onRemoveFile).not.toHaveBeenCalled();
  });

  it('stays usable while the input is disabled, e.g. during a running answer', () => {
    renderList([extractedAudio({ blob: new Blob([WAV_BYTES], { type: 'audio/wav' }) })], {
      disabled: true
    });

    const save = screen.getByRole('button', { name: /^Save audio/ });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(anchorClicks).toHaveLength(1);
  });
});

describe('extractedAudio helpers', () => {
  beforeEach(() => {
    URL.createObjectURL = jest.fn(() => 'blob:mock-wav');
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it('only offers saving for audio extracted from a video', () => {
    const blob = new Blob([WAV_BYTES]);
    expect(canSaveExtractedAudio(extractedAudio({ blob }))).toBe(true);
    expect(canSaveExtractedAudio(extractedAudio())).toBe(true); // data URL only
    expect(canSaveExtractedAudio(extractedAudio({ extractedFromVideo: false }))).toBe(false);
    expect(canSaveExtractedAudio(extractedAudio({ type: 'document' }))).toBe(false);
    expect(canSaveExtractedAudio(extractedAudio({ base64: undefined }))).toBe(false);
    expect(canSaveExtractedAudio(null)).toBe(false);
  });

  it('prefers the blob, falls back to the data URL and gives up on anything else', async () => {
    const blob = new Blob([WAV_BYTES], { type: 'audio/wav' });
    expect(getExtractedAudioBlob(extractedAudio({ blob }))).toBe(blob);

    const fromDataUrl = getExtractedAudioBlob(extractedAudio());
    expect(fromDataUrl.type).toBe('audio/wav');
    expect(await readAsText(fromDataUrl)).toBe(WAV_BYTES);

    expect(
      getExtractedAudioBlob(extractedAudio({ base64: 'data:audio/wav;base64,@@@' }))
    ).toBeNull();
    expect(getExtractedAudioBlob(extractedAudio({ base64: 'not a data url' }))).toBeNull();
    expect(getExtractedAudioBlob(extractedAudio({ base64: undefined }))).toBeNull();
  });

  it('reports whether a download was started', () => {
    expect(saveExtractedAudio(extractedAudio())).toBe(true);
    expect(saveExtractedAudio(extractedAudio({ base64: 'not a data url' }))).toBe(false);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
