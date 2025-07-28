import webSearchService from '../services/WebSearchService.js';

export default async function braveSearch({ query, q, chatId }) {
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Use the unified web search service with brave provider
  return await webSearchService.search(searchQuery, {
    provider: 'brave',
    chatId
  });
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
