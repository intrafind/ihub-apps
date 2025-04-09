/**
 * Helper function to send Server-Sent Events
 * @param {Object} res - Express response object
 * @param {string} event - Event name
 * @param {Object} data - Data to send
 */
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Helper function to get API key for a model
 * @param {string} modelId - The model ID
 * @returns {string|null} The API key or null if not found
 */
export async function getApiKeyForModel(modelId) {
  try {
    // Load models configuration to find the provider
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    const filePath = path.join(__dirname, '../config/models.json');
    const data = await fs.readFile(filePath, 'utf8');
    const models = JSON.parse(data);
    
    // Find the model by ID
    const model = models.find(m => m.id === modelId);
    if (!model) {
      console.error(`Model not found: ${modelId}`);
      return null;
    }
    
    // Get the provider for this model
    const provider = model.provider;
    
    // Check for provider-specific API keys
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_API_KEY;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY;
      case 'google':
        return process.env.GOOGLE_API_KEY;
      case 'local':
        // For local models, check if there's a specific LOCAL_API_KEY or return a default empty string
        // This allows local models to work without authentication in many cases
        return process.env.LOCAL_API_KEY || '';
      default:
        // Try to find a generic API key based on provider name (e.g., COHERE_API_KEY for provider 'cohere')
        const genericKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        if (genericKey) {
          return genericKey;
        }
        
        // Check for a default API key as last resort
        if (process.env.DEFAULT_API_KEY) {
          console.log(`Using DEFAULT_API_KEY for provider: ${provider}`);
          return process.env.DEFAULT_API_KEY;
        }
        
        console.error(`No API key found for provider: ${provider}`);
        return null;
    }
  } catch (error) {
    console.error('Error getting API key for model:', error);
    return null;
  }
}