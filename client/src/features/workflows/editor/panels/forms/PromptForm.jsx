import { useState, useCallback } from 'react';
import FormField from './FormField';
import LocalizedField from './LocalizedField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';
import { fetchTools } from '../../../../../api/endpoints/admin';
import { fetchAdminSources } from '../../../../../api/adminApi';

function PromptForm({ config, onChange }) {
  const [schemaText, setSchemaText] = useState(() => {
    try {
      return config.outputSchema ? JSON.stringify(config.outputSchema, null, 2) : '';
    } catch {
      return '';
    }
  });

  const handleSchemaChange = text => {
    setSchemaText(text);
    if (!text.trim()) {
      onChange({ ...config, outputSchema: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      onChange({ ...config, outputSchema: parsed });
    } catch {
      // invalid JSON, keep text but don't update config
    }
  };

  const fetchSources = useCallback(() => fetchAdminSources(), []);
  const fetchToolsFn = useCallback(() => fetchTools(), []);
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <LocalizedField
        label="System Prompt"
        rows={6}
        value={config.system}
        onChange={v => onChange({ ...config, system: v })}
        placeholder="System instructions for the prompt..."
      />
      <LocalizedField
        label="User Prompt"
        rows={4}
        value={config.prompt}
        onChange={v => onChange({ ...config, prompt: v })}
        placeholder="Prompt template with {{variables}}..."
      />
      <ResourcePicker
        label="Model ID"
        fetchFn={fetchModelsFn}
        value={config.modelId}
        onChange={v => onChange({ ...config, modelId: v })}
        placeholder="Search models..."
      />
      <FormField
        label="Temperature"
        type="number"
        value={config.temperature}
        onChange={v => onChange({ ...config, temperature: v })}
        min={0}
        max={2}
        step={0.1}
      />
      <FormField
        label="Max Tokens"
        type="number"
        value={config.maxTokens}
        onChange={v => onChange({ ...config, maxTokens: v })}
        min={1}
      />
      <ResourcePicker
        label="Tools"
        fetchFn={fetchToolsFn}
        value={config.tools}
        onChange={v => onChange({ ...config, tools: v })}
        multi
        placeholder="Search tools..."
      />
      <ResourcePicker
        label="Sources"
        fetchFn={fetchSources}
        value={config.sources}
        onChange={v => onChange({ ...config, sources: v })}
        multi
        placeholder="Search sources..."
      />
      <FormField
        label="Max Iterations"
        type="number"
        value={config.maxIterations}
        onChange={v => onChange({ ...config, maxIterations: v })}
        min={1}
        max={50}
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. promptResult"
      />
      <div>
        <label className={labelClass}>Output Schema (JSON)</label>
        <textarea
          value={schemaText}
          onChange={e => handleSchemaChange(e.target.value)}
          rows={4}
          placeholder='{"type": "object", "properties": {...}}'
          className={`${inputClass} font-mono`}
        />
      </div>
      <FormField
        label="Auto Summarize"
        type="checkbox"
        value={config.autoSummarize}
        onChange={v => onChange({ ...config, autoSummarize: v })}
      />
    </div>
  );
}

export default PromptForm;
