// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Most files are processed in a blink: the panel only shows once processing has
// gone on this long, so it does not flash up and vanish for them.
const SHOW_AFTER_MS = 300;

/**
 * Progress of the file the uploader is processing: its name, what is going on,
 * a progress bar (animated while there is no percentage to show) and a Stop
 * button. Mount it while processing, unmount it when done.
 *
 * @param {Object} props
 * @param {{fileName: string, stage: string|null, percent: number|null, detail?: {unit: string, current: number, total: number}, index: number, total: number}|null} props.progress
 *   From `Uploader`; `stage` is one of the stages the extractions report (`read`, `parse`,
 *   `extract`, `convert`, `render`, `finalize` for documents, `decode`, `resample`, `encode` for
 *   audio), `detail` the page or slide a document extraction is on
 * @param {Function} props.onStop - Stops the processing
 */
const ProcessingProgress = ({ progress, onStop }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible || !progress) return null;

  const { fileName, stage, percent, detail, index, total } = progress;
  const stageText = {
    read: t('components.uploader.stage.read', 'Reading file…'),
    parse: t('components.uploader.stage.parse', 'Opening document…'),
    extract: t('components.uploader.stage.extract', 'Extracting text…'),
    convert: t('components.uploader.stage.convert', 'Converting file…'),
    render: t('components.uploader.stage.render', 'Rendering pages…'),
    decode: t('components.uploader.stage.decode', 'Extracting audio…'),
    resample: t('components.uploader.stage.resample', 'Converting audio…'),
    encode: t('components.uploader.stage.encode', 'Encoding audio…'),
    finalize: t('components.uploader.stage.finalize', 'Finishing up…')
  }[stage];
  // Which page or slide a document extraction is on; a unit this panel does not know is left out
  const detailLabel = ({ unit, current, total }) => {
    if (unit === 'page') {
      return t('components.uploader.detail.page', 'Page {{current}} of {{total}}', {
        current,
        total
      });
    }
    if (unit === 'slide') {
      return t('components.uploader.detail.slide', 'Slide {{current}} of {{total}}', {
        current,
        total
      });
    }
    return null;
  };
  const detailText = detail ? detailLabel(detail) : null;
  const known = typeof percent === 'number';

  return (
    <div
      data-testid="upload-progress"
      className="mb-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0" aria-live="polite">
          <p className="truncate font-medium text-gray-900 dark:text-gray-100" title={fileName}>
            {fileName}
          </p>
          <p className="text-gray-600 dark:text-gray-300">
            {stageText || t('components.uploader.processing', 'Processing file...')}
            {detailText && (
              // Not announced: it changes every page, and the progress bar says how far it is
              <span
                aria-hidden="true"
                className="ml-2 tabular-nums text-gray-500 dark:text-gray-400"
              >
                {detailText}
              </span>
            )}
            {total > 1 && (
              <span className="ml-2 text-gray-500 dark:text-gray-400">
                {t('components.uploader.fileOfTotal', 'File {{current}} of {{total}}', {
                  current: index + 1,
                  total
                })}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onStop}
          aria-label={t('components.uploader.stopProcessing', 'Stop processing {{fileName}}', {
            fileName
          })}
          className="shrink-0 rounded-md border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {t('components.uploader.stop', 'Stop')}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={t('components.uploader.progressFor', 'Progress of {{fileName}}', {
            fileName
          })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? Math.round(percent) : undefined}
          className="h-2 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        >
          <div
            className={`h-full rounded-full bg-indigo-600 dark:bg-indigo-500 ${
              known ? 'transition-all duration-300 ease-out' : 'upload-progress-indeterminate'
            }`}
            style={known ? { width: `${percent}%` } : undefined}
          />
        </div>
        {known && (
          <span className="w-10 text-right text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {Math.round(percent)}%
          </span>
        )}
      </div>
    </div>
  );
};

export default ProcessingProgress;
