import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useChatPersistence } from '../../../shared/hooks/useChats';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  requestExport,
  requestExportText,
  signClipboardText
} from '../../../api/endpoints/exports';
import { writeTextToClipboard } from '../../../shared/utils/clipboardText';
import {
  COPYABLE_EXPORT_FORMATS,
  EXPORT_FORMATS,
  PDF_TEMPLATES,
  buildChatExportRequest,
  buildExportTitle,
  describeExportError,
  getEuIconMode,
  getExportableMessages,
  getMessageKey,
  getMessagePreview,
  isHumanReviewOptionAvailable,
  shouldSignClipboardCopy,
  toIsoTimestamp,
  toggleMessageSelection
} from '../utils/exportRequest';

/** Icon per export format in the format grid. */
const FORMAT_ICONS = {
  pdf: 'file-text',
  docx: 'document-text',
  pptx: 'presentation-chart-bar',
  xlsx: 'table-cells',
  csv: 'document-text',
  txt: 'document-text',
  markdown: 'code',
  html: 'code',
  json: 'code',
  jsonl: 'code'
};

/** English fallbacks of the format names/descriptions (`pages.appChat.export.formats.*`). */
const FORMAT_FALLBACKS = {
  pdf: { name: 'PDF Document', description: 'Formatted PDF with styling options' },
  docx: { name: 'Word Document', description: 'Microsoft Word document' },
  pptx: { name: 'PowerPoint', description: 'PowerPoint presentation with slides' },
  xlsx: { name: 'Excel Spreadsheet', description: 'Excel workbook with structured data' },
  csv: { name: 'CSV File', description: 'Comma-separated values' },
  txt: { name: 'Text File', description: 'Plain text format' },
  markdown: { name: 'Markdown', description: 'Markdown formatted text' },
  html: { name: 'HTML', description: 'HTML document' },
  json: { name: 'JSON', description: 'JSON format with metadata' },
  jsonl: { name: 'JSON Lines', description: 'JSON Lines format' }
};

/**
 * Export a conversation (or one message) through the server.
 *
 * Every file is rendered, AI-labelled and signed by `POST /api/exports`
 * (EU AI Act Art. 50(2), issues #2571/#2576). The dialog only collects the
 * choices — which messages, format, PDF template, EU AI icon, editorial
 * responsibility — and saves the file the server returns. "Copy" requests the
 * same export in a text format and puts it on the clipboard.
 *
 * The request shape (stored chat → message ids, otherwise the message
 * content) is decided in `features/chat/utils/exportRequest.js`.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Render the dialog
 * @param {Function} props.onClose - Close handler
 * @param {Object[]} [props.messages=[]] - The conversation as the chat renders it
 * @param {Object} [props.settings={}] - `{ model, style, outputFormat, temperature, variables }`
 * @param {string} [props.appId] - App the conversation belongs to
 * @param {string} [props.chatId] - Chat id (used to export a stored chat by message ids)
 * @param {boolean} [props.isSingleMessage=false] - Export exactly `messages[0]`, no selection list
 * @param {Object} [props.app] - App config (localized name, per-app signpost override)
 * @param {string} [props.conversationTitle] - Title of the conversation, used as document title
 * @param {boolean} [props.serverBacked] - Whether the chat is stored server-side; defaults to
 *   the viewer's chat persistence (ids are only sent when every selected message has a `serverId`)
 * @returns {JSX.Element|null}
 */
function ExportDialog({
  isOpen,
  onClose,
  messages = [],
  settings = {},
  appId,
  chatId,
  isSingleMessage = false,
  app = null,
  conversationTitle = null,
  serverBacked
}) {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig() || {};
  const chatPersistence = useChatPersistence();
  const currentLanguage = i18n.language || 'en';
  const aiConfig = platformConfig?.aiTransparency || null;
  const baseId = useId();

  const [selectedFormat, setSelectedFormat] = useState('pdf');
  const [template, setTemplate] = useState('default');
  const [euIconChecked, setEuIconChecked] = useState(false);
  const [humanReviewed, setHumanReviewed] = useState(false);
  // Messages the user unticked; everything else is selected, so a message that
  // arrives while the dialog is open is included by default.
  const [excludedKeys, setExcludedKeys] = useState(() => new Set());
  const [anchorKey, setAnchorKey] = useState(null);
  const [phase, setPhase] = useState('idle'); // 'idle' | 'exporting' | 'copying'
  const [statusMessage, setStatusMessage] = useState('');
  const [exportError, setExportError] = useState(null);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef(null);
  const wasOpenRef = useRef(false);
  const busy = phase !== 'idle';

  useFocusTrap(dialogRef, {
    isActive: isOpen,
    returnFocusOnDeactivate: true
  });

  // Every opening starts from "all messages selected" and a clean status.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setExcludedKeys(new Set());
      setAnchorKey(null);
      setExportError(null);
      setStatusMessage('');
      setCopied(false);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, busy, onClose]);

  const exportableMessages = useMemo(() => getExportableMessages(messages), [messages]);
  const messageKeys = useMemo(
    () => exportableMessages.map((message, index) => getMessageKey(message, index)),
    [exportableMessages]
  );
  const selectedKeys = useMemo(
    () => new Set(messageKeys.filter(key => !excludedKeys.has(key))),
    [messageKeys, excludedKeys]
  );
  const selectedMessages = useMemo(
    () =>
      isSingleMessage
        ? exportableMessages
        : exportableMessages.filter((_, index) => selectedKeys.has(messageKeys[index])),
    [isSingleMessage, exportableMessages, selectedKeys, messageKeys]
  );

  if (!isOpen) return null;

  const euIconMode = getEuIconMode(aiConfig);
  const humanReviewAvailable = isHumanReviewOptionAvailable(aiConfig);
  const serverLabelled = aiConfig?.enabled === true && aiConfig?.labels?.exportLabel !== false;
  const canCopySelectedFormat = COPYABLE_EXPORT_FORMATS.includes(selectedFormat);
  const nothingSelected = selectedMessages.length === 0;
  const isServerBacked = typeof serverBacked === 'boolean' ? serverBacked : chatPersistence;

  const appName = app?.name
    ? getLocalizedContent(app.name, currentLanguage)
    : uiConfig?.title
      ? getLocalizedContent(uiConfig.title, currentLanguage)
      : 'iHub Apps';

  /**
   * The request body for the chosen format and options.
   * @param {string} format
   * @returns {Object}
   */
  const buildRequest = format =>
    buildChatExportRequest({
      format,
      messages: selectedMessages,
      serverBacked: isServerBacked,
      chatId,
      appId,
      title: conversationTitle,
      fallbackTitle: buildExportTitle({
        appName,
        messages: selectedMessages,
        single: isSingleMessage,
        labels: {
          message: t('pages.appChat.export.document.message', 'Message'),
          chat: t('pages.appChat.export.document.chat', 'Chat')
        }
      }),
      settings,
      template,
      euIcon: euIconMode === 'always' || (euIconMode === 'optional' && euIconChecked),
      humanReviewed: humanReviewAvailable && humanReviewed,
      single: isSingleMessage
    });

  const showError = error => {
    const { key, fallback, params } = describeExportError(error);
    setExportError(t(key, { defaultValue: fallback, ...(params || {}) }));
  };

  const handleCopy = async () => {
    setCopied(false);
    setExportError(null);
    if (!canCopySelectedFormat) {
      setExportError(
        t(
          'pages.appChat.export.copyNotSupported',
          'Copy not supported for this format. Please use download instead.'
        )
      );
      return;
    }

    const format = selectedFormat;
    setPhase('copying');
    setStatusMessage(
      t('pages.appChat.export.status.copying', 'Preparing the text for the clipboard…')
    );
    try {
      const body = buildRequest(format);
      await writeTextToClipboard(async () => {
        const text = await requestExportText(body);
        if (!shouldSignClipboardCopy({ format, text, aiConfig, app })) return text;
        try {
          return await signClipboardText(text, appId);
        } catch (signError) {
          // The signpost is an extra layer, never the only one: copy the
          // labelled export text rather than nothing.
          console.warn('Clipboard signpost unavailable:', signError);
          return text;
        }
      });
      setCopied(true);
      setStatusMessage(t('pages.appChat.export.status.copied', 'Copied to the clipboard.'));
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Copy to clipboard failed:', error);
      setStatusMessage('');
      showError(error);
    } finally {
      setPhase('idle');
    }
  };

  const handleExport = async () => {
    setExportError(null);
    setPhase('exporting');
    setStatusMessage(t('pages.appChat.export.status.preparing', 'Preparing the export…'));
    try {
      const { filename } = await requestExport(buildRequest(selectedFormat));
      setStatusMessage(
        t('pages.appChat.export.status.downloaded', {
          filename,
          defaultValue: 'Export downloaded: {{filename}}'
        })
      );
      setTimeout(() => {
        onClose?.();
      }, 500);
    } catch (error) {
      console.error(`Export to ${selectedFormat} failed:`, error);
      setStatusMessage('');
      showError(error);
    } finally {
      setPhase('idle');
    }
  };

  const handleToggleMessage = (key, event) => {
    const range = event?.nativeEvent?.shiftKey === true;
    const next = toggleMessageSelection({
      keys: messageKeys,
      selected: selectedKeys,
      key,
      anchorKey,
      range
    });
    setExcludedKeys(new Set(messageKeys.filter(k => !next.has(k))));
    setAnchorKey(key);
  };

  const selectAll = () => {
    setExcludedKeys(new Set());
    setAnchorKey(null);
  };

  const selectNone = () => {
    setExcludedKeys(new Set(messageKeys));
    setAnchorKey(null);
  };

  const roleLabel = role => {
    if (role === 'user') return t('pages.appChat.export.messages.roleUser', 'You');
    if (role === 'system') return t('pages.appChat.export.messages.roleSystem', 'System');
    return t('pages.appChat.export.messages.roleAssistant', 'Assistant');
  };

  const formatTimestamp = message => {
    const iso = toIsoTimestamp(message.ts ?? message.timestamp ?? message.createdAt);
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(currentLanguage, {
        dateStyle: 'short',
        timeStyle: 'short'
      });
    } catch {
      return '';
    }
  };

  const exportFormats = EXPORT_FORMATS.map(id => ({
    id,
    icon: FORMAT_ICONS[id] || 'document-text',
    name: t(`pages.appChat.export.formats.${id}`, FORMAT_FALLBACKS[id]?.name || id),
    description: t(
      `pages.appChat.export.descriptions.${id}`,
      FORMAT_FALLBACKS[id]?.description || id
    )
  }));

  const templateLabels = {
    default: t('pages.appChat.export.templateDefault', 'Default'),
    professional: t('pages.appChat.export.templateProfessional', 'Professional'),
    minimal: t('pages.appChat.export.templateMinimal', 'Minimal')
  };

  const formatGroupId = `${baseId}-formats`;
  const messagesHeadingId = `${baseId}-messages`;
  const selectionCountId = `${baseId}-selection-count`;
  const optionsHeadingId = `${baseId}-options`;
  const templateId = `${baseId}-template`;
  const euIconId = `${baseId}-eu-icon`;
  const humanReviewedId = `${baseId}-human-reviewed`;
  const humanReviewedHintId = `${baseId}-human-reviewed-hint`;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={e => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        aria-busy={busy}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2
            id="export-dialog-title"
            className="text-xl font-semibold text-gray-900 dark:text-gray-100"
          >
            {isSingleMessage
              ? t('pages.appChat.export.dialogTitleSingleMessage', 'Export Message')
              : t('pages.appChat.export.dialogTitle', 'Export Conversation')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            disabled={busy}
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x-mark" size="md" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Message selection */}
          {!isSingleMessage && (
            <section className="mb-6" aria-labelledby={messagesHeadingId}>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <h3
                  id={messagesHeadingId}
                  className="text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('pages.appChat.export.messages.heading', 'Messages to export')}
                </h3>
                {exportableMessages.length > 0 && (
                  <div className="flex items-center gap-3 text-xs">
                    <span id={selectionCountId} className="text-gray-600 dark:text-gray-400">
                      {t('pages.appChat.export.messages.selectedCount', {
                        count: selectedMessages.length,
                        total: exportableMessages.length,
                        defaultValue: '{{count}} of {{total}} selected'
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={selectAll}
                      disabled={busy || excludedKeys.size === 0}
                      className="font-medium text-blue-700 dark:text-blue-300 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                    >
                      {t('pages.appChat.export.messages.selectAll', 'Select all')}
                    </button>
                    <button
                      type="button"
                      onClick={selectNone}
                      disabled={busy || nothingSelected}
                      className="font-medium text-blue-700 dark:text-blue-300 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                    >
                      {t('pages.appChat.export.messages.selectNone', 'Select none')}
                    </button>
                  </div>
                )}
              </div>

              {exportableMessages.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('pages.appChat.export.messages.empty', 'There are no messages to export yet.')}
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t(
                      'pages.appChat.export.messages.rangeHint',
                      'Tip: hold Shift while clicking to select or clear a range.'
                    )}
                  </p>
                  <ul
                    className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700"
                    aria-describedby={selectionCountId}
                  >
                    {exportableMessages.map((message, index) => {
                      const key = messageKeys[index];
                      const inputId = `${baseId}-message-${index}`;
                      const timestamp = formatTimestamp(message);
                      return (
                        <li key={key}>
                          <label
                            htmlFor={inputId}
                            className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          >
                            <input
                              id={inputId}
                              type="checkbox"
                              checked={selectedKeys.has(key)}
                              onChange={event => handleToggleMessage(key, event)}
                              disabled={busy}
                              className="mt-1 h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="flex-1 min-w-0">
                              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                                {roleLabel(message.role)}
                                {timestamp && (
                                  <span className="font-normal text-gray-500 dark:text-gray-400">
                                    {' · '}
                                    {timestamp}
                                  </span>
                                )}
                              </span>
                              <span className="block text-sm text-gray-900 dark:text-gray-100 truncate">
                                {getMessagePreview(message)}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          )}

          {/* Format Selection */}
          <div className="mb-6">
            <h3
              id={formatGroupId}
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3"
            >
              {t('pages.appChat.export.selectFormat', 'Select export format')}
            </h3>
            <div
              role="group"
              aria-labelledby={formatGroupId}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              {exportFormats.map(format => (
                <button
                  type="button"
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  disabled={busy}
                  aria-pressed={selectedFormat === format.id}
                  className={`p-3 sm:p-4 rounded-lg border-2 text-left transition-all ${
                    selectedFormat === format.id
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  } ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className="flex items-start gap-3">
                    <Icon
                      name={format.icon}
                      size="md"
                      className={
                        selectedFormat === format.id
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-gray-500'
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`font-medium mb-1 ${
                          selectedFormat === format.id
                            ? 'text-blue-900 dark:text-blue-100'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {format.name}
                      </div>
                      {format.description && (
                        <div className="text-xs text-gray-600 dark:text-gray-400">
                          {format.description}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* PDF Options */}
          {selectedFormat === 'pdf' && (
            <div className="mb-4 space-y-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t('pages.appChat.export.pdfOptions', 'PDF Options')}
              </h3>
              <div>
                <label
                  htmlFor={templateId}
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  {t('pages.appChat.export.template', 'Template')}
                </label>
                <select
                  id={templateId}
                  value={template}
                  onChange={e => setTemplate(e.target.value)}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  disabled={busy}
                >
                  {PDF_TEMPLATES.map(id => (
                    <option key={id} value={id}>
                      {templateLabels[id]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* AI label options (EU AI Act Art. 50) */}
          {(euIconMode !== 'off' || humanReviewAvailable) && (
            <div
              role="group"
              aria-labelledby={optionsHeadingId}
              className="mb-4 space-y-3 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg"
            >
              <h3
                id={optionsHeadingId}
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t('pages.appChat.export.options.heading', 'AI label')}
              </h3>
              {euIconMode !== 'off' && (
                <div className="flex items-start gap-3">
                  <input
                    id={euIconId}
                    type="checkbox"
                    checked={euIconMode === 'always' || euIconChecked}
                    disabled={busy || euIconMode === 'always'}
                    onChange={e => setEuIconChecked(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <label htmlFor={euIconId} className="text-sm text-gray-800 dark:text-gray-200">
                    {t('pages.appChat.export.options.euIcon', 'Add the EU AI icon')}
                    {euIconMode === 'always' && (
                      <span className="block text-xs text-gray-600 dark:text-gray-400">
                        {t(
                          'pages.appChat.export.options.euIconAlways',
                          'This installation always adds the EU AI icon.'
                        )}
                      </span>
                    )}
                  </label>
                </div>
              )}
              {humanReviewAvailable && (
                <div className="flex items-start gap-3">
                  <input
                    id={humanReviewedId}
                    type="checkbox"
                    checked={humanReviewed}
                    disabled={busy}
                    onChange={e => setHumanReviewed(e.target.checked)}
                    aria-describedby={humanReviewedHintId}
                    className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <label
                    htmlFor={humanReviewedId}
                    className="text-sm text-gray-800 dark:text-gray-200"
                  >
                    {t(
                      'pages.appChat.export.options.humanReviewed',
                      'Reviewed by a human (editorial responsibility)'
                    )}
                    <span
                      id={humanReviewedHintId}
                      className="block text-xs text-gray-600 dark:text-gray-400"
                    >
                      {t(
                        'pages.appChat.export.options.humanReviewedHint',
                        'Declares that a person reviewed the content and takes editorial responsibility for it.'
                      )}
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {serverLabelled && (
            <p className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
              <Icon name="information-circle" size="sm" className="mt-0.5 flex-none" />
              <span>
                {t(
                  'pages.appChat.export.serverNote',
                  'The file is created on the server and labelled as AI-generated content.'
                )}
              </span>
            </p>
          )}

          {/* Progress (polite) and errors (assertive) */}
          <p
            role="status"
            aria-live="polite"
            className={statusMessage ? 'mt-4 text-sm text-gray-700 dark:text-gray-300' : 'sr-only'}
          >
            {statusMessage}
          </p>
          {exportError && (
            <div
              role="alert"
              className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
            >
              <div className="flex items-start gap-2">
                <Icon
                  name="exclamation-circle"
                  size="sm"
                  className="text-red-600 dark:text-red-400 mt-0.5"
                />
                <div className="text-sm text-red-800 dark:text-red-200">{exportError}</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={busy || nothingSelected || !canCopySelectedFormat}
            title={
              !canCopySelectedFormat
                ? t(
                    'pages.appChat.export.copyNotSupported',
                    'Copy not supported for this format. Please use download instead.'
                  )
                : undefined
            }
            className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {phase === 'copying' ? (
              <>
                <div
                  className="animate-spin rounded-full h-4 w-4 border-2 border-gray-500 border-t-transparent"
                  aria-hidden="true"
                ></div>
                {t('pages.appChat.export.copying', 'Copying…')}
              </>
            ) : copied ? (
              <>
                <Icon name="check" size="sm" />
                {t('pages.appChat.export.copied', 'Copied!')}
              </>
            ) : (
              <>
                <Icon name="clipboard" size="sm" />
                {t('pages.appChat.export.copy', 'Copy')}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={busy || nothingSelected}
            className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {phase === 'exporting' ? (
              <>
                <div
                  className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"
                  aria-hidden="true"
                ></div>
                {t('pages.appChat.export.exporting', 'Exporting...')}
              </>
            ) : (
              <>
                <Icon name="download" size="sm" />
                {t('pages.appChat.export.export', 'Export')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;
