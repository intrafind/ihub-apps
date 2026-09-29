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
import vm from 'node:vm';
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { extractJson } from '../loop/extractJson.js';
import { MAX_PATTERN_LENGTH, validateRegexPattern } from '../../utils/safeRegex.js';
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

/** Longest a single `pattern` test of one answer may run. */
const PATTERN_TEST_TIMEOUT_MS = 50;

/** Total time the `pattern` tests of one answer may take together. */
const PATTERN_BUDGET_MS = 250;

/**
 * Deadline for the `pattern` tests of the answer being validated right now.
 * Validation is synchronous, so one module-level deadline is enough: it is
 * set before each validation and read by every pattern test inside it.
 */
let patternDeadline = 0;

/**
 * A regular expression for Ajv whose tests run under a hard timeout.
 *
 * A caller's schema brings its own `pattern`s, and through the prompt a
 * caller also shapes the text they are tested against — the two things a
 * catastrophic-backtracking attack needs. So every test runs in a `vm`
 * context with a timeout (V8 interrupts a backtracking regex on it), and the
 * tests of one answer share a time budget. Patterns of a caller's schema are
 * also checked against the known-unsafe shapes when they are compiled, so the
 * obvious ones are a 400 up front.
 *
 * @param {{screen: boolean}} options - `screen`: refuse known-unsafe shapes at compile time.
 * @returns {(pattern: string, flags: string) => {test: (value: string) => boolean}}
 */
function timedRegExpEngine({ screen }) {
  return (pattern, flags) => {
    if (screen && pattern.length <= MAX_PATTERN_LENGTH) {
      const check = validateRegexPattern(pattern);
      if (!check.valid) throw new Error(`pattern ${JSON.stringify(pattern)}: ${check.error}`);
    }
    const re = new RegExp(pattern, flags);
    const context = vm.createContext({ re, text: '' });
    const script = new vm.Script('re.test(text)');
    return {
      test(value) {
        const remaining = patternDeadline - Date.now();
        if (remaining <= 0) throw new Error('the pattern checks ran out of time');
        context.text = String(value);
        try {
          return (
            script.runInContext(context, {
              timeout: Math.max(1, Math.min(PATTERN_TEST_TIMEOUT_MS, remaining))
            }) === true
          );
        } catch (error) {
          if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            throw new Error(`pattern ${JSON.stringify(pattern)} took too long to check`);
          }
          throw error;
        }
      },
      // Ajv shares compiled patterns by this string; it must name the pattern.
      toString: () => String(re)
    };
  };
}

const AJV_BY_DIALECT = { '2020-12': Ajv2020, '2019-09': Ajv2019, 'draft-07': Ajv };

/**
 * The JSON Schema dialect a schema declares through `$schema`.
 *
 * @param {unknown} schema - Raw schema (object or JSON string).
 * @returns {'2020-12'|'2019-09'|'draft-07'}
 */
export function schemaDialect(schema) {
  let value = schema;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return 'draft-07';
    }
  }
  const declared = typeof value?.$schema === 'string' ? value.$schema : '';
  if (declared.includes('2020-12')) return '2020-12';
  if (declared.includes('2019-09')) return '2019-09';
  return 'draft-07';
}

/**
 * Compiled validators of app schemas, keyed by the configuration object the
 * schema came from: an app's schema compiles once per config load, and a
 * reload (new objects) lets the old entry go with the old config.
 *
 * @type {WeakMap<Object, {schema: Object|null, validate: Function|null, error: string|null}>}
 */
const appValidators = new WeakMap();

/**
 * A schema as the validator compiles it: parsed when it is a JSON string (the
 * app schema allows one), and without the root `$schema` / `$id` — the dialect
 * is chosen from `$schema` separately ({@link schemaDialect}), and providers
 * take the schema without either.
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
 * Compile a schema into a validate function, on an Ajv instance of its own.
 *
 * An Ajv instance keeps what it compiled — the schema, the generated code and
 * its values — for as long as the instance lives, and `removeSchema` does not
 * release all of it. A shared instance would grow with every caller schema;
 * one instance per compile goes when its validate function goes (with the
 * request, or with the app config it came from). Compiling that way costs a
 * few milliseconds, next to a model call.
 *
 * @param {Object} schema - Normalized schema.
 * @param {Object} [options]
 * @param {string} [options.dialect='draft-07'] - {@link schemaDialect}.
 * @param {boolean} [options.screen=true] - Refuse known-unsafe `pattern` shapes.
 * @returns {Function} Ajv validate function.
 * @throws {Error} When the schema does not compile.
 */
function compileSchema(schema, { dialect = 'draft-07', screen = true } = {}) {
  const AjvClass = AJV_BY_DIALECT[dialect] || Ajv;
  const ajv = new AjvClass({
    allErrors: true,
    strict: false,
    logger: false,
    code: { regExp: timedRegExpEngine({ screen }) }
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

/**
 * Compile a caller-supplied schema, so a broken one is a 400 before any
 * model is called rather than a validation failure after.
 *
 * @param {Object} schema
 * @param {string} param - Request field, for the error.
 * @returns {Function} Ajv validate function.
 * @throws {InferenceApiError}
 */
function compileRequestSchema(schema, dialect, param) {
  try {
    return compileSchema(schema, { dialect, screen: true });
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
  const validate = compileRequestSchema(schema, schemaDialect(spec.schema), `${param}.schema`);
  const name = typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 64) : 'response';
  return { kind: 'json_schema', schema, name, source: 'request', validate };
}

/**
 * The format an app imposes through its `outputSchema`, or null. A schema
 * that does not compile is reported on the format as `compileError`.
 *
 * @param {Object} app
 * @returns {{kind: 'json_schema', schema: Object, name: string, source: 'app',
 *   validate?: Function, compileError?: string}|null}
 */
export function appOutputFormat(app) {
  if (!app?.outputSchema) return null;
  const holder = typeof app.outputSchema === 'object' ? app.outputSchema : app;
  let entry = appValidators.get(holder);
  if (!entry) {
    const schema = normalizeSchema(app.outputSchema);
    entry = { schema, validate: null, error: null };
    if (schema) {
      try {
        // An admin's schema: its patterns are timed, not screened.
        entry.validate = compileSchema(schema, {
          dialect: schemaDialect(app.outputSchema),
          screen: false
        });
      } catch (error) {
        entry.error = error.message;
      }
    }
    appValidators.set(holder, entry);
  }
  if (!entry.schema) return null;
  return {
    kind: 'json_schema',
    schema: entry.schema,
    name: 'response',
    source: 'app',
    ...(entry.validate ? { validate: entry.validate } : { compileError: entry.error })
  };
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
  const validate =
    format.kind === 'json_schema' ? format.validate || compileSchema(format.schema) : null;
  const check = value => {
    patternDeadline = Date.now() + PATTERN_BUDGET_MS;
    try {
      return validate(value)
        ? { ok: true }
        : { ok: false, errors: describeErrors(validate.errors) };
    } catch (error) {
      // A pattern that ran out of time: the answer cannot be shown to match.
      return { ok: false, errors: [{ path: '/', message: error.message, keyword: 'pattern' }] };
    } finally {
      patternDeadline = 0;
    }
  };
  return content => {
    const value = extractJson(typeof content === 'string' ? content : '');
    if (value === null) {
      return {
        valid: false,
        errors: [{ path: '/', message: 'the answer is not valid JSON', keyword: 'parse' }]
      };
    }
    if (format.kind === 'json_object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return {
          valid: false,
          errors: [{ path: '/', message: 'must be a JSON object', keyword: 'type' }]
        };
      }
      return { valid: true, value, text: JSON.stringify(value) };
    }
    const result = check(value);
    if (result.ok) return { valid: true, value, text: JSON.stringify(value) };
    return { valid: false, value, errors: result.errors };
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
