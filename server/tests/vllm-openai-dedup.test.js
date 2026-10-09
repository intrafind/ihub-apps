// Plain-node test (run: node server/tests/vllm-openai-dedup.test.js).
// Regression coverage for issue #1747: vLLM's adapter/converter duplicated
// OpenAI's near-verbatim, and the duplication had already drifted into two
// real bugs. This test pins both fixes plus the deduplication itself.
import VLLMAdapter from '../adapters/vllm.js';
import {
  convertGenericToolCallsToVLLM,
  convertVLLMToolsToGeneric
} from '../adapters/toolCalling/VLLMConverter.js';
import {
  convertOpenAIToolCallsToGeneric,
  convertOpenAIResponseToGeneric
} from '../adapters/toolCalling/OpenAIConverter.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log(`   ${detail}`);
}

// --- Bug #1: convertGenericToolCallsToVLLM put the tool-call id in
// function.name instead of the actual function name. ---
{
  const [toolCall] = convertGenericToolCallsToVLLM([
    { id: 'call_abc123', name: 'get_weather', arguments: { city: 'Berlin' }, index: 0 }
  ]);
  check(
    'convertGenericToolCallsToVLLM puts the function name (not the call id) in function.name',
    toolCall.function.name === 'get_weather',
    `got function.name="${toolCall.function.name}"`
  );
  check(
    'convertGenericToolCallsToVLLM preserves the call id in the id field',
    toolCall.id === 'call_abc123'
  );
}

// The delegated converter also emits the OpenAI tool-call envelope, which the
// old vLLM copy was missing.
{
  const [toolCall] = convertGenericToolCallsToVLLM([
    { id: 'call_abc123', name: 'get_weather', arguments: { city: 'Berlin' }, index: 0 }
  ]);
  check(
    'convertGenericToolCallsToVLLM emits type "function" like OpenAI',
    toolCall.type === 'function'
  );
  check(
    'convertGenericToolCallsToVLLM serializes object arguments to a JSON string',
    toolCall.function.arguments === '{"city":"Berlin"}'
  );
}

// --- Latent bug: the old convertVLLMToolsToGeneric read the never-set
// `tool.function.id`, so every converted tool got an undefined id. ---
{
  const [tool] = convertVLLMToolsToGeneric([
    { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: {} } }
  ]);
  check(
    'convertVLLMToolsToGeneric gives the tool a defined id (the function name)',
    tool.id === 'get_weather' && tool.name === 'get_weather',
    `got id=${tool.id} name=${tool.name}`
  );
}

// --- Bug #2: OpenAIConverter's accumulated-tool-arguments parse-failure
// handler referenced an undefined `e` instead of the caught `error`,
// throwing a ReferenceError inside the catch block itself. ---
{
  const chunk = obj => JSON.stringify(obj);
  const sid = 'openai-malformed-args';
  await convertOpenAIResponseToGeneric(
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'set_plan', arguments: '{"tasks": [trunc' }
              }
            ]
          }
        }
      ]
    }),
    sid
  );

  let threw = false;
  let err = '';
  let result = null;
  try {
    result = await convertOpenAIResponseToGeneric(
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sid
    );
  } catch (e) {
    threw = true;
    err = e.message;
  }
  check(
    'malformed accumulated tool args + finish_reason does NOT throw ReferenceError',
    !threw,
    err
  );
  check(
    'finish_reason path still produces the tool call with raw arguments preserved',
    Boolean(result) && Array.isArray(result.tool_calls) && result.tool_calls.length === 1,
    JSON.stringify(result?.tool_calls)
  );
}

// --- convertOpenAIToolCallsToGeneric round-trips real function names
// (sanity check that the delegation didn't lose this). ---
{
  const [call] = convertOpenAIToolCallsToGeneric([
    { id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }
  ]);
  check('convertOpenAIToolCallsToGeneric resolves the real function name', call.name === 'noop');
}

// --- vLLM's formatMessages (now delegated to the shared OpenAI-compatible
// helper) still formats images the same way as before the refactor. ---
{
  const formatted = VLLMAdapter.formatMessages([
    {
      role: 'user',
      content: 'What do you see?',
      imageData: [{ base64: 'AAAA', fileType: 'image/jpeg' }]
    }
  ]);
  const imagePart = formatted[0].content.find(p => p.type === 'image_url');
  check(
    'VLLMAdapter.formatMessages still formats images via the shared helper',
    imagePart?.image_url?.url === 'data:image/jpeg;base64,AAAA'
  );
}

// --- BaseAdapter.enforceSchemaNoExtras (hoisted from openai/vllm/openai-responses) ---
{
  const input = {
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'string' } } },
      list: { type: 'array', items: { type: 'object', properties: {} } },
      tuple: { type: 'array', items: [{ type: 'object' }, null, { type: 'string' }] }
    }
  };
  const original = JSON.stringify(input);
  const out = VLLMAdapter.enforceSchemaNoExtras(input);
  check(
    'enforceSchemaNoExtras sets additionalProperties:false on the root',
    out.additionalProperties === false
  );
  check(
    'enforceSchemaNoExtras recurses through properties',
    out.properties.a.additionalProperties === false
  );
  check(
    'enforceSchemaNoExtras recurses through items (single and tuple, tolerating null entries)',
    out.properties.list.items.additionalProperties === false &&
      out.properties.tuple.items[0].additionalProperties === false &&
      out.properties.tuple.items[1] === null
  );
  check(
    'enforceSchemaNoExtras leaves non-object nodes alone',
    !('additionalProperties' in out.properties.a.properties.b)
  );
  check('enforceSchemaNoExtras does not mutate its input', JSON.stringify(input) === original);
}

// --- Shared formatMessages: thought signature handling now lives in one place ---
{
  const toolCalls = [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'noop', arguments: '{}' },
      extra_content: { google: { thought_signature: 'sig' } }
    }
  ];
  const [stripped] = VLLMAdapter.formatMessages(
    [{ role: 'assistant', content: '', tool_calls: toolCalls }],
    { id: 'my-vllm-model', modelId: 'meta-llama/Llama-3.1-8B' }
  );
  check(
    'vLLM formatMessages strips the Gemini thought signature for a non-Gemini model',
    !('extra_content' in stripped.tool_calls[0])
  );
  const [kept] = VLLMAdapter.formatMessages(
    [{ role: 'assistant', content: '', tool_calls: toolCalls }],
    { id: 'gemini-via-vllm', modelId: 'gemini-3-pro' }
  );
  check(
    'vLLM formatMessages keeps the thought signature for a model that consumes it',
    kept.tool_calls[0].extra_content?.google?.thought_signature === 'sig'
  );
  check(
    'assistant tool-call message with empty content is sent as null content',
    stripped.content === null
  );
}

// --- vLLM picks up audio attachments through the shared helper ---
{
  const [msg] = VLLMAdapter.formatMessages([
    {
      role: 'user',
      content: 'Transcribe',
      audioData: { base64: 'data:audio/wav;base64,QUJD', fileType: 'audio/wav' }
    }
  ]);
  const audioPart = msg.content.find(p => p.type === 'input_audio');
  check(
    'VLLMAdapter.formatMessages formats audio via the shared helper',
    audioPart?.input_audio?.data === 'QUJD' && audioPart.input_audio.format === 'wav',
    JSON.stringify(audioPart)
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
