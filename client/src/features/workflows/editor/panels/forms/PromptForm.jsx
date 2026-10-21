// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import LocalizedField from './LocalizedField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';
import { fetchTools } from '../../../../../api/endpoints/admin';
import ProjectPicker from '../../../../admin/components/ProjectPicker';

function PromptForm({ config, onChange }) {
  const { t } = useTranslation();
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

  const fetchToolsFn = useCallback(() => fetchTools(), []);
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
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
      <FormField
        label="Max Web Searches"
        type="number"
        value={config.maxWebSearches}
        onChange={v => onChange({ ...config, maxWebSearches: v })}
        min={1}
        max={50}
      />
      <div>
        <div className={labelClass}>{t('admin.projects.picker.label', 'Projects')}</div>
        <ProjectPicker
          compact
          value={config.projects || []}
          onChange={links => onChange({ ...config, projects: links })}
        />
      </div>
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
