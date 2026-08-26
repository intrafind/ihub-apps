import { useCallback } from 'react';
import FormField from './FormField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';

/**
 * Config form for `quote-validator` nodes.
 *
 * Checks every quote in the collected records against the source document's
 * fulltext: first a fast text match, then an LLM double-check for quotes
 * that do not match exactly. Records with unverified quotes are marked
 * "partial" instead of failing the run.
 */
function QuoteValidatorForm({ config, onChange, variables }) {
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  return (
    <div className="space-y-3">
      <FormField
        label="Records Variable"
        value={config.recordsVar}
        onChange={v => onChange({ ...config, recordsVar: v })}
        placeholder="_records"
        suggestions={variables}
        helpText="State array holding the records whose quotes should be checked. Default: _records"
      />
      <FormField
        label="Corpus Variable"
        value={config.corpusVar}
        onChange={v => onChange({ ...config, corpusVar: v })}
        placeholder="_corpus"
        suggestions={variables}
        helpText="State array with the source documents (their fulltext is searched for each quote). Default: _corpus"
      />
      <FormField
        label="Coverage Variable"
        value={config.coverageVar}
        onChange={v => onChange({ ...config, coverageVar: v })}
        placeholder="_coverage"
        suggestions={variables}
        helpText="State variable where checked/validated quote counts are tracked. Default: _coverage"
      />
      <FormField
        label="Max Source Characters"
        type="number"
        value={config.maxSourceChars}
        onChange={v => onChange({ ...config, maxSourceChars: v })}
        min={1000}
        step={1000}
        helpText="How much of each document's fulltext is searched. Default: 30000"
      />
      <ResourcePicker
        label="Model"
        fetchFn={fetchModelsFn}
        value={config.modelId}
        onChange={v => onChange({ ...config, modelId: v })}
        placeholder="Search models..."
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The model is only used when a quote is not found word-for-word and needs an LLM
        double-check. Leave empty to use the workflow's default model.
      </p>
    </div>
  );
}

export default QuoteValidatorForm;
