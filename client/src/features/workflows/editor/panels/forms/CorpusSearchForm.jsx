import FormField from './FormField';

/**
 * Config form for `corpus-search` nodes.
 *
 * Runs every query of a query plan (or one literal query) against iFinder,
 * deduplicates the hits, optionally loads each document's fulltext, and
 * stores the result as the workflow's corpus array.
 *
 * Advanced key left to the JSON tab: `filterPath`.
 */

/** Render a string array as one entry per line for a textarea. */
const arrayToLines = value => (Array.isArray(value) ? value.join('\n') : value || '');

/**
 * Parse textarea lines back into a string array (empty text clears the key).
 * Blank lines are dropped: pressing Enter after the last entry would otherwise
 * send an empty query or filter to the search backend.
 */
const linesToArray = text => {
  if (typeof text !== 'string') return undefined;
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};

function CorpusSearchForm({ config, onChange, variables }) {
  return (
    <div className="space-y-3">
      <FormField
        label="Search Profile"
        value={config.searchProfile}
        onChange={v => onChange({ ...config, searchProfile: v })}
        placeholder="e.g. $.data.searchProfile"
        helpText="iFinder search profile id, or a $.data reference when the start node collects it from the user. Leave empty for the iFinder default."
      />
      <FormField
        label="Query Plan Path"
        value={config.planPath}
        onChange={v => onChange({ ...config, planPath: v })}
        placeholder="$.data._queryPlan"
        helpText="State path of the plan produced by a query-plan node. Default: $.data._queryPlan"
      />
      <FormField
        label="Single Query Path"
        value={config.queryPath}
        onChange={v => onChange({ ...config, queryPath: v })}
        placeholder="e.g. $.data._subQuestion"
        helpText="Optional. Run just this one query instead of the plan — useful inside loops. When set, the plan is ignored."
      />
      <FormField
        label="Extra Queries"
        type="textarea"
        rows={3}
        value={arrayToLines(config.extraQueries)}
        onChange={v => onChange({ ...config, extraQueries: linesToArray(v) })}
        placeholder={'$.data.userPrompt\n*'}
        helpText="Optional, one per line. Literal search strings or $.data references run in addition to the plan. * matches everything."
      />
      <FormField
        label="Filters"
        type="textarea"
        rows={3}
        value={arrayToLines(config.filter)}
        onChange={v => onChange({ ...config, filter: linesToArray(v) })}
        placeholder="e.g. mediaType:pdf"
        helpText="Optional iFinder filter expressions, one per line. All filters must match (AND)."
      />
      <FormField
        label="Max Results per Query"
        type="number"
        value={config.maxPerTopic}
        onChange={v => onChange({ ...config, maxPerTopic: v })}
        min={0}
        helpText="Hits kept per query. 0 = fetch every hit a query returns (bounded only by the total below). Default: 25"
      />
      <FormField
        label="Max Total Documents"
        type="number"
        value={config.maxTotalDocs}
        onChange={v => onChange({ ...config, maxTotalDocs: v })}
        min={1}
        helpText="Hard cap on unique documents collected across all queries. Default: 500"
      />
      <FormField
        label="Load Fulltext"
        type="checkbox"
        value={config.fetchFulltext ?? true}
        onChange={v => onChange({ ...config, fetchFulltext: v })}
      />
      <FormField
        label="Max Fulltext Characters"
        type="number"
        value={config.maxFulltextChars}
        onChange={v => onChange({ ...config, maxFulltextChars: v })}
        min={1000}
        step={1000}
        helpText="Characters loaded per document when fulltext is on. Default: 50000"
      />
      <FormField
        label="Corpus Variable"
        value={config.corpusVar}
        onChange={v => onChange({ ...config, corpusVar: v })}
        placeholder="_corpus"
        suggestions={variables}
        helpText="State variable the found documents are stored in. Default: _corpus"
      />
      <FormField
        label="Coverage Variable"
        value={config.coverageVar}
        onChange={v => onChange({ ...config, coverageVar: v })}
        placeholder="_coverage"
        suggestions={variables}
        helpText="State variable for coverage statistics (candidates, processed, quotes). Default: _coverage"
      />
    </div>
  );
}

export default CorpusSearchForm;
