/**
 * Structured output for the inference API — the output contract a request
 * asks for, whether the model can honour it, and whether an answer does.
 *
 * Three sources can ask for structured output:
 *
 *   - Chat Completions `response_format` (`json_object` / `json_schema`)
 *   - Responses `text.format` (`json_object` / `json_schema`)
 *   - an app's `outputSchema`, which the app path applies itself
 *
 * All three end up as one normalized format `{ kind, schema?, name?, source }`
 * that maps onto the adapter options every provider already understands
 * (`responseFormat: 'json'`, `responseSchema`). Enforcement is the provider's
 * (OpenAI strict schema, Anthropic forced tool, Google/Mistral schema); this
 * module is the server-side check on top: the answer is extracted (Markdown
 * fences and surrounding prose stripped, for providers without native
 * enforcement) and validated with a JSON Schema validator.
 *
 * @module services/inference/structuredOutput
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extractJson } from '../loop/extractJson.js';
import { InferenceApiError } from './errors.js';

/**
 * Providers that enforce a JSON schema natively. Everything else is steered
 * by an instruction in the system prompt and relies on the server-side check.
 */
export const NATIVE_STRUCTURED_OUTPUT_PROVIDERS = Object.freeze([
  'openai',
  'openai-responses',
  'anthropic',
  'google',
  'mistral',
  'local'
]);

/**
 * Providers that cannot produce structured output at all: iAssistant answers
 * from its own retrieval pipeline and takes no output instructions.
 */
const NO_STRUCTURED_OUTPUT_PROVIDERS = Object.freeze(['iassistant-conversation']);

/** Compiled validators kept, keyed by the schema's JSON. */
const MAX_CACHED_VALIDATORS = 200;

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
addFormats(ajv);

/** @type {Map<string, Function>} */
const validatorCache = new Map();

/**
 * A schema as the validator compiles it: parsed when it is a JSON string (the
 * app schema allows one), and without the root `$schema` / `$id`. The dialect
 * marker would make the draft-07 validator refuse a 2020-12 schema whose
 * keywords it handles fine, and a root `$id` would clash between two versions
 * of the same app schema.
 *
 * @param {unknown} schema
 * @returns {Object|null}
 */
export function normalizeSchema(schema) {
  let value = schema;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { $schema: _dialect, $id: _id, ...rest } = value;
  return rest;
}

/**
 * The compiled validator of a schema.
 *
 * @param {Object} schema - Normalized schema.
 * @returns {Function} Ajv validate function.
 * @throws {Error} When the schema does not compile.
 */
function compile(schema) {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  if (validatorCache.size >= MAX_CACHED_VALIDATORS) {
    validatorCache.delete(validatorCache.keys().next().value);
  }
  validatorCache.set(key, validate);
  return validate;
}

/**
 * Check that a caller-supplied schema is usable, so a broken one is a 400
 * before any model is called rather than a validation failure after.
 *
 * @param {Object} schema
 * @param {string} param - Request field, for the error.
 * @throws {InferenceApiError}
 */
function assertCompiles(schema, param) {
  try {
    compile(schema);
  } catch (error) {
    throw new InferenceApiError(
      400,
      'invalid_json_schema',
      `Invalid JSON schema: ${error.message}`,
      {
        param
      }
    );
  }
}

/**
 * Chat Completions `response_format` → normalized format, or null for text.
 *
 * @param {unknown} responseFormat
 * @returns {{kind: 'json_object'|'json_schema', schema?: Object, name?: string, source: 'request'}|null}
 * @throws {InferenceApiError} 400 for an unknown type or a malformed schema.
 */
export function parseResponseFormat(responseFormat) {
  if (responseFormat === undefined || responseFormat === null) return null;
  if (typeof responseFormat !== 'object' || Array.isArray(responseFormat)) {
    throw new InferenceApiError(
      400,
      'invalid_response_format',
      'response_format must be an object',
      {
        param: 'response_format'
      }
    );
  }
  const { type } = responseFormat;
  if (type === 'text') return null;
  if (type === 'json_object') return { kind: 'json_object', source: 'request' };
  if (type === 'json_schema') {
    const spec = responseFormat.json_schema;
    if (!spec || typeof spec !== 'object') {
      throw new InferenceApiError(
        400,
        'invalid_response_format',
        'response_format.json_schema is required for type json_schema',
        { param: 'response_format.json_schema' }
      );
    }
    return schemaFormat(spec, 'response_format.json_schema');
  }
  throw new InferenceApiError(
    400,
    'invalid_response_format',
    `Unsupported response_format type: ${String(type)}. Use text, json_object or json_schema.`,
    { param: 'response_format.type' }
  );
}

/**
 * Responses `text` parameter → normalized format, or null for text.
 *
 * @param {unknown} text - The request's `text` object.
 * @returns {{kind: 'json_object'|'json_schema', schema?: Object, name?: string, source: 'request'}|null}
 * @throws {InferenceApiError}
 */
export function parseTextFormat(text) {
  if (text === undefined || text === null) return null;
  if (typeof text !== 'object' || Array.isArray(text)) {
    throw new InferenceApiError(400, 'invalid_text_format', 'text must be an object', {
      param: 'text'
    });
  }
  const format = text.format;
  if (format === undefined || format === null) return null;
  if (typeof format !== 'object' || Array.isArray(format)) {
    throw new InferenceApiError(400, 'invalid_text_format', 'text.format must be an object', {
      param: 'text.format'
    });
  }
  if (format.type === 'text') return null;
  if (format.type === 'json_object') return { kind: 'json_object', source: 'request' };
  if (format.type === 'json_schema') return schemaFormat(format, 'text.format');
  throw new InferenceApiError(
    400,
    'invalid_text_format',
    `Unsupported text.format type: ${String(format.type)}. Use text, json_object or json_schema.`,
    { param: 'text.format.type' }
  );
}

/**
 * A `json_schema` format spec (`{ name, schema, strict?, description? }`) →
 * normalized format.
 *
 * @param {Object} spec
 * @param {string} param
 * @returns {{kind: 'json_schema', schema: Object, name: string, source: 'request'}}
 */
function schemaFormat(spec, param) {
  const schema = normalizeSchema(spec.schema);
  if (!schema) {
    throw new InferenceApiError(
      400,
      'invalid_json_schema',
      `${param}.schema must be a JSON schema object`,
      {
        param: `${param}.schema`
      }
    );
  }
  assertCompiles(schema, `${param}.schema`);
  const name = typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 64) : 'response';
  return { kind: 'json_schema', schema, name, source: 'request' };
}

/**
 * The format an app imposes through its `outputSchema`, or null.
 *
 * @param {Object} app
 * @returns {{kind: 'json_schema', schema: Object, name: string, source: 'app'}|null}
 */
export function appOutputFormat(app) {
  if (!app?.outputSchema) return null;
  const schema = normalizeSchema(app.outputSchema);
  if (!schema) return null;
  return { kind: 'json_schema', schema, name: 'response', source: 'app' };
}

/**
 * Adapter options for a normalized format.
 *
 * @param {Object|null} format
 * @returns {{responseFormat?: 'json', responseSchema?: Object}}
 */
export function adapterOptionsFor(format) {
  if (!format) return {};
  if (format.kind === 'json_schema')
    return { responseFormat: 'json', responseSchema: format.schema };
  return { responseFormat: 'json' };
}

/**
 * Whether a model can be asked for structured output, and how.
 *
 * @param {Object} model - Resolved model config.
 * @returns {'native'|'prompted'|'unsupported'}
 */
export function structuredOutputSupport(model) {
  if (!model) return 'unsupported';
  if (model.supportsStructuredOutput === false) return 'unsupported';
  if (NO_STRUCTURED_OUTPUT_PROVIDERS.includes(model.provider)) return 'unsupported';
  if (NATIVE_STRUCTURED_OUTPUT_PROVIDERS.includes(model.provider)) return 'native';
  return 'prompted';
}

/**
 * Refuse a structured-output request the model cannot serve.
 *
 * @param {Object} model
 * @param {Object|null} format
 * @param {string} [label] - Model identifier for the message.
 * @throws {InferenceApiError} 400 `structured_output_not_supported`.
 */
export function assertStructuredOutputSupported(model, format, label) {
  if (!format) return;
  if (structuredOutputSupport(model) === 'unsupported') {
    throw new InferenceApiError(
      400,
      'structured_output_not_supported',
      `Model ${label || model?.id} (provider ${model?.provider}) does not support structured output`,
      { param: 'model' }
    );
  }
}

/**
 * The system instruction for a model without native enforcement.
 *
 * @param {Object} format
 * @returns {string}
 */
export function jsonInstruction(format) {
  if (format.kind === 'json_schema') {
    return `Respond only with valid JSON. The JSON must match this schema: ${JSON.stringify(format.schema)}`;
  }
  return 'Respond only with a valid JSON object.';
}

/**
 * Ajv errors in the shape the API reports them.
 *
 * @param {Array} errors
 * @returns {Array<{path: string, message: string, keyword: string}>}
 */
function describeErrors(errors) {
  return (errors || []).map(error => {
    let message = error.message || 'is invalid';
    if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
      message = `must not have additional property '${error.params.additionalProperty}'`;
    } else if (error.keyword === 'enum' && Array.isArray(error.params?.allowedValues)) {
      message = `must be one of ${error.params.allowedValues.map(v => JSON.stringify(v)).join(', ')}`;
    }
    return { path: error.instancePath || '/', message, keyword: error.keyword };
  });
}

/**
 * Build the answer check for a format.
 *
 * The verdict carries the parsed value and its canonical JSON text: what the
 * caller gets back is the validated JSON, not the model's wrapping of it.
 *
 * @param {Object} format - Normalized format.
 * @returns {(content: string) => {valid: boolean, value?: *, text?: string, errors?: Array}}
 */
export function createOutputValidator(format) {
  const validate = format.kind === 'json_schema' ? compile(format.schema) : null;
  return content => {
    const value = extractJson(typeof content === 'string' ? content : '');
    if (value === null) {
      return {
        valid: false,
        errors: [{ path: '/', message: 'the answer is not valid JSON', keyword: 'parse' }]
      };
    }
    if (format.kind === 'json_object') {
      if (Array.isArray(value)) {
        return {
          valid: false,
          errors: [{ path: '/', message: 'must be a JSON object', keyword: 'type' }]
        };
      }
      return { valid: true, value, text: JSON.stringify(value) };
    }
    if (validate(value)) return { valid: true, value, text: JSON.stringify(value) };
    return { valid: false, value, errors: describeErrors(validate.errors) };
  };
}

/**
 * The validation opt-out: `?validate=false` or `validate: false` in the body
 * (SDK callers reach the body through `extra_body`). On by default.
 *
 * @param {Object} req
 * @returns {boolean}
 */
export function validationRequested(req) {
  const query = req.query?.validate;
  if (typeof query === 'string' && ['false', '0', 'no', 'off'].includes(query.toLowerCase())) {
    return false;
  }
  return req.body?.validate !== false;
}

/**
 * The 422 an answer that never became valid produces.
 *
 * @param {{errors?: Array, attempts?: number}} verdict
 * @returns {InferenceApiError}
 */
export function outputValidationError(verdict) {
  const attempts = verdict?.attempts || 1;
  return new InferenceApiError(
    422,
    'output_validation_failed',
    `The model's answer did not match the output schema after ${attempts} attempt${
      attempts === 1 ? '' : 's'
    }`,
    { details: verdict?.errors || [] }
  );
}
