// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AWS regions of the Bedrock adapter: which values the region of a Bedrock
 * provider or model may take, which region an API call is sent to, and which
 * cross-region inference-profile prefix a region implies.
 *
 * Shared by the adapter (server/adapters/bedrock.js), the model discovery of
 * the "Connect a model provider" wizard (server/services/BedrockModelDiscovery.js),
 * the provider routes that validate a stored region, and the admin UI that
 * asks for one. Pure: no server or React imports.
 */

/** Region used when neither the model, the provider nor the environment names one. */
export const DEFAULT_BEDROCK_REGION = 'eu-central-1';

/**
 * Pseudo-region for the global cross-region inference profiles
 * (`global.anthropic.…`). Calls are then sent to {@link GLOBAL_SOURCE_REGION}.
 */
export const GLOBAL_BEDROCK_REGION = 'global';

/** Source region the `global` profiles are invoked through (the iHub default region). */
export const GLOBAL_SOURCE_REGION = DEFAULT_BEDROCK_REGION;

/**
 * Regions offered as suggestions in the admin UI. Any other region that has
 * the shape of an AWS region is accepted too (see {@link isValidBedrockRegion}).
 */
export const BEDROCK_REGION_SUGGESTIONS = Object.freeze([
  'eu-central-1',
  'eu-central-2',
  'eu-west-1',
  'eu-west-3',
  'eu-north-1',
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ap-northeast-1',
  'ap-southeast-2',
  'ca-central-1',
  GLOBAL_BEDROCK_REGION
]);

/**
 * Shape of an AWS region code: `eu-central-1`, `ap-southeast-2`,
 * `us-gov-west-1`, `us-isob-east-1`. Deliberately a shape check rather than
 * a list, so a region AWS opens later works without a release. Anchored and
 * free of nested quantifiers (no catastrophic backtracking).
 */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-(?:gov|iso[a-z]?))?-[a-z]{4,10}-\d{1,2}$/;

/**
 * Whether `value` is a region the Bedrock adapter can be configured with: an
 * AWS region code or `global`. The region becomes part of the host name the
 * server calls (`bedrock-runtime.<region>.amazonaws.com`), so anything else —
 * dots, slashes, upper case — is refused rather than sent.
 *
 * @param {unknown} value
 * @returns {boolean}
 *
 * @example
 * isValidBedrockRegion('eu-central-1'); // true
 * isValidBedrockRegion('global');       // true
 * isValidBedrockRegion('evil.com/x');   // false
 */
export function isValidBedrockRegion(value) {
  if (typeof value !== 'string') return false;
  return value === GLOBAL_BEDROCK_REGION || AWS_REGION_PATTERN.test(value);
}

/**
 * The AWS region an API call for `region` is sent to: the region itself, or
 * the source region of the `global` profiles.
 *
 * @param {string|undefined|null} region
 * @returns {string}
 */
export function bedrockEndpointRegion(region) {
  if (!region || region === GLOBAL_BEDROCK_REGION) return GLOBAL_SOURCE_REGION;
  return region;
}

/**
 * The cross-region inference-profile prefix a region implies
 * (`eu-central-1` → `eu.`), or null when the region belongs to no profile
 * geography the adapter knows.
 *
 * `apac-` is kept for model configs written with the region placeholder the
 * Model Editor used to suggest (`apac-northeast-1`).
 *
 * @param {string|undefined|null} region
 * @returns {string|null}
 */
export function bedrockProfilePrefix(region) {
  if (!region) return null;
  if (region === GLOBAL_BEDROCK_REGION) return 'global.';
  if (region.startsWith('us-')) return 'us.';
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('apac-') || region.startsWith('ap-')) return 'apac.';
  return null;
}

/**
 * Geography prefixes of the system-defined cross-region inference profiles
 * AWS publishes (`eu.anthropic.…`, `jp.anthropic.…`, `global.anthropic.…`).
 */
const PROFILE_PREFIX_PATTERN = /^(?:us|us-gov|eu|apac|jp|au|ca|global)\./;

/**
 * Whether a Bedrock model id already names a cross-region inference profile,
 * in which case the adapter sends it as it is.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function hasBedrockProfilePrefix(modelId) {
  return typeof modelId === 'string' && PROFILE_PREFIX_PATTERN.test(modelId);
}
