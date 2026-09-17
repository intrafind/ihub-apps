import { useCallback } from 'react';
import FormField from './FormField';
import LocalizedField from './LocalizedField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';

function VerifierForm({ config, onChange, variables }) {
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  return (
    <div className="space-y-3">
      <FormField
        label="Mode"
        type="select"
        value={config.mode || 'quality'}
        onChange={v => onChange({ ...config, mode: v })}
        options={[
          { value: 'quality', label: 'Quality' },
          { value: 'adversarial', label: 'Adversarial' }
        ]}
        helpText="Quality scores the output against the criteria below. Adversarial runs a tool-enabled reviewer that actively hunts for gaps before giving its verdict."
      />
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
        suggestions={variables}
        helpText="State variable holding the output to verify. Leave empty to verify the previous node's result."
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
