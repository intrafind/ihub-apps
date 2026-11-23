// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Detail panel for a single step in the Agent Runs Step table. Renders the
 * captured transcript: model used, resolved system + user prompts, tools
 * available, every tool call (name + args + result preview), token usage,
 * citations added, skills activated.
 *
 * The agent isn't trusted unless the human can see exactly what it did —
 * this is the transparency surface for that.
 */
function CollapsibleBlock({ title, defaultOpen = false, count, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-sm">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 flex items-center justify-between"
      >
        <span>
          {open ? '▾' : '▸'} {title}
          {typeof count === 'number' && <span className="ml-1.5 text-gray-500">({count})</span>}
        </span>
      </button>
      {open && <div className="p-3 bg-white text-xs">{children}</div>}
    </div>
  );
}

function PromptMessage({ role, content }) {
  const { t } = useTranslation();
  const label =
    role === 'system'
      ? t('admin.agents.stepDetails.role.system', 'System')
      : role === 'user'
        ? t('admin.agents.stepDetails.role.user', 'User')
        : role === 'assistant'
          ? t('admin.agents.stepDetails.role.assistant', 'Assistant')
          : role || t('admin.agents.stepDetails.role.message', 'Message');
  const labelColor =
    role === 'system'
      ? 'text-purple-700 bg-purple-50 border-purple-200'
      : role === 'user'
        ? 'text-blue-700 bg-blue-50 border-blue-200'
        : 'text-gray-700 bg-gray-50 border-gray-200';
  return (
    <div className="mb-2">
      <span className={`inline-block px-1.5 py-0.5 rounded-sm border text-xs ${labelColor}`}>
        {label}
      </span>
      <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-gray-800 font-sans text-xs leading-relaxed">
        {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
      </pre>
    </div>
  );
}

function ToolCallRow({ call }) {
  const { t } = useTranslation();
  const isError = !!call.error;
  return (
    <div className={`border-l-2 pl-2 py-1 ${isError ? 'border-red-400' : 'border-indigo-300'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-medium text-gray-800">{call.name}</span>
        {call.appId && (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-orange-100 text-orange-800">
            {t('admin.agents.stepDetails.appBadge', 'app · {{id}}', { id: call.appId })}
          </span>
        )}
        {call.toolId && call.toolId !== call.name && !call.appId && (
          <span className="text-xs text-gray-500 font-mono">[{call.toolId}]</span>
        )}
        {typeof call.durationMs === 'number' && (
          <span className="text-xs text-gray-500">
            {call.durationMs < 1000
              ? `${call.durationMs}ms`
              : `${(call.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {isError && (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-red-100 text-red-800">
            {call.error}
          </span>
        )}
      </div>
      {call.args && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
            {t('admin.agents.stepDetails.args', 'args')}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap wrap-break-word bg-gray-50 p-2 rounded-sm text-gray-700 text-xs">
            {String(call.args)}
          </pre>
        </details>
      )}
      {call.result && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
            {t('admin.agents.stepDetails.result', 'result')}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap wrap-break-word bg-gray-50 p-2 rounded-sm text-gray-700 text-xs">
            {String(call.result)}
          </pre>
        </details>
      )}
      {call.message && !call.args && !call.result && (
        <p className="text-xs text-gray-600 mt-1">{call.message}</p>
      )}
    </div>
  );
}

/**
 * Why an app was not registered as a tool, keyed by the reason code the server sends.
 * @param {Function} t - i18next translation function
 * @returns {Object<string, string>}
 */
function appNotRegisteredReasons(t) {
  return {
    'feature-flag-off': t(
      'admin.agents.stepDetails.appReason.featureFlagOff',
      'features.appAsTool is OFF — enable it in features.json (or via Admin → Features) to allow apps as tools'
    ),
    'grounding-swap': t(
      'admin.agents.stepDetails.appReason.groundingSwap',
      'Gemini native grounding cannot co-exist with function tools; webSearch dropped this app'
    ),
    'app-in-app-guard': t(
      'admin.agents.stepDetails.appReason.appInAppGuard',
      'agent is itself invoked from an app — synthetic app__* tools were stripped'
    ),
    'resolve-failed': t(
      'admin.agents.stepDetails.appReason.resolveFailed',
      'app could not be resolved (missing config or no permissions)'
    )
  };
}

/**
 * Label and colour of each source load status.
 * @param {Function} t - i18next translation function
 * @returns {Object<string, {label: string, cls: string}>}
 */
function sourceStatusLabels(t) {
  return {
    loaded: {
      label: t('admin.agents.stepDetails.sourceStatus.loaded', 'loaded'),
      cls: 'bg-emerald-100 text-emerald-800'
    },
    cached: {
      label: t('admin.agents.stepDetails.sourceStatus.cached', 'cached'),
      cls: 'bg-emerald-100 text-emerald-800'
    },
    unresolved: {
      label: t('admin.agents.stepDetails.sourceStatus.unresolved', 'unresolved'),
      cls: 'bg-amber-100 text-amber-800'
    },
    error: {
      label: t('admin.agents.stepDetails.sourceStatus.error', 'error'),
      cls: 'bg-red-100 text-red-800'
    }
  };
}

function StepDetails({ log }) {
  const { t } = useTranslation();
  if (!log) {
    return (
      <div className="text-xs text-gray-500 italic px-3 py-2">
        {t(
          'admin.agents.stepDetails.noTranscript',
          'No transcript captured for this step (older run, or the executor doesn’t produce one).'
        )}
      </div>
    );
  }
  const sourceStatusLabel = sourceStatusLabels(t);
  const appNotRegisteredReason = appNotRegisteredReasons(t);

  const tokens = log.tokens || {};
  const inTok = tokens.prompt_tokens || tokens.input_tokens || tokens.input || tokens.promptTokens;
  const outTok =
    tokens.completion_tokens || tokens.output_tokens || tokens.output || tokens.completionTokens;
  const totalTok = tokens.total_tokens || tokens.total || (inTok && outTok ? inTok + outTok : null);
  const messages = Array.isArray(log.messages) ? log.messages : [];
  const tools = Array.isArray(log.tools) ? log.tools : [];
  const toolCalls = Array.isArray(log.toolCalls) ? log.toolCalls : [];
  const sources = Array.isArray(log.sources) ? log.sources : [];
  const apps = Array.isArray(log.apps) ? log.apps : [];
  const appsRegisteredCount = apps.filter(a => a.registered).length;
  const appsBlockedCount = apps.length - appsRegisteredCount;

  return (
    <div className="bg-gray-50 px-4 py-3 space-y-3 border-l-4 border-indigo-400 mb-2">
      {/* Quick facts */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700">
        {log.model && (
          <span>
            <span className="text-gray-500">{t('admin.agents.stepDetails.model', 'model')} </span>
            <span className="font-mono">{log.model}</span>
          </span>
        )}
        {log.kind && (
          <span>
            <span className="text-gray-500">{t('admin.agents.stepDetails.kind', 'kind')} </span>
            <span className="font-mono">{log.kind}</span>
          </span>
        )}
        {typeof log.iterations === 'number' && log.iterations > 0 && (
          <span>
            <span className="text-gray-500">
              {t('admin.agents.stepDetails.iterations', 'iterations')}{' '}
            </span>
            <span className="font-mono">{log.iterations}</span>
          </span>
        )}
        {totalTok != null && (
          <span>
            <span className="text-gray-500">{t('admin.agents.stepDetails.tokens', 'tokens')} </span>
            <span className="font-mono">
              {totalTok
                ? t(
                    'admin.agents.stepDetails.tokenCountsTotal',
                    '{{input}} in / {{output}} out / {{total}} total',
                    { input: inTok || '—', output: outTok || '—', total: totalTok }
                  )
                : t('admin.agents.stepDetails.tokenCounts', '{{input}} in / {{output}} out', {
                    input: inTok || '—',
                    output: outTok || '—'
                  })}
            </span>
          </span>
        )}
        {typeof log.citationsAdded === 'number' && log.citationsAdded > 0 && (
          <span>
            <span className="text-gray-500">
              {t('admin.agents.stepDetails.citationsAdded', 'citations added')}{' '}
            </span>
            <span className="font-mono">+{log.citationsAdded}</span>
          </span>
        )}
        {Array.isArray(log.skillsActivated) && log.skillsActivated.length > 0 && (
          <span>
            <span className="text-gray-500">
              {t('admin.agents.stepDetails.skillsActivated', 'skills activated')}{' '}
            </span>
            <span className="font-mono">{log.skillsActivated.join(', ')}</span>
          </span>
        )}
        {typeof log.plannedTaskCount === 'number' && (
          <span>
            <span className="text-gray-500">
              {t('admin.agents.stepDetails.plannedTasks', 'planned tasks')}{' '}
            </span>
            <span className="font-mono">{log.plannedTaskCount}</span>
          </span>
        )}
        {typeof log.responseLength === 'number' && log.responseLength > 0 && (
          <span>
            <span className="text-gray-500">
              {t('admin.agents.stepDetails.response', 'response')}{' '}
            </span>
            <span className="font-mono">
              {t('admin.agents.stepDetails.responseChars', '{{count}} chars', {
                count: log.responseLength
              })}
            </span>
          </span>
        )}
      </div>

      {log.reasoning && (
        <div className="text-xs text-gray-700 italic">
          <span className="text-gray-500 not-italic">
            {t('admin.agents.stepDetails.reasoning', 'reasoning:')}
          </span>{' '}
          {log.reasoning}
        </div>
      )}

      {log.groundingSwap && (
        <div className="text-xs bg-amber-50 border border-amber-300 rounded-sm p-2">
          <div className="font-medium text-amber-900">
            {t(
              'admin.agents.stepDetails.groundingSwapTitle',
              '⚠ Function tools dropped on this step'
            )}
          </div>
          <p className="text-amber-800 mt-1">{log.groundingSwap.reason}</p>
          {Array.isArray(log.groundingSwap.droppedToolIds) &&
            log.groundingSwap.droppedToolIds.length > 0 && (
              <p className="text-amber-800 mt-1">
                <span className="text-amber-700">
                  {t('admin.agents.stepDetails.notRegisteredLabel', 'Not registered:')}
                </span>{' '}
                <span className="font-mono">{log.groundingSwap.droppedToolIds.join(', ')}</span>
              </p>
            )}
          {Array.isArray(log.droppedApps) && log.droppedApps.length > 0 && (
            <p className="text-amber-800 mt-1">
              <span className="text-amber-700">
                {t('admin.agents.stepDetails.appsAlsoNotRegistered', 'Apps also not registered:')}
              </span>{' '}
              <span className="font-mono">{log.droppedApps.join(', ')}</span>
            </p>
          )}
          <p className="text-amber-700 mt-1 text-xs">
            {t(
              'admin.agents.stepDetails.groundingSwapHint',
              'To use apps + function tools on a Google model, remove webSearch from this profile (the agent loses native grounding) or split the step into two — one for grounded research, one for app/function calls.'
            )}
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <CollapsibleBlock
          title={t('admin.agents.stepDetails.prompts', 'Prompts')}
          count={messages.length}
        >
          {messages.map((m, i) => (
            <PromptMessage key={`${m.role}-${i}`} role={m.role} content={m.content} />
          ))}
        </CollapsibleBlock>
      )}

      {tools.length > 0 && (
        <CollapsibleBlock
          title={t('admin.agents.stepDetails.toolsAvailable', 'Tools available')}
          count={tools.length}
        >
          <ul className="space-y-1">
            {tools.map((tool, i) => (
              <li key={`${tool.id || i}`} className="font-mono">
                {tool.id}
                {tool.description && (
                  <span className="text-gray-500 font-sans ml-1.5">— {tool.description}</span>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleBlock>
      )}

      {sources.length > 0 && (
        <CollapsibleBlock
          title={t(
            'admin.agents.stepDetails.sourcesInjected',
            'Sources injected into system prompt'
          )}
          count={sources.length}
        >
          <p className="text-gray-500 mb-2">
            {t(
              'admin.agents.stepDetails.sourcesHelp',
              'These were loaded by the runtime and embedded as a {{tag}} block in the system prompt. They do NOT appear as tool calls because the agent did not need to fetch them — they were already in context.',
              { tag: '<sources>' }
            )}
          </p>
          <ul className="space-y-1">
            {sources.map((s, i) => {
              const status = sourceStatusLabel[s.status] || {
                label: s.status || t('admin.agents.stepDetails.sourceStatus.unknown', 'unknown'),
                cls: 'bg-gray-100 text-gray-700'
              };
              return (
                <li key={`${s.id || i}`} className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-gray-800">{s.id}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-sm ${status.cls}`}>
                    {status.label}
                  </span>
                  {typeof s.bytesApprox === 'number' && s.bytesApprox > 0 && (
                    <span className="text-gray-500">
                      {t('admin.agents.stepDetails.bytesApprox', '~{{count}} bytes', {
                        count: s.bytesApprox
                      })}
                    </span>
                  )}
                  {s.error && <span className="text-red-700">{s.error}</span>}
                </li>
              );
            })}
          </ul>
        </CollapsibleBlock>
      )}

      {apps.length > 0 && (
        <CollapsibleBlock
          title={t('admin.agents.stepDetails.appsAvailable', 'Apps available')}
          count={apps.length}
          defaultOpen={appsBlockedCount > 0}
        >
          {appsBlockedCount > 0 && (
            <p className="text-amber-800 mb-2">
              {t(
                'admin.agents.stepDetails.appsBlockedHelp',
                '{{registered}} of {{count}} configured apps were registered as tools on this step. Apps that were not registered are listed with the reason — the model never saw them.',
                { registered: appsRegisteredCount, count: apps.length }
              )}
            </p>
          )}
          <ul className="space-y-1">
            {apps.map((a, i) => (
              <li key={`${a.id || i}`} className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-gray-800">app__{a.id}</span>
                {a.registered ? (
                  <span className="text-xs px-1.5 py-0.5 rounded-sm bg-emerald-100 text-emerald-800">
                    {t('admin.agents.stepDetails.registered', 'registered')}
                  </span>
                ) : (
                  <>
                    <span className="text-xs px-1.5 py-0.5 rounded-sm bg-red-100 text-red-800">
                      {t('admin.agents.stepDetails.notRegistered', 'not registered')}
                    </span>
                    <span className="text-gray-600">
                      {appNotRegisteredReason[a.reason] ||
                        a.reason ||
                        t('admin.agents.stepDetails.unknownReason', 'unknown reason')}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleBlock>
      )}

      {toolCalls.length > 0 && (
        <CollapsibleBlock
          title={t('admin.agents.stepDetails.toolCalls', 'Tool calls')}
          count={toolCalls.length}
          defaultOpen
        >
          <div className="space-y-2">
            {toolCalls.map((c, i) => (
              <ToolCallRow key={`${c.name}-${i}`} call={c} />
            ))}
          </div>
        </CollapsibleBlock>
      )}
    </div>
  );
}

export default StepDetails;
