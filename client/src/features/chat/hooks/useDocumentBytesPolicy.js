import { useEffect, useMemo, useState } from 'react';
import { fetchToolsBasic } from '../../../api';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { getDocumentBytesBudget, offersFileInputTool } from '../../upload/utils/documentBytes';

/** Stable empty list, so the memo below does not recompute on every render. */
const EMPTY_TOOLS = [];

/**
 * Whether the documents uploaded in a chat carry their own bytes, and how
 * many of them one message may carry.
 *
 * The bytes are only useful to a tool with file inputs (MCP `format: "file"`),
 * so they are attached only when the app offers such a tool. The chat learns
 * that from `/api/tools?appId=…` — the same (cached) request the tools menu
 * makes — where MCP tools advertise their file parameters as
 * `_mcp.fileInputs`. Until the list has loaded, or when it cannot be loaded
 * (tools feature off, request failed), no bytes are attached: a document then
 * travels as text only, as it did before file inputs existed.
 *
 * The budget comes from the platform's `requestBodyLimitMB` (see
 * `getDocumentBytesBudget`).
 *
 * @param {Object|null|undefined} app - The app the chat runs in
 * @param {Object} [options]
 * @param {string[]|null} [options.enabledTools] - The turn's enabled tools. Omit it
 *   to ask about the app's tool set as a whole (upload time); pass it to ask about
 *   the tools the next request will offer (send time).
 * @returns {{attachBytes: boolean, budget: number}}
 * @example
 *   const { attachBytes, budget } = useDocumentBytesPolicy(app);
 *   <UnifiedUploader includeDocumentBytes={attachBytes} documentBytesBudget={budget} … />
 */
export default function useDocumentBytesPolicy(app, { enabledTools } = {}) {
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const toolsFeatureEnabled = featureFlags.isEnabled('tools', true);
  const appId = app?.id;
  const appToolRefs = app?.tools;
  const hasAppTools = Array.isArray(appToolRefs) && appToolRefs.length > 0;
  const shouldLoad = Boolean(appId) && hasAppTools && toolsFeatureEnabled;
  // The loaded list, tagged with the app it belongs to so a list of the
  // previous app is never used while the next one loads.
  const [loaded, setLoaded] = useState({ appId: null, tools: [] });

  useEffect(() => {
    if (!shouldLoad) return undefined;
    let active = true;
    fetchToolsBasic({ appId })
      .then(tools => {
        if (active) setLoaded({ appId, tools: Array.isArray(tools) ? tools : [] });
      })
      .catch(() => {
        if (active) setLoaded({ appId, tools: [] });
      });
    return () => {
      active = false;
    };
  }, [appId, shouldLoad]);

  const availableTools = shouldLoad && loaded.appId === appId ? loaded.tools : EMPTY_TOOLS;

  const attachBytes = useMemo(
    () => shouldLoad && offersFileInputTool(appToolRefs, availableTools, enabledTools),
    [shouldLoad, appToolRefs, availableTools, enabledTools]
  );
  const budget = useMemo(
    () => getDocumentBytesBudget(platformConfig?.requestBodyLimitMB),
    [platformConfig?.requestBodyLimitMB]
  );

  return { attachBytes, budget };
}
