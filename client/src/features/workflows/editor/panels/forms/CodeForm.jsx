import FormField from './FormField';

function CodeForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Code"
        type="textarea"
        rows={10}
        value={config.code}
        onChange={v => onChange({ ...config, code: v })}
        placeholder="// Your code here..."
      />
      <FormField
        label="Timeout"
        type="number"
        value={config.timeout}
        onChange={v => onChange({ ...config, timeout: v })}
        min={100}
        step={1000}
        placeholder="ms"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. codeResult"
      />
    </div>
  );
}

export default CodeForm;
