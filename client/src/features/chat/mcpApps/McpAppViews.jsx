import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import McpAppView from './McpAppView';
import { normalizeMcpAppViews } from './mcpAppViewList';

/**
 * The MCP App views of one assistant answer.
 *
 * Read-only surfaces (a shared chat) show where a view was instead of loading
 * it: a view is live — it calls tools as the person looking at it — and a
 * shared link is for reading.
 *
 * @param {Object} props
 * @param {Array<Object>} props.views - `message.mcpApps`
 * @param {string} props.appId
 * @param {string} props.chatId
 * @param {boolean} [props.readOnly]
 * @param {{sendMessage: (text: string) => void, isProcessing: boolean}|null} [props.host] -
 *   What the chat lets a view do beyond its iframe (see McpAppView)
 */
function McpAppViews({ views, appId, chatId, readOnly = false, host = null }) {
  const { t } = useTranslation();
  const list = normalizeMcpAppViews(views);
  if (list.length === 0) return null;

  if (readOnly || !appId) {
    return list.map(view => (
      <div
        key={view.callId}
        className="my-2 flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-2 text-xs text-gray-500 dark:text-gray-400"
      >
        <Icon name="cube" size="sm" className="shrink-0" />
        <span>
          {t('mcpApps.readOnly', 'Interactive view “{{name}}” — open the chat to use it.', {
            name: view.toolName || view.toolId
          })}
        </span>
      </div>
    ));
  }

  return list.map(view => (
    <McpAppView key={view.callId} view={view} appId={appId} chatId={chatId} host={host} />
  ));
}

export default McpAppViews;
