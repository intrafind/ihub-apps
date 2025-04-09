import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
console.log(API_URL);

// Create axios instance
const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Apps
export const fetchApps = async () => {
  const response = await apiClient.get('/apps');
  return response.data;
};

export const fetchAppDetails = async (appId) => {
  const response = await apiClient.get(`/apps/${appId}`);
  return response.data;
};

// Models
export const fetchModels = async () => {
  const response = await apiClient.get('/models');
  return response.data;
};

export const fetchModelDetails = async (modelId) => {
  const response = await apiClient.get(`/models/${modelId}`);
  return response.data;
};

// Chat
export const streamAppChat = async (appId, chatId) => {
  return new EventSource(`${API_URL}/apps/${appId}/chat/${chatId}`);
};

export const sendAppChatMessage = async (appId, chatId, messages, options = {}) => {
  const response = await apiClient.post(`/apps/${appId}/chat/${chatId}`, {
    messages,
    ...options
  });
  return response.data;
};

export const sendDirectModelMessage = async (modelId, messages, options = {}) => {
  const response = await apiClient.post(`/models/${modelId}/chat`, {
    messages,
    ...options
  });
  return response.data;
};

// Styles
export const fetchStyles = async () => {
  const response = await apiClient.get('/styles');
  return response.data;
};

// UI Configuration
export const fetchUIConfig = async () => {
  const response = await apiClient.get('/ui');
  return response.data;
};

// Test model
export const testModel = async (modelId) => {
  const response = await apiClient.get(`/models/${modelId}/chat/test`);
  return response.data;
};

// Stop an ongoing streaming chat session
export const stopAppChatStream = async (appId, chatId) => {
  const response = await apiClient.post(`/apps/${appId}/chat/${chatId}/stop`);
  return response.data;
};

// Check if a chat session is still active
export const checkAppChatStatus = async (appId, chatId) => {
  const response = await apiClient.get(`/apps/${appId}/chat/${chatId}/status`);
  return response.data;
};