import { useCallback } from 'react';
import FormField from './FormField';
import LocalizedField from './LocalizedField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';
import { fetchTools } from '../../../../../api/adminApi';

function PlannerForm({ config, onChange }) {
  const tt = config.taskTemplate || {};

  const onTT = (field, value) => {
    onChange({ ...config, taskTemplate: { ...tt, [field]: value } });
  };

  const fetchToolsFn = useCallback(() => fetchTools(), []);
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  return (
    <div className="space-y-3">
      <LocalizedField
        label="Goal"
        rows={4}
        value={config.goal}
        onChange={v => onChange({ ...config, goal: v })}
        placeholder="Describe the planning goal..."
      />
      <LocalizedField
        label="System Prompt"
        rows={4}
        value={config.system}
        onChange={v => onChange({ ...config, system: v })}
        placeholder="System instructions for the planner..."
      />
      <LocalizedField
        label="User Prompt"
        rows={4}
        value={config.prompt}
        onChange={v => onChange({ ...config, prompt: v })}
        placeholder="Prompt template with {{variables}}..."
      />
      <FormField
        label="Max Tasks"
        type="number"
        value={config.maxTasks}
        onChange={v => onChange({ ...config, maxTasks: v })}
        min={1}
        max={100}
      />
      <FormField
        label="Synthesize"
        type="checkbox"
        value={config.synthesize}
        onChange={v => onChange({ ...config, synthesize: v })}
      />
      <FormField
        label="Max Depth"
        type="number"
        value={config.maxDepth}
        onChange={v => onChange({ ...config, maxDepth: v })}
        min={1}
        max={10}
      />

      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 pt-2 border-t border-gray-200 dark:border-gray-700">
        Task Template
      </h4>
      <ResourcePicker
        label="Tools"
        fetchFn={fetchToolsFn}
        value={tt.tools}
        onChange={v => onTT('tools', v)}
        multi
        placeholder="Search tools..."
      />
      <ResourcePicker
        label="Model ID"
        fetchFn={fetchModelsFn}
        value={tt.modelId}
        onChange={v => onTT('modelId', v)}
        placeholder="Search models..."
      />
      <FormField
        label="Max Iterations"
        type="number"
        value={tt.maxIterations}
        onChange={v => onTT('maxIterations', v)}
        min={1}
        max={50}
      />
    </div>
  );
}

export default PlannerForm;
