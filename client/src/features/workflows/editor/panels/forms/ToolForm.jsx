import { useCallback } from 'react';
import FormField from './FormField';
import ResourcePicker from './ResourcePicker';
import { fetchTools } from '../../../../../api/adminApi';

function ToolForm({ config, onChange }) {
  const fetchToolsFn = useCallback(() => fetchTools(), []);

  return (
    <div className="space-y-3">
      <ResourcePicker
        label="Tool Name"
        fetchFn={fetchToolsFn}
        value={config.toolName}
        onChange={v => onChange({ ...config, toolName: v })}
        placeholder="Search tools..."
      />
      <FormField
        label="Parameters"
        type="textarea"
        rows={6}
        value={config.parameters}
        onChange={v => onChange({ ...config, parameters: v })}
        placeholder="JSON object"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. toolResult"
      />
    </div>
  );
}

export default ToolForm;
