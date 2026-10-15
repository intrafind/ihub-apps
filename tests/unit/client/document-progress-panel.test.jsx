/**
 * The progress panel for documents (issue #2835, follow-up): the page or slide being worked on
 * next to the stage, the uploader handing it over, and Stop reaching a real extraction — a PDF
 * pdf.js is working on is destroyed and nothing is attached.
 */
import '@testing-library/jest-dom';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));
jest.mock(
  'pdfjs-dist/legacy/build/pdf.mjs',
  () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }),
  {
    virtual: true
  }
);

// The real thing, interpolation included
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return text.replace(/{{(\w+)}}/g, (_, name) => values[name] ?? '');
    }
  })
}));

const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
const ProcessingProgress =
  require('../../../client/src/features/upload/components/ProcessingProgress').default;
const Uploader = require('../../../client/src/features/upload/components/Uploader').default;
const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const { makeFile } = require('../../utils/officeFixtures');
const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  pdfjs.getDocument.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const progress = (extra = {}) => ({
  fileName: 'vertrag.pdf',
  stage: 'extract',
  percent: 40,
  index: 0,
  total: 1,
  ...extra
});

const showPanel = () => screen.findByTestId('upload-progress');

describe('ProcessingProgress', () => {
  it('names the page being extracted', async () => {
    render(
      <ProcessingProgress
        progress={progress({ detail: { unit: 'page', current: 12, total: 340 } })}
        onStop={() => {}}
      />
    );
    await showPanel();

    expect(screen.getByText('Extracting text…')).toBeInTheDocument();
    expect(screen.getByText('Page 12 of 340')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  it('names the slide being extracted', async () => {
    render(
      <ProcessingProgress
        progress={progress({
          fileName: 'quartal.pptx',
          detail: { unit: 'slide', current: 3, total: 40 }
        })}
        onStop={() => {}}
      />
    );
    await showPanel();

    expect(screen.getByText('Slide 3 of 40')).toBeInTheDocument();
  });

  it('does not announce every page to a screen reader: the progress bar says how far it is', async () => {
    render(
      <ProcessingProgress
        progress={progress({ detail: { unit: 'page', current: 12, total: 340 } })}
        onStop={() => {}}
      />
    );
    await showPanel();

    expect(screen.getByText('Page 12 of 340')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Extracting text…')).not.toHaveAttribute('aria-hidden');
  });

  it('shows the page next to the file of a batch', async () => {
    render(
      <ProcessingProgress
        progress={progress({
          index: 1,
          total: 3,
          detail: { unit: 'page', current: 2, total: 9 }
        })}
        onStop={() => {}}
      />
    );
    await showPanel();

    expect(screen.getByText('Page 2 of 9')).toBeInTheDocument();
    expect(screen.getByText('File 2 of 3')).toBeInTheDocument();
  });

  it('keeps the page while the bar is indeterminate', async () => {
    render(
      <ProcessingProgress
        progress={progress({ percent: null, detail: { unit: 'page', current: 1, total: 4 } })}
        onStop={() => {}}
      />
    );
    await showPanel();

    expect(screen.getByRole('progressbar').firstChild).toHaveClass('upload-progress-indeterminate');
    expect(screen.getByText('Page 1 of 4')).toBeInTheDocument();
  });

  it('leaves out a unit it does not know, and shows nothing without a detail', async () => {
    const { rerender } = render(
      <ProcessingProgress
        progress={progress({ detail: { unit: 'chapter', current: 1, total: 4 } })}
        onStop={() => {}}
      />
    );
    await showPanel();
    expect(screen.queryByText(/of 4/)).not.toBeInTheDocument();

    rerender(<ProcessingProgress progress={progress()} onStop={() => {}} />);
    expect(screen.getByText('Extracting text…')).toBeInTheDocument();
    expect(screen.queryByText(/Page|Slide/)).not.toBeInTheDocument();
  });

  it.each([
    ['read', 'Reading file…'],
    ['parse', 'Opening document…'],
    ['extract', 'Extracting text…'],
    ['convert', 'Converting file…'],
    ['render', 'Rendering pages…'],
    ['finalize', 'Finishing up…']
  ])('says what the %s stage is doing', async (stage, text) => {
    render(<ProcessingProgress progress={progress({ stage })} onStop={() => {}} />);
    await showPanel();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('a stage it does not know is processing', async () => {
    render(<ProcessingProgress progress={progress({ stage: 'mystery' })} onStop={() => {}} />);
    await showPanel();
    expect(screen.getByText('Processing file...')).toBeInTheDocument();
  });

  it('has a German label for every new stage and unit', () => {
    for (const key of ['parse', 'extract', 'convert', 'render']) {
      expect(en.components.uploader.stage[key]).toEqual(expect.any(String));
      expect(de.components.uploader.stage[key]).toEqual(expect.any(String));
      expect(de.components.uploader.stage[key]).not.toBe(en.components.uploader.stage[key]);
    }
    for (const unit of ['page', 'slide']) {
      expect(de.components.uploader.detail[unit]).toContain('{{current}}');
      expect(de.components.uploader.detail[unit]).toContain('{{total}}');
      expect(de.components.uploader.detail[unit]).not.toBe(en.components.uploader.detail[unit]);
    }
  });
});

describe('Uploader', () => {
  it('hands the detail of a report to the render prop, and none where there is none', async () => {
    const state = { current: null };
    let report;
    render(
      <Uploader
        accept={['text/plain']}
        onProcessFile={(file, { onProgress }) =>
          new Promise(() => {
            report = onProgress;
          })
        }
      >
        {renderState => {
          state.current = renderState;
          return <input {...renderState.inputProps} data-testid="input" />;
        }}
      </Uploader>
    );
    fireEvent.change(screen.getByTestId('input'), {
      target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] }
    });
    await waitFor(() => expect(report).toBeDefined());

    act(() =>
      report({ stage: 'extract', percent: 10, detail: { unit: 'page', current: 2, total: 9 } })
    );
    expect(state.current.progress).toEqual({
      fileName: 'a.txt',
      stage: 'extract',
      percent: 10,
      detail: { unit: 'page', current: 2, total: 9 },
      index: 0,
      total: 1
    });

    // The next report says nothing about a page: the page of the one before is gone
    act(() => report({ stage: 'finalize', percent: null }));
    expect(state.current.progress).toEqual({
      fileName: 'a.txt',
      stage: 'finalize',
      percent: null,
      index: 0,
      total: 1
    });
  });
});

describe('a PDF in the uploader', () => {
  const LONG = 'Dieser Vertrag gilt fuer alle Parteien und regelt die Zusammenarbeit.';

  /** A document whose page 3 pdf.js never answers, and the task that destroys it. */
  function openPdfThatStopsAt(hangAt, pageCount = 5) {
    const pdf = {
      numPages: pageCount,
      getPageLabels: jest.fn(async () => null),
      getPage: jest.fn(number =>
        number === hangAt
          ? new Promise(() => {})
          : Promise.resolve({
              getTextContent: async () => ({
                items: [
                  { str: LONG, hasEOL: false },
                  { str: '', hasEOL: true }
                ]
              })
            })
      )
    };
    const task = { promise: Promise.resolve(pdf), destroy: jest.fn(async () => {}) };
    pdfjs.getDocument.mockReturnValue(task);
    return { pdf, task };
  }

  function renderUploader() {
    const onFileSelect = jest.fn();
    const utils = render(
      <UnifiedUploader
        onFileSelect={onFileSelect}
        config={{
          imageUploadEnabled: false,
          audioUploadEnabled: false,
          videoUploadEnabled: false,
          fileUpload: {
            enabled: true,
            supportedFormats: ['application/pdf'],
            maxFileSizeMB: 10
          }
        }}
      >
        <div />
      </UnifiedUploader>
    );
    const input = utils.container.querySelector('input[type="file"]');
    return {
      ...utils,
      onFileSelect,
      upload: file => fireEvent.change(input, { target: { files: [file] } })
    };
  }

  const pdfFile = () => makeFile(new ArrayBuffer(8), 'vertrag.pdf', 'application/pdf');

  it('shows the page it is on, and Stop stops pdf.js', async () => {
    const { pdf, task } = openPdfThatStopsAt(3);
    const { upload, onFileSelect } = renderUploader();

    upload(pdfFile());

    expect(await screen.findByText('Page 3 of 5')).toBeInTheDocument();
    expect(screen.getByText('vertrag.pdf')).toBeInTheDocument();
    expect(screen.getByText('Extracting text…')).toBeInTheDocument();
    expect(task.destroy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Stop processing/ }));

    await waitFor(() => expect(screen.queryByTestId('upload-progress')).not.toBeInTheDocument());
    // pdf.js was told to stop, no page after the one it hangs on was asked for
    await waitFor(() => expect(task.destroy).toHaveBeenCalled());
    expect(pdf.getPage).toHaveBeenCalledTimes(3);
    // Nothing is attached, nothing is an error, the plain extraction did not start
    expect(onFileSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(/Error|error|Please try again/)).not.toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  it('attaches the text of a PDF that was left alone', async () => {
    openPdfThatStopsAt(0, 2);
    const { upload, onFileSelect } = renderUploader();

    upload(pdfFile());

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    expect(onFileSelect.mock.calls[0][0]).toMatchObject({
      type: 'document',
      fileName: 'vertrag.pdf',
      content: `[Page 1]\n${LONG}\n\n[Page 2]\n${LONG}`
    });
  });
});
