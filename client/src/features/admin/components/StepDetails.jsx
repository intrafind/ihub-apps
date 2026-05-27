import { useState } from 'react';

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
    <div className="border border-gray-200 rounded">
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
  const label =
    role === 'system'
      ? 'System'
      : role === 'user'
        ? 'User'
        : role === 'assistant'
          ? 'Assistant'
          : role || 'Message';
  const labelColor =
    role === 'system'
      ? 'text-purple-700 bg-purple-50 border-purple-200'
      : role === 'user'
        ? 'text-blue-700 bg-blue-50 border-blue-200'
        : 'text-gray-700 bg-gray-50 border-gray-200';
  return (
    <div className="mb-2">
      <span className={`inline-block px-1.5 py-0.5 rounded border text-xs ${labelColor}`}>
        {label}
      </span>
      <pre className="mt-1 whitespace-pre-wrap break-words text-gray-800 font-sans text-xs leading-relaxed">
        {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
      </pre>
    </div>
  );
}

function ToolCallRow({ call }) {
  const isError = !!call.error;
  return (
    <div className={`border-l-2 pl-2 py-1 ${isError ? 'border-red-400' : 'border-indigo-300'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-medium text-gray-800">{call.name}</span>
        {call.appId && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-800">
            app · {call.appId}
          </span>
        )}
        {call.toolId && call.toolId !== call.name && !call.appId && (
          <span className="text-xs text-gray-500 font-mono">[{call.toolId}]</span>
        )}
        {typeof call.durationMs === 'number' && (
          <span className="text-xs text-gray-400">
            {call.durationMs < 1000
              ? `${call.durationMs}ms`
              : `${(call.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {isError && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800">
            {call.error}
          </span>
        )}
      </div>
      {call.args && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">args</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words bg-gray-50 p-2 rounded text-gray-700 text-xs">
            {String(call.args)}
          </pre>
        </details>
      )}
      {call.result && (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">result</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words bg-gray-50 p-2 rounded text-gray-700 text-xs">
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

const APP_NOT_REGISTERED_REASON = {
  'feature-flag-off':
    'features.appAsTool is OFF — enable it in features.json (or via Admin → Features) to allow apps as tools',
  'grounding-swap':
    'Gemini native grounding cannot co-exist with function tools; webSearch dropped this app',
  'app-in-app-guard': 'agent is itself invoked from an app — synthetic app__* tools were stripped',
  'resolve-failed': 'app could not be resolved (missing config or no permissions)'
};

const SOURCE_STATUS_LABEL = {
  loaded: { label: 'loaded', cls: 'bg-emerald-100 text-emerald-800' },
  cached: { label: 'cached', cls: 'bg-emerald-100 text-emerald-800' },
  unresolved: { label: 'unresolved', cls: 'bg-amber-100 text-amber-800' },
  error: { label: 'error', cls: 'bg-red-100 text-red-800' }
};

function StepDetails({ log }) {
  if (!log) {
    return (
      <div className="text-xs text-gray-500 italic px-3 py-2">
        No transcript captured for this step (older run, or the executor doesn’t produce one).
      </div>
    );
  }

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
            <span className="text-gray-500">model </span>
            <span className="font-mono">{log.model}</span>
          </span>
        )}
        {log.kind && (
          <span>
            <span className="text-gray-500">kind </span>
            <span className="font-mono">{log.kind}</span>
          </span>
        )}
        {typeof log.iterations === 'number' && log.iterations > 0 && (
          <span>
            <span className="text-gray-500">iterations </span>
            <span className="font-mono">{log.iterations}</span>
          </span>
        )}
        {totalTok != null && (
          <span>
            <span className="text-gray-500">tokens </span>
            <span className="font-mono">
              {inTok || '—'} in / {outTok || '—'} out{totalTok ? ` / ${totalTok} total` : ''}
            </span>
          </span>
        )}
        {typeof log.citationsAdded === 'number' && log.citationsAdded > 0 && (
          <span>
            <span className="text-gray-500">citations added </span>
            <span className="font-mono">+{log.citationsAdded}</span>
          </span>
        )}
        {Array.isArray(log.skillsActivated) && log.skillsActivated.length > 0 && (
          <span>
            <span className="text-gray-500">skills activated </span>
            <span className="font-mono">{log.skillsActivated.join(', ')}</span>
          </span>
        )}
        {typeof log.plannedTaskCount === 'number' && (
          <span>
            <span className="text-gray-500">planned tasks </span>
            <span className="font-mono">{log.plannedTaskCount}</span>
          </span>
        )}
        {typeof log.responseLength === 'number' && log.responseLength > 0 && (
          <span>
            <span className="text-gray-500">response </span>
            <span className="font-mono">{log.responseLength} chars</span>
          </span>
        )}
      </div>

      {log.reasoning && (
        <div className="text-xs text-gray-700 italic">
          <span className="text-gray-500 not-italic">reasoning:</span> {log.reasoning}
        </div>
      )}

      {log.groundingSwap && (
        <div className="text-xs bg-amber-50 border border-amber-300 rounded p-2">
          <div className="font-medium text-amber-900">⚠ Function tools dropped on this step</div>
          <p className="text-amber-800 mt-1">{log.groundingSwap.reason}</p>
          {Array.isArray(log.groundingSwap.droppedToolIds) &&
            log.groundingSwap.droppedToolIds.length > 0 && (
              <p className="text-amber-800 mt-1">
                <span className="text-amber-700">Not registered:</span>{' '}
                <span className="font-mono">{log.groundingSwap.droppedToolIds.join(', ')}</span>
              </p>
            )}
          {Array.isArray(log.droppedApps) && log.droppedApps.length > 0 && (
            <p className="text-amber-800 mt-1">
              <span className="text-amber-700">Apps also not registered:</span>{' '}
              <span className="font-mono">{log.droppedApps.join(', ')}</span>
            </p>
          )}
          <p className="text-amber-700 mt-1 text-xs">
            To use apps + function tools on a Google model, remove webSearch from this profile (the
            agent loses native grounding) or split the step into two — one for grounded research,
            one for app/function calls.
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <CollapsibleBlock title="Prompts" count={messages.length}>
          {messages.map((m, i) => (
            <PromptMessage key={`${m.role}-${i}`} role={m.role} content={m.content} />
          ))}
        </CollapsibleBlock>
      )}

      {tools.length > 0 && (
        <CollapsibleBlock title="Tools available" count={tools.length}>
          <ul className="space-y-1">
            {tools.map((t, i) => (
              <li key={`${t.id || i}`} className="font-mono">
                {t.id}
                {t.description && (
                  <span className="text-gray-500 font-sans ml-1.5">— {t.description}</span>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleBlock>
      )}

      {sources.length > 0 && (
        <CollapsibleBlock title="Sources injected into system prompt" count={sources.length}>
          <p className="text-gray-500 mb-2">
            These were loaded by the runtime and embedded as a{' '}
            <span className="font-mono">&lt;sources&gt;</span> block in the system prompt. They do
            NOT appear as tool calls because the agent did not need to fetch them — they were
            already in context.
          </p>
          <ul className="space-y-1">
            {sources.map((s, i) => {
              const status = SOURCE_STATUS_LABEL[s.status] || {
                label: s.status || 'unknown',
                cls: 'bg-gray-100 text-gray-700'
              };
              return (
                <li key={`${s.id || i}`} className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-gray-800">{s.id}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${status.cls}`}>
                    {status.label}
                  </span>
                  {typeof s.bytesApprox === 'number' && s.bytesApprox > 0 && (
                    <span className="text-gray-500">~{s.bytesApprox} bytes</span>
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
          title="Apps available"
          count={apps.length}
          defaultOpen={appsBlockedCount > 0}
        >
          {appsBlockedCount > 0 && (
            <p className="text-amber-800 mb-2">
              {appsRegisteredCount} of {apps.length} configured apps were registered as tools on
              this step. Apps that were not registered are listed with the reason — the model never
              saw them.
            </p>
          )}
          <ul className="space-y-1">
            {apps.map((a, i) => (
              <li key={`${a.id || i}`} className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-gray-800">app__{a.id}</span>
                {a.registered ? (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    registered
                  </span>
                ) : (
                  <>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800">
                      not registered
                    </span>
                    <span className="text-gray-600">
                      {APP_NOT_REGISTERED_REASON[a.reason] || a.reason || 'unknown reason'}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleBlock>
      )}

      {toolCalls.length > 0 && (
        <CollapsibleBlock title="Tool calls" count={toolCalls.length} defaultOpen>
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
