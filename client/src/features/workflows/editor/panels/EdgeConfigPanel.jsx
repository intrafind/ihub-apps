import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from './forms/FormField';

/**
 * Side panel for editing a selected edge's condition.
 * Turns the raw condition object into a small builder: pick when the
 * connection should be followed, and — for conditional types — which
 * variable/field to test and against what.
 *
 * @param {object} props
 * @param {object} props.selectedEdge - The currently selected React Flow edge
 * @param {Array<{value: string, label: string}>} props.variables - Upstream variable suggestions
 * @param {function} props.onUpdateEdge - (edgeId, { condition }) => void
 * @param {function} props.onDeleteEdge - (edgeId) => void
 * @param {function} props.onClose - Close the panel
 */
export function EdgeConfigPanel({ selectedEdge, variables, onUpdateEdge, onDeleteEdge, onClose }) {
  const { t } = useTranslation();
  const [condition, setCondition] = useState({ type: 'always' });

  useEffect(() => {
    if (selectedEdge) {
      setCondition(selectedEdge.data?.condition || { type: 'always' });
    }
  }, [selectedEdge?.id]);

  if (!selectedEdge) return null;

  const type = condition.type || 'always';

  const update = next => {
    setCondition(next);
    onUpdateEdge(selectedEdge.id, { condition: next });
  };

  const fieldSuggestions = [
    { value: 'result.branch', label: 'decision result (true/false)' },
    ...(variables || []).map(v => ({ value: `data.${v.value}`, label: v.label }))
  ];

  return (
    <div className="w-80 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('workflows.editor.edgeCondition', 'Connection condition')}
        </span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1"
          aria-label={t('common.close', 'Close')}
        >
          &#x2715;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'workflows.editor.edgeConditionHint',
            'When should the workflow follow this connection?'
          )}
        </p>

        <FormField
          label={t('workflows.editor.edgeWhen', 'Follow this connection')}
          type="select"
          value={type}
          onChange={v => {
            if (v === 'always' || v === 'never') update({ type: v });
            else if (v === 'expression')
              update({ type: v, expression: condition.expression || '' });
            else update({ type: v, field: condition.field || '', value: condition.value ?? '' });
          }}
          options={[
            { value: 'always', label: 'Always' },
            { value: 'equals', label: 'When a value equals…' },
            { value: 'contains', label: 'When a value contains…' },
            { value: 'exists', label: 'When a value exists' },
            { value: 'expression', label: 'When an expression is true (advanced)' },
            { value: 'never', label: 'Never (disable this path)' }
          ]}
        />

        {(type === 'equals' || type === 'contains' || type === 'exists') && (
          <FormField
            label={t('workflows.editor.edgeField', 'Value to check')}
            value={condition.field || ''}
            onChange={v => update({ ...condition, field: v })}
            suggestions={fieldSuggestions}
            placeholder="e.g. result.branch or data.searchResults"
            helpText={t(
              'workflows.editor.edgeFieldHelp',
              'Use result.branch for decision outcomes, or data.<variable> for workflow variables.'
            )}
          />
        )}

        {(type === 'equals' || type === 'contains') && (
          <FormField
            label={t('workflows.editor.edgeValue', 'Compare with')}
            value={condition.value ?? ''}
            onChange={v => update({ ...condition, value: v })}
            placeholder={type === 'equals' ? 'e.g. true' : 'e.g. error'}
          />
        )}

        {type === 'expression' && (
          <FormField
            label={t('workflows.editor.edgeExpression', 'Expression')}
            type="textarea"
            rows={3}
            value={condition.expression || ''}
            onChange={v => update({ ...condition, expression: v })}
            placeholder="$.data._docIndex < $.data._docsTotal"
            helpText={t(
              'workflows.editor.edgeExpressionHelp',
              'Boolean expression over workflow state, e.g. $.data.score > 0.8'
            )}
          />
        )}
      </div>

      <div className="shrink-0 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={() => onDeleteEdge(selectedEdge.id)}
          className="w-full border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-sm py-2 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          {t('workflows.editor.deleteEdge', 'Delete connection')}
        </button>
      </div>
    </div>
  );
}

export default EdgeConfigPanel;
