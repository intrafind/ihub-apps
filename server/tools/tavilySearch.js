import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';

export default async function tavilySearch({ query, q, search_depth = 'basic', max_results = 5, chatId }) {
  const searchQuery = query || q;
  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }
  const apiKey = config.TAVILY_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_SEARCH_API_KEY is not set');
  }
  const endpoint = config.TAVILY_ENDPOINT || 'https://api.tavily.com/search';
  actionTracker.trackAction(chatId, { action: 'search', query: searchQuery });
  const res = await throttledFetch('tavilySearch', endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: searchQuery,
      search_depth,
      max_results
    })
  });

  if (!res.ok) {
    throw new Error(`Tavily search failed with status ${res.status}`);
  }

  const data = await res.json();
  const results = [];
  if (Array.isArray(data.results)) {
    for (const item of data.results) {
      results.push({
        title: item.title,
        url: item.url,
        description: item.content,
        score: item.score
      });
    }
  }
  return { results };
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');

  if (!searchQuery) {
    console.error('Usage: node tavilySearch.js <search term>');
    console.error('Example: node tavilySearch.js "JavaScript tutorials"');
    process.exit(1);
  }

  console.log(`Searching for: "${searchQuery}"`);

  try {
    const result = await tavilySearch({ query: searchQuery });
    console.log('\nSearch Results:');
    console.log('===============');

    if (result.results.length === 0) {
      console.log('No results found.');
    } else {
      result.results.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   URL: ${item.url}\n`);
      });
    }
  } catch (error) {
    console.error('Error performing search:', error.message);
    process.exit(1);
  }
}
