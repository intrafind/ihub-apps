import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { consumeMcpConnectResult, normalizeMcpAuthPrompts } from './mcpConnectPrompts';
import { buildMcpConnectUrl } from './mcpConnectUrl';
import { fetchMcpConnectionStates, invalidateMcpConnectionStates } from './mcpConnectionStatus';

/**
 * Asks the user to connect an MCP server that uses per-user sign-in, shown
 * under the answer whose tool call needed it.
 *
 * **Connect** leaves the page for the server's sign-in and comes back here;
 * the card then reads the result from the URL (once) and says whether the
 * server is connected, so the user can ask again. A stored card (a reopened
 * chat) asks the server whether the user is connected now and shows that
 * instead of the stale prompt.
 *
 * @param {Object} props
 * @param {{serverId: string, serverName: string}} props.prompt
 * @param {boolean} [props.readOnly] - Shared chats show the notice without a button
 * @param {(url: string) => void} [props.navigate] - Test seam; defaults to a full-page navigation
 */
export function McpConnectCard({ prompt, readOnly = false, navigate }) {
  const { t } = useTranslation();
  const [result] = useState(() => {
    const returned = consumeMcpConnectResult();
    if (returned.connected || returned.error) invalidateMcpConnectionStates();
    if (returned.connected === prompt.serverId) return 'connected';
    if (returned.error && returned.errorServer === prompt.serverId) return 'error';
    return null;
  });
  // Live state: true / false once known; null while unknown.
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (readOnly) return undefined;
    let cancelled = false;
    fetchMcpConnectionStates().then(states => {
      if (!cancelled && states.has(prompt.serverId)) setLive(states.get(prompt.serverId));
    });
    return () => {
      cancelled = true;
    };
  }, [prompt.serverId, readOnly]);
  const state =
    live === true ? 'connected' : live === false && result === 'connected' ? null : result;

  const connect = () => {
    const url = buildMcpConnectUrl(prompt.serverId);
    if (typeof navigate === 'function') navigate(url);
    else window.location.assign(url);
  };

  if (state === 'connected') {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 px-3 py-2 text-sm text-green-800 dark:text-green-200"
        role="status"
      >
        <Icon name="check-circle" size="sm" className="shrink-0" />
        <span>
          {t('mcpConnect.connected', '{{name}} is connected. Send your request again to use it.', {
            name: prompt.serverName
          })}
        </span>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-3 py-3 text-sm text-blue-900 dark:text-blue-100">
      <div className="flex items-start gap-2">
        <Icon name="lock-closed" size="sm" className="mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">
            {t('mcpConnect.title', 'Connect {{name}}', { name: prompt.serverName })}
          </p>
          <p className="mt-0.5 text-blue-800 dark:text-blue-200">
            {t(
              'mcpConnect.explanation',
              '{{name}} needs you to sign in with your own account before its tools can be used.',
              { name: prompt.serverName }
            )}
          </p>
          {state === 'error' && (
            <p className="mt-1 text-red-700 dark:text-red-300" role="alert">
              {t('mcpConnect.failed', 'Connecting {{name}} did not succeed. Try again.', {
                name: prompt.serverName
              })}
            </p>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={connect}
              className="mt-2 inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Icon name="link" size="sm" className="mr-1.5" />
              {t('mcpConnect.connect', 'Connect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Connect cards of one assistant answer (`message.mcpAuthRequired`).
 *
 * @param {Object} props
 * @param {Array<Object>} props.prompts
 * @param {boolean} [props.readOnly]
 */
function McpConnectCards({ prompts, readOnly = false }) {
  const list = normalizeMcpAuthPrompts(prompts);
  if (list.length === 0) return null;
  return list.map(prompt => (
    <McpConnectCard key={prompt.serverId} prompt={prompt} readOnly={readOnly} />
  ));
}

export default McpConnectCards;
