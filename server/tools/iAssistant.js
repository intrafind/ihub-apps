// iAssistant tool wrapper for RAG-based question answering

import iAssistantService from '../services/integrations/iAssistantService.js';

// Export main method for RAG question answering
export async function ask(params) {
  return iAssistantService.ask(params);
}

// Export default with all methods
export default {
  ask
};
