// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Two pickers of the app editor that live outside `app-form/` say everything
 * in the reader's language: the model selector's hints and the file-format
 * picker of the upload card. Both used to show English sentences from the
 * code in a German editor.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => require('./helpers/appFormHarness').i18nMock());
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/endpoints/config', () =>
  require('./helpers/appFormHarness').configApiMock()
);

const { setUiLanguage } = require('./helpers/appFormHarness');
const ResourceSelector =
  require('../../../client/src/features/admin/components/ResourceSelector').default;
const MimeTypeSelector =
  require('../../../client/src/features/admin/components/MimeTypeSelector').default;

const MODELS = [{ id: 'm1', name: 'Model one' }];

afterEach(() => setUiLanguage('en'));

describe('ResourceSelector', () => {
  function renderSelector(selected = []) {
    render(
      <ResourceSelector
        label="Erlaubte Modelle"
        resources={MODELS}
        selectedResources={selected}
        onSelectionChange={() => {}}
      />
    );
    return screen.getByLabelText('Erlaubte Modelle');
  }

  it('says in German that nothing matches the search', () => {
    setUiLanguage('de');
    const search = renderSelector();
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Zu Ihrer Suche passt kein Eintrag.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('No matching items found');
  });

  it('says in German how to search when everything is selected already', () => {
    setUiLanguage('de');
    const search = renderSelector(['m1']);
    fireEvent.focus(search);
    expect(screen.getByText('Tippen Sie, um zu suchen.')).toBeInTheDocument();
  });

  it('has German defaults for the placeholder, the empty selection and "all"', () => {
    setUiLanguage('de');
    const search = renderSelector();
    expect(search).toHaveAttribute('placeholder', 'Suchen und auswählen...');
    expect(screen.getByText('Nichts ausgewählt')).toBeInTheDocument();
  });

  it('keeps the English texts in English', () => {
    const search = renderSelector();
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches your search.')).toBeInTheDocument();
  });
});

describe('MimeTypeSelector', () => {
  it('names the category in the reader’s language', async () => {
    setUiLanguage('de');
    render(
      <MimeTypeSelector categoryType="images" selectedFormats={['image/png']} onChange={() => {}} />
    );
    expect(screen.getByText('Die verfügbaren Formate werden geladen...')).toBeInTheDocument();
    expect(await screen.findByText('Gesamte Kategorie „Bilder“ verwenden')).toBeInTheDocument();
    expect(screen.getByText('Oder wählen Sie einzelne Formate:')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Use entire|Or select individual/);
  });

  it('says in German when the kind of file is not set up', async () => {
    setUiLanguage('de');
    render(<MimeTypeSelector categoryType="nope" selectedFormats={[]} onChange={() => {}} />);
    expect(
      await screen.findByText('Diese Dateiart ist in dieser Installation nicht eingerichtet.')
    ).toBeInTheDocument();
  });
});
