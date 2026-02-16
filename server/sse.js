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
    } catch (err) {
      logger.error('Error sending SSE action event:', err);
    }
  }
});
