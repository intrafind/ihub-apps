// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin app editor: turning an upload type on selects its entire format category, which the admin
 * can uncheck to pick formats. A type that was already on keeps the formats the app saved.
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const CATEGORY = ['image/png', 'image/jpeg', 'image/gif'];

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({
    categories: { images: { name: { en: 'Images' }, mimeTypes: CATEGORY } },
    mimeTypes: {}
  }))
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key)
  })
}));

const UploadConfigSection =
  require('../../../client/src/features/admin/components/app-form/UploadConfigSection').default;

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

function Editor({ initial, onSave }) {
  const [app, setApp] = useState(initial);
  return (
    <UploadConfigSection
      app={app}
      onChange={(field, value) => {
        setApp(prev => ({ ...prev, [field]: value }));
        onSave(value);
      }}
      t={t}
      parseNumberOrUndefined={value => Number(value)}
    />
  );
}

// The labels are not linked to their checkboxes; the checkbox is the label's previous sibling
const boxOf = text => screen.getByText(text).previousSibling;
const categoryBox = () => boxOf(/Use entire/);

describe('entire format category', () => {
  it('is selected when an upload type is turned on, and can be unchecked', async () => {
    const onSave = jest.fn();
    render(<Editor initial={{ upload: { enabled: true } }} onSave={onSave} />);

    fireEvent.click(boxOf('Enable Image Upload'));

    await waitFor(() => expect(categoryBox()).toBeChecked());
    expect(onSave.mock.calls.at(-1)[0].imageUpload).toEqual({
      enabled: true,
      supportedFormats: CATEGORY
    });
    expect(screen.queryByText('Or select individual formats:')).not.toBeInTheDocument();

    fireEvent.click(categoryBox());

    expect(categoryBox()).not.toBeChecked();
    expect(screen.getByText('Or select individual formats:')).toBeInTheDocument();
    // Unchecking keeps what was selected, to be narrowed down
    expect(onSave.mock.calls.at(-1)[0].imageUpload.supportedFormats).toEqual(CATEGORY);
  });

  it('leaves the formats of a type that was already on alone', async () => {
    const onSave = jest.fn();
    render(
      <Editor
        initial={{
          upload: { enabled: true, imageUpload: { enabled: true, supportedFormats: ['image/png'] } }
        }}
        onSave={onSave}
      />
    );

    await waitFor(() => expect(screen.getByText('Or select individual formats:')).toBeVisible());
    expect(categoryBox()).not.toBeChecked();
    expect(onSave).not.toHaveBeenCalled();
  });
});
