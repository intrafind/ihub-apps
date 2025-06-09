/**
 * Perform a simple web search using DuckDuckGo's Instant Answer API.
 * This API is free and does not require an API key.
 */
export default async function webSearch({ query }) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }
  const data = await response.json();
  const results = [];
  if (Array.isArray(data.RelatedTopics)) {
    for (const topic of data.RelatedTopics) {
      if (topic.Text && topic.FirstURL) {
        results.push({ title: topic.Text, url: topic.FirstURL });
      } else if (Array.isArray(topic.Topics)) {
        for (const sub of topic.Topics) {
          if (sub.Text && sub.FirstURL) {
            results.push({ title: sub.Text, url: sub.FirstURL });
          }
        }
      }
      if (results.length >= 5) break;
    }
  }
  return { results };
}
