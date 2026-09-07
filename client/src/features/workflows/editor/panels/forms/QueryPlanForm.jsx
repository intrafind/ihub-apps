import { useCallback } from 'react';
import FormField from './FormField';
import ResourcePicker from './ResourcePicker';
import { fetchModels } from '../../../../../api/endpoints/models';

/**
 * Config form for `query-plan` nodes.
 *
 * A query-plan node asks an LLM to expand a user question (plus optional
 * topic seeds) into a structured search plan (topics, synonyms, entities,
 * expansions) that a downstream `corpus-search` node executes.
 *
 * Advanced keys left to the JSON tab: `queryLanguagePath`, `thinking`.
 */
function QueryPlanForm({ config, onChange, variables }) {
  const fetchModelsFn = useCallback(() => fetchModels(), []);

  return (
    <div className="space-y-3">
      <FormField
        label="Question Path"
        value={config.questionPath}
        onChange={v => onChange({ ...config, questionPath: v })}
        placeholder="$.data.userQuestion"
        helpText="Where in workflow state to read the user's question. Default: $.data.userQuestion"
      />
      <FormField
        label="Topic Seeds Path"
        value={config.seedsPath}
        onChange={v => onChange({ ...config, seedsPath: v })}
        placeholder="$.data.topicSeeds"
        helpText="Optional. State path with topics that must appear in the plan. Leave empty for none."
      />
      <ResourcePicker
        label="Model"
        fetchFn={fetchModelsFn}
        value={config.modelId}
        onChange={v => onChange({ ...config, modelId: v })}
        placeholder="Search models..."
      />
      <FormField
        label="Max Topics"
        type="number"
        value={config.maxTopics}
        onChange={v => onChange({ ...config, maxTopics: v })}
        min={1}
        max={50}
        helpText="Most search queries the plan may contain. Default: 8"
      />
      <FormField
        label="Max Synonyms per Topic"
        type="number"
        value={config.maxSynonymsPerTopic}
        onChange={v => onChange({ ...config, maxSynonymsPerTopic: v })}
        min={1}
        max={20}
        helpText="Alternate phrasings generated for each topic. Default: 5"
      />
      <FormField
        label="Corpus Language"
        value={config.queryLanguage}
        onChange={v => onChange({ ...config, queryLanguage: v })}
        placeholder="e.g. de"
        helpText="Language the documents are written in (en, de, fr, ...). Queries are generated in this language. Leave empty to use the chat language."
      />
      <FormField
        label="Output Variable"
        value={config.outputVar}
        onChange={v => onChange({ ...config, outputVar: v })}
        placeholder="_queryPlan"
        suggestions={variables}
        helpText="State variable the finished plan is stored in. Default: _queryPlan"
      />
    </div>
  );
}

export default QueryPlanForm;
