import FormField from './FormField';

/**
 * Config form for `inbox-load` nodes.
 *
 * Deterministically reads the agent's inbox and picks the highest-priority
 * open item (no LLM call). The picked item is stored in the state variable
 * `currentInboxItem`; when the inbox has no open items, the workflow ends.
 */
function InboxLoadForm({ config, onChange }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Inbox ID"
        value={config.inboxId}
        onChange={v => onChange({ ...config, inboxId: v })}
        placeholder="e.g. my-agent-inbox"
        helpText="Optional. Leave empty to use the inbox of the agent profile running this workflow."
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Picks the highest-priority open item (p1 before p2 before p3) and stores it in the state
        variable "currentInboxItem". If the inbox is empty, the workflow finishes without running
        the remaining nodes.
      </p>
    </div>
  );
}

export default InboxLoadForm;
