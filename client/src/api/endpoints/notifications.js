import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

export const fetchNotifications = async ({ limit, unreadOnly } = {}) => {
  const params = {};
  if (limit) params.limit = limit;
  if (unreadOnly) params.unreadOnly = 'true';
  return handleApiResponse(() => apiClient.get('/notifications', { params }), null, null, false);
};

export const markNotificationRead = async notificationId => {
  return handleApiResponse(
    () => apiClient.post(`/notifications/${notificationId}/read`),
    null,
    null,
    false
  );
};

export const markAllNotificationsRead = async () => {
  return handleApiResponse(() => apiClient.post('/notifications/read-all'), null, null, false);
};
