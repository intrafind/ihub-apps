import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import ArrayField from './ArrayField';

/**
 * The end step's settings. Its Output is the answer of the workflow, which the
 * chat shows as it is; everything below it is additional information that is
 * passed on next to it.
 */
function EndForm({ config, onChange, variables }) {
  const { t } = useTranslation();
  const missing = typeof config.output !== 'string' || config.output.trim() === '';
  return (
    <div className="space-y-3">
      <div>
        <FormField
          label={t('workflows.editor.endOutput', 'Output')}
          value={config.output}
          onChange={v => onChange({ ...config, output: v })}
          placeholder="finalReport"
          suggestions={variables}
          helpText={t(
            'workflows.editor.endOutputHelp',
            'The answer of the workflow, which the chat shows as it is: a variable (finalReport), a path into one (report.markdown) or a text with variables ({{summary}}). JSON stays JSON. Everything below is additional information.'
          )}
        />
        {missing && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            {t(
              'workflows.editor.endOutputMissing',
              'Every end step needs an output: the workflow cannot be saved, and a run that reaches this step fails, without one.'
            )}
          </p>
        )}
      </div>
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
