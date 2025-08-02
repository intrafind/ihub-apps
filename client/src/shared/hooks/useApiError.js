import { useCallback } from 'react';
import { useNetworkStatus } from '../contexts/NetworkStatusContext';
import { useTranslation } from 'react-i18next';

/**
 * Hook for consistent API error handling across components
 */
export function useApiError() {
  const { getErrorMessage, classifyError, isOnline } = useNetworkStatus();
  const { t } = useTranslation();

  const handleApiError = useCallback(
    (error, options = {}) => {
      const {
        showNotification = true,
        fallbackMessage = null,
        context = 'general'
      } = options;

      // Get user-friendly error message
      const userMessage =
        getErrorMessage(error, t) ||
        fallbackMessage ||
        t('error.unknown', 'An unexpected error occurred');

      // Classify error for better handling
      const errorType = classifyError(error);

      // Enhanced error object with context
      const enhancedError = {
        ...error,
        userMessage,
        errorType,
        context,
        networkStatus: error.networkStatus || {
          isOnline,
          errorType
        }
      };

      // Log error with context
      console.error(`API Error [${context}]:`, {
        message: error.message,
        userMessage,
        errorType,
        url: error.config?.url,
        status: error.response?.status
      });

      // Show notification if requested
      if (showNotification && window.showErrorNotification) {
        window.showErrorNotification(userMessage, {
          type: errorType
        });
      }

      return enhancedError;
    },
    [getErrorMessage, classifyError, isOnline, t]
  );

  const createErrorHandler = useCallback(
    (context, options = {}) => {
      return error => handleApiError(error, { ...options, context });
    },
    [handleApiError]
  );

  return {
    handleApiError,
    createErrorHandler
  };
}
