import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { resetChatId } from '../../../utils/chatId';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';
import { useWorkflowExecution } from '../hooks';
import { HumanCheckpoint, ExecutionProgress, AppSelectionModal } from '../components';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';

/**
 * Helper to download content as a file
 */
const downloadAsFile = (content, filename, type = 'text/markdown') => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Helper to filter internal fields and get displayable output
 */
const getDisplayableOutput = data => {
  if (!data) return {};

  const internalFields = new Set([
    'nodeResults',
    '_nodeIterations',
    '_workflowDefinition',
    '_workflow',
    'pendingCheckpoint',
    '_pausedAt',
    '_pauseReason',
    '_resumedAt',
    '_modelOverride'
  ]);

  const output = {};
  for (const [key, value] of Object.entries(data)) {
    // Skip internal fields, underscore-prefixed, and human response variables
    if (
      internalFields.has(key) ||
      key.startsWith('_') ||
      key.startsWith('humanResponse_') ||
      key.startsWith('_humanResult_')
    ) {
      continue;
    }
    output[key] = value;
  }
  return output;
};

/**
 * Helper to render a value (handles strings, objects, arrays)
 * Automatically renders markdown content as formatted HTML
 */
const renderValue = value => {
  if (typeof value === 'string') {
    // Check if the string contains markdown formatting
    if (isMarkdown(value)) {
      // markdownToHtml uses marked which is already configured for the app
      // Content comes from workflow LLM responses which are trusted (same as chat)
      const html = markdownToHtml(value);
      return (
        <div
          className="prose dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-a:text-indigo-600 dark:prose-a:text-indigo-400 prose-code:bg-gray-100 dark:prose-code:bg-gray-800 prose-pre:bg-gray-50 dark:prose-pre:bg-gray-900"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    // Plain text - just show with whitespace preserved
    return <div className="prose dark:prose-invert max-w-none whitespace-pre-wrap">{value}</div>;
  }
  if (typeof value === 'object') {
    return (
      <pre className="text-sm bg-gray-50 dark:bg-gray-900 p-3 rounded overflow-auto">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return String(value);
};

/**
 * Truncation threshold for long string fields in accordion panels.
 * Fields exceeding this character count show a truncated preview with a toggle.
 */
const LONG_STRING_THRESHOLD = 500;

/**
 * Page for viewing and interacting with a single workflow execution.
 */
function WorkflowExecutionPage() {
  const { executionId } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [showAppSelection, setShowAppSelection] = useState(false);
  /** @type {[Set<string>, Function]} Tracks which output accordion panels are expanded */
  const [expandedOutputFields, setExpandedOutputFields] = useState(new Set());
  /** @type {[Set<string>, Function]} Tracks which long string fields are fully shown */
  const [fullyShownFields, setFullyShownFields] = useState(new Set());
  /** @type {[Set<string>, Function]} Tracks fields with active "copied" feedback */
  const [copiedFields, setCopiedFields] = useState(new Set());
  /** @type {[boolean, Function]} Tracks whether the additional data section is expanded */
  const [additionalDataExpanded, setAdditionalDataExpanded] = useState(false);

  const { state, loading, connected, error, respondToCheckpoint, cancelExecution, refetch } =
    useWorkflowExecution(executionId);

  /**
   * Toggle an output field's accordion panel open/closed.
   * @param {string} fieldKey - The output field key to toggle
   */
  const toggleOutputField = fieldKey => {
    setExpandedOutputFields(prev => {
      const next = new Set(prev);
      if (next.has(fieldKey)) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  /**
   * Toggle whether a long string field is shown in full or truncated.
   * @param {string} fieldKey - The output field key to toggle
   */
  const toggleFullyShown = fieldKey => {
    setFullyShownFields(prev => {
      const next = new Set(prev);
      if (next.has(fieldKey)) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  /**
   * Copy the stringified value of an output field to the clipboard.
   * Shows a brief "copied" indicator on the corresponding button.
   * @param {string} fieldKey - The output field key
   * @param {*} value - The value to copy (strings are copied as-is, objects are JSON-stringified)
   */
  const copyToClipboard = async (fieldKey, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFields(prev => new Set(prev).add(fieldKey));
      setTimeout(() => {
        setCopiedFields(prev => {
          const next = new Set(prev);
          next.delete(fieldKey);
          return next;
        });
      }, 2000);
    } catch {
      // Fallback: clipboard API may not be available in all contexts
    }
  };

  const handleStartChatWithResults = app => {
    const workflowDef = state?.data?._workflowDefinition;
    const output = getDisplayableOutput(state?.data);

    // 1. Determine the primary output text (assistant message)
    let outputText = '';
    const primaryOutputKey = workflowDef?.chatIntegration?.primaryOutput;
    if (primaryOutputKey && state?.data?.[primaryOutputKey]) {
      const val = state.data[primaryOutputKey];
      outputText = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    } else {
      // Fallback: pick the longest string field (reports are longer than inputs)
      const keys = Object.keys(output);
      for (const key of keys) {
        if (typeof output[key] === 'string' && output[key].length > outputText.length) {
          outputText = output[key];
        }
      }
      if (!outputText && keys.length > 0) {
        outputText = JSON.stringify(output, null, 2);
      }
    }

    // 2. Determine the user's original input (user message)
    let userInput = '';
    const startNode = workflowDef?.nodes?.find(n => n.type === 'start');
    const inputVars = startNode?.config?.inputVariables;
    if (inputVars?.length > 0) {
      const parts = inputVars
        .map(v => state?.data?.[v.name])
        .filter(v => typeof v === 'string' && v.length > 0);
      userInput = parts.join('\n\n');
    }

    // Start a fresh chat session for this app
    const newChatId = resetChatId(app.id);

    // Pre-seed with a context user message + completed assistant message
    const now = Date.now();
    const messages = [
      {
        id: `user-${now}-wf`,
        role: 'user',
        content:
          userInput ||
          t(
            'workflows.chatWithResults.contextMessage',
            'Here are the results from the workflow "{{name}}":',
            {
              name: workflowName
            }
          )
      },
      {
        id: `msg-${now}-wf`,
        role: 'assistant',
        content: outputText,
        loading: false
      }
    ];

    // Write to sessionStorage so AppChat picks them up on mount
    sessionStorage.setItem(`ai_hub_chat_messages_${newChatId}`, JSON.stringify(messages));

    setShowAppSelection(false);
    navigate(`/apps/${app.id}`);
  };

  const handleCancel = async () => {
    if (
      window.confirm(t('workflows.confirmCancel', 'Are you sure you want to cancel this workflow?'))
    ) {
      await cancelExecution();
    }
  };

  const handleBack = () => {
    navigate('/workflows');
  };

  const handleExportState = () => {
    // Open the export endpoint in a new tab to trigger download
    const exportUrl = buildApiUrl(`workflows/executions/${executionId}/export`);
    window.open(exportUrl, '_blank');
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <LoadingSpinner message={t('workflows.loadingExecution', 'Loading execution...')} />
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center py-12">
          <Icon name="exclamation-triangle" className="w-16 h-16 mx-auto text-red-400 mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            {t('workflows.executionNotFound.title', 'Execution Not Found')}
          </h2>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            {error ||
              t('workflows.executionNotFound.description', 'This execution could not be found.')}
          </p>
          <button
            onClick={handleBack}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            {t('workflows.backToWorkflows', 'Back to Workflows')}
          </button>
        </div>
      </div>
    );
  }

  const workflowName = state.workflowName
    ? getLocalizedContent(state.workflowName, currentLanguage)
    : state.workflowId;

  const isActive = state.status === 'running' || state.status === 'paused';
  const hasCheckpoint = !!state.pendingCheckpoint;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-6">
        <Link
          to="/workflows"
          className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 flex items-center gap-1"
        >
          <Icon name="arrow-left" className="w-4 h-4" />
          {t('workflows.backToWorkflows', 'Back to Workflows')}
        </Link>
      </nav>

      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{workflowName}</h1>
              {/* Connection indicator */}
              {isActive && (
                <span
                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                    connected
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full mr-1 ${connected ? 'bg-green-500' : 'bg-gray-400'}`}
                  />
                  {connected
                    ? t('workflows.connected', 'Connected')
                    : t('workflows.disconnected', 'Disconnected')}
                </span>
              )}
            </div>

            <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
              <span>
                {t('workflows.executionId', 'Execution')}: {state.executionId.slice(0, 16)}...
              </span>
              {state.startedAt && (
                <span>
                  {t('workflows.startedAt', 'Started')}:{' '}
                  {new Date(state.startedAt).toLocaleString(currentLanguage)}
                </span>
              )}
              {state.completedAt && (
                <span>
                  {t('workflows.completedAt', 'Completed')}:{' '}
                  {new Date(state.completedAt).toLocaleString(currentLanguage)}
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-red-600 border border-red-300 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2"
              >
                <Icon name="x-mark" className="w-4 h-4" />
                {t('workflows.cancel', 'Cancel')}
              </button>
            )}
            {(state.status === 'completed' || state.status === 'approved') && (
              <button
                onClick={() => setShowAppSelection(true)}
                className="px-4 py-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-gray-700 border border-indigo-300 dark:border-indigo-600 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors flex items-center gap-2"
                title={t(
                  'workflows.chatWithResults.title',
                  'Continue chatting with the workflow output in an app'
                )}
              >
                <Icon name="chat-bubble-left-right" className="w-4 h-4" />
                {t('workflows.chatWithResults.button', 'Chat with Results')}
              </button>
            )}
            <button
              onClick={handleExportState}
              className="px-4 py-2 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors flex items-center gap-2"
              title={t('workflows.exportState', 'Export execution state for debugging')}
            >
              <Icon name="arrow-down-tray" className="w-4 h-4" />
              {t('workflows.export', 'Export')}
            </button>
            <button
              onClick={refetch}
              className="px-4 py-2 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors flex items-center gap-2"
              title={t('common.refresh', 'Refresh')}
            >
              <Icon name="arrow-path" className="w-4 h-4" />
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* Main content grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Progress panel */}
        <div>
          <ExecutionProgress state={state} nodes={state.data?._workflowDefinition?.nodes || []} />
        </div>

        {/* Right panel - Checkpoint or status */}
        <div>
          {hasCheckpoint ? (
            <HumanCheckpoint
              checkpoint={state.pendingCheckpoint}
              onRespond={respondToCheckpoint}
              displayData={state.pendingCheckpoint?.displayData}
            />
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                {t('workflows.status', 'Status')}
              </h3>

              {/* Status display */}
              <div className="flex items-center gap-3 mb-4">
                <span
                  className={`w-4 h-4 rounded-full ${
                    state.status === 'completed'
                      ? 'bg-green-500'
                      : state.status === 'approved'
                        ? 'bg-green-500'
                        : state.status === 'rejected'
                          ? 'bg-orange-500'
                          : state.status === 'failed'
                            ? 'bg-red-500'
                            : state.status === 'running'
                              ? 'bg-blue-500 animate-pulse'
                              : state.status === 'paused'
                                ? 'bg-yellow-500'
                                : state.status === 'cancelled'
                                  ? 'bg-gray-500'
                                  : 'bg-gray-400'
                  }`}
                />
                <span className="text-xl font-medium capitalize text-gray-900 dark:text-white">
                  {state.status}
                </span>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {state.data?.nodeInvocations || state.completedNodes?.length || 0}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('workflows.nodesExecuted', 'Executed')}
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                  <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                    {state.currentNodes?.length || 0}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('workflows.active', 'Active')}
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                  <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                    {state.failedNodes?.length || 0}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('workflows.failed', 'Failed')}
                  </div>
                </div>
              </div>

              {/* Execution metrics (if available) */}
              {state.data?.executionMetrics && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                    {t('workflows.metrics', 'Metrics')}
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('workflows.totalDuration', 'Duration')}:
                      </span>
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        {state.data.executionMetrics.totalDuration >= 1000
                          ? `${(state.data.executionMetrics.totalDuration / 1000).toFixed(1)}s`
                          : `${state.data.executionMetrics.totalDuration}ms`}
                      </span>
                    </div>
                    {state.data.executionMetrics.totalTokens?.total > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-500 dark:text-gray-400">
                            {t('workflows.totalTokens', 'Total Tokens')}:
                          </span>
                          <span className="font-medium text-gray-700 dark:text-gray-300">
                            {state.data.executionMetrics.totalTokens.total.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400 dark:text-gray-500">
                            {t('workflows.inputTokens', 'Input')}:
                          </span>
                          <span className="text-gray-600 dark:text-gray-400">
                            {state.data.executionMetrics.totalTokens.input.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-400 dark:text-gray-500">
                            {t('workflows.outputTokens', 'Output')}:
                          </span>
                          <span className="text-gray-600 dark:text-gray-400">
                            {state.data.executionMetrics.totalTokens.output.toLocaleString()}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Completion message */}
              {(state.status === 'completed' || state.status === 'approved') && (
                <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                    <Icon name="check-circle" className="w-5 h-5" />
                    <span className="font-medium">
                      {state.status === 'approved'
                        ? t('workflows.approvedSuccess', 'Workflow approved!')
                        : t('workflows.completedSuccess', 'Workflow completed successfully!')}
                    </span>
                  </div>
                </div>
              )}

              {/* Rejected message */}
              {state.status === 'rejected' && (
                <div className="mt-4 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg border border-orange-200 dark:border-orange-800">
                  <div className="flex items-center gap-2 text-orange-700 dark:text-orange-300">
                    <Icon name="x-circle" className="w-5 h-5" />
                    <span className="font-medium">
                      {t('workflows.rejectedMessage', 'Workflow was rejected')}
                    </span>
                  </div>
                </div>
              )}

              {/* Cancelled message */}
              {state.status === 'cancelled' && (
                <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
                  <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                    <Icon name="stop-circle" className="w-5 h-5" />
                    <span className="font-medium">
                      {t('workflows.cancelledMessage', 'Workflow was cancelled')}
                    </span>
                  </div>
                </div>
              )}

              {/* Failed message */}
              {state.status === 'failed' && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                  <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                    <Icon name="x-circle" className="w-5 h-5" />
                    <span className="font-medium">
                      {t('workflows.failedMessage', 'Workflow failed')}
                    </span>
                  </div>
                  {state.errors && state.errors.length > 0 && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {state.errors[state.errors.length - 1]?.message ||
                        state.errors[state.errors.length - 1]}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Workflow Output - shown when workflow is finished */}
        {(state.status === 'completed' ||
          state.status === 'approved' ||
          state.status === 'rejected') &&
          (() => {
            const output = getDisplayableOutput(state.data);
            const keys = Object.keys(output);
            if (keys.length === 0) return null;

            const primaryOutputKey =
              state.data?._workflowDefinition?.chatIntegration?.primaryOutput;
            const hasPrimaryOutput = primaryOutputKey && output[primaryOutputKey] !== undefined;
            const additionalKeys = hasPrimaryOutput
              ? keys.filter(k => k !== primaryOutputKey)
              : keys;

            /**
             * Renders the per-field action buttons (copy + download).
             * @param {string} key - Field key
             * @param {*} value - Field value
             */
            const renderFieldActions = (key, value) => (
              <div className="flex items-center gap-1.5">
                {/* Copy to clipboard */}
                <button
                  onClick={e => {
                    e.stopPropagation();
                    copyToClipboard(key, value);
                  }}
                  className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-1"
                  title={t('workflows.output.copyToClipboard', 'Copy to clipboard')}
                >
                  <Icon name={copiedFields.has(key) ? 'check' : 'copy'} className="w-3 h-3" />
                  {copiedFields.has(key)
                    ? t('workflows.output.copied', 'Copied')
                    : t('workflows.output.copy', 'Copy')}
                </button>
                {/* Download as file */}
                {typeof value === 'string' &&
                  (key.toLowerCase().includes('report') ||
                    key.toLowerCase().includes('summary') ||
                    value.length > 200) && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        downloadAsFile(value, `${key}-${state.executionId.slice(0, 8)}.md`);
                      }}
                      className="px-2 py-1 text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded hover:bg-indigo-200 dark:hover:bg-indigo-900/50 transition-colors flex items-center gap-1"
                    >
                      <Icon name="arrow-down-tray" className="w-3 h-3" />
                      {t('workflows.download', 'Download')}
                    </button>
                  )}
              </div>
            );

            /**
             * Renders the content of an output field, handling truncation for long strings.
             * @param {string} key - Field key
             * @param {*} value - Field value
             */
            const renderFieldContent = (key, value) => {
              // Long string truncation (only for non-primary or accordion views)
              if (
                typeof value === 'string' &&
                value.length > LONG_STRING_THRESHOLD &&
                !fullyShownFields.has(key)
              ) {
                return (
                  <div>
                    {renderValue(value.substring(0, LONG_STRING_THRESHOLD) + '...')}
                    <button
                      onClick={() => toggleFullyShown(key)}
                      className="mt-2 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium"
                    >
                      {t('workflows.output.showFull', 'Show full content')}
                    </button>
                  </div>
                );
              }
              if (
                typeof value === 'string' &&
                value.length > LONG_STRING_THRESHOLD &&
                fullyShownFields.has(key)
              ) {
                return (
                  <div>
                    {renderValue(value)}
                    <button
                      onClick={() => toggleFullyShown(key)}
                      className="mt-2 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium"
                    >
                      {t('workflows.output.showLess', 'Show less')}
                    </button>
                  </div>
                );
              }
              return renderValue(value);
            };

            /**
             * Renders a single accordion panel for an output field.
             * @param {string} key - Field key
             */
            const renderAccordionPanel = key => {
              const value = output[key];
              const isExpanded = expandedOutputFields.has(key);

              return (
                <div
                  key={key}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
                >
                  {/* Accordion header */}
                  <button
                    onClick={() => toggleOutputField(key)}
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        className="w-4 h-4 text-gray-400 flex-shrink-0"
                      />
                      <h4 className="font-medium text-gray-700 dark:text-gray-300 capitalize">
                        {key.replace(/_/g, ' ')}
                      </h4>
                      {/* Type hint badge */}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {typeof value === 'string'
                          ? `${value.length} ${t('workflows.output.chars', 'chars')}`
                          : typeof value === 'object'
                            ? Array.isArray(value)
                              ? `[${value.length}]`
                              : `{${Object.keys(value).length}}`
                            : typeof value}
                      </span>
                    </div>
                    {isExpanded && renderFieldActions(key, value)}
                  </button>

                  {/* Accordion content */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50/50 dark:bg-gray-900/30">
                      {renderFieldContent(key, value)}
                    </div>
                  )}
                </div>
              );
            };

            return (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 lg:col-span-2">
                {/* Output header with download-all button */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {t('workflows.output', 'Workflow Output')}
                  </h3>
                  <button
                    onClick={() =>
                      downloadAsFile(
                        JSON.stringify(output, null, 2),
                        `workflow-output-${state.executionId.slice(0, 8)}.json`,
                        'application/json'
                      )
                    }
                    className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-1.5"
                    title={t('workflows.downloadAllJson', 'Download all output as JSON')}
                  >
                    <Icon name="arrow-down-tray" className="w-4 h-4" />
                    {t('workflows.downloadJson', 'Download JSON')}
                  </button>
                </div>

                {/* Primary output mode: show primary field prominently, rest in collapsible section */}
                {hasPrimaryOutput ? (
                  <div className="space-y-6">
                    {/* Primary output - always visible */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-gray-700 dark:text-gray-300 capitalize">
                          {primaryOutputKey.replace(/_/g, ' ')}
                        </h4>
                        {renderFieldActions(primaryOutputKey, output[primaryOutputKey])}
                      </div>
                      {renderValue(output[primaryOutputKey])}
                    </div>

                    {/* Additional data - collapsible */}
                    {additionalKeys.length > 0 && (
                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                        <button
                          onClick={() => setAdditionalDataExpanded(prev => !prev)}
                          className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <Icon
                              name={additionalDataExpanded ? 'chevron-up' : 'chevron-down'}
                              className="w-4 h-4 text-gray-400"
                            />
                            <span className="font-medium text-gray-600 dark:text-gray-400">
                              {t('workflows.output.additionalData', 'Additional Data')}
                            </span>
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              ({additionalKeys.length}{' '}
                              {additionalKeys.length === 1
                                ? t('workflows.output.field', 'field')
                                : t('workflows.output.fields', 'fields')}
                              )
                            </span>
                          </div>
                        </button>
                        {additionalDataExpanded && (
                          <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
                            {additionalKeys.map(key => (
                              <div key={key}>
                                <div className="flex items-center justify-between mb-2">
                                  <h4 className="font-medium text-gray-700 dark:text-gray-300 capitalize">
                                    {key.replace(/_/g, ' ')}
                                  </h4>
                                  {renderFieldActions(key, output[key])}
                                </div>
                                {renderFieldContent(key, output[key])}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  /* Accordion mode: each field in its own collapsible panel */
                  <div className="space-y-2">{keys.map(key => renderAccordionPanel(key))}</div>
                )}
              </div>
            );
          })()}
      </div>

      {/* App selection modal for "Chat with Results" */}
      <AppSelectionModal
        isOpen={showAppSelection}
        onClose={() => setShowAppSelection(false)}
        onSelect={handleStartChatWithResults}
      />
    </div>
  );
}

export default WorkflowExecutionPage;
