import { useCallback } from 'react';
import FormField from './FormField';
import LocalizedField from './LocalizedField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';

function VerifierForm({ config, onChange }) {
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  return (
    <div className="space-y-3">
      <LocalizedField
        label="Criteria"
        rows={4}
        value={config.criteria}
        onChange={v => onChange({ ...config, criteria: v })}
        placeholder="Verification criteria..."
      />
      <ResourcePicker
        label="Model ID"
        fetchFn={fetchModelsFn}
        value={config.modelId}
        onChange={v => onChange({ ...config, modelId: v })}
        placeholder="Search models..."
      />
      <FormField
        label="Input Variable"
        value={config.inputVariable}
        onChange={v => onChange({ ...config, inputVariable: v })}
        placeholder="e.g. promptResult"
      />
      <FormField
        label="Threshold"
        type="number"
        value={config.threshold}
        onChange={v => onChange({ ...config, threshold: v })}
        min={0}
        max={1}
        step={0.1}
      />
      <FormField
        label="Max Retries"
        type="number"
        value={config.maxRetries}
        onChange={v => onChange({ ...config, maxRetries: v })}
        min={0}
        max={10}
      />
    </div>
  );
}

export default VerifierForm;
