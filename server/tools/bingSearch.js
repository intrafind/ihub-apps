export default async function bingSearch({ query }) {
  if (!query) {
    throw new Error('query parameter is required');
  }
  const apiKey = process.env.BING_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BING_SEARCH_API_KEY is not set');
  }
  const endpoint = process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search';
  const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&count=5`, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey }
  });
  if (!res.ok) {
    throw new Error(`Bing search failed with status ${res.status}`);
  }
  const data = await res.json();
  const results = [];
  if (data.webPages && Array.isArray(data.webPages.value)) {
    for (const item of data.webPages.value) {
      if (item.name && item.url) {
        results.push({ title: item.name, url: item.url });
      }
      if (results.length >= 5) break;
    }
  }
  return { results };
}
