// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Model listing of AWS Bedrock for `POST /api/admin/models/_discover` (the
 * "Connect a model provider" wizard and the import dialog).
 *
 * Bedrock lists its models on the control plane of a region, not behind an
 * OpenAI-style `/models` URL:
 *
 *   GET https://bedrock.<region>.amazonaws.com/foundation-models
 *       → { modelSummaries: [{ modelId, modelName, providerName,
 *           inputModalities, outputModalities, inferenceTypesSupported,
 *           modelLifecycle }] }
 *   GET https://bedrock.<region>.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED
 *       → { inferenceProfileSummaries: [{ inferenceProfileId,
 *           inferenceProfileName, models: [{ modelArn }], status }], nextToken }
 *
 * Both are called with the Bedrock API key as `Authorization: Bearer …`, the
 * same credential the adapter (server/adapters/bedrock.js) sends to the
 * runtime — no AWS SDK and no SigV4 signing. The calls go through `httpFetch`,
 * so the platform's proxy and SSL whitelist apply exactly as they do for the
 * models later.
 *
 * Many current models (Claude 4, Llama 4, Nova in most regions) can only be
 * invoked through a cross-region inference profile. The listing says so in
 * `inferenceTypesSupported`; such a model is offered under the id of the
 * profile this region serves it with (`eu.anthropic.claude-sonnet-4-…`), which
 * the adapter sends unchanged. A model iHub cannot call from this region is
 * listed as `unsupported`.
 */

import { httpFetch, redactUrlSecrets } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';
import { fetchListingBody, ModelDiscoveryError } from './ModelEndpointDiscovery.js';
import {
  GLOBAL_BEDROCK_REGION,
  bedrockEndpointRegion,
  bedrockProfilePrefix,
  hasBedrockProfilePrefix,
  isValidBedrockRegion
} from '../../shared/bedrockRegions.js';

/** API type of the Bedrock adapter, and of the models imported from the listing. */
export const BEDROCK_API_TYPE = 'bedrock';

/** Most pages of inference profiles read (1000 per page). */
const MAX_PROFILE_PAGES = 10;

/** Most entries returned to the browser (same cap as the other listings). */
const MAX_BEDROCK_MODELS = 5000;

/**
 * Control-plane URLs of a region.
 *
 * @param {string} region - AWS region code or `global`
 * @returns {{ baseUrl: string, modelsUrl: string, profilesUrl: string, endpointRegion: string }}
 */
export function resolveBedrockEndpoints(region) {
  const endpointRegion = bedrockEndpointRegion(region);
  const baseUrl = `https://bedrock.${endpointRegion}.amazonaws.com`;
  return {
    baseUrl,
    modelsUrl: `${baseUrl}/foundation-models`,
    profilesUrl: `${baseUrl}/inference-profiles`,
    endpointRegion
  };
}

/** Request headers: JSON, and the Bedrock API key as a Bearer token when there is one. */
function bedrockHeaders(apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** AWS error types that mean "this key is not a valid credential". */
const INVALID_CREDENTIAL_PATTERN =
  /UnrecognizedClientException|InvalidSignatureException|IncompleteSignature|ExpiredToken|security token|invalid api key|api key format|authentication failed/i;

/**
 * Sort AWS's 401/403 into the readable causes the wizard explains. AWS answers
 * 403 both for a key it does not recognise and for a key whose IAM identity
 * may not call the action; the `x-amzn-ErrorType` header and the error body
 * tell them apart.
 *
 * @param {Response} response - Non-OK answer to a call that sent a key
 * @returns {Promise<ModelDiscoveryError|null>} Null for any other status (generic mapping)
 */
export async function bedrockRejection(response) {
  if (response.status !== 401 && response.status !== 403) return null;
  const errorType = String(response.headers?.get?.('x-amzn-errortype') || '');
  let text = '';
  try {
    text = await response.text();
  } catch {
    // An unreadable body leaves the header to decide.
  }
  const answer = `${errorType} ${text.slice(0, 2000)}`;
  if (/AccessDeniedException|not authorized to perform/i.test(answer)) {
    return new ModelDiscoveryError('accessDenied', 'AWS refused to list the Bedrock models', {
      upstreamStatus: response.status,
      details: `HTTP ${response.status}. The API key is valid, but its IAM identity may not list models (bedrock:ListFoundationModels). Give it the AmazonBedrockLimitedAccess policy or allow that action.`
    });
  }
  if (response.status === 401 || INVALID_CREDENTIAL_PATTERN.test(answer)) {
    return new ModelDiscoveryError(
      'authenticationFailed',
      'AWS did not accept the Bedrock API key',
      {
        upstreamStatus: response.status,
        details: `HTTP ${response.status}. Check that the key is complete and has not expired, or create a new one in the AWS console (Bedrock > API keys).`
      }
    );
  }
  return null;
}

/** First non-empty trimmed string among `values`, or null. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Upper-cased strings of a list field; anything else is an empty list. */
function upperList(value) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === 'string').map(v => v.trim().toUpperCase())
    : [];
}

/** The iHub model type of an output modality list. */
function typeFromOutputs(outputs) {
  if (outputs.includes('TEXT')) return 'chat';
  if (outputs.includes('EMBEDDING')) return 'embedding';
  if (outputs.includes('IMAGE')) return 'image';
  return 'other';
}

/** Foundation model id named at the end of a model ARN (`…:foundation-model/<id>`). */
function modelIdFromArn(arn) {
  if (typeof arn !== 'string') return null;
  const marker = 'foundation-model/';
  const index = arn.lastIndexOf(marker);
  return index === -1 ? null : arn.slice(index + marker.length) || null;
}

/**
 * Index the region's system-defined inference profiles by the foundation
 * model they route to.
 *
 * @param {Array<Object>} summaries - `inferenceProfileSummaries` of every page read
 * @returns {Map<string, Array<{ id: string, name: string }>>}
 */
export function indexInferenceProfiles(summaries) {
  const byModel = new Map();
  for (const summary of summaries || []) {
    const id = firstString(summary?.inferenceProfileId);
    if (!id) continue;
    if (summary.status && summary.status !== 'ACTIVE') continue;
    const name = firstString(summary.inferenceProfileName) || id;
    const modelIds = new Set(
      (Array.isArray(summary.models) ? summary.models : [])
        .map(m => modelIdFromArn(m?.modelArn))
        .filter(Boolean)
    );
    for (const modelId of modelIds) {
      if (!byModel.has(modelId)) byModel.set(modelId, []);
      byModel.get(modelId).push({ id, name });
    }
  }
  return byModel;
}

/**
 * The profile a model is invoked through from `region`: the one of the
 * region's geography (`eu.` for `eu-central-1`), else any non-global profile
 * the region serves. For `global` only a `global.` profile qualifies.
 *
 * @param {Array<{ id: string, name: string }>|undefined} profiles
 * @param {string} region
 * @returns {{ id: string, name: string }|null}
 */
function pickProfile(profiles, region) {
  if (!profiles || profiles.length === 0) return null;
  const prefix = bedrockProfilePrefix(region);
  if (region === GLOBAL_BEDROCK_REGION) {
    return profiles.find(p => p.id.startsWith('global.')) || null;
  }
  return (
    (prefix && profiles.find(p => p.id.startsWith(prefix))) ||
    profiles.find(p => !p.id.startsWith('global.')) ||
    null
  );
}

/**
 * Turn one entry of `ListFoundationModels` into a discovery entry with the id
 * the adapter is called with, or null for a model that cannot be called on
 * demand at all (provisioned-throughput-only variants such as `…:28k`).
 *
 * @param {Object} summary - One `modelSummaries` entry
 * @param {Object} context
 * @param {string} context.region - Region the admin chose (`global` included)
 * @param {Map<string, Array<{ id: string, name: string }>>|null} context.profiles
 *   Profiles by model; null when the profile listing could not be read
 * @returns {Object|null}
 */
export function normalizeBedrockModel(summary, { region, profiles }) {
  if (!summary || typeof summary !== 'object') return null;
  const modelId = firstString(summary.modelId);
  if (!modelId) return null;

  const inferenceTypes = upperList(summary.inferenceTypesSupported);
  const onDemand = inferenceTypes.includes('ON_DEMAND');
  const viaProfile = inferenceTypes.includes('INFERENCE_PROFILE');
  if (!onDemand && !viaProfile) return null;

  const type = typeFromOutputs(upperList(summary.outputModalities));
  const chat = type === 'chat';
  const baseName = firstString(summary.modelName) || modelId;

  // The id the adapter is called with. `global` always goes through a global
  // profile (the adapter would otherwise prefix a bare id with `global.`).
  let id = modelId;
  let name = baseName;
  let callable = true;
  if (region === GLOBAL_BEDROCK_REGION || !onDemand) {
    const profile = pickProfile(profiles?.get(modelId), region);
    if (profile) {
      id = profile.id;
      name = profile.name;
    } else if (profiles === null && !onDemand) {
      // Profiles unreadable: the adapter adds the region's prefix to a bare id
      // of a model it knows needs one; spell it out so the config is explicit.
      const prefix = bedrockProfilePrefix(region);
      if (prefix && !hasBedrockProfilePrefix(modelId)) id = `${prefix}${modelId}`;
    } else {
      callable = false;
    }
  }

  const lifecycle = summary.modelLifecycle || {};
  const endOfLife =
    firstString(lifecycle.endOfLifeTime) ||
    (String(lifecycle.status).toUpperCase() === 'LEGACY'
      ? firstString(lifecycle.legacyTime)
      : null);

  return {
    id,
    name,
    description: null,
    ownedBy: firstString(summary.providerName),
    type,
    contextWindow: null,
    maxOutputTokens: null,
    supportsVision: chat ? upperList(summary.inputModalities).includes('IMAGE') : null,
    // Converse reports no per-model tool support; the admin sets it.
    supportsTools: null,
    endOfLife,
    foundationModelId: modelId,
    // iHub runs Bedrock chat models through Converse only.
    ...(chat && callable ? {} : { unsupported: true })
  };
}

/**
 * Read every page of the region's system-defined inference profiles.
 * A failure is not fatal: the models are then offered under their bare ids,
 * with the region's profile prefix where the listing says one is needed.
 *
 * @returns {Promise<Array<Object>|null>} Summaries, or null when unreadable
 */
async function listInferenceProfiles({ fetchImpl, profilesUrl, apiKey }) {
  const summaries = [];
  let nextToken = null;
  try {
    for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
      const query = new URLSearchParams({ maxResults: '1000', type: 'SYSTEM_DEFINED' });
      if (nextToken) query.set('nextToken', nextToken);
      const body = await fetchListingBody({
        fetchImpl,
        requestUrl: `${profilesUrl}?${query}`,
        headers: bedrockHeaders(apiKey),
        modelsUrl: profilesUrl,
        provider: BEDROCK_API_TYPE,
        key: apiKey,
        rejectionCheck: bedrockRejection
      });
      if (Array.isArray(body?.inferenceProfileSummaries)) {
        summaries.push(...body.inferenceProfileSummaries);
      }
      nextToken = firstString(body?.nextToken);
      if (!nextToken) break;
    }
  } catch (err) {
    logger.warn('Bedrock inference profiles could not be listed', {
      component: 'BedrockModelDiscovery',
      url: redactUrlSecrets(profilesUrl),
      messageKey: err?.messageKey,
      error: err?.message
    });
    return null;
  }
  return summaries;
}

/**
 * List the Bedrock models a region offers, normalized like the other
 * listings of {@link import('./ModelEndpointDiscovery.js').discoverModels}.
 *
 * @param {Object} params
 * @param {string} params.region - AWS region code or `global`
 * @param {string} [params.apiKey] - Bedrock API key; without one AWS answers 403
 * @param {Object} [deps]
 * @param {typeof httpFetch} [deps.fetch] - Injected for tests; defaults to `httpFetch`
 * @returns {Promise<{ provider: 'bedrock', modelsUrl: string, baseUrl: string, azure: false,
 *   region: string, models: Array<Object> }>}
 * @throws {ModelDiscoveryError} `invalidRegion` (400) for a value that is not a region; the
 *   causes of {@link fetchListingBody} for a failed listing
 *
 * @example
 * const { models } = await discoverBedrockModels({ region: 'eu-central-1', apiKey });
 * // models[0] → { id: 'eu.anthropic.claude-sonnet-4-…', type: 'chat', … }
 */
export async function discoverBedrockModels({ region, apiKey } = {}, deps = {}) {
  if (!isValidBedrockRegion(region)) {
    throw new ModelDiscoveryError('invalidRegion', 'This is not an AWS region', {
      status: 400,
      details: 'Enter an AWS region code such as eu-central-1, or global.'
    });
  }
  const fetchImpl = deps.fetch || httpFetch;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const { baseUrl, modelsUrl, profilesUrl, endpointRegion } = resolveBedrockEndpoints(region);

  let body;
  try {
    body = await fetchListingBody({
      fetchImpl,
      requestUrl: modelsUrl,
      headers: bedrockHeaders(key),
      modelsUrl,
      provider: BEDROCK_API_TYPE,
      key,
      rejectionCheck: bedrockRejection
    });
  } catch (err) {
    if (err instanceof ModelDiscoveryError && err.messageKey === 'hostNotFound') {
      err.details.remediation = `There is no Bedrock endpoint for the region "${endpointRegion}". Check the spelling, or choose a region where Bedrock is offered.`;
    }
    throw err;
  }
  if (!Array.isArray(body?.modelSummaries)) {
    throw new ModelDiscoveryError('invalidResponse', 'The answer is not a Bedrock model list', {
      details: 'AWS answered without "modelSummaries".'
    });
  }

  const profileSummaries = await listInferenceProfiles({ fetchImpl, profilesUrl, apiKey: key });
  const profiles = profileSummaries ? indexInferenceProfiles(profileSummaries) : null;

  const seen = new Set();
  const models = [];
  for (const summary of body.modelSummaries) {
    const entry = normalizeBedrockModel(summary, { region, profiles });
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
    if (models.length >= MAX_BEDROCK_MODELS) break;
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  logger.info('Bedrock models discovered', {
    component: 'BedrockModelDiscovery',
    region,
    models: models.length,
    profiles: profileSummaries ? profileSummaries.length : null
  });

  return { provider: BEDROCK_API_TYPE, modelsUrl, baseUrl, azure: false, region, models };
}
