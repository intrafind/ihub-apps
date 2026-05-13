export const clients = new Map();
export const activeRequests = new Map();
import { actionTracker } from './actionTracker.js';
import logger from './utils/logger.js';

export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

actionTracker.on('fire-sse', step => {
  const { chatId, event } = step;
  if (!chatId) return;
  if (clients.has(chatId)) {
    const clientEntry = clients.get(chatId);
    clientEntry.lastActivity = new Date(); // Keep connection marked as active
    try {
      sendSSE(clientEntry.response, event, step);
    } catch (error) {
      // The socket is most likely dead (peer closed, write-after-end, etc.).
      // Without this cleanup, every subsequent fire-sse event would re-throw
      // and the Map entry would linger until cleanupInactiveClients evicts it
      // 5 minutes later — meanwhile the LLM keeps streaming into a void and
      // the activeRequests controller leaks.
      logger.error('Error sending SSE action event; tearing down dead client', {
        component: 'SSE',
        chatId,
        error: error?.message || String(error)
      });
      try {
        const controller = activeRequests.get(chatId);
        if (controller) {
          controller.abort();
          activeRequests.delete(chatId);
        }
      } catch (abortErr) {
        logger.error('Error aborting activeRequest after SSE write failure', {
          component: 'SSE',
          chatId,
          error: abortErr?.message || String(abortErr)
        });
      }
      // Only delete the entry if it's still the one we just wrote to — avoids
      // wiping out a freshly-reconnected entry on the same chatId.
      if (clients.get(chatId) === clientEntry) {
        clients.delete(chatId);
      }
    }
  }
});
