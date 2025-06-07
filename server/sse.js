export const clients = new Map();
export const activeRequests = new Map();

export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export function connect(chatId, res, appId) {
  clients.set(chatId, { response: res, lastActivity: new Date(), appId });
  sendSSE(res, 'connected', { chatId });
}

export function disconnect(chatId) {
  if (clients.has(chatId)) {
    if (activeRequests.has(chatId)) {
      try {
        const controller = activeRequests.get(chatId);
        controller.abort();
      } catch (e) {
        console.error(`Error aborting request for chat ID: ${chatId}`, e);
      }
      activeRequests.delete(chatId);
    }
    const client = clients.get(chatId);
    client.response.end();
    clients.delete(chatId);
    console.log(`Client disconnected: ${chatId}`);
  }
}
