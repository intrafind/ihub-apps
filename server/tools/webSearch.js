/**
 * Perform a web search using DuckDuckGo via the `duck-duck-scrape` library.
 * Results are limited to the first five entries returned.
 */
import { search } from 'duck-duck-scrape';

export default async function webSearch({ query }) {
  const data = await search(query);
  const results = [];

  for (const row of data.results || []) {
    if (row.title && row.url) {
      results.push({ title: row.title, url: row.url });
    }
    if (results.length >= 5) break;
  }

  return { results };
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const query = process.argv.slice(2).join(' ');
  
  if (!query) {
    console.error('Usage: node webSearch.js <search term>');
    console.error('Example: node webSearch.js "JavaScript tutorials"');
    process.exit(1);
  }
  
  console.log(`Searching for: "${query}"`);
  
  try {
    const result = await webSearch({ query });
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
