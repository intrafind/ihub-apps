import { useState } from 'react';
import FormField from './FormField';

const MODE_OPTIONS = [
  { value: 'forEach', label: 'For each item in a list' },
  { value: 'for', label: 'A fixed number of times' },
  { value: 'while', label: 'While a condition is true (advanced)' },
  { value: 'drain', label: 'Work through the task queue (advanced)' }
];

/**
 * Configuration form for the loop container node.
 * The loop's steps are the nodes placed INSIDE the container on the canvas;
 * this form only configures what to repeat over and how results are collected.
 */
function LoopForm({ config, onChange, variables }) {
  const mode = config.mode || 'forEach';
  const [showAdvanced, setShowAdvanced] = useState(false);

  const arraySuggestions = (variables || []).filter(
    v => !v.value.startsWith('_loop') || v.value === '_loopItem'
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Place the steps to repeat <strong>inside this box on the canvas</strong>. Inside the loop,{' '}
        <code className="font-mono">{'{{_loopItem}}'}</code> is the current item and{' '}
        <code className="font-mono">{'{{_loopHuman}}'}</code>/
        <code className="font-mono">{'{{_loopTotal}}'}</code> the progress counter.
      </p>

      <FormField
        label="Repeat"
        type="select"
        value={mode}
        onChange={v => onChange({ ...config, mode: v })}
        options={MODE_OPTIONS}
      />

      {mode === 'forEach' && (
        <>
          <FormField
            label="List to repeat over"
            value={config.array}
            onChange={v => onChange({ ...config, array: v })}
            suggestions={arraySuggestions}
            placeholder="e.g. searchResults"
            helpText="Name of a list variable produced by an earlier step."
          />
          <FormField
            label="Run items in parallel"
            type="select"
            value={String(config.concurrency || 1)}
            onChange={v => {
              const parsed = Number(v);
              const next = { ...config };
              if (parsed > 1) next.concurrency = parsed;
              else delete next.concurrency;
              onChange(next);
            }}
            options={[
              { value: '1', label: 'Off — one after another' },
              { value: '2', label: '2 at a time' },
              { value: '3', label: '3 at a time' },
              { value: '5', label: '5 at a time' },
              { value: '10', label: '10 at a time' }
            ]}
            helpText="Parallel items cannot pass data to each other — only the collected results are kept."
          />
        </>
      )}

      {mode === 'for' && (
        <FormField
          label="How many times"
          type="number"
          value={config.count}
          onChange={v => onChange({ ...config, count: v })}
          min={1}
        />
      )}

      {mode === 'while' && (
        <FormField
          label="Keep repeating while"
          type="textarea"
          rows={3}
          value={config.condition}
          onChange={v => onChange({ ...config, condition: v })}
          placeholder="data.retryCount < 3"
          helpText="JavaScript condition over the workflow state, e.g. data.needsMoreWork === true"
        />
      )}

      {mode === 'drain' && (
        <FormField
          label="Task queue variable"
          value={config.queueKey}
          onChange={v => onChange({ ...config, queueKey: v })}
          placeholder="_taskQueue"
          helpText="State key holding the task queue. Steps inside may add more tasks."
        />
      )}

      <FormField
        label="Collect results into"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. analyses"
        helpText="After the loop, this variable holds one result per iteration."
      />

      <FormField
        label="Max iterations (safety limit)"
        type="range"
        value={config.maxIterations ?? 50}
        onChange={v => onChange({ ...config, maxIterations: v })}
        min={1}
        max={500}
        helpText="The loop always stops after this many rounds."
      />

      <button
        type="button"
        onClick={() => setShowAdvanced(s => !s)}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {showAdvanced ? 'Hide advanced options' : 'Advanced options…'}
      </button>

      {showAdvanced && (
        <div className="space-y-3 border-l-2 border-gray-200 dark:border-gray-700 pl-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Legacy workflows may define the loop body as inline JSON (<code>body</code>) instead of
            container steps — edit that via the JSON tab. Container steps are used whenever{' '}
            <code>body</code> is empty.
          </p>
        </div>
      )}
    </div>
  );
}

export default LoopForm;
