import webSearchService from '../services/WebSearchService.js';

export default async function tavilySearch({
  query,
  q,
  search_depth = 'basic',
  max_results = 5,
  chatId
}) {
  const searchQuery = query || q;
  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Use the unified web search service with tavily provider
  return await webSearchService.search(searchQuery, {
    provider: 'tavily',
    chatId,
    search_depth,
    max_results
  });
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
