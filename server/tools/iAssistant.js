/**
 * iAssistant tool wrapper for RAG-based question answering
 * Supports both streaming (direct to client) and buffered modes
 */

import iAssistantService from '../services/integrations/iAssistantService.js';

// Export main method for RAG question answering
export async function ask(params) {
  // Check if streaming mode is requested (passthrough to client)
  const isStreaming = params.passthrough === true || params.streaming === true;

  if (isStreaming) {
    // Streaming mode: Return async iterator for direct client streaming
    const response = await iAssistantService.ask({
      ...params,
      streaming: true,
      appConfig: params.appConfig || null
    });

    // Return custom async generator that yields content chunks using our proven SSE parsing
    return {
      [Symbol.asyncIterator]: async function* () {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Process complete SSE events using the same logic as the adapter
            if (buffer.includes('\n\n')) {
              const parts = buffer.split('\n\n');
              const completeEvents = parts.slice(0, -1).join('\n\n');
              const remainingData = parts[parts.length - 1];

              if (completeEvents) {
                // Use the service's proven streaming buffer processor
                const result = iAssistantService.processStreamingBuffer(completeEvents + '\n\n');

                // Yield any answer content found
                if (result && result.content && result.content.length > 0) {
                  for (const textContent of result.content) {
                    yield textContent;
                  }
                }

                // Stop streaming if complete
                if (result && result.complete) {
                  break;
                }
              }

              buffer = remainingData;
            }
          }

          // Process any remaining data in buffer
          if (buffer.trim()) {
            const result = iAssistantService.processStreamingBuffer(buffer);
            if (result && result.content && result.content.length > 0) {
              for (const textContent of result.content) {
                yield textContent;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    };
  } else {
    // Non-streaming mode: Buffer complete response using service's collection method
    return iAssistantService.ask({
      ...params,
      streaming: false,
      appConfig: params.appConfig || null
    });
  }
}

// Export default with all methods
export default {
  ask
};
