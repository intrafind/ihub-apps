// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The top of the app builder's Start screen (`DescribeSlot`): which model the
 * line under the description box names. A model an administrator chose for
 * drafts (`configuredModelId`) is named when the author may use it; otherwise
 * the automatic choice (the default model, else the first that can draft).
 *
 * The components are the real ones with the real English texts. The last
 * tests take the setting through the real `PlatformConfigProvider`, which
 * assembles `platformConfig` by hand from `/api/configs/platform`: when it left
 * out `appGenerator`, both create pages named the automatic model although an
 * administrator had chosen one.
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockI18n = i18next.createInstance();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

// Icon reads the runtime base path through `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockPlatform = { current: {} };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAuthStatus: () => Promise.resolve({ authMode: 'local', authMethods: {} }),
  fetchUIConfig: () => Promise.resolve({}),
  fetchPlatformConfig: () => Promise.resolve(mockPlatform.current),
  invalidateAuthStatusCache: () => {},
  invalidatePlatformConfigCache: () => {},
  invalidateUIConfigCache: () => {}
}));

const DescribeSlot =
  require('../../../client/src/features/admin/components/app-create/DescribeSlot').default;
const {
  PlatformConfigProvider,
  usePlatformConfig
} = require('../../../client/src/shared/contexts/PlatformConfigContext');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

const MODELS = [
  { id: 'fast', name: { en: 'Fast Model' } },
  { id: 'main', name: { en: 'Main Model' }, default: true },
  { id: 'painter', name: { en: 'Painter' }, supportsImageGeneration: true }
];

/** The privacy line as it reads for a model name. */
const privacyLine = model => en.admin.apps.create.start.privacy.replace('{{model}}', model);

function renderSlot(props) {
  return render(
    <DescribeSlot
      enabled
      models={MODELS}
      language="en"
      description=""
      onDescriptionChange={() => {}}
      onDraft={() => {}}
      generate={jest.fn()}
      {...props}
    />
  );
}

describe('DescribeSlot names the model the description is sent to', () => {
  test('names the configured draft model when the author may use it', () => {
    renderSlot({ configuredModelId: 'fast' });
    expect(screen.getByText(privacyLine('Fast Model'))).toBeInTheDocument();
    expect(screen.queryByText(privacyLine('Main Model'))).not.toBeInTheDocument();
  });

  test('names the automatic choice when the configured model is not among the usable ones', () => {
    renderSlot({ configuredModelId: 'not-allowed' });
    expect(screen.getByText(privacyLine('Main Model'))).toBeInTheDocument();
  });

  test('names the automatic choice when the configured model cannot draft', () => {
    renderSlot({ configuredModelId: 'painter' });
    expect(screen.getByText(privacyLine('Main Model'))).toBeInTheDocument();
  });

  test('names the automatic choice without a configured model', () => {
    renderSlot({});
    expect(screen.getByText(privacyLine('Main Model'))).toBeInTheDocument();
  });
});

describe('the configured draft model reaches the create page through the platform config', () => {
  /** Reads the setting the way AdminAppCreatePage and UserAppCreatePage do. */
  function CreatePageSlot() {
    const { platformConfig, isLoading } = usePlatformConfig();
    if (isLoading) return null;
    return (
      <DescribeSlot
        enabled
        models={MODELS}
        configuredModelId={platformConfig?.appGenerator?.modelId || ''}
        language="en"
        description=""
        onDescriptionChange={() => {}}
        onDraft={() => {}}
        generate={jest.fn()}
      />
    );
  }

  const renderInProvider = () =>
    render(
      <PlatformConfigProvider>
        <CreatePageSlot />
      </PlatformConfigProvider>
    );

  test('names the model the server sends as the draft model', async () => {
    mockPlatform.current = { appGenerator: { modelId: 'fast' } };
    renderInProvider();
    expect(await screen.findByText(privacyLine('Fast Model'))).toBeInTheDocument();
  });

  test('names the automatic choice when the server sends no draft model', async () => {
    mockPlatform.current = {};
    renderInProvider();
    expect(await screen.findByText(privacyLine('Main Model'))).toBeInTheDocument();
  });
});
