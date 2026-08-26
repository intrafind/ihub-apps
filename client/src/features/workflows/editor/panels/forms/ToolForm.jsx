import { useCallback } from 'react';
import FormField from './FormField';
import JsonField from './JsonField';
import ResourcePicker from './ResourcePicker';
import { fetchTools } from '../../../../../api/endpoints/admin';

/**
 * Resolves the localized-or-plain `name`/`description` shapes the tools API
 * returns into a single display string.
 */
function text(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.en || Object.values(value)[0] || fallback;
  return fallback;
}

/**
 * The tools API lists multi-function tools as one entry with a `functions`
 * map, but a workflow calls one function by its expanded id — `iFinder` holds
 * `getContent`, which `runTool` reaches as `iFinder_getContent`. Offer the
 * expanded ids so the picker's value is something the engine can actually run.
 *
 * @param {Array<object>} tools - Raw tool list from the admin API
 * @returns {Array<{id: string, name: string, description: string}>}
 */
export function expandToolFunctions(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const toolName = text(tool.name, tool.id);
    const fns = tool.functions;
    if (fns && typeof fns === 'object' && !Array.isArray(fns) && Object.keys(fns).length > 0) {
      for (const [fn, cfg] of Object.entries(fns)) {
        out.push({
          id: `${tool.id}_${fn}`,
          name: `${toolName} · ${fn}`,
          description: text(cfg?.description, text(tool.description))
        });
      }
    } else {
      out.push({ id: tool.id, name: toolName, description: text(tool.description) });
    }
  }
  return out;
}

function ToolForm({ config, onChange, variables }) {
  const fetchToolsFn = useCallback(async () => {
    const tools = await fetchTools();
    return expandToolFunctions(Array.isArray(tools) ? tools : tools?.tools);
  }, []);

  return (
    <div className="space-y-3">
      <ResourcePicker
        label="Tool"
        fetchFn={fetchToolsFn}
        value={config.toolId}
        onChange={v => onChange({ ...config, toolId: v })}
        placeholder="Search tools..."
      />
      <JsonField
        label="Parameters"
        expect="object"
        value={config.parameters}
        onChange={v => onChange({ ...config, parameters: v })}
        placeholder={'{\n  "documentId": "$.data._currentDoc.docId"\n}'}
        helpText="One entry per tool parameter. A value like $.data.myVariable is read from workflow state."
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. toolResult"
        suggestions={variables}
        helpText="Where the tool's result is stored."
      />
      <FormField
        label="Timeout (ms)"
        type="number"
        value={config.timeout}
        onChange={v => onChange({ ...config, timeout: v || undefined })}
        placeholder="e.g. 90000"
      />
      <FormField
        label="Continue if this tool fails"
        type="checkbox"
        value={config.optional === true}
        onChange={v => onChange({ ...config, optional: v || undefined })}
      />
    </div>
  );
}

export default ToolForm;
