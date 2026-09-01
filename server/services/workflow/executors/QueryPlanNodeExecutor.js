/**
 * Executor for `query-plan` workflow nodes.
 *
 * Optional first step of a corpus-analysis workflow. Takes a user question
 * (and optional topic seeds) and asks an LLM to expand them into a
 * structured query plan: topics, synonyms, entities, filters, and
 * additional search expansions.
 *
 * The output is consumed by `corpus-search`. Workflows whose query is
 * fully known up-front (Stellungnahmen review with hard-coded topic
 * seeds) skip this node and feed a static plan directly to `corpus-search`.
 *
 * The plan shape is intentionally close to iFinder's actual search
 * surface (query-string DSL, return-field hints) rather than abstract
 * filter objects — iFinder doesn't expose structured filters beyond what
 * the query language carries.
 *
 * @module services/workflow/executors/QueryPlanNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { thinkingConfigToOptions } from '../thinkingOptions.js';
import configCache from '../../../configCache.js';

export class QueryPlanNodeExecutor extends BaseNodeExecutor {
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  async execute(node, state, context) {
    const config = node.config || {};
    const {
      questionPath = '$.data.userQuestion',
      seedsPath,
      outputVar = '_queryPlan',
      maxTopics = 8,
      maxSynonymsPerTopic = 5,
      queryLanguage: configQueryLanguage,
      queryLanguagePath = '$.data.queryLanguage'
    } = config;
    const language = context?.language || 'en';
    // The corpus language can differ from the chat locale (e.g. user types
    // English but the iFinder profile is German). Precedence: workflow state
    // (input variable) > node config literal > chat locale.
    const stateQueryLanguage = this.resolveVariable(queryLanguagePath, state);
    const queryLanguage =
      (typeof stateQueryLanguage === 'string' && stateQueryLanguage.trim()) ||
      (typeof configQueryLanguage === 'string' && configQueryLanguage.trim()) ||
      language;
    const languageNames = {
      en: 'English',
      de: 'German',
      fr: 'French',
      es: 'Spanish',
      it: 'Italian',
      nl: 'Dutch',
      pt: 'Portuguese'
    };
    const queryLanguageName = languageNames[queryLanguage] || queryLanguage;

    const question = this.resolveVariable(questionPath, state);
    if (!question || typeof question !== 'string') {
      return this.createErrorResult(
        `query-plan: could not resolve question at '${questionPath}'.`,
        { nodeId: node.id }
      );
    }
    const seeds = seedsPath ? this.resolveVariable(seedsPath, state) : null;

    const { data: models } = configCache.getModels();
    // Use the shared prompt-node precedence (config.modelId → _modelOverride →
    // workflow defaultModelId → context → global default) so the seed-plan step
    // honors the chat-selected model and the workflow default instead of
    // silently dropping to the global default model.
    const model = this.resolveModel(models, config, context, state, node.id);
    if (!model) {
      return this.createErrorResult('No model available for query planning', { nodeId: node.id });
    }
    const system =
      `You build search-query plans for an enterprise document index (iFinder, Elasticsearch-style query DSL). ` +
      `Given a user question and optional topic seeds, produce a plan that maximises recall over a permitted, indexed corpus. ` +
      `\n\nCORPUS LANGUAGE: ${queryLanguageName}. Generate ALL topics, synonyms, entities, and expansions in ${queryLanguageName}, ` +
      `even if the user question is in a different language. Do not translate proper nouns, legal citations, paragraph identifiers ` +
      `(e.g. "§ 48 SGB V") or product names. Preserve the indexed corpus's terminology — e.g. for German legal corpora use ` +
      `German legal terms and full word forms, not English equivalents.` +
      `\n\nReturn ONLY JSON of this shape (no prose, no markdown fences): ` +
      `{"topics":[<string>],"synonyms":{"<topic>":[<string>]},"entities":[<string>],"filters":{},"expansions":[<string>]}. ` +
      `topics: ${maxTopics} or fewer focused search queries (each is a complete query string, not a single keyword). ` +
      `synonyms: per-topic alternate phrasings/word families/acronyms (≤ ${maxSynonymsPerTopic} per topic). ` +
      `entities: named people/organisations/laws/regulations mentioned. ` +
      `filters: leave empty unless the question explicitly names a date range or document type. ` +
      `expansions: additional related queries the user did not ask but a thorough analyst would also run. ` +
      `Prefer iFinder query-language features when useful (e.g. "title:..." or field-scoped queries). Do not invent fields you cannot verify.`;

    const userParts = [`USER QUESTION:\n${question}`];
    if (seeds) {
      userParts.push(
        `TOPIC SEEDS (treat as required topics — include them verbatim AND with synonyms/word-family expansions):\n${
          typeof seeds === 'string' ? seeds : JSON.stringify(seeds)
        }`
      );
    }

    const llmResult = await this.llmHelper.runSingleShotLLM({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userParts.join('\n\n') }
      ],
      options: { temperature: 0.2, ...thinkingConfigToOptions(config.thinking) },
      language,
      errorLabel: 'query-plan LLM call'
    });
    if (!llmResult.success) {
      return this.createErrorResult(llmResult.error, { nodeId: node.id });
    }
    const plan = parsePlan(llmResult.content);

    if (!plan) {
      return this.createErrorResult('query-plan: LLM returned no parseable plan', {
        nodeId: node.id
      });
    }

    this.logger.info('query-plan complete', {
      component: 'QueryPlanNodeExecutor',
      nodeId: node.id,
      topicCount: plan.topics?.length || 0,
      expansionCount: plan.expansions?.length || 0
    });

    return this.createSuccessResult(plan, {
      stateUpdates: { [outputVar]: plan },
      resolvedInputs: {
        question,
        queryLanguage,
        seeds: seeds || null,
        modelId: model.id,
        maxTopics,
        maxSynonymsPerTopic
      }
    });
  }
}

function parsePlan(content) {
  if (typeof content !== 'string') return null;
  const cleaned = content.replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  return {
    topics: Array.isArray(parsed?.topics) ? parsed.topics.filter(s => typeof s === 'string') : [],
    synonyms:
      parsed?.synonyms && typeof parsed.synonyms === 'object' && !Array.isArray(parsed.synonyms)
        ? parsed.synonyms
        : {},
    entities: Array.isArray(parsed?.entities)
      ? parsed.entities.filter(s => typeof s === 'string')
      : [],
    filters:
      parsed?.filters && typeof parsed.filters === 'object' && !Array.isArray(parsed.filters)
        ? parsed.filters
        : {},
    expansions: Array.isArray(parsed?.expansions)
      ? parsed.expansions.filter(s => typeof s === 'string')
      : []
  };
}

export default QueryPlanNodeExecutor;
