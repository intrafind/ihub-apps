import FormField from './FormField';

/**
 * Configuration form for the memory node, which reads one section of an agent
 * profile's long-term memory into a workflow variable.
 */
/**
 * Whether the form shows the "from a workflow variable" mode.
 *
 * Keyed on which config key is PRESENT, not on whether it holds a value:
 * choosing "a fixed agent profile" writes an empty string, and a truthiness
 * test would flip straight back to path mode before the user could type.
 *
 * @param {object} config - The node's config
 * @returns {boolean} True when the profile comes from a state path
 */
export function usesProfilePath(config) {
  return (config || {}).profileId === undefined;
}

function MemoryForm({ config, onChange, variables }) {
  const usesPath = usesProfilePath(config);

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
        onChange={v => {
          // Delete rather than set-to-undefined: presence is what selects the
          // mode, and an `undefined` value would still serialize away but read
          // as present until it does.
          const next = { ...config };
          if (v === 'path') {
            delete next.profileId;
            next.profileIdPath = config.profileIdPath || 'agentProfileId';
          } else {
            delete next.profileIdPath;
            next.profileId = config.profileId || '';
          }
          onChange(next);
        }}
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
          onChange={v => onChange({ ...config, profileId: v ?? '' })}
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
