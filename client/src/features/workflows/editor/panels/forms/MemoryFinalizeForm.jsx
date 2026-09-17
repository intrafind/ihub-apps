/**
 * Config form for `memory-finalize` nodes.
 *
 * This node has no settings: it deterministically writes all pending
 * long-term memory updates (queued in the state variable
 * `_pendingMemoryUpdates` by an upstream memory-compose prompt node) to the
 * agent profile's memory file. No LLM call is made.
 */
function MemoryFinalizeForm() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        This node needs no configuration. It saves every pending memory update queued earlier in the
        run (state variable "_pendingMemoryUpdates") to the agent profile's long-term memory, then
        clears the queue.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        If there is nothing to save — for example the memory composer decided the run produced no
        knowledge worth keeping — the node does nothing and the workflow continues normally.
      </p>
    </div>
  );
}

export default MemoryFinalizeForm;
