/**
 * PlatformConfigContext must pass `speech` through.
 *
 * The context hand-assembles platformConfig from three endpoints. It dropped
 * `speech`, so useVoiceRecognition never saw the Azure platform host or the
 * keyConfigured flag: apps without their own host failed with "Azure
 * subscription key is not configured", and a configured key was never used.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const speech = {
  realtime: { enabled: false },
  azure: { enabled: true, host: 'ws://speech.internal:5000', region: '', keyConfigured: false }
};

jest.mock('../../../client/src/api', () => ({
  fetchAuthStatus: jest.fn(async () => ({ authMode: 'local', authenticated: true })),
  fetchUIConfig: jest.fn(async () => ({})),
  fetchPlatformConfig: jest.fn(async () => ({ speech }))
}));

import {
  PlatformConfigProvider,
  usePlatformConfig
} from '../../../client/src/shared/contexts/PlatformConfigContext';

function SpeechProbe() {
  const { platformConfig } = usePlatformConfig();
  if (!platformConfig) return null;
  return <pre data-testid="speech">{JSON.stringify(platformConfig.speech ?? null)}</pre>;
}

test('exposes platform speech config (Azure host, keyConfigured) to consumers', async () => {
  render(
    <PlatformConfigProvider>
      <SpeechProbe />
    </PlatformConfigProvider>
  );

  await waitFor(() => expect(screen.getByTestId('speech')).toBeInTheDocument());
  expect(JSON.parse(screen.getByTestId('speech').textContent)).toEqual(speech);
});
