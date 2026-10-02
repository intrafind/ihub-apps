import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatBytes, validateUpload } from '../utils/verifyResult';

/**
 * Input of the `/verify` page: a file (drop zone or picker) or pasted text.
 *
 * Only collects and validates the input; the page sends it to
 * `POST /api/provenance/verify`.
 *
 * @param {Object} props
 * @param {number} [props.maxUploadMB] - Upload limit from `GET /api/provenance/info`
 * @param {boolean} [props.canUseTextDetection=false] - Whether text watermarks are checked for this viewer
 * @param {boolean} [props.busy=false] - A check is running
 * @param {(input: {file?: File, text?: string}) => void} props.onSubmit
 * @returns {JSX.Element}
 */
function VerifyContentForm({ maxUploadMB, canUseTextDetection = false, busy = false, onSubmit }) {
  const { t } = useTranslation();
  const baseId = useId();
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [validationError, setValidationError] = useState(null);

  const fileInputId = `${baseId}-file`;
  const fileHintId = `${baseId}-file-hint`;
  const textId = `${baseId}-text`;
  const textHintId = `${baseId}-text-hint`;
  const modeLabelId = `${baseId}-mode`;
  const privacyId = `${baseId}-privacy`;

  const describeValidation = reason => {
    if (reason === 'tooLarge') {
      return t('verify.input.fileTooLarge', {
        max: maxUploadMB,
        defaultValue: 'The file is larger than {{max}} MB.'
      });
    }
    return t('verify.input.fileEmpty', 'The file is empty.');
  };

  const pickFile = candidate => {
    if (!candidate) return;
    const reason = validateUpload(candidate, maxUploadMB);
    setValidationError(reason ? describeValidation(reason) : null);
    setFile(reason ? null : candidate);
  };

  const clearFile = () => {
    setFile(null);
    setValidationError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.focus();
  };

  const handleDrop = event => {
    event.preventDefault();
    setDragOver(false);
    if (busy) return;
    pickFile(event.dataTransfer?.files?.[0] || null);
  };

  const canSubmit = !busy && (mode === 'file' ? Boolean(file) : text.trim().length > 0);

  const handleSubmit = event => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(mode === 'file' ? { file } : { text });
  };

  const modeButtonClass = active =>
    `px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
      active
        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
        : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
    }`;

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-describedby={privacyId}>
      <div className="flex flex-wrap items-center gap-3">
        <span id={modeLabelId} className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('verify.input.modeLabel', 'What do you want to check?')}
        </span>
        <div
          role="group"
          aria-labelledby={modeLabelId}
          className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-900 p-1 gap-1"
        >
          <button
            type="button"
            aria-pressed={mode === 'file'}
            onClick={() => setMode('file')}
            className={modeButtonClass(mode === 'file')}
            disabled={busy}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="upload" size="sm" />
              {t('verify.input.modeFile', 'A file')}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'text'}
            onClick={() => setMode('text')}
            className={modeButtonClass(mode === 'text')}
            disabled={busy}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="document-text" size="sm" />
              {t('verify.input.modeText', 'Pasted text')}
            </span>
          </button>
        </div>
      </div>

      {mode === 'file' ? (
        <div>
          <div
            onDragOver={event => {
              event.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
              dragOver
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40'
            }`}
          >
            <Icon name="cloud-arrow-up" size="xl" className="text-gray-400 dark:text-gray-500" />
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('verify.input.dropTitle', 'Drag a file here, or')}
            </p>
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              className="sr-only peer"
              aria-describedby={fileHintId}
              disabled={busy}
              onChange={event => pickFile(event.target.files?.[0] || null)}
            />
            <label
              htmlFor={fileInputId}
              className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-semibold text-white peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-800"
            >
              <Icon name="folder-open" size="sm" />
              {t('verify.input.chooseFile', 'Choose a file')}
            </label>
            <p id={fileHintId} className="text-xs text-gray-600 dark:text-gray-400">
              {t('verify.input.fileHint', {
                max: maxUploadMB,
                defaultValue:
                  'Images, PDF, Word, PowerPoint, Excel, HTML, text or JSON — up to {{max}} MB'
              })}
            </p>
          </div>

          {file && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2">
              <Icon name="document" size="md" className="text-gray-500 dark:text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('verify.input.selectedFile', 'Selected file')}
                </p>
                <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {file.name}
                  <span className="ml-2 font-normal text-gray-600 dark:text-gray-400">
                    {formatBytes(file.size)}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={clearFile}
                disabled={busy}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                aria-label={t('verify.input.removeFile', {
                  name: file.name,
                  defaultValue: 'Remove {{name}}'
                })}
              >
                <Icon name="x-mark" size="sm" />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <label
            htmlFor={textId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('verify.input.textLabel', 'Text to check')}
          </label>
          <textarea
            id={textId}
            value={text}
            onChange={event => setText(event.target.value)}
            rows={8}
            disabled={busy}
            placeholder={t('verify.input.textPlaceholder', 'Paste the text you want to check')}
            aria-describedby={textHintId}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
          />
          <p id={textHintId} className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {canUseTextDetection
              ? t(
                  'verify.input.textHintExpert',
                  'Checks the text signpost, provenance records and the text watermark of self-hosted models.'
                )
              : t(
                  'verify.input.textHint',
                  'Checks the text signpost and provenance records. Text watermarks can only be checked by approved experts.'
                )}
          </p>
        </div>
      )}

      {validationError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {validationError}
        </p>
      )}

      <p id={privacyId} className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
        <Icon name="lock-closed" size="sm" className="mt-0.5 flex-none" />
        <span>
          {t(
            'verify.input.privacy',
            'The content is checked and discarded right away — it is not stored.'
          )}
        </span>
      </p>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-400 dark:disabled:bg-gray-600"
      >
        {busy ? (
          <>
            <span
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden="true"
            />
            {t('verify.input.checking', 'Checking…')}
          </>
        ) : (
          <>
            <Icon name="magnifying-glass" size="sm" />
            {t('verify.input.submit', 'Check content')}
          </>
        )}
      </button>
    </form>
  );
}

export default VerifyContentForm;
