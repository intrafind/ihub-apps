import FormField from './FormField';
import ArrayField from './ArrayField';

function JoinForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Strategy"
        type="select"
        value={config.strategy}
        onChange={v => onChange({ ...config, strategy: v })}
        options={[
          { value: 'all', label: 'all' },
          { value: 'any', label: 'any' },
          { value: 'majority', label: 'majority' }
        ]}
      />
      <ArrayField
        label="Input Variables"
        value={config.inputVariables}
        onChange={v => onChange({ ...config, inputVariables: v })}
        placeholder="Variable name"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. joinedResult"
      />
    </div>
  );
}

export default JoinForm;
