// Plain-node test (run: node server/tests/vllm-toolcall-parse-error.test.js).
// Regression for a ReferenceError ("e is not defined") in VLLMConverter's
// tool-argument parse-failure handlers: the catch bound `error` but logged the
// undefined `e`, so a RECOVERABLE malformed-tool-args parse failure threw a
// FATAL error that crashed the whole agent run. Long/complex vLLM responses can
// emit truncated tool-call arguments, hitting exactly this path.
import { convertVLLMResponseToGeneric } from '../adapters/toolCalling/VLLMConverter.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

async function run() {
  // Streaming chunks reach the converter as JSON STRINGS (it parseJsonAsync's
  // each one); only the sentinel '[DONE]' is passed as a bare string.
  const chunk = obj => JSON.stringify(obj);

  // --- Path 1: malformed args finalized via an explicit finish_reason ---
  const sid1 = 'malformed-finish-reason';
  await convertVLLMResponseToGeneric(
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
    sid1
  );
  let result1,
    threw1 = false,
    err1 = '';
  try {
    result1 = await convertVLLMResponseToGeneric(
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sid1
    );
  } catch (e) {
    threw1 = true;
    err1 = e.message;
  }
  check('malformed args + finish_reason does NOT throw', !threw1, err1);
  check(
    'finish_reason path still produces the tool call',
    !!result1 && Array.isArray(result1.tool_calls) && result1.tool_calls.length === 1,
    JSON.stringify(result1?.tool_calls)
  );
  check(
    'finish_reason path preserves raw arguments on parse failure',
    !!result1 && JSON.stringify(result1).includes('__raw_arguments')
  );

  // --- Path 2: malformed args finalized via [DONE] ---
  const sid2 = 'malformed-done';
  await convertVLLMResponseToGeneric(
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_2',
                function: { name: 'update_task', arguments: '{not valid json' }
              }
            ]
          }
        }
      ]
    }),
    sid2
  );
  let result2,
    threw2 = false,
    err2 = '';
  try {
    result2 = await convertVLLMResponseToGeneric('[DONE]', sid2);
  } catch (e) {
    threw2 = true;
    err2 = e.message;
  }
  check('malformed args + [DONE] does NOT throw', !threw2, err2);
  check(
    '[DONE] path preserves raw arguments on parse failure',
    !!result2 && JSON.stringify(result2).includes('__raw_arguments')
  );

  // --- Sanity: well-formed args still parse normally (no regression) ---
  const sid3 = 'wellformed';
  await convertVLLMResponseToGeneric(
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_3', function: { name: 'noop', arguments: '{"ok":true}' } }
            ]
          }
        }
      ]
    }),
    sid3
  );
  const result3 = await convertVLLMResponseToGeneric(
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sid3
  );
  check(
    'well-formed args still parse (no __raw_arguments)',
    !!result3 &&
      result3.tool_calls.length === 1 &&
      !JSON.stringify(result3).includes('__raw_arguments')
  );

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
