import bingSearch from './bingSearch.js';
import googleSearch from './googleSearch.js';
import duckSearch from './duckSearch.js';
import braveSearch from './braveSearch.js';

export default async function multiSearch({ query }) {
  if (!query) {
    throw new Error('query parameter is required');
  }

  const results = [];

  try {
    const { results: bingResults } = await bingSearch({ query });
    results.push(...bingResults);
  } catch (err) {
    console.error('Bing search error', err);
  }

  if (results.length < 5) {
    try {
      const { results: googleResults } = await googleSearch({ query });
      results.push(...googleResults);
    } catch (err) {
      console.error('Google search error', err);
    }
  }

  if (results.length < 5) {
    try {
      const { results: duckResults } = await duckSearch({ query });
      results.push(...duckResults);
    } catch (err) {
      console.error('DuckDuckGo search error', err);
    }
  }

  if (results.length < 5) {
    try {
      const { results: braveResults } = await braveSearch({ query });
      results.push(...braveResults);
    } catch (err) {
      console.error('Brave search error', err);
    }
  }

  return { results: results.slice(0, 5) };
}
