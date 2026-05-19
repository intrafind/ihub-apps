import FormField from './FormField';

function ParallelForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. parallelResults"
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Configure parallel branches by connecting multiple nodes from this node&apos;s output.
      </p>
    </div>
  );
}

export default ParallelForm;
