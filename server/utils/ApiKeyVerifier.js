import { getApiKeyForModel } from '../utils.js';
import ErrorHandler from './ErrorHandler.js';
import { sendSSE } from '../sse.js';
import configCache from '../configCache.js';

class ApiKeyVerifier {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  async verifyApiKey(model, res = null, clientRes = null, language = null) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    const lang = language || defaultLang;
    
    try {
      const apiKey = await getApiKeyForModel(model.id);
      
      if (!apiKey) {
        console.error(`API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`);
        
        const error = await this.errorHandler.createApiKeyError(model.provider, lang);
        
        if (clientRes) {
          sendSSE(clientRes, 'error', { message: error.message });
        }
        
        if (res) {
          res.status(401).json(this.errorHandler.formatErrorResponse(error));
        }
        
        return { success: false, error };
      }
      
      return { success: true, apiKey };
    } catch (error) {
      console.error(`Error getting API key for model ${model.id}:`, error);
      
      const internalError = await this.errorHandler.getLocalizedError('internalError', {}, lang);
      const chatError = new Error(internalError);
      chatError.code = 'INTERNAL_ERROR';
      
      if (clientRes) {
        sendSSE(clientRes, 'error', { message: internalError });
      }
      
      if (res) {
        res.status(500).json({ error: internalError, code: 'INTERNAL_ERROR' });
      }
      
      return { success: false, error: chatError };
    }
  }

  async validateApiKeys() {
    const providers = ['openai', 'anthropic', 'google', 'mistral'];
    const missing = [];
    
    for (const provider of providers) {
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      if (!process.env[envVar]) {
        missing.push(provider);
      }
    }
    
    if (missing.length > 0) {
      console.warn(`⚠️ WARNING: Missing API keys for providers: ${missing.join(', ')}`);
      console.warn('Some models may not work. Please check your .env file configuration.');
      return { valid: false, missing };
    } else {
      console.log('✓ All provider API keys are configured');
      return { valid: true, missing: [] };
    }
  }
}

export default ApiKeyVerifier;