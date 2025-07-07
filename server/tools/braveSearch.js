import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';

export default async function braveSearch({ query, q }) {
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;
  
  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }
  const apiKey = config.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY is not set');
  }
  const endpoint = config.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';
  actionTracker.trackAction({ action: 'search', query: searchQuery });
  const res = await throttledFetch('braveSearch', `${endpoint}?q=${encodeURIComponent(searchQuery)}`, {
    headers: {
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Brave search failed with status ${res.status}`);
  }
  const data = await res.json();
  const results = [];
  if (data.web && Array.isArray(data.web.results)) {
    for (const item of data.web.results) {
      results.push({ title: item.title, url: item.url, description: item.description, language: item.language });
    }
  }
  return { results };
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');
  
  if (!searchQuery) {
    console.error('Usage: node braveSearch.js <search term>');
    console.error('Example: node braveSearch.js "JavaScript tutorials"');
    process.exit(1);
  }
  
  console.log(`Searching for: "${searchQuery}"`);
  
  try {
    const result = await braveSearch({ query: searchQuery });
    console.log('\nSearch Results:');
    console.log('===============');
    
    if (result.results.length === 0) {
      console.log('No results found.');
    } else {
      result.results.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   URL: ${item.url}\n`);
        console.log(`   Result: ${JSON.stringify(item, null, 2)}\n`);
      });
    }
  } catch (error) {
    console.error('Error performing search:', error.message);
    process.exit(1);
  }
}