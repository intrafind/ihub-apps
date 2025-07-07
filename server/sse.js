export const clients = new Map();
export const activeRequests = new Map();
import { actionTracker } from './actionTracker.js';

export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

actionTracker.on('fire-sse', step => {
  const { chatId, event } = step;
  if (!chatId) return;
  if (clients.has(chatId)) {
    const client = clients.get(chatId).response;
    try {
      sendSSE(client, event, step);
    } catch (err) {
      console.error('Error sending SSE action event:', err);
    }
  }
});


