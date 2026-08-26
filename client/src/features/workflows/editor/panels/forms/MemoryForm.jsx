import FormField from './FormField';

/**
 * Configuration form for the memory node, which reads one section of an agent
 * profile's long-term memory into a workflow variable.
 */
function MemoryForm({ config, onChange, variables }) {
  const usesPath = !!config.profileIdPath || !config.profileId;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Reads one section of an agent&apos;s long-term memory — the notes admin discovery writes,
        such as a corpus map — so a later step can use it as context.
      </p>

      <FormField
        label="Which agent's memory"
        type="select"
        value={usesPath ? 'path' : 'fixed'}
        onChange={v =>
          onChange(
            v === 'path'
              ? {
                  ...config,
                  profileId: undefined,
                  profileIdPath: config.profileIdPath || 'agentProfileId'
                }
              : { ...config, profileIdPath: undefined, profileId: config.profileId || '' }
          )
        }
        options={[
          { value: 'path', label: 'From a workflow variable' },
          { value: 'fixed', label: 'A fixed agent profile' }
        ]}
      />

      {usesPath ? (
        <FormField
          label="Variable holding the agent profile ID"
          value={config.profileIdPath}
          onChange={v => onChange({ ...config, profileIdPath: v })}
          placeholder="agentProfileId"
          suggestions={variables}
          helpText="Usually collected by the Start step."
        />
      ) : (
        <FormField
          label="Agent profile ID"
          value={config.profileId}
          onChange={v => onChange({ ...config, profileId: v })}
          placeholder="e.g. stellungnahmen-reviewer"
        />
      )}

      <FormField
        label="Section heading"
        value={config.section}
        onChange={v => onChange({ ...config, section: v })}
        placeholder="e.g. iFinder corpus map"
        helpText="The '## ' heading in the memory file, without the hashes. Empty if the heading is absent."
      />

      <FormField
        label="Read into"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. corpusMap"
        helpText="The section's text is stored here — an empty string when there is nothing to read."
      />
    </div>
  );
}

export default MemoryForm;
