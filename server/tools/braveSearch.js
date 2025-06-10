export default async function braveSearch({ query }) {
  if (!query) {
    throw new Error('query parameter is required');
  }
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY is not set');
  }
  const endpoint = process.env.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';
  const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&count=5`, {
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
      if (item.title && item.url) {
        results.push({ title: item.title, url: item.url });
      }
      if (results.length >= 5) break;
    }
  }
  return { results };
}
