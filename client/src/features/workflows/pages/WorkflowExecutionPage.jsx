import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { resetChatId } from '../../../utils/chatId';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';
import { configureMarked } from '../../../shared/components/MarkdownRenderer';
import {
  useWorkflowExecution,
  useElapsedTime,
  useTechnicalDetailsToggle,
  useDocumentTitleOverride
} from '../hooks';
import {
  HumanCheckpoint,
  ExecutionProgress,
  AppSelectionModal,
  StatusBadge,
  ProgressBar,
  TechnicalDetailsToggle
} from '../components';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { apiClient } from '../../../api/client';
import { getDisplayableOutput } from '../utils/filterInternalFields';

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
          className="prose dark:prose-invert max-w-none prose-headings:text-gray-900 dark:prose-headings:text-white prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-a:text-indigo-600 dark:prose-a:text-indigo-400"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    // Plain text — render in a monospaced <pre> so ASCII art / box-drawing
    // characters stay aligned (LLMs don't always wrap them in code fences).
    // overflow-x-auto so very wide rows scroll instead of wrapping.
    return (
      <pre className="text-sm font-mono whitespace-pre bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-3 rounded overflow-x-auto">
        {value}
      </pre>
    );
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

  // Install the same code-block renderer the chat uses. Without this, fenced
  // code blocks (e.g. ASCII art reports) get marked's default <pre><code>,
  // which renders correctly in chat (chat configures its renderer on mount)
  // but loses the explicit monospace/overflow-x-auto styling here.
  useEffect(() => {
    configureMarked(t);
  }, [t]);
  const [showAppSelection, setShowAppSelection] = useState(false);
  /** @type {[Set<string>, Function]} Tracks which output accordion panels are expanded */
  const [expandedOutputFields, setExpandedOutputFields] = useState(new Set());
  /** @type {[Set<string>, Function]} Tracks which long string fields are fully shown */
  const [fullyShownFields, setFullyShownFields] = useState(new Set());
  /** @type {[Set<string>, Function]} Tracks fields with active "copied" feedback */
  const [copiedFields, setCopiedFields] = useState(new Set());
  /** @type {[boolean, Function]} Tracks whether the additional data section is expanded */
  const [additionalDataExpanded, setAdditionalDataExpanded] = useState(false);

  const { user } = useAuth();
  const isAdmin = user?.permissions?.adminAccess === true;
  const [showTechnical] = useTechnicalDetailsToggle();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState(null);

  const { state, loading, connected, error, respondToCheckpoint, cancelExecution, refetch } =
    useWorkflowExecution(executionId);

  const handleRestart = async () => {
    setRestartError(null);
    setRestarting(true);
    try {
      await apiClient.post(`/workflows/executions/${executionId}/restart`);
      await refetch();
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        'Failed to restart workflow';
      setRestartError(msg);
    } finally {
      setRestarting(false);
    }
  };

  const elapsed = useElapsedTime(state?.startedAt, state?.completedAt);

  const localizedName = state?.workflowName
    ? getLocalizedContent(state.workflowName, currentLanguage)
    : state?.workflowId;

  const titlePrefix = useMemo(() => {
    if (!state || !localizedName) return null;
    switch (state.status) {
      case 'running':
        return t('workflows.documentTitle.running', '● Running: {{name}}', { name: localizedName });
      case 'paused':
        return t('workflows.documentTitle.paused', '⏸ {{name}}', { name: localizedName });
      case 'completed':
      case 'approved':
        return t('workflows.documentTitle.completed', '✓ {{name}}', { name: localizedName });
      case 'failed':
        return t('workflows.documentTitle.failed', '⚠ {{name}}', { name: localizedName });
      case 'cancelled':
      case 'rejected':
        return t('workflows.documentTitle.cancelled', '✕ {{name}}', { name: localizedName });
      default:
        return localizedName;
    }
  }, [state, localizedName, t]);

  useDocumentTitleOverride(titlePrefix);

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

  const handleCancelClick = () => setShowCancelConfirm(true);
  const handleCancelConfirm = async () => {
    setShowCancelConfirm(false);
    await cancelExecution();
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

  const workflowOutput = getDisplayableOutput(state.data);
  const workflowOutputKeys = Object.keys(workflowOutput);
  const primaryOutputKey = state.data?._workflowDefinition?.chatIntegration?.primaryOutput;
  const hasPrimaryOutput = primaryOutputKey && workflowOutput[primaryOutputKey] !== undefined;
  const additionalKeys = hasPrimaryOutput
    ? workflowOutputKeys.filter(k => k !== primaryOutputKey)
    : workflowOutputKeys;

  // Start inputs: take user-provided values that were passed to the start node
  // (filtered to exclude both internal underscore keys and downstream outputs).
  const startInputVariables =
    state.data?._workflowDefinition?.nodes?.find(n => n.type === 'start')?.config
      ?.inputVariables || [];
  const startInputs = startInputVariables
    .map(v => {
      const value = state.data?.[v.name];
      if (value === undefined || value === null || value === '') return null;
      return { name: v.name, label: v.label, type: v.type, value };
    })
    .filter(Boolean);

  // Workflow-level model the user selected when starting (kept as a runtime override)
  const startedWithModel = state.data?._modelOverride;
  const workflowDefaultModel = state.data?._workflowDefinition?.config?.defaultModelId;

  // Cancellation reason — engine records it as a workflow_cancelled history event
  const cancellationReason = (state.history || []).find(h => h.type === 'workflow_cancelled')
    ?.data?.reason;

  // Show output even when cancelled if any prompt steps produced results — users
  // want to see what was generated before timeout/cancellation.
  const showOutput =
    state.status === 'completed' ||
    state.status === 'approved' ||
    state.status === 'rejected' ||
    (state.status === 'cancelled' && workflowOutputKeys.length > 0);

  const renderFieldActions = (key, value) => (
    <div className="flex items-center gap-1.5">
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
            <Icon name="download" className="w-3 h-3" />
            {t('workflows.download', 'Download')}
          </button>
        )}
    </div>
  );

  const renderFieldContent = (key, value) => {
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

  const renderAccordionPanel = key => {
    const value = workflowOutput[key];
    const isExpanded = expandedOutputFields.has(key);
    return (
      <div
        key={key}
        className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
      >
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
        {isExpanded && (
          <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50/50 dark:bg-gray-900/30">
            {renderFieldContent(key, value)}
          </div>
        )}
      </div>
    );
  };

  const totalSteps = state.data?._workflowDefinition?.nodes?.length || 0;
  const completedSteps = state.completedNodes?.length || 0;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-6">
        <Link
          to="/workflows"
          className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 flex items-center gap-1"
        >
          <Icon name="arrow-left" className="w-4 h-4" aria-hidden="true" />
          {t('workflows.backToWorkflows', 'Back to Workflows')}
        </Link>
      </nav>

      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{workflowName}</h1>
              <StatusBadge status={state.status} live />
              {isActive && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
                  title={connected ? 'Receiving live updates' : 'Reconnecting'}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                    }`}
                    aria-hidden="true"
                  />
                  {connected
                    ? t('workflows.live', 'Live')
                    : t('workflows.reconnecting', 'Reconnecting…')}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {(isActive || state.status === 'completed' || state.status === 'approved') && (
              <div className="mb-3">
                <ProgressBar
                  status={state.status}
                  completedCount={completedSteps}
                  totalCount={totalSteps}
                  elapsedFormatted={elapsed.formatted}
                />
              </div>
            )}

            <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400 flex-wrap">
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
              {showTechnical && (
                <span className="font-mono">
                  {t('workflows.executionId', 'Execution')}: {state.executionId.slice(0, 16)}…
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {(state.status === 'completed' || state.status === 'approved') && (
              <button
                onClick={() => setShowAppSelection(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center gap-2 font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                title={t(
                  'workflows.chatWithResults.title',
                  'Continue chatting with the workflow output in an app'
                )}
              >
                <Icon name="chat-bubble-left-right" className="w-4 h-4" aria-hidden="true" />
                {t('workflows.chatWithResults.button', 'Chat with Results')}
              </button>
            )}
            {isAdmin && state.workflowId && (
              <Link
                to={`/admin/workflows/${state.workflowId}/edit`}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                aria-label={t('workflows.editWorkflow', 'Edit Workflow')}
              >
                <Icon name="pencil" className="w-4 h-4" aria-hidden="true" />
                {t('workflows.editWorkflow', 'Edit Workflow')}
              </Link>
            )}
            <button
              onClick={refetch}
              className="p-2 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              title={t('common.refresh', 'Refresh')}
              aria-label={t('common.refresh', 'Refresh')}
            >
              <Icon name="arrow-path" className="w-4 h-4" aria-hidden="true" />
            </button>
            {showTechnical && (
              <button
                onClick={handleExportState}
                className="p-2 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                title={t('workflows.exportState', 'Export execution state for debugging')}
                aria-label={t('workflows.export', 'Export')}
              >
                <Icon name="download" className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
            {isActive && (
              <button
                onClick={handleCancelClick}
                className="px-4 py-2 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                aria-label={t('workflows.cancel', 'Cancel')}
              >
                <Icon name="x-mark" className="w-4 h-4" aria-hidden="true" />
                {t('workflows.cancel', 'Cancel')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 flex items-center justify-end">
          <TechnicalDetailsToggle />
        </div>
      </div>

      {/* Checkpoint takeover: when paused for input, the checkpoint is the page. */}
      {hasCheckpoint && (
        <div id="active-checkpoint" className="mb-6">
          <HumanCheckpoint
            checkpoint={state.pendingCheckpoint}
            onRespond={respondToCheckpoint}
            displayData={state.pendingCheckpoint?.displayData}
          />
        </div>
      )}

      {/* Main content grid */}
      <div className={hasCheckpoint ? 'space-y-6' : 'grid gap-6 lg:grid-cols-2'}>
        {/* Progress panel (collapsed under "So far" when checkpoint is pending) */}
        {hasCheckpoint ? (
          <details className="bg-white dark:bg-gray-800 rounded-lg shadow-md group" open={false}>
            <summary className="cursor-pointer p-4 font-medium text-gray-700 dark:text-gray-200 flex items-center gap-2 list-none">
              <Icon
                name="chevron-down"
                className="w-4 h-4 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
              {t('workflows.sofar', 'So far')}
              <span className="text-sm text-gray-400 dark:text-gray-500">
                ({completedSteps} {completedSteps === 1 ? 'step' : 'steps'})
              </span>
            </summary>
            <div className="border-t border-gray-100 dark:border-gray-700">
              <ExecutionProgress
                state={state}
                nodes={state.data?._workflowDefinition?.nodes || []}
              />
            </div>
          </details>
        ) : (
          <div>
            <ExecutionProgress state={state} nodes={state.data?._workflowDefinition?.nodes || []} />
          </div>
        )}

        {/* Right panel - Status (only shown when no checkpoint is pending) */}
        {!hasCheckpoint && (
          <div>
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
                    {showTechnical && state.data.executionMetrics.totalTokens?.total > 0 && (
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
                  {cancellationReason && (
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      {t('workflows.cancelledReason', 'Reason')}:{' '}
                      <span className="font-medium">
                        {t(
                          `workflows.cancelReason.${cancellationReason}`,
                          cancellationReason
                        )}
                      </span>
                    </p>
                  )}
                  {/* Resume button — engine refuses user_cancelled, so hide it then */}
                  {cancellationReason !== 'user_cancelled' &&
                    cancellationReason !== 'user_requested' && (
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={restarting}
                          onClick={handleRestart}
                          className="inline-flex items-center px-3 py-1.5 border border-indigo-300 rounded-md text-sm font-medium text-indigo-700 bg-white hover:bg-indigo-50 dark:bg-gray-800 dark:text-indigo-300 dark:border-indigo-700 dark:hover:bg-gray-700 disabled:opacity-50"
                        >
                          <Icon name="play" className="w-4 h-4 mr-1.5" />
                          {restarting
                            ? t('workflows.resuming', 'Resuming…')
                            : t('workflows.resume', 'Resume from last step')}
                        </button>
                      </div>
                    )}
                  {restartError && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">{restartError}</p>
                  )}
                </div>
              )}

              {/* Failed message */}
              {state.status === 'failed' && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                  <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                    <Icon name="x-circle" className="w-5 h-5" aria-hidden="true" />
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
                  {((state.currentNodes || []).length > 0 ||
                    (state.failedNodes || []).length > 0) && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={restarting}
                        onClick={handleRestart}
                        className="inline-flex items-center px-3 py-1.5 border border-indigo-300 rounded-md text-sm font-medium text-indigo-700 bg-white hover:bg-indigo-50 dark:bg-gray-800 dark:text-indigo-300 dark:border-indigo-700 dark:hover:bg-gray-700 disabled:opacity-50"
                      >
                        <Icon name="play" className="w-4 h-4 mr-1.5" />
                        {restarting
                          ? t('workflows.resuming', 'Resuming…')
                          : t('workflows.resume', 'Resume from last step')}
                      </button>
                    </div>
                  )}
                  {restartError && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">{restartError}</p>
                  )}
                </div>
              )}

              {/* Model used */}
              {(startedWithModel || workflowDefaultModel) && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('workflows.modelUsed', 'Model')}
                  </h4>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                      <Icon name="cpu-chip" className="w-3 h-3 mr-1" />
                      {startedWithModel || workflowDefaultModel}
                    </span>
                    {!startedWithModel && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ({t('workflows.workflowDefault', 'workflow default')})
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Start inputs panel */}
            {startInputs.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 mt-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  {t('workflows.startInputs', 'Inputs')}
                </h3>
                <dl className="space-y-3">
                  {startInputs.map(input => (
                    <div key={input.name}>
                      <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                        {input.label
                          ? getLocalizedContent(input.label, currentLanguage) || input.name
                          : input.name}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 break-words whitespace-pre-wrap">
                        {typeof input.value === 'string'
                          ? input.value
                          : JSON.stringify(input.value, null, 2)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}

        {/* Workflow Output - shown when workflow is finished, or when cancelled but partial output exists */}
        {showOutput && workflowOutputKeys.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 lg:col-span-2">
              {/* Output header with download-all button */}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {state.status === 'cancelled'
                    ? t('workflows.partialOutput', 'Partial Output (before cancellation)')
                    : t('workflows.output', 'Workflow Output')}
                </h3>
                <button
                  onClick={() =>
                    downloadAsFile(
                      JSON.stringify(workflowOutput, null, 2),
                      `workflow-output-${state.executionId.slice(0, 8)}.json`,
                      'application/json'
                    )
                  }
                  className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-1.5"
                  title={t('workflows.downloadAllJson', 'Download all output as JSON')}
                >
                  <Icon name="download" className="w-4 h-4" />
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
                      {renderFieldActions(primaryOutputKey, workflowOutput[primaryOutputKey])}
                    </div>
                    {renderValue(workflowOutput[primaryOutputKey])}
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
                                {renderFieldActions(key, workflowOutput[key])}
                              </div>
                              {renderFieldContent(key, workflowOutput[key])}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* Accordion mode: each field in its own collapsible panel */
                <div className="space-y-2">
                  {workflowOutputKeys.map(key => renderAccordionPanel(key))}
                </div>
              )}
            </div>
          )}
      </div>

      {/* App selection modal for "Chat with Results" */}
      <AppSelectionModal
        isOpen={showAppSelection}
        onClose={() => setShowAppSelection(false)}
        onSelect={handleStartChatWithResults}
      />

      {/* Confirm dialog for cancelling the workflow */}
      <ConfirmDialog
        isOpen={showCancelConfirm}
        title={t('workflows.confirmCancel.title', 'Cancel this workflow?')}
        message={t(
          'workflows.confirmCancel.message',
          "The workflow will stop running. You can't resume it after cancelling."
        )}
        confirmLabel={t('workflows.confirmCancel.confirm', 'Yes, cancel')}
        denyLabel={t('workflows.confirmCancel.deny', 'Keep running')}
        danger
        onConfirm={handleCancelConfirm}
        onDeny={() => setShowCancelConfirm(false)}
      />
    </div>
  );
}

export default WorkflowExecutionPage;
