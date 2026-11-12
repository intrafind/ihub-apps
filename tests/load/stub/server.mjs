#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Load-test stubs, no dependencies:
 *
 * 1. Fake LLM (OpenAI-compatible) on STUB_LLM_PORT (8979):
 *    POST /v1/chat/completions streams STUB_TOKENS words at STUB_TOKENS_PER_SEC
 *    after STUB_TTFT_MS (± STUB_JITTER). Realistic stream durations keep SSE
 *    connections and relays busy like a real model, without GPU cost — the runs
 *    then measure iHub, not the LLM.
 *    GET /v1/models, GET /__stats (in-flight, prompt sizes — shows how much
 *    project context iHub injected).
 *
 * 2. Synthetic website on STUB_SITE_PORT (8980): /docs/ with STUB_SITE_PAGES
 *    interlinked HTML pages and robots.txt, STUB_SITE_LATENCY_MS per page. Use it
 *    for crawl-heavy runs instead of a production website.
 *
 *   node tests/load/stub/server.mjs
 */

import http from 'node:http';
import { TOPICS, topicText } from '../lib/fixtures.mjs';

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const HOST = process.env.STUB_HOST || '0.0.0.0';
const LLM_PORT = env('STUB_LLM_PORT', 8979);
const SITE_PORT = env('STUB_SITE_PORT', 8980);
const TTFT_MS = env('STUB_TTFT_MS', 700);
const TOKENS = env('STUB_TOKENS', 250);
const TPS = env('STUB_TOKENS_PER_SEC', 40);
const JITTER = env('STUB_JITTER', 0.25);
const PAGES = env('STUB_SITE_PAGES', 300);
const SITE_LATENCY = env('STUB_SITE_LATENCY_MS', 80);

const WORDS = (
  'the platform answers questions from documents and keeps the source of every statement so that ' +
  'users can verify the result before they act on it while the administrators decide which models ' +
  'and data sources are available to which groups of users in the organisation'
).split(' ');

const stats = {
  requests: 0,
  inflight: 0,
  maxInflight: 0,
  errors: 0,
  promptChars: [],
  promptTokens: 0,
  genTokens: 0
};
const jitter = v => Math.max(0, v * (1 + (Math.random() * 2 - 1) * JITTER));

function promptChars(body) {
  let n = 0;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') n += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) n += (p.text || '').length;
  }
  return n;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const llm = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ object: 'list', data: [{ id: 'loadtest-stub-model', object: 'model' }] })
    );
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/metrics')) {
    // vLLM-style metrics, so stub runs exercise the same observer as gpu-01.
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(
      [
        `vllm:num_requests_running{model_name="loadtest-stub-model"} ${stats.inflight}`,
        `vllm:num_requests_waiting{model_name="loadtest-stub-model"} 0`,
        `vllm:kv_cache_usage_perc{model_name="loadtest-stub-model"} ${Math.min(1, stats.inflight / 256)}`,
        `vllm:prompt_tokens_total{model_name="loadtest-stub-model"} ${stats.promptTokens}`,
        `vllm:generation_tokens_total{model_name="loadtest-stub-model"} ${stats.genTokens}`,
        `vllm:num_preemptions_total{model_name="loadtest-stub-model"} 0`,
        ''
      ].join('\n')
    );
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/__stats')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        requests: stats.requests,
        inflight: stats.inflight,
        maxInflight: stats.maxInflight,
        errors: stats.errors,
        promptChars: {
          p50: percentile(stats.promptChars, 50),
          p95: percentile(stats.promptChars, 95),
          max: percentile(stats.promptChars, 100)
        }
      })
    );
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
    return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      stats.errors += 1;
    }
    stats.requests += 1;
    stats.inflight += 1;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    const pc = promptChars(body);
    stats.promptChars.push(pc);
    if (stats.promptChars.length > 5000) stats.promptChars.splice(0, 1000);

    const n = Math.max(1, Math.round(jitter(TOKENS)));
    const usage = {
      prompt_tokens: Math.ceil(pc / 4),
      completion_tokens: n,
      total_tokens: Math.ceil(pc / 4) + n
    };
    stats.promptTokens += usage.prompt_tokens;
    stats.genTokens += n;
    const id = `chatcmpl-${Date.now()}`;
    const model = body.model || 'loadtest-stub-model';
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        stats.inflight -= 1;
      }
    };
    res.on('close', finish);

    if (!body.stream) {
      setTimeout(
        () => {
          const text = Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(' ');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              model,
              choices: [
                { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
              ],
              usage
            })
          );
          finish();
        },
        jitter(TTFT_MS) + (n / TPS) * 1000
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const interval = 1000 / TPS;
    let i = 0;
    const tick = () => {
      if (res.destroyed) return finish();
      if (i < n) {
        send({
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [
            {
              index: 0,
              delta: {
                ...(i === 0 ? { role: 'assistant' } : {}),
                content: `${i ? ' ' : ''}${WORDS[i % WORDS.length]}`
              },
              finish_reason: null
            }
          ]
        });
        i += 1;
        setTimeout(tick, jitter(interval));
        return;
      }
      send({
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      send({ id, object: 'chat.completion.chunk', model, choices: [], usage });
      res.end('data: [DONE]\n\n');
      finish();
    };
    setTimeout(tick, jitter(TTFT_MS));
  });
});

// --- synthetic website -------------------------------------------------------
function page(n) {
  const topic = TOPICS[n % TOPICS.length];
  const links = [1, 2, 3, 7, 13]
    .map(d => (n + d) % PAGES)
    .map(
      m =>
        `<li><a href="/docs/page-${m}.html">${TOPICS[m % TOPICS.length].title} part ${m}</a></li>`
    )
    .join('');
  const text = topicText(topic, 6000, n + 1)
    .split(/\n\n+/)
    .map(p => `<p>${p}</p>`)
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${topic.title} part ${n}</title></head><body><main><h1>${topic.title} part ${n}</h1>${text}<ul>${links}</ul></main></body></html>`;
}

const site = http.createServer((req, res) => {
  const url = { pathname: (req.url || '/').split('?')[0] };
  setTimeout(() => {
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (url.pathname === '/docs/' || url.pathname === '/docs' || url.pathname === '/') {
      const items = Array.from(
        { length: Math.min(PAGES, 25) },
        (_, n) => `<li><a href="/docs/page-${n}.html">Page ${n}</a></li>`
      ).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Load test docs</title></head><body><h1>Documentation</h1><ul>${items}</ul></body></html>`
      );
      return;
    }
    const m = /^\/docs\/page-(\d+)\.html$/.exec(url.pathname);
    if (m && Number(m[1]) < PAGES) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(Number(m[1])));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }, jitter(SITE_LATENCY));
});

llm.keepAliveTimeout = 65_000;
llm.listen(LLM_PORT, HOST, () =>
  console.log(
    `fake LLM  on ${HOST}:${LLM_PORT} (/v1)  (TTFT ${TTFT_MS} ms, ${TOKENS} tokens @ ${TPS}/s)`
  )
);
site.listen(SITE_PORT, HOST, () =>
  console.log(`test site on ${HOST}:${SITE_PORT} (/docs/)  (${PAGES} pages)`)
);
