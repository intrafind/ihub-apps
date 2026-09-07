import FormField from './FormField';

/**
 * Config form for `template-render` nodes.
 *
 * Renders a Markdown report from workflow state (no LLM call) and saves it
 * as a run artifact. Templates use {{variable}} placeholders plus
 * {{#each}} / {{#if}} blocks; `records`, `coverage`, `synthesis` are
 * available as top-level aliases and the whole state under `data`.
 */
function TemplateRenderForm({ config, onChange, variables }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Template"
        type="textarea"
        rows={10}
        value={config.template}
        onChange={v => onChange({ ...config, template: v })}
        placeholder={
          '# Report\n\n{{userQuestion}}\n\n{{#each records}}\n- {{this.source.title}}\n{{/each}}'
        }
        helpText="Markdown with {{variable}} placeholders. {{#each records}}...{{/each}} loops, {{#if ...}}...{{/if}} conditions. Use {{data.someVariable}} to read any state variable."
      />
      <FormField
        label="Report File Name"
        value={config.artifactName}
        onChange={v => onChange({ ...config, artifactName: v })}
        placeholder="final-report.md"
        helpText="File name of the saved report artifact. Letters, numbers, dots, dashes and underscores only (no folders). Default: final-report.md"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. finalReport"
        suggestions={variables}
        helpText="Optional. State variable to store the rendered Markdown in, so the end node can show it as the final answer."
      />
      <FormField
        label="Report Details Variable"
        value={config.reportVar}
        onChange={v => onChange({ ...config, reportVar: v })}
        placeholder="e.g. reportInfo"
        suggestions={variables}
        helpText="Optional. Stores an object with the Markdown plus metadata (size, file name, timestamp)."
      />
      <FormField
        label="Records Variable"
        value={config.recordsVar}
        onChange={v => onChange({ ...config, recordsVar: v })}
        placeholder="_records"
        suggestions={variables}
        helpText="State array exposed to the template as {{records}}. Default: _records"
      />
      <FormField
        label="Coverage Variable"
        value={config.coverageVar}
        onChange={v => onChange({ ...config, coverageVar: v })}
        placeholder="_coverage"
        suggestions={variables}
        helpText="State variable exposed as {{coverage}}. Default: _coverage"
      />
      <FormField
        label="Synthesis Variable"
        value={config.synthesisVar}
        onChange={v => onChange({ ...config, synthesisVar: v })}
        placeholder="_synthesis"
        suggestions={variables}
        helpText="State variable exposed as {{synthesis}}. Default: _synthesis"
      />
    </div>
  );
}

export default TemplateRenderForm;
