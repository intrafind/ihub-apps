import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import Icon from '../../../shared/components/Icon';
import InputVariables from './InputVariables';
import UnifiedUploader from '../../upload/components/UnifiedUploader';
import AttachedFilesList from '../../upload/components/AttachedFilesList';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { getMissingRequiredVariables } from '../utils/startForm';

/**
 * The form a new chat of an app with `startForm.enabled` opens with (issue
 * #2581): the app's variables, a drop zone when uploads are on, and a send
 * button. The chat composer takes over once it is sent.
 *
 * @param {Object} props
 * @param {Object} props.app - App config
 * @param {Array<Object>} props.localizedVariables - `app.variables` with localized labels
 * @param {Object} props.variables - Variable name → entered value
 * @param {Function} props.onVariablesChange - Receives the new variables object
 * @param {string} [props.message=''] - Text the chat was opened with (`?prefill=`),
 *   sent as the template's `{{content}}`; its field only shows when there is some
 * @param {Function} [props.onMessageChange] - Receives the edited text
 * @param {Object} props.uploadConfig - From `useFileUploadHandler().createUploadConfig`
 * @param {Object|Array|null} props.selectedFile - Attached file(s)
 * @param {Function} props.onFileSelect - Receives the new file selection (or null)
 * @param {Function} props.onSubmit - Called with the submit event once the form is valid
 * @param {boolean} [props.canSubmit=true] - False while there is nothing to send yet
 * @param {boolean} [props.isProcessing=false]
 * @param {Object|string|null} [props.welcomeMessage] - The app greeting (`{ title, subtitle }`
 *   or a plain title)
 * @param {string|null} [props.errorMessage] - Shown above the send button
 * @param {string} props.currentLanguage
 */
function ChatStartForm({
  app,
  localizedVariables,
  variables,
  onVariablesChange,
  message = '',
  onMessageChange,
  uploadConfig,
  selectedFile,
  onFileSelect,
  onSubmit,
  canSubmit = true,
  isProcessing = false,
  welcomeMessage = null,
  errorMessage = null,
  currentLanguage
}) {
  const { t } = useTranslation();
  const openDialogRef = useRef(null);
  const [missing, setMissing] = useState([]);
  // Stays once shown, so clearing the prefilled text does not remove its field.
  const [messageEdited, setMessageEdited] = useState(false);
  const showMessage = Boolean(message) || messageEdited;

  const files = useMemo(
    () => (!selectedFile ? [] : Array.isArray(selectedFile) ? selectedFile : [selectedFile]),
    [selectedFile]
  );
  const uploadEnabled = uploadConfig?.localUploadEnabled === true;
  const submitLabel =
    getLocalizedContent(app?.startForm?.submitLabel, currentLanguage) ||
    t('pages.appChat.startForm.submit', 'Start');

  const greeting =
    typeof welcomeMessage === 'string'
      ? { title: welcomeMessage, subtitle: '' }
      : welcomeMessage && typeof welcomeMessage === 'object'
        ? { title: welcomeMessage.title || '', subtitle: welcomeMessage.subtitle || '' }
        : null;

  const handleVariablesChange = next => {
    onVariablesChange(next);
    if (missing.length > 0) {
      setMissing(getMissingRequiredVariables(app, next).map(v => v.name));
    }
  };

  const handleSubmit = e => {
    e.preventDefault();
    if (isProcessing || !canSubmit) return;
    // The inputs carry `required`, but a value of only spaces passes the
    // browser's own check.
    const missingNow = getMissingRequiredVariables(app, variables);
    setMissing(missingNow.map(v => v.name));
    if (missingNow.length > 0) return;
    onSubmit(e);
  };

  const handleRemoveFile = index => {
    const updated = files.filter((_, i) => i !== index);
    onFileSelect(updated.length === 0 ? null : updated.length === 1 ? updated[0] : updated);
  };

  const missingLabels = localizedVariables
    .filter(v => missing.includes(v.name))
    .map(v => v.localizedLabel);

  const card = (
    <form
      onSubmit={handleSubmit}
      className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-4 sm:p-6 space-y-5"
      data-testid="start-form"
    >
      {greeting && (greeting.title || greeting.subtitle) && (
        <div className="text-center">
          {greeting.title && (
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              {greeting.title}
            </h3>
          )}
          {greeting.subtitle && (
            <p
              className="mt-1 text-sm text-gray-500 dark:text-gray-400"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(marked.parseInline(greeting.subtitle))
              }}
            />
          )}
        </div>
      )}

      <InputVariables
        variables={variables}
        setVariables={handleVariablesChange}
        localizedVariables={localizedVariables}
      />

      {showMessage && (
        <div className="flex flex-col">
          <label
            htmlFor="start-form-message"
            className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('pages.appChat.startForm.message', 'Message')}
          </label>
          <textarea
            id="start-form-message"
            value={message}
            onChange={e => {
              setMessageEdited(true);
              onMessageChange?.(e.target.value);
            }}
            rows={3}
            className="p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-sm focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      )}

      {uploadEnabled && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('pages.appChat.startForm.attachments', 'Attachments')}
          </span>
          <button
            type="button"
            onClick={() => openDialogRef.current?.()}
            disabled={isProcessing}
            className="w-full flex flex-col items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:text-indigo-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Icon name="paper-clip" size="lg" className="text-current" />
            <span>
              {t(
                'pages.appChat.startForm.dropZone',
                'Drag and drop files here, or click to browse'
              )}
            </span>
          </button>
          {files.length > 0 && (
            <AttachedFilesList
              files={files}
              onRemoveFile={handleRemoveFile}
              onRemoveAll={() => onFileSelect(null)}
              disabled={isProcessing}
            />
          )}
        </div>
      )}

      {missingLabels.length > 0 && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('error.missingRequiredFields', 'Please fill in all required fields:')}{' '}
          {missingLabels.join(', ')}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isProcessing || !canSubmit}
          className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );

  // With uploads on, the whole card is the drop target: a file dropped next
  // to the dashed zone would otherwise be opened by the browser instead.
  return uploadEnabled ? (
    <UnifiedUploader
      onFileSelect={onFileSelect}
      disabled={isProcessing}
      fileData={selectedFile}
      config={uploadConfig}
      openDialogRef={openDialogRef}
    >
      {card}
    </UnifiedUploader>
  ) : (
    card
  );
}

export default ChatStartForm;
