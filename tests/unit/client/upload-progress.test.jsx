/**
 * Progress and Stop while an attachment is processed (issue #2835): extracting
 * the audio of a long video takes seconds to minutes, so the uploader shows
 * what it is doing, with a progress bar and a Stop button, and lets go of the
 * file when it is stopped.
 */

import '@testing-library/jest-dom';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

// The real thing, interpolation included, apart from the extraction itself:
// the test decides when it progresses and ends.
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
  extractAudioFromVideo: jest.fn()
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const Uploader = require('../../../client/src/features/upload/components/Uploader').default;
const {
  extractAudioFromVideo
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { createAbortError } = require('../../../client/src/utils/abortable');

const WAV = {
  base64: 'data:audio/wav;base64,AAAA',
  blob: new Blob(['wav'], { type: 'audio/wav' }),
  format: 'audio/wav',
  sampleRate: 16000,
  channels: 1,
  duration: 2,
  size: 3
};

// The extraction in progress: what it was handed, and a way to end it
let extraction;

beforeEach(() => {
  extraction = null;
  extractAudioFromVideo.mockReset();
  extractAudioFromVideo.mockImplementation(
    (file, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        extraction = { file, signal, onProgress, resolve, reject };
        // As the real one: stopping rejects with the abort error
        signal.addEventListener('abort', () => reject(createAbortError()));
      })
  );
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const video = (name = 'standup.webm') => new File(['video'], name, { type: 'video/webm' });
const note = (name = 'notes.txt') => new File(['some notes'], name, { type: 'text/plain' });

const config = (extra = {}) => ({
  imageUploadEnabled: false,
  audioUploadEnabled: false,
  videoUpload: {
    enabled: true,
    extractAudio: true,
    supportedFormats: ['video/webm'],
    maxFileSizeMB: 10
  },
  fileUpload: { enabled: true, supportedFormats: ['text/plain'], maxFileSizeMB: 10 },
  ...extra
});

// The parent holds what was selected, as the chat does, and hands it back
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
      <div data-testid="children" />
    </UnifiedUploader>
  );
}

function renderUploader({ onProcessingChange, uploadConfig = config() } = {}) {
  const onFileSelect = jest.fn();
  const utils = render(
    <Harness
      onFileSelect={onFileSelect}
      onProcessingChange={onProcessingChange}
      config={uploadConfig}
    />
  );
  const input = utils.container.querySelector('input[type="file"]');
  return {
    ...utils,
    input,
    onFileSelect,
    upload: (...files) => fireEvent.change(input, { target: { files } })
  };
}

// The panel only shows once processing has gone on for a moment
const showPanel = () => screen.findByRole('progressbar');

describe('the progress panel', () => {
  test('shows the file, what is going on, a progress bar and a Stop button', async () => {
    const { upload } = renderUploader();
    upload(video());

    const bar = await showPanel();
    expect(screen.getByText('standup.webm')).toBeInTheDocument();
    expect(screen.getByText('Processing file...')).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-label', 'Progress of standup.webm');
    const stop = screen.getByRole('button', { name: 'Stop processing standup.webm' });
    expect(stop).toHaveAttribute('type', 'button');
    expect(stop).toHaveTextContent('Stop');
  });

  test('is an indeterminate bar, with no value, while the stage has no percent', async () => {
    const { upload } = renderUploader();
    upload(video());
    const bar = await showPanel();

    act(() => extraction.onProgress({ stage: 'decode', percent: null }));

    expect(screen.getByText('Extracting audio…')).toBeInTheDocument();
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar.firstChild).toHaveClass('upload-progress-indeterminate');
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  test('shows the percent, as the bar value and as text, once there is one', async () => {
    const { upload } = renderUploader();
    upload(video());
    const bar = await showPanel();

    act(() => extraction.onProgress({ stage: 'encode', percent: 80 }));

    expect(screen.getByText('Encoding audio…')).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuenow', '80');
    expect(bar.firstChild).toHaveStyle({ width: '80%' });
    expect(bar.firstChild).not.toHaveClass('upload-progress-indeterminate');
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  test.each([
    ['read', 'Reading file…'],
    ['decode', 'Extracting audio…'],
    ['resample', 'Converting audio…'],
    ['encode', 'Encoding audio…'],
    ['finalize', 'Finishing up…']
  ])('says what the %s stage does', async (stage, text) => {
    const { upload } = renderUploader();
    upload(video());
    await showPanel();

    act(() => extraction.onProgress({ stage, percent: null }));

    expect(screen.getByText(text)).toBeInTheDocument();
  });

  test('does not flash up for a file that is done in a blink', async () => {
    jest.useFakeTimers();
    const { upload, onFileSelect } = renderUploader();
    upload(note());

    // The text file is read and attached within a few ticks...
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
    });
    expect(onFileSelect).toHaveBeenCalled();
    // ...and the panel never got its turn
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  test('shows only once processing has gone on for a while', async () => {
    jest.useFakeTimers();
    const { upload } = renderUploader();
    upload(video());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
    });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  test('goes when the file is attached', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video());
    await showPanel();

    await act(async () => extraction.resolve(WAV));

    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(onFileSelect).toHaveBeenCalledTimes(1);
    expect(onFileSelect.mock.calls[0][0]).toMatchObject({
      fileName: 'standup.wav',
      extractedFromVideo: true
    });
  });

  test('hands the extraction the file, a signal and a progress callback', async () => {
    const { upload } = renderUploader();
    upload(video('talk.webm'));
    await showPanel();

    expect(extraction.file.name).toBe('talk.webm');
    expect(extraction.signal).toBeInstanceOf(AbortSignal);
    expect(extraction.signal.aborted).toBe(false);
    expect(typeof extraction.onProgress).toBe('function');
  });
});

describe('Stop', () => {
  test('aborts the extraction, shows no error and attaches nothing', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video());
    await showPanel();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));

    expect(extraction.signal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(screen.queryByText(/Error|error|Could not|Please try again/)).not.toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('is not logged as an error', async () => {
    const { upload } = renderUploader();
    upload(video());
    await showPanel();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

    expect(console.error).not.toHaveBeenCalled();
  });

  test('resets the file input so the same file can be picked again', async () => {
    const { upload, input } = renderUploader();
    const assigned = [];
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => '',
      set: value => assigned.push(value)
    });
    upload(video());
    await showPanel();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));

    await waitFor(() => expect(assigned).toContain(''));
  });

  test('lets the user pick a file again afterwards', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video());
    await showPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

    upload(video('again.webm'));
    await showPanel();
    await act(async () => extraction.resolve(WAV));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledTimes(1));
    expect(onFileSelect.mock.calls[0][0]).toMatchObject({ originalVideoName: 'again.webm' });
  });

  test('keeps the files attached before', async () => {
    const uploadConfig = config({ allowMultiple: true });
    const { upload, onFileSelect } = renderUploader({ uploadConfig });
    upload(note('first.txt'));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalledTimes(1));

    upload(video());
    await showPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    // Stopping attached and detached nothing
    expect(onFileSelect).toHaveBeenCalledTimes(1);

    // The next file joins the one attached before: it was never lost
    upload(note('second.txt'));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalledTimes(2));
    expect(onFileSelect.mock.calls[1][0].map(file => file.fileName)).toEqual([
      'first.txt',
      'second.txt'
    ]);
  });

  test('keeps the files of a batch that were done before the one stopped', async () => {
    const uploadConfig = config({ allowMultiple: true });
    const { upload, onFileSelect } = renderUploader({ uploadConfig });

    upload(note('done.txt'), video());
    await showPanel();
    // Two files: say which one
    expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledTimes(1));
    expect(onFileSelect.mock.calls[0][0].map(file => file.fileName)).toEqual(['done.txt']);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  test('drops the file of an extraction that cannot be cancelled and finishes after Stop', async () => {
    // Decoding cannot be cancelled: the extraction runs on and resolves anyway
    extractAudioFromVideo.mockImplementation(
      (file, { signal, onProgress }) =>
        new Promise(resolve => {
          extraction = { file, signal, onProgress, resolve };
        })
    );
    const { upload, onFileSelect } = renderUploader();
    upload(video());
    await showPanel();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    await act(async () => extraction.resolve(WAV));

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  test('a failure that is not a stop still shows its error and no panel', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video());
    await showPanel();

    await act(async () => extraction.reject(new Error('audio-decode-error')));

    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(screen.getByText(/Could not decode audio from video/)).toBeInTheDocument();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  test('stops an extraction that is still going when the uploader goes away', async () => {
    const onProcessingChange = jest.fn();
    const { upload, unmount } = renderUploader({ onProcessingChange });
    upload(video());
    await showPanel();

    unmount();

    expect(extraction.signal.aborted).toBe(true);
    expect(onProcessingChange).toHaveBeenLastCalledWith(false);
  });

  test('attaches nothing of a batch when the uploader goes away during it', async () => {
    const uploadConfig = config({ allowMultiple: true });
    const { upload, unmount, onFileSelect } = renderUploader({ uploadConfig });
    upload(note('done.txt'), video());
    await showPanel();

    unmount();
    // Let the stopped run run out
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // The composer is gone: there is nothing left to attach the text file to
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});

describe('onProcessingChange', () => {
  test('follows the processing: true while a file is processed, false after', async () => {
    const onProcessingChange = jest.fn();
    const { upload } = renderUploader({ onProcessingChange });
    expect(onProcessingChange).not.toHaveBeenCalled();

    upload(video());
    await waitFor(() => expect(onProcessingChange).toHaveBeenLastCalledWith(true));

    await act(async () => extraction.resolve(WAV));
    await waitFor(() => expect(onProcessingChange).toHaveBeenLastCalledWith(false));
    expect(onProcessingChange.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  test('is false again after a stop', async () => {
    const onProcessingChange = jest.fn();
    const { upload } = renderUploader({ onProcessingChange });
    upload(video());
    await waitFor(() => expect(onProcessingChange).toHaveBeenLastCalledWith(true));
    await showPanel();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));

    await waitFor(() => expect(onProcessingChange).toHaveBeenLastCalledWith(false));
  });
});

describe('Uploader', () => {
  // A processor that ignores the signal altogether
  function renderBareUploader(onProcessFile, props = {}) {
    const onSelect = jest.fn();
    const render_ = { current: null };
    // The progress at every render, as the render prop saw it
    const history = [];
    const utils = render(
      <Uploader onSelect={onSelect} onProcessFile={onProcessFile} {...props}>
        {state => {
          render_.current = state;
          if (state.progress) history.push(state.progress);
          return <input {...state.inputProps} data-testid="input" />;
        }}
      </Uploader>
    );
    return {
      ...utils,
      onSelect,
      history,
      state: () => render_.current,
      upload: (...files) => fireEvent.change(screen.getByTestId('input'), { target: { files } })
    };
  }

  test('passes the progress and the stop to the render prop', async () => {
    const { upload, state } = renderBareUploader(
      (file, { onProgress }) =>
        new Promise(() => {
          onProgress({ stage: 'decode', percent: 40 });
        }),
      { accept: ['text/plain'] }
    );
    expect(state().progress).toBeNull();
    expect(state().isProcessing).toBe(false);

    upload(note('a.txt'));

    await waitFor(() => expect(state().isProcessing).toBe(true));
    expect(state().progress).toEqual({
      fileName: 'a.txt',
      stage: 'decode',
      percent: 40,
      index: 0,
      total: 1
    });
    expect(typeof state().cancelProcessing).toBe('function');
  });

  test('stop returns at once even from a processor that ignores the signal', async () => {
    const { upload, state, onSelect } = renderBareUploader(() => new Promise(() => {}), {
      accept: ['text/plain']
    });
    upload(note('a.txt'));
    await waitFor(() => expect(state().isProcessing).toBe(true));

    act(() => state().cancelProcessing());

    await waitFor(() => expect(state().isProcessing).toBe(false));
    expect(state().progress).toBeNull();
    expect(state().error).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a processor that takes no second argument keeps working', async () => {
    const processor = jest.fn(async file => ({
      preview: { type: 'document', fileName: file.name },
      data: { type: 'document', fileName: file.name }
    }));
    const { upload, onSelect } = renderBareUploader(processor, { accept: ['text/plain'] });

    upload(note('plain.txt'));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({ type: 'document', fileName: 'plain.txt' })
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  test('a processor that is not async keeps working', async () => {
    const { upload, onSelect } = renderBareUploader(
      file => ({ preview: {}, data: { fileName: file.name } }),
      { accept: ['text/plain'] }
    );

    upload(note('sync.txt'));

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ fileName: 'sync.txt' }));
  });

  test('numbers the files of a batch', async () => {
    let release;
    const { upload, history } = renderBareUploader(
      async (file, { onProgress }) => {
        onProgress({ stage: 'read', percent: 10 });
        if (file.name === 'b.txt') await new Promise(resolve => (release = resolve));
        return { preview: {}, data: { fileName: file.name } };
      },
      { accept: ['text/plain'], allowMultiple: true }
    );

    upload(note('a.txt'), note('b.txt'));
    await waitFor(() => expect(release).toBeDefined());

    const seen = history.map(({ fileName, index, total }) => [fileName, index, total]);
    expect(seen).toContainEqual(['a.txt', 0, 2]);
    expect(seen).toContainEqual(['b.txt', 1, 2]);
    await act(async () => release());
  });

  describe('a batch that is stopped or discarded while its last file is processed', () => {
    // Let a run that was aborted run out: its loop goes on in later ticks
    const settle = () =>
      act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

    // `quick.txt` is done at once, `slow.txt` never ends (and ignores the signal)
    const quickThenSlow = async file => {
      if (file.name === 'slow.txt') await new Promise(() => {});
      return { preview: {}, data: { fileName: file.name } };
    };

    const startBatch = async () => {
      const utils = renderBareUploader(quickThenSlow, {
        accept: ['text/plain'],
        allowMultiple: true
      });
      utils.upload(note('quick.txt'), note('slow.txt'));
      await waitFor(() => expect(utils.state().progress).toMatchObject({ fileName: 'slow.txt' }));
      return utils;
    };

    test('Stop keeps the files that were done', async () => {
      const { state, onSelect } = await startBatch();

      act(() => state().cancelProcessing());
      await settle();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith([{ fileName: 'quick.txt' }]);
      expect(state().isProcessing).toBe(false);
    });

    test('Clear drops them: the cleared attachments do not come back', async () => {
      const { state, onSelect } = await startBatch();

      act(() => state().handleClear());
      await settle();

      // Cleared, and not attached again by the run that was still going
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenLastCalledWith(null);
      expect(state().isProcessing).toBe(false);
      expect(state().preview).toBeNull();
    });

    test('going away drops them: nothing is attached after the unmount', async () => {
      const { unmount, onSelect } = await startBatch();

      unmount();
      await settle();

      expect(onSelect).not.toHaveBeenCalled();
    });

    test('a new batch after a Clear is attached as usual', async () => {
      const { state, onSelect, upload } = await startBatch();
      act(() => state().handleClear());
      await settle();

      upload(note('again.txt'));

      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
      expect(onSelect).toHaveBeenLastCalledWith([{ fileName: 'again.txt' }]);
    });
  });
});
