/**
 * Perform a web search using DuckDuckGo's results endpoint.
 * This approach mimics the behaviour of the `duckduckgo_search` library
 * and typically returns more results than the Instant Answer API.
 */
export default async function webSearch({ query }) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };

  // Fetch the search page to obtain the vqd token
  const pageRes = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    { headers }
  );
  if (!pageRes.ok) {
    throw new Error(`Failed to load search page (${pageRes.status})`);
  }
  const pageText = await pageRes.text();
  const vqdMatch = pageText.match(/vqd=['"](\d+-\d+-\d+)['"]/);
  if (!vqdMatch) {
    throw new Error('Unable to extract search token');
  }

  const params = new URLSearchParams({
    q: query,
    l: 'us-en',
    o: 'json',
    sp: '0',
    vqd: vqdMatch[1],
  });
  const apiRes = await fetch(`https://links.duckduckgo.com/d.js?${params}`, {
    headers,
  });
  if (!apiRes.ok) {
    throw new Error(`Search request failed with status ${apiRes.status}`);
  }
  const data = await apiRes.json();
  const results = [];
  for (const row of data.results || []) {
    if (row.t && row.u) {
      results.push({
        title: row.t.replace(/<[^>]+>/g, ''),
        url: row.u,
      });
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
