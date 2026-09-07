import FormField from './FormField';

/**
 * Config form for `inbox-finalize` nodes.
 *
 * Deterministically marks the inbox item loaded by an earlier `inbox-load`
 * node as done (no LLM call), attaching a short completion note taken from
 * the run's synthesis output when available.
 */
function InboxFinalizeForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Inbox ID"
        value={config.inboxId}
        onChange={v => onChange({ ...config, inboxId: v })}
        placeholder="e.g. my-agent-inbox"
        helpText="Optional. Leave empty to use the inbox the item was loaded from (or the agent profile's inbox)."
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Marks the item in "currentInboxItem" (set by the inbox-load node) as done. If no item was
        loaded, or it was already completed elsewhere, the node simply does nothing.
      </p>
    </div>
  );
}

export default InboxFinalizeForm;
