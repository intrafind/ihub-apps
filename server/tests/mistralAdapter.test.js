import assert from 'assert';
import { execFileSync } from 'child_process';


import { createCompletionRequest, processResponseBuffer } from '../adapters/index.js';
import { loadConfiguredTools } from '../toolLoader.js';
import config from '../config.js';
import configCache from '../configCache.js';

async function testToolCall() {
  await configCache.initialize();
  const tools = await loadConfiguredTools();
  const braveTool = tools.find(t => t.id === 'braveSearch');
  assert(braveTool, 'Brave search tool not found');

  const model = {
    id: 'mistral-small',
    modelId: 'mistral-small-latest',
    url: 'https://api.mistral.ai/v1/chat/completions',
    provider: 'mistral'
  };

  const messages = [{ role: 'user', content: 'Use the braveSearch function to look up cat news' }];
  const req = createCompletionRequest(model, messages, MISTRAL_KEY, {
    stream: false,
    tools: [braveTool],
    toolChoice: 'auto'
  });

  const curlArgs = [
    '-s', req.url,
    '-H', `Authorization: ${req.headers.Authorization}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(req.body)
  ];
  const text = execFileSync('curl', curlArgs, { encoding: 'utf8' });
  const result = processResponseBuffer('mistral', text);
  assert(result.tool_calls.length > 0, 'No tool call returned');
  const call = result.tool_calls[0];
  assert(call.function.name === 'braveSearch', 'Unexpected tool called');

  const args = JSON.parse(call.function.arguments);
  const searchCurlArgs = [
    '-s', `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=1`,
    '-H', `X-Subscription-Token: ${process.env.BRAVE_SEARCH_API_KEY}`,
    '-H', 'Accept: application/json'
  ];
  const searchRes = execFileSync('curl', searchCurlArgs, { encoding: 'utf8' });
  const search = JSON.parse(searchRes);
  assert(Array.isArray(search.web.results) && search.web.results.length > 0, 'Brave search returned no results');
  console.log('Mistral adapter tool call test passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testToolCall().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
