/**
 * Admin app editor: Word review options of the file upload (concepts/document-extraction/,
 * release 2, WP-B). Both are off unless chosen; choosing the default again removes the key, so
 * saving an app never writes defaults into its file.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

// The format picker loads the platform's MIME type list from the API; it is not under test.
jest.mock('../../../client/src/features/admin/components/MimeTypeSelector', () => () => null);

const UploadConfigSection =
  require('../../../client/src/features/admin/components/app-form/UploadConfigSection').default;

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const app = fileUpload => ({
  upload: { enabled: true, fileUpload: { enabled: true, ...fileUpload } }
});

function renderSection(fileUpload) {
  const onChange = jest.fn();
  render(
    <UploadConfigSection
      app={app(fileUpload)}
      onChange={onChange}
      t={t}
      parseNumberOrUndefined={value => Number(value)}
    />
  );
  return {
    onChange,
    tracked: screen.getByLabelText('Word: tracked changes'),
    comments: screen.getByLabelText('Word: comments')
  };
}

describe('file upload: Word review options in the app editor', () => {
  it('show the defaults for an app that does not set them', () => {
    const { tracked, comments } = renderSection({});
    expect(tracked).toHaveValue('accepted');
    expect(comments).toHaveValue('ignore');
  });

  it('show what the app has set', () => {
    const { tracked, comments } = renderSection({ trackedChanges: 'markup', comments: 'inline' });
    expect(tracked).toHaveValue('markup');
    expect(comments).toHaveValue('inline');
  });

  it('opt in by choosing the option', () => {
    const { tracked, comments, onChange } = renderSection({});
    fireEvent.change(tracked, { target: { value: 'markup' } });
    expect(onChange).toHaveBeenLastCalledWith(
      'upload',
      expect.objectContaining({
        fileUpload: expect.objectContaining({ enabled: true, trackedChanges: 'markup' })
      })
    );
    fireEvent.change(comments, { target: { value: 'inline' } });
    expect(onChange.mock.calls.at(-1)[1].fileUpload.comments).toBe('inline');
  });

  it('choosing the default again removes the key instead of writing it', () => {
    const { tracked, onChange } = renderSection({ trackedChanges: 'markup' });
    fireEvent.change(tracked, { target: { value: 'accepted' } });
    const saved = onChange.mock.calls.at(-1)[1].fileUpload;
    expect(JSON.parse(JSON.stringify(saved))).toEqual({ enabled: true });
  });

  it('are not offered for the other upload types', () => {
    renderSection({});
    expect(screen.getAllByText('Word: tracked changes')).toHaveLength(1);
  });
});
