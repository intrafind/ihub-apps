import { renderHook, waitFor } from '@testing-library/react';

/**
 * The app editor's voice input picker lists the enabled streaming
 * transcription models of the admin model list — not the public /api/models,
 * which only holds the models the admin's own groups may use.
 */

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

const useAdminTranscriptionModels =
  require('../../../client/src/features/admin/hooks/useAdminTranscriptionModels').default;

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

test('lists the enabled streaming transcription models of the admin model list', async () => {
  mockMakeAdminApiCall.mockResolvedValue({
    data: [
      { id: 'gemini-live', modelType: 'transcription', provider: 'google-live', enabled: true },
      { id: 'voxtral', modelType: 'transcription', provider: 'vllm-realtime' },
      { id: 'whisper', modelType: 'transcription', provider: 'openai', enabled: true },
      { id: 'old', modelType: 'transcription', provider: 'mistral', enabled: false },
      { id: 'gpt', modelType: 'chat', enabled: true },
      { id: 'speech', modelType: 'tts', enabled: true }
    ]
  });
  const { result } = renderHook(() => useAdminTranscriptionModels());

  await waitFor(() => expect(result.current.map(m => m.id)).toEqual(['gemini-live', 'voxtral']));
  expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/models');
});

test('stays empty when the list cannot be loaded', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockMakeAdminApiCall.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useAdminTranscriptionModels());

  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(result.current).toEqual([]);
  error.mockRestore();
});
