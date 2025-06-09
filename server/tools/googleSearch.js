export default async function googleSearch({ query }) {
  if (!query) {
    throw new Error('query parameter is required');
  }
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) {
    throw new Error('GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX must be set');
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google search failed with status ${res.status}`);
  }
  const data = await res.json();
  const results = [];
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (item.title && item.link) {
        results.push({ title: item.title, url: item.link });
      }
      if (results.length >= 5) break;
    }
  }
  return { results };
}
