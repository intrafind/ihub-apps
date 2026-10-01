#!/usr/bin/env node

/**
 * Web answers' sources and citations, on every search path (issue #2520).
 *
 *  - OpenAI Responses: streamed `url_citation` annotations and `web_search_call`
 *    items reach `groundingMetadata` — before, only the non-streaming path parsed
 *    annotations, into a field nothing read, so a streamed answer showed no
 *    sources at all.
 *  - Anthropic: a citation marker follows each cited text block.
 *  - Google: grounding supports are resolved to passages and URLs where the
 *    chunk indices still mean something.
 *  - `shared/sources`: one source list for every path, numbered in the order
 *    the answer cites them, and a citation never points at a URL the turn did
 *    not return.
 *
 * Run: node --test server/tests/websearch-citations.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearOpenaiResponsesStreamingState,
  convertOpenaiResponsesResponseToGeneric,
  toGroundingMetadata,
  withCitationMarkers
} from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import { convertAnthropicResponseToGeneric } from '../adapters/toolCalling/AnthropicConverter.js';
import { withWebSupports } from '../adapters/toolCalling/GoogleConverter.js';
import {
  citationMarkers,
  emptySourceSet,
  insertSupportMarkers,
  linkTargets,
  mergeSources,
  resolveCitations,
  sourcesFromGrounding,
  storedSourceSet,
  urlKey
} from '../../shared/sources/index.js';
import { extractToolSources } from '../services/sources/index.js';

/** An answer's set, folded from its frames the way the loop and the client fold them. */
const setOf = (...frames) =>
  frames.reduce((set, frame) => mergeSources(set, frame), emptySourceSet());

const json = value => JSON.stringify(value);

describe('OpenAI Responses web search → groundingMetadata', () => {
  it('parses a streamed url_citation annotation', async () => {
    const chunk = await convertOpenaiResponsesResponseToGeneric(
      json({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: 'url_citation',
          url: 'https://langdock.com/?utm_source=openai',
          title: 'Langdock',
          start_index: 10,
          end_index: 60
        }
      })
    );
    assert.deepEqual(chunk.groundingMetadata, {
      citations: [
        {
          url: 'https://langdock.com/?utm_source=openai',
          title: 'Langdock',
          start_index: 10,
          end_index: 60
        }
      ]
    });
  });

  it('parses the query and sources of a finished web_search_call', async () => {
    const chunk = await convertOpenaiResponsesResponseToGeneric(
      json({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'what is langdock',
            sources: [{ type: 'url', url: 'https://docs.langdock.com/' }]
          }
        }
      })
    );
    assert.deepEqual(chunk.groundingMetadata, {
      webSearchQueries: ['what is langdock'],
      searchResults: [{ url: 'https://docs.langdock.com/' }]
    });
  });

  it('parses annotations of a non-streamed response into the same shape', async () => {
    const chunk = await convertOpenaiResponsesResponseToGeneric(
      json({
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { query: 'q' } },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer ([a.example](https://a.example/))',
                annotations: [{ type: 'url_citation', url: 'https://a.example/', title: 'A' }]
              }
            ]
          }
        ]
      })
    );
    assert.deepEqual(chunk.groundingMetadata, {
      webSearchQueries: ['q'],
      citations: [{ url: 'https://a.example/', title: 'A' }]
    });
  });

  describe('inline markers for citations the text does not link', () => {
    const cite = (url, start, end) => ({
      type: 'response.output_text.annotation.added',
      output_index: 1,
      content_index: 0,
      annotation: { type: 'url_citation', url, title: 'T', start_index: start, end_index: end }
    });
    const delta = text => ({
      type: 'response.output_text.delta',
      output_index: 1,
      content_index: 0,
      delta: text
    });
    const stream = async (events, streamId) => {
      let content = '';
      for (const event of events) {
        const chunk = await convertOpenaiResponsesResponseToGeneric(json(event), streamId);
        content += chunk.content.join('');
      }
      clearOpenaiResponsesStreamingState(streamId);
      return content;
    };

    it('streams a marker after a cited range that has no link', async () => {
      const content = await stream(
        [
          delta('Langdock is an AI platform.'),
          cite('https://langdock.com/?utm_source=openai', 0, 27),
          delta(' It is based in Berlin.'),
          cite('https://langdock.com/about?utm_source=openai', 28, 50),
          cite('https://langdock.com/?utm_source=openai', 28, 50)
        ],
        'openai-markers'
      );
      assert.equal(
        content,
        'Langdock is an AI platform.[1](https://langdock.com/?utm_source=openai)' +
          ' It is based in Berlin.[2](https://langdock.com/about?utm_source=openai)' +
          '[1](https://langdock.com/?utm_source=openai)'
      );
    });

    it('adds nothing where the model wrote the citation as a link', async () => {
      const text = 'Claim ([a.example](https://a.example/?utm_source=openai)).';
      const content = await stream(
        [delta(text), cite('https://a.example/?utm_source=openai', 6, 57)],
        'openai-linked'
      );
      assert.equal(content, text);
    });

    it('places markers at the annotated ranges of a non-streamed answer', () => {
      const text = 'First claim. Second claim ([b.example](https://b.example/)).';
      const out = withCitationMarkers(
        text,
        [
          { type: 'url_citation', url: 'https://a.example/', start_index: 0, end_index: 12 },
          { type: 'url_citation', url: 'https://b.example/', start_index: 26, end_index: 58 }
        ],
        new Map()
      );
      assert.equal(
        out,
        'First claim.[1](https://a.example/) Second claim ([b.example](https://b.example/)).'
      );
      assert.equal(withCitationMarkers(out, [], new Map()), out);
    });
  });

  it('has no grounding for a plain text delta', async () => {
    const chunk = await convertOpenaiResponsesResponseToGeneric(
      json({ type: 'response.output_text.delta', delta: 'hi' })
    );
    assert.equal(chunk.groundingMetadata, undefined);
    assert.equal(toGroundingMetadata([], [{ type: 'file_citation' }]), null);
  });
});

describe('Anthropic web search citations', () => {
  const stream = async (events, streamId) => {
    let content = '';
    let grounding = null;
    for (const event of events) {
      const chunk = await convertAnthropicResponseToGeneric(json(event), streamId);
      content += chunk.content.join('');
      if (chunk.groundingMetadata) grounding = chunk.groundingMetadata;
    }
    return { content, grounding };
  };
  const citation = (url, title) => ({
    type: 'web_search_result_location',
    url,
    title,
    cited_text: `From ${title}`,
    encrypted_index: 'x'
  });

  it('appends a marker after each cited text block, numbered per message', async () => {
    const { content } = await stream(
      [
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Intro. ' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '', citations: [] }
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'citations_delta', citation: citation('https://a.example/', 'A') }
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Langdock is a platform.' }
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'text', text: '', citations: [] }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'citations_delta', citation: citation('https://b.example/', 'B') }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'citations_delta', citation: citation('https://a.example/', 'A') }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: ' Founded 2023.' }
        },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      ],
      'anthropic-markers'
    );
    assert.equal(
      content,
      'Intro. Langdock is a platform.[1](https://a.example/) Founded 2023.[2](https://b.example/)[1](https://a.example/)'
    );
  });

  it('marks cited blocks of a non-streamed response too', async () => {
    const chunk = await convertAnthropicResponseToGeneric(
      json({
        type: 'message',
        content: [
          { type: 'text', text: 'Claim.', citations: [citation('https://a.example/x(y)', 'A')] }
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      'anthropic-full'
    );
    assert.equal(chunk.content.join(''), 'Claim.[1](https://a.example/x%28y%29)');
    assert.equal(chunk.groundingMetadata.citations.length, 1);
  });
});

describe('Google grounding supports', () => {
  it('resolves chunk indices to URLs within the payload', () => {
    const metadata = withWebSupports({
      webSearchQueries: ['q'],
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'a.example' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/r/2', title: 'b.example' } }
      ],
      groundingSupports: [
        { segment: { startIndex: 0, endIndex: 9, text: 'Claim one.' }, groundingChunkIndices: [1] },
        { segment: { text: 'Claim two.' }, groundingChunkIndices: [0, 1, 7] }
      ]
    });
    assert.deepEqual(metadata.webSupports, [
      { text: 'Claim one.', urls: ['https://vertexaisearch.cloud.google.com/r/2'] },
      {
        text: 'Claim two.',
        urls: [
          'https://vertexaisearch.cloud.google.com/r/1',
          'https://vertexaisearch.cloud.google.com/r/2'
        ]
      }
    ]);
  });

  it('leaves metadata without supports as it is', () => {
    const metadata = { webSearchQueries: ['q'] };
    assert.equal(withWebSupports(metadata), metadata);
  });
});

describe('shared/sources', () => {
  it('compares URLs without scheme, www, trailing slash and tracking parameters', () => {
    assert.equal(
      urlKey('https://www.Example.com/a/?utm_source=openai#top'),
      urlKey('http://example.com/a')
    );
    assert.notEqual(urlKey('https://example.com/a?id=1'), urlKey('https://example.com/a?id=2'));
    assert.equal(urlKey('javascript:alert(1)'), null);
  });

  it('finds link targets in order, skipping images and code', () => {
    assert.deepEqual(
      linkTargets(
        'See [1](https://a.example/) and https://b.example/page. ![x](https://img.example/i.png) `https://code.example/` [W](https://w.example/Foo_(bar))'
      ),
      ['https://a.example/', 'https://b.example/page', 'https://w.example/Foo_(bar)']
    );
  });

  describe('script-backed search', () => {
    const sources = setOf(
      extractToolSources({
        toolId: 'braveSearch',
        toolDef: { id: 'braveSearch', script: 'braveSearch.js' },
        args: { query: 'langdock' },
        result: {
          results: [
            { url: 'https://langdock.com/', title: 'Langdock', description: 'AI platform' },
            { url: 'https://docs.langdock.com/', title: 'Docs' },
            { url: 'https://ycombinator.com/companies/langdock', title: 'YC' }
          ],
          extractedContent: [{ url: 'https://docs.langdock.com/', contentExtracted: true }]
        }
      }),
      extractToolSources({
        toolId: 'webContentExtractor',
        args: { url: 'https://docs.langdock.com/' },
        result: { url: 'https://docs.langdock.com/', content: 'text', wordCount: 812 }
      }),
      extractToolSources({
        toolId: 'webContentExtractor',
        args: { url: 'https://blocked.example/' },
        result: { error: true },
        failed: true
      }),
      extractToolSources({
        toolId: 'iFinder_search',
        args: { query: 'internal' },
        result: { results: [{ id: 'intra-1', title: 'Internal', url: 'https://intranet/' }] }
      })
    );

    it('lists queries and sources once, merged across calls — web pages and documents alike', () => {
      assert.deepEqual(sources.queries, ['langdock', 'internal']);
      assert.deepEqual(
        sources.items.map(s => [s.id, s.provider]),
        [
          ['url:langdock.com', 'web'],
          ['url:docs.langdock.com', 'web'],
          ['url:ycombinator.com/companies/langdock', 'web'],
          ['url:blocked.example', 'web'],
          ['ifinder:intra-1', 'ifinder']
        ]
      );
      const [, docs, , blocked] = sources.items;
      assert.deepEqual(docs.read, { ok: true, words: 812 });
      // The search returned it: public, although the reader read it too.
      assert.equal(docs.private, false);
      assert.deepEqual(blocked.read, { ok: false });
      assert.equal(blocked.private, true);
    });

    it('numbers cited sources in citation order; the rest were considered', () => {
      const answer =
        'Langdock is an AI platform [3](https://docs.langdock.com/). ' +
        'It is a YC company [1](https://www.ycombinator.com/companies/langdock/?utm_source=x). ' +
        'Again [3](https://docs.langdock.com/).';
      const { cited, considered, numberOfUrl } = resolveCitations(answer, sources);
      assert.deepEqual(
        cited.map(s => [s.n, s.url]),
        [
          [1, 'https://docs.langdock.com/'],
          [2, 'https://ycombinator.com/companies/langdock']
        ]
      );
      assert.deepEqual(
        considered.map(s => s.id),
        ['url:langdock.com', 'url:blocked.example', 'ifinder:intra-1']
      );
      assert.equal(numberOfUrl('http://docs.langdock.com'), 1);
    });

    it('never turns a URL the turn did not return into a citation', () => {
      const { cited, numberOfUrl } = resolveCitations(
        'Trust me [1](https://invented.example/) and [2](https://langdock.com/)',
        sources
      );
      assert.deepEqual(
        cited.map(s => s.url),
        ['https://langdock.com/']
      );
      assert.equal(numberOfUrl('https://invented.example/'), null);
    });

    it('a document is cited by its link, or by its id in the text', () => {
      const byId = resolveCitations('See the memo (intra-1).', sources);
      assert.deepEqual(
        byId.cited.map(s => s.id),
        ['ifinder:intra-1']
      );
      assert.equal(resolveCitations('See intra-10.', sources).cited.length, 0);
    });
  });

  it('iAssistant: <cite> markers number documents and passages the same way', () => {
    const set = setOf({
      items: [
        { provider: 'ifinder', ref: { id: 'doc-a' }, title: 'A', markers: ['r:1'] },
        {
          provider: 'ifinder',
          ref: { id: 'doc-b' },
          title: 'B',
          markers: ['r:2'],
          passages: [{ text: 'Passage four.', marker: 's:4' }]
        },
        { provider: 'ifinder', ref: { id: 'doc-c' }, title: 'C', markers: ['r:3'] }
      ]
    });
    const { cited, considered, numberOfMarker } = resolveCitations(
      'First <cite type="s">4</cite>, then <cite type="r">1</cite> and again <cite type="r">2</cite>.',
      set
    );
    assert.deepEqual(
      cited.map(s => [s.n, s.title]),
      [
        [1, 'B'],
        [2, 'A']
      ]
    );
    assert.equal(numberOfMarker('r:2'), 1, 'the passage’s document keeps its number');
    assert.equal(numberOfMarker('r:3'), null);
    assert.deepEqual(
      considered.map(s => s.title),
      ['C']
    );
  });

  it('Anthropic: cited results are cited, the other results considered', () => {
    const set = setOf(
      sourcesFromGrounding({
        webSearchQueries: ['langdock'],
        searchResults: [
          {
            type: 'web_search_result',
            url: 'https://a.example/',
            title: 'A',
            page_age: 'June 1, 2025'
          },
          { type: 'web_search_result', url: 'https://b.example/', title: 'B' }
        ]
      }),
      // Streamed piece by piece: the citation arrives later.
      sourcesFromGrounding({
        citations: [{ url: 'https://a.example/', title: 'A', cited_text: 'Quoted.' }]
      })
    );
    const { cited, considered } = resolveCitations('Claim.[1](https://a.example/)', set);
    assert.deepEqual(
      cited.map(s => [s.n, s.url, s.passages]),
      [[1, 'https://a.example/', [{ text: 'Quoted.' }]]]
    );
    assert.equal(cited[0].publishedDate, new Date('June 1, 2025').toISOString());
    assert.deepEqual(
      considered.map(s => s.url),
      ['https://b.example/']
    );
  });

  it('Google: markers go after the supported passages; chunk sites name the host', () => {
    const set = setOf(
      sourcesFromGrounding(
        withWebSupports({
          webSearchQueries: ['langdock'],
          groundingChunks: [
            { web: { uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'langdock.com' } }
          ],
          groundingSupports: [
            { segment: { text: 'Langdock is an AI platform.' }, groundingChunkIndices: [0] }
          ]
        })
      )
    );
    assert.equal(set.items[0].site, 'langdock.com');
    const answer = insertSupportMarkers('Langdock is an AI platform. More text.', set.supports);
    assert.equal(
      answer,
      'Langdock is an AI platform.[1](https://vertexaisearch.cloud.google.com/r/1) More text.'
    );
    // Idempotent: a stored answer that already carries the markers keeps them once.
    assert.equal(insertSupportMarkers(answer, set.supports), answer);
    assert.equal(resolveCitations(answer, set).cited.length, 1);
  });

  it('Google: a chunk no support rests on was only considered', () => {
    const set = setOf(
      sourcesFromGrounding(
        withWebSupports({
          webSearchQueries: ['langdock'],
          groundingChunks: [
            { web: { uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'langdock.com' } },
            { web: { uri: 'https://vertexaisearch.cloud.google.com/r/2', title: 'example.com' } }
          ],
          groundingSupports: [
            { segment: { text: 'Langdock is an AI platform.' }, groundingChunkIndices: [0] }
          ]
        })
      )
    );
    const answer = insertSupportMarkers('Langdock is an AI platform.', set.supports);
    const { cited, considered } = resolveCitations(answer, set);
    assert.deepEqual(
      cited.map(s => s.site),
      ['langdock.com']
    );
    assert.deepEqual(
      considered.map(s => s.site),
      ['example.com']
    );
    // A supported chunk stays cited when its passage is not found in the text.
    assert.equal(resolveCitations('Other wording.', set).cited.length, 1);
  });

  it('OpenAI: the links the model wrote are the citations', () => {
    const set = setOf(
      sourcesFromGrounding({
        webSearchQueries: ['q'],
        citations: [{ url: 'https://a.example/?utm_source=openai', title: 'A' }]
      })
    );
    const { cited } = resolveCitations(
      'Claim ([a.example](https://a.example/?utm_source=openai)).',
      set
    );
    assert.deepEqual(
      cited.map(s => s.n),
      [1]
    );
  });

  it('a tool that searches something else reports nothing unless it says what it found', () => {
    assert.equal(
      extractToolSources({
        toolId: 'jira_searchIssues',
        result: { results: [{ url: 'https://jira.example/X-1' }] }
      }),
      null
    );
    assert.equal(
      extractToolSources({ toolId: 'entraPeopleSearch', args: { query: 'Ada' }, result: {} }),
      null
    );
    assert.equal(
      extractToolSources({ toolId: 'mcp__brave__brave_web_search', result: 'text' }),
      null
    );
    assert.equal(sourcesFromGrounding({}), null);
  });

  it('stores queries and bounded sources, without the supports', () => {
    const stored = storedSourceSet({
      queries: ['q', '  ', 'q2'],
      items: [
        { url: 'https://a.example/', title: 'x'.repeat(1000), snippet: 's', junk: { deep: true } },
        { url: 'javascript:alert(1)' }
      ],
      supports: [{ text: 'a', urls: ['https://a.example/'] }]
    });
    assert.deepEqual(stored.queries, ['q', 'q2']);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].title.length, 300);
    assert.equal(stored.items[0].junk, undefined);
    assert.equal(stored.supports, undefined);
  });

  it('numbers markers through one map per answer', () => {
    const numbers = new Map();
    assert.equal(citationMarkers(['https://a.example/'], numbers), '[1](https://a.example/)');
    assert.equal(
      citationMarkers(['https://b.example/', 'https://a.example/'], numbers),
      '[2](https://b.example/)[1](https://a.example/)'
    );
  });
});
