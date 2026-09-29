/**
 * Unit specs for the inference API building blocks (services/inference):
 * the `model` identifier, app variables through `prompt.variables`, the
 * per-turn template rules, the structured-output formats and their
 * server-side validation, the Anthropic `json` tool lift, request input
 * conversion and conversation items.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import {
  appModelLabel,
  parseModelIdentifier,
  resolveInferenceTarget
} from '../services/inference/modelIdentifier.js';
import { resolvePromptVariables } from '../services/inference/promptVariables.js';
import { turnPrompt } from '../services/inference/appTurn.js';
import {
  appOutputFormat,
  createOutputValidator,
  normalizeSchema,
  parseResponseFormat,
  parseTextFormat,
  structuredOutputSupport,
  validationRequested
} from '../services/inference/structuredOutput.js';
import {
  liftJsonToolChunk,
  liftJsonToolResult,
  withJsonInstruction
} from '../services/inference/plainTurn.js';
import {
  documentFromInlineFile,
  messagesFromChatCompletions,
  messagesFromResponsesInput
} from '../services/inference/inputContent.js';
import {
  assertBinding,
  historyForModel,
  itemFromMessage,
  messagesFromItems,
  validateMetadata
} from '../services/inference/conversations.js';
import { structuredOutputSeam } from '../services/loop/seams/structuredOutputSeam.js';

const MODELS = [
  { id: 'gpt', provider: 'openai', supportsTools: true },
  { id: 'claude', provider: 'anthropic', supportsTools: true },
  { id: 'notools', provider: 'openai', supportsTools: false },
  { id: 'ia', provider: 'iassistant-conversation' },
  { id: 'br', provider: 'bedrock' }
];
const findModel = id => MODELS.find(m => m.id.toLowerCase() === String(id).toLowerCase()) || null;

const APPS = [
  { id: 'summarizer', preferredModel: 'gpt', allowedModels: ['gpt', 'claude', 'notools'] },
  { id: 'locked', preferredModel: 'gpt', disallowModelSelection: true },
  { id: 'tooling', tools: ['webSearch'], preferredModel: 'gpt' },
  { id: 'nda', preferredModel: 'gpt', outputSchema: { type: 'object' } },
  { id: 'redirect', type: 'redirect' }
];

const all = () => ({ id: 'u', permissions: { apps: new Set(['*']), models: new Set(['*']) } });

async function throwsApi(fn, { status, code }) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.status, status, `status of ${error.code}: ${error.message}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

describe('model identifier', () => {
  test.before(() => configCache.setCacheEntry('config/apps.json', APPS));

  it('parses plain models, apps and app/model pairs', () => {
    assert.deepEqual(parseModelIdentifier('gpt'), { appId: null, modelId: 'gpt' });
    assert.deepEqual(parseModelIdentifier('app:summarizer'), {
      appId: 'summarizer',
      modelId: null
    });
    assert.deepEqual(parseModelIdentifier('app:summarizer/claude'), {
      appId: 'summarizer',
      modelId: 'claude'
    });
    assert.equal(appModelLabel('summarizer', 'claude'), 'app:summarizer/claude');
  });

  it('refuses malformed identifiers', async () => {
    for (const bad of ['app:', 'app:/gpt', 'app:x/', 'app:x/a/b']) {
      await throwsApi(() => parseModelIdentifier(bad), { status: 400, code: 'invalid_model' });
    }
    await throwsApi(() => parseModelIdentifier(''), { status: 400, code: 'missing_model' });
  });

  it('resolves an app on its default model, leaving the choice to the pipeline', () => {
    const target = resolveInferenceTarget({ model: 'app:summarizer', user: all(), findModel });
    assert.equal(target.kind, 'app');
    assert.equal(target.app.id, 'summarizer');
    assert.equal(target.modelId, null);
  });

  it('checks an explicit model against the app and the caller', async () => {
    const ok = resolveInferenceTarget({ model: 'app:summarizer/claude', user: all(), findModel });
    assert.equal(ok.modelId, 'claude');

    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:summarizer/br', user: all(), findModel }),
      {
        status: 400,
        code: 'model_not_allowed_for_app'
      }
    );
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:locked/claude', user: all(), findModel }),
      {
        status: 400,
        code: 'model_selection_disabled'
      }
    );
    // The preferred model is still accepted on a locked app.
    assert.equal(
      resolveInferenceTarget({ model: 'app:locked/gpt', user: all(), findModel }).modelId,
      'gpt'
    );
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:tooling/notools', user: all(), findModel }),
      { status: 400, code: 'model_capability_missing' }
    );
    await throwsApi(() => resolveInferenceTarget({ model: 'app:nda/ia', user: all(), findModel }), {
      status: 400,
      code: 'structured_output_not_supported'
    });
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:summarizer/nope', user: all(), findModel }),
      { status: 404, code: 'model_not_found' }
    );
    const onlyGpt = { id: 'u', permissions: { apps: new Set(['*']), models: new Set(['gpt']) } };
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:summarizer/claude', user: onlyGpt, findModel }),
      { status: 403, code: 'model_access_denied' }
    );
  });

  it('answers 404 alike for an unknown app and an app the caller may not use', async () => {
    const noApps = { id: 'u', permissions: { apps: new Set(['nda']), models: new Set(['*']) } };
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:summarizer', user: noApps, findModel }),
      {
        status: 404,
        code: 'app_not_found'
      }
    );
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:missing', user: all(), findModel }),
      {
        status: 404,
        code: 'app_not_found'
      }
    );
    await throwsApi(
      () => resolveInferenceTarget({ model: 'app:redirect', user: all(), findModel }),
      {
        status: 400,
        code: 'app_not_invocable'
      }
    );
  });
});

describe('prompt.variables', () => {
  const app = {
    id: 'summarizer',
    variables: [
      {
        name: 'action',
        type: 'select',
        required: true,
        predefinedValues: [
          { value: 'summarize', label: { en: 'Summarize', de: 'Zusammenfassen' } },
          { value: 'translate', label: { en: 'Translate' } }
        ],
        defaultValue: { en: 'Summarize', de: 'Zusammenfassen' }
      },
      { name: 'max_points', type: 'number' },
      { name: 'include_quotes', type: 'boolean' },
      { name: 'since', type: 'date' },
      { name: 'topic', type: 'string', required: true },
      { name: 'tone', type: 'text', defaultValue: { en: 'neutral', de: 'sachlich' } }
    ]
  };

  it('coerces values and fills defaults in the request language', () => {
    const { provided, variables } = resolvePromptVariables({
      prompt: {
        id: 'summarizer',
        version: '7',
        variables: { max_points: 5, include_quotes: 'TRUE', since: '2026-02-28', topic: 'x' }
      },
      app,
      language: 'de'
    });
    assert.equal(provided, true);
    assert.deepEqual(variables, {
      // A default naming an option's label resolves to the option's value.
      action: 'summarize',
      max_points: '5',
      include_quotes: 'true',
      since: '2026-02-28',
      topic: 'x',
      tone: 'sachlich'
    });
  });

  it('reports every violation in one 400, per variable', async () => {
    const error = await throwsApi(
      () =>
        resolvePromptVariables({
          prompt: {
            variables: {
              action: 'dance',
              max_points: 'five',
              include_quotes: 'yes',
              since: '2026-02-30',
              nope: 'x',
              tone: { type: 'input_file', file_data: 'x' }
            }
          },
          app,
          language: 'en'
        }),
      { status: 400, code: 'invalid_prompt_variables' }
    );
    const byVariable = Object.fromEntries(error.details.map(d => [d.variable, d.code]));
    assert.deepEqual(byVariable, {
      nope: 'unknown_variable',
      action: 'invalid_value',
      max_points: 'invalid_type',
      include_quotes: 'invalid_type',
      since: 'invalid_type',
      topic: 'missing_required',
      tone: 'file_value_not_supported'
    });
  });

  it('refuses a prompt.id naming another app', async () => {
    await throwsApi(
      () => resolvePromptVariables({ prompt: { id: 'other' }, app, language: 'en' }),
      { status: 400, code: 'prompt_id_mismatch' }
    );
  });

  it('without prompt.variables, every variable still has a value (defaults, else empty)', async () => {
    const lax = { id: 'x', variables: app.variables.filter(v => v.name !== 'topic') };
    const { provided, variables } = resolvePromptVariables({
      prompt: undefined,
      app: lax,
      language: 'en'
    });
    assert.equal(provided, false);
    assert.equal(variables.action, 'summarize');
    assert.equal(variables.max_points, '');
    assert.equal(variables.tone, 'neutral');
  });
});

describe('turn template rules', () => {
  const resolvedNone = { provided: false, variables: { action: 'summarize', doc: '' } };
  const resolvedSome = { provided: true, variables: { action: 'translate', doc: 'd2' } };

  it('wraps the first turn, and a follow-up only when it sends variables', () => {
    assert.deepEqual(turnPrompt({ firstTurn: true, resolved: resolvedNone }), {
      applyTemplate: true,
      variables: resolvedNone.variables,
      storeVariables: true
    });
    const followUp = turnPrompt({
      firstTurn: false,
      resolved: resolvedNone,
      stored: { action: 'summarize', doc: 'd1' }
    });
    assert.equal(followUp.applyTemplate, false);
    assert.equal(followUp.storeVariables, false);
    // The system prompt keeps the variables of the turn that last set them.
    assert.deepEqual(followUp.variables, { action: 'summarize', doc: 'd1' });

    const reparameterized = turnPrompt({
      firstTurn: false,
      resolved: resolvedSome,
      stored: { action: 'summarize', doc: 'd1' }
    });
    assert.equal(reparameterized.applyTemplate, true);
    assert.deepEqual(reparameterized.variables, resolvedSome.variables);
  });

  it('wraps every turn of an app that sends no history, on the stored variables', () => {
    const oneShot = turnPrompt({
      firstTurn: false,
      resolved: resolvedNone,
      stored: { action: 'summarize', doc: 'd1' },
      historyReplayed: false
    });
    assert.equal(oneShot.applyTemplate, true);
    assert.equal(oneShot.storeVariables, false);
    assert.deepEqual(oneShot.variables, { action: 'summarize', doc: 'd1' });
  });
});

describe('structured output', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { risk: { type: 'string', enum: ['low', 'high'] }, score: { type: 'number' } },
    required: ['risk'],
    additionalProperties: false
  };

  it('parses response_format and text.format', async () => {
    assert.equal(parseResponseFormat({ type: 'text' }), null);
    assert.deepEqual(parseResponseFormat({ type: 'json_object' }), {
      kind: 'json_object',
      source: 'request'
    });
    const fromChat = parseResponseFormat({
      type: 'json_schema',
      json_schema: { name: 'r', schema }
    });
    assert.equal(fromChat.kind, 'json_schema');
    assert.equal(fromChat.name, 'r');
    assert.equal(fromChat.schema.$schema, undefined, 'the dialect marker is dropped');
    const fromResponses = parseTextFormat({ format: { type: 'json_schema', name: 'r', schema } });
    assert.deepEqual(fromResponses.schema, fromChat.schema);
    assert.equal(parseTextFormat({ format: { type: 'text' } }), null);
    await throwsApi(() => parseResponseFormat({ type: 'xml' }), {
      status: 400,
      code: 'invalid_response_format'
    });
    await throwsApi(
      () => parseResponseFormat({ type: 'json_schema', json_schema: { schema: { type: 'nope' } } }),
      { status: 400, code: 'invalid_json_schema' }
    );
    assert.deepEqual(normalizeSchema('{"type":"object"}'), { type: 'object' });
  });

  it("compiles an app's schema once per config object and reports one that does not compile", () => {
    const app = { id: 'a', outputSchema: { type: 'object', required: ['x'] } };
    const first = appOutputFormat(app);
    assert.equal(typeof first.validate, 'function');
    assert.equal(appOutputFormat(app).validate, first.validate, 'reused for the same config');
    assert.equal(createOutputValidator(first)('{"x":1}').valid, true);
    const broken = appOutputFormat({ id: 'b', outputSchema: { type: 'nope' } });
    assert.equal(broken.validate, undefined);
    assert.match(broken.compileError, /schema is invalid|must be equal/);
    assert.equal(appOutputFormat({ id: 'c' }), null);
  });

  it('validates answers, stripping fences and prose', () => {
    const validate = createOutputValidator({
      kind: 'json_schema',
      schema: normalizeSchema(schema)
    });
    const fenced = validate('Here it is:\n```json\n{"risk":"high","score":3}\n```');
    assert.equal(fenced.valid, true);
    assert.deepEqual(fenced.value, { risk: 'high', score: 3 });
    assert.equal(fenced.text, '{"risk":"high","score":3}');

    const invalid = validate('{"risk":"medium","extra":1}');
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.errors.map(e => [e.path, e.keyword]).sort(), [
      ['/', 'additionalProperties'],
      ['/risk', 'enum']
    ]);
    assert.equal(validate('no json here').errors[0].keyword, 'parse');

    const object = createOutputValidator({ kind: 'json_object' });
    assert.equal(object('{"a":1}').valid, true);
    assert.equal(object('[1,2]').valid, false);
  });

  it('knows which providers enforce a schema', () => {
    assert.equal(structuredOutputSupport({ provider: 'openai' }), 'native');
    assert.equal(structuredOutputSupport({ provider: 'anthropic' }), 'native');
    assert.equal(structuredOutputSupport({ provider: 'bedrock' }), 'prompted');
    assert.equal(structuredOutputSupport({ provider: 'iassistant-conversation' }), 'unsupported');
    assert.equal(
      structuredOutputSupport({ provider: 'openai', supportsStructuredOutput: false }),
      'unsupported'
    );
  });

  it('opts out through the query or the body', () => {
    assert.equal(validationRequested({ query: {}, body: {} }), true);
    assert.equal(validationRequested({ query: { validate: 'false' }, body: {} }), false);
    assert.equal(validationRequested({ query: {}, body: { validate: false } }), false);
  });

  it('lifts the Anthropic json tool call into the answer', () => {
    const format = { kind: 'json_object' };
    const chunk = {
      content: [],
      tool_calls: [{ index: 0, name: 'json', arguments: { risk: 'low' } }],
      finishReason: 'tool_calls'
    };
    const lifted = liftJsonToolChunk(chunk, format);
    assert.deepEqual(lifted.content, ['{"risk":"low"}']);
    assert.deepEqual(lifted.tool_calls, []);
    assert.equal(lifted.finishReason, 'stop');
    assert.equal(liftJsonToolChunk(chunk, null), chunk, 'untouched without structured output');

    const result = liftJsonToolResult(
      {
        content: '',
        toolCalls: [{ index: 0, function: { name: 'json', arguments: '{"risk":"high"}' } }],
        finishReason: 'tool_calls'
      },
      format
    );
    assert.equal(result.content, '{"risk":"high"}');
    assert.deepEqual(result.toolCalls, []);
  });

  it('instructs models without native enforcement', () => {
    const format = { kind: 'json_object' };
    assert.equal(withJsonInstruction([{ role: 'user', content: 'x' }], format)[0].role, 'system');
    const amended = withJsonInstruction(
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'x' }
      ],
      format
    );
    assert.match(amended[0].content, /^Be brief\.\n\nRespond only with a valid JSON object\.$/);
  });

  it('seam: retries an invalid answer once, then lets it stand', () => {
    const rejected = [];
    const seam = structuredOutputSeam({
      validate: createOutputValidator({ kind: 'json_object' }),
      maxRetries: 1,
      onAttemptRejected: info => rejected.push(info.attempt)
    });
    const first = seam.onAnswer({}, { content: 'nope', canRetry: true });
    assert.equal(first.handled, true);
    assert.match(first.retry, /corrected JSON/);
    assert.equal(first.error.code, 'OUTPUT_VALIDATION_FAILED');
    assert.equal(seam.onAnswer({}, { content: 'still nope', canRetry: true }), null);
    assert.equal(seam.verdict().valid, false);
    assert.equal(seam.attempts(), 2);
    assert.deepEqual(rejected, [1]);
  });
});

describe('request input', () => {
  const pdfLess = Buffer.from('plain text body').toString('base64');

  it('turns Responses input into chat messages, documents extracted', async () => {
    const messages = await messagesFromResponsesInput([
      { role: 'developer', content: 'rules' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'earlier' }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Analyze' },
          {
            type: 'input_file',
            filename: 'nda.txt',
            file_data: `data:text/plain;base64,${pdfLess}`
          },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
        ]
      }
    ]);
    assert.deepEqual(messages[0], { role: 'system', content: 'rules' });
    assert.deepEqual(messages[1], { role: 'assistant', content: 'earlier' });
    assert.equal(messages[2].content, 'Analyze');
    assert.equal(messages[2].fileData[0].content, 'plain text body');
    assert.equal(messages[2].fileData[0].fileName, 'nda.txt');
    assert.deepEqual(messages[2].imageData[0], { base64: 'iVBORw0KGgo=', fileType: 'image/png' });
    assert.deepEqual(await messagesFromResponsesInput('hi'), [{ role: 'user', content: 'hi' }]);
  });

  it('refuses hosted references, remote images, unsupported items and file types', async () => {
    await throwsApi(
      () =>
        messagesFromResponsesInput([
          { role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }
        ]),
      { status: 400, code: 'unsupported_file_reference' }
    );
    await throwsApi(
      () =>
        messagesFromResponsesInput([
          { role: 'user', content: [{ type: 'input_image', image_url: 'https://x/y.png' }] }
        ]),
      { status: 400, code: 'unsupported_image_source' }
    );
    await throwsApi(
      () => messagesFromResponsesInput([{ type: 'function_call_output', call_id: 'c' }]),
      {
        status: 400,
        code: 'unsupported_input_item'
      }
    );
    await throwsApi(
      () =>
        documentFromInlineFile(
          { data: 'data:application/zip;base64,UEsDBA==', filename: 'a.zip' },
          'input[0]'
        ),
      { status: 400, code: 'unsupported_file_type' }
    );
  });

  it('extracts the text of a PDF', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Confidential NDA between A and B', {
      x: 50,
      y: 700,
      size: 12,
      font: await doc.embedFont(StandardFonts.Helvetica)
    });
    const data = `data:application/pdf;base64,${Buffer.from(await doc.save()).toString('base64')}`;
    const file = await documentFromInlineFile({ data, filename: 'nda.pdf' }, 'input[0]');
    assert.equal(file.fileType, 'application/pdf');
    assert.match(file.content, /Confidential NDA between A and B/);
  });

  it('turns Chat Completions content parts into chat messages', async () => {
    const messages = await messagesFromChatCompletions([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read' },
          {
            type: 'file',
            file: { filename: 'a.md', file_data: `data:text/markdown;base64,${pdfLess}` }
          }
        ]
      }
    ]);
    assert.equal(messages[0].content, 'Read');
    assert.equal(messages[0].fileData[0].fileType, 'text/markdown');
    await throwsApi(
      () => messagesFromChatCompletions([{ role: 'tool', content: 'x', tool_call_id: 'c' }]),
      { status: 400, code: 'invalid_messages' }
    );
  });
});

describe('conversation items', () => {
  it('replays user turns as rendered and leaves failed answers out', () => {
    const history = historyForModel([
      { role: 'user', content: 'raw', renderedContent: 'Template: raw' },
      { role: 'assistant', content: '{"a":1}', output: { a: 1 } },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'bad', error: { code: 'OUTPUT_VALIDATION_FAILED' } },
      { role: 'assistant', content: '   ' }
    ]);
    assert.deepEqual(history, [
      { role: 'user', content: 'Template: raw' },
      { role: 'assistant', content: '{"a":1}' },
      { role: 'user', content: 'again' }
    ]);
  });

  it('returns raw input with its variables, and answers with their structured output', () => {
    const user = itemFromMessage({
      id: 'm1',
      role: 'user',
      content: 'raw',
      renderedContent: 'Template: raw',
      variables: { action: 'summarize' },
      attachments: [{ type: 'application/pdf', name: 'nda.pdf' }],
      ts: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(user.content, [
      { type: 'input_text', text: 'raw' },
      { type: 'input_file', filename: 'nda.pdf' }
    ]);
    assert.deepEqual(user.metadata, { variables: { action: 'summarize' } });
    const answer = itemFromMessage({
      id: 'm2',
      role: 'assistant',
      content: '{"a":1}',
      output: { a: 1 },
      model: 'app:nda/gpt'
    });
    assert.deepEqual(answer.content[0].parsed, { a: 1 });
    assert.equal(answer.metadata.model, 'app:nda/gpt');
    assert.equal(answer.status, 'completed');
  });

  it('binds a conversation to its first app', async () => {
    const appTarget = id => ({ kind: 'app', app: { id } });
    assertBinding({ id: 'c', appId: null }, appTarget('a'));
    assertBinding({ id: 'c', appId: 'a', binding: 'app' }, appTarget('a'));
    await throwsApi(() => assertBinding({ id: 'c', appId: 'a' }, appTarget('b')), {
      status: 400,
      code: 'conversation_app_mismatch'
    });
    await throwsApi(() => assertBinding({ id: 'c', appId: 'a' }, { kind: 'model' }), {
      status: 400,
      code: 'conversation_app_mismatch'
    });
    await throwsApi(() => assertBinding({ id: 'c', binding: 'model' }, appTarget('a')), {
      status: 400,
      code: 'conversation_app_mismatch'
    });
  });

  it('validates metadata and items', async () => {
    assert.deepEqual(validateMetadata({ a: 'b' }), { a: 'b' });
    await throwsApi(() => validateMetadata({ a: 1 }), { status: 400, code: 'invalid_metadata' });
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    await throwsApi(() => validateMetadata(tooMany), { status: 400, code: 'invalid_metadata' });
    assert.deepEqual(messagesFromItems([{ type: 'message', role: 'user', content: 'hi' }]), [
      { role: 'user', content: 'hi' }
    ]);
    await throwsApi(() => messagesFromItems([{ role: 'system', content: 'x' }]), {
      status: 400,
      code: 'invalid_items'
    });
  });
});
