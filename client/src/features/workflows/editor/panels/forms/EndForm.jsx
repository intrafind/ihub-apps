import FormField from './FormField';
import ArrayField from './ArrayField';

function EndForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <ArrayField
        label="Output Variables"
        value={config.outputVariables}
        onChange={v => onChange({ ...config, outputVariables: v })}
        placeholder="Variable name"
      />
      <FormField
        label="Output Format"
        type="select"
        value={config.outputFormat}
        onChange={v => onChange({ ...config, outputFormat: v })}
        options={[
          { value: '', label: '— default —' },
          { value: 'json', label: 'JSON' },
          { value: 'text', label: 'Text' },
          { value: 'raw', label: 'Raw' }
        ]}
      />
      <FormField
        label="Include Node Outputs"
        type="checkbox"
        value={config.includeNodeOutputs}
        onChange={v => onChange({ ...config, includeNodeOutputs: v })}
      />
      <FormField
        label="Include Metadata"
        type="checkbox"
        value={config.includeMetadata}
        onChange={v => onChange({ ...config, includeMetadata: v })}
      />
    </div>
  );
}

export default EndForm;
