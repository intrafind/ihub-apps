// Plain-node test (run: node server/tests/vllm-openai-dedup.test.js).
// Regression coverage for issue #1747: vLLM's adapter/converter duplicated
// OpenAI's near-verbatim, and the duplication had already drifted into two
// real bugs. This test pins both fixes plus the deduplication itself.
import VLLMAdapter from '../adapters/vllm.js';
import { convertGenericToolCallsToVLLM } from '../adapters/toolCalling/VLLMConverter.js';
import {
  convertOpenAIToolCallsToGeneric,
  convertOpenAIResponseToGeneric
} from '../adapters/toolCalling/OpenAIConverter.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
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
  let result;
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
    !!result && Array.isArray(result.tool_calls) && result.tool_calls.length === 1,
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

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
