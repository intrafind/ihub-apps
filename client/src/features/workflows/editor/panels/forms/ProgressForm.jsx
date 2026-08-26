import FormField from './FormField';

/**
 * Config form for `progress` nodes.
 *
 * A zero-cost node that shows a status message in the chat while the
 * workflow runs — typically placed inside loops so each iteration is
 * visible (e.g. "Analysing document 3 / 12").
 */
function ProgressForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Message"
        type="textarea"
        rows={3}
        value={config.message}
        onChange={v => onChange({ ...config, message: v })}
        placeholder='Analysing document {{_docHuman}} / {{_docsTotal}} — "{{_currentDoc.title}}"'
        helpText="Text shown as a workflow step. Insert state variables with {{variableName}}, nested values with {{variable.field}}."
      />
      <FormField
        label="Status"
        type="select"
        value={config.status || 'running'}
        onChange={v => onChange({ ...config, status: v })}
        options={[
          { value: 'running', label: 'Running' },
          { value: 'completed', label: 'Completed' }
        ]}
        helpText='"Running" steps are marked done automatically when the next step starts — best for loops. "Completed" shows the message as a finished step right away.'
      />
    </div>
  );
}

export default ProgressForm;
