import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {}, resetHeaderColor: jest.fn() })
}));
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [], loading: false, error: null })
}));
jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  default: () => ({ chats: [] }),
  useChatPersistence: () => false
}));
jest.mock('../../../client/src/shared/hooks/useFavorites', () => ({
  __esModule: true,
  default: () => ({ favorites: [] })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/IHubLogo', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/AppChatStarter', () => ({
  __esModule: true,
  default: () => null
}));
// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

import StartPage from '../../../client/src/features/apps/pages/StartPage';

/** `/start?documentId=…` hands over to the app picker, which can carry the document. */

let location;
function Probe() {
  location = useLocation();
  return null;
}
const renderAt = url =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe />
      <Routes>
        <Route path="/start" element={<StartPage />} />
        <Route path="/apps" element={<div>picker</div>} />
      </Routes>
    </MemoryRouter>
  );

test('redirects to the app picker with the document parameters', () => {
  renderAt('/start?documentId=d1&source=ifinder&searchProfile=sp&send=true');
  expect(screen.getByText('picker')).toBeTruthy();
  expect(location.pathname).toBe('/apps');
  const params = new URLSearchParams(location.search);
  expect(params.get('documentId')).toBe('d1');
  expect(params.get('source')).toBe('ifinder');
  expect(params.get('searchProfile')).toBe('sp');
  expect(params.has('send')).toBe(false);
});

test('stays on the start page without a pending document', () => {
  renderAt('/start?documentId=d1');
  expect(location.pathname).toBe('/start');
  expect(screen.queryByText('picker')).toBeNull();
});
