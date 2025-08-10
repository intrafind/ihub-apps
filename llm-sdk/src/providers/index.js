/**
 * Provider implementations for LLM SDK
 */

export { OpenAIProvider } from './OpenAIProvider.js';
export { AnthropicProvider } from './AnthropicProvider.js';
export { GoogleProvider } from './GoogleProvider.js';

// Provider registry for dynamic loading
export const PROVIDERS = {
  openai: () => import('./OpenAIProvider.js').then(m => m.OpenAIProvider),
  anthropic: () => import('./AnthropicProvider.js').then(m => m.AnthropicProvider),
  google: () => import('./GoogleProvider.js').then(m => m.GoogleProvider)
};

/**
 * Get provider class by name
 * @param {string} providerName - Provider name
 * @returns {Promise<Class>} Provider class constructor
 */
export async function getProviderClass(providerName) {
  const loader = PROVIDERS[providerName.toLowerCase()];
  if (!loader) {
    throw new Error(`Provider '${providerName}' not found`);
  }
  return await loader();
}
