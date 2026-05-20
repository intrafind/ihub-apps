/**
 * Shared validator for tool-call names emitted by LLM providers.
 *
 * Provider converters (Google/Anthropic/OpenAI/Mistral/Bedrock) extract a tool
 * name from the model's response and pass it downstream. Some models leak
 * chain-of-thought or internal control tokens (e.g. Gemini's `ctrl42`/`ctrl40`
 * function-call delimiters) into the name field. Without a sanity check, those
 * malformed names flow through normalizeToolName + the executor's allowlist
 * fallback and reach the tool loader as "Invalid tool id" errors that kill the
 * whole run.
 *
 * This validator is intentionally stricter than the downstream `isValidId` so
 * we drop garbage at the provider boundary, where we still know it came from
 * the model and can hand the model a clean error back.
 */

const VALID_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_NAME_LENGTH = 64;

export function isPlausibleToolName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  return VALID_NAME_PATTERN.test(name);
}

/**
 * Describe why a name failed validation. Used in warning logs so we can tell
 * "model produced empty name" apart from "model produced 400-char CoT".
 */
export function describeInvalidToolName(name) {
  if (typeof name !== 'string') return `not a string (typeof=${typeof name})`;
  if (name.length === 0) return 'empty string';
  if (name.length > MAX_NAME_LENGTH) {
    return `too long (${name.length} chars, max ${MAX_NAME_LENGTH})`;
  }
  if (!VALID_NAME_PATTERN.test(name)) {
    return 'contains characters outside [A-Za-z0-9_.-] or does not start with a letter or underscore';
  }
  return 'unknown reason';
}

export const TOOL_NAME_MAX_LENGTH = MAX_NAME_LENGTH;

/**
 * Validate a tool name at the provider boundary. Returns true if the name
 * looks plausible. If not, logs a warning and (if a result object is given)
 * appends a text notice so the model sees the rejection on the next turn.
 *
 * Use this at every provider converter's tool-call extraction site.
 */
export function validateProviderToolName({ name, provider, log, result }) {
  if (isPlausibleToolName(name)) return true;
  const reason = describeInvalidToolName(name);
  const truncated =
    typeof name === 'string' && name.length > 80 ? `${name.slice(0, 80)}…(${name.length})` : name;
  if (log && typeof log.warn === 'function') {
    log.warn(`${provider} emitted malformed tool name; dropping`, {
      component: `${provider}Converter`,
      reason,
      name: truncated
    });
  }
  if (result && Array.isArray(result.content)) {
    result.content.push(
      `[provider:${provider.toLowerCase()} dropped malformed function call] ${reason}: ${truncated}`
    );
  }
  return false;
}
