// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A project document whose text the text recognition model read at upload (#3986) says so under
 * its name: from how many pages, whether the page limit cut it, and (in the tooltip) which model.
 * A failed item with an OCR error code gets a translated reason.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ItemRecognition =
  require('../../../client/src/features/projects/components/ItemRecognition').default;
const ProjectItemStatus =
  require('../../../client/src/features/projects/components/ProjectItemStatus').default;

describe('ItemRecognition', () => {
  test('names the pages and the model', () => {
    render(
      <ItemRecognition
        item={{ text: { recognized: { modelId: 'vision-1', pages: 3, at: '2026-11-26' } } }}
      />
    );
    const line = screen.getByTestId('item-recognition');
    expect(line).toHaveTextContent('Text recognized from 3 page(s)');
    expect(line).toHaveAttribute('title', 'Recognized by vision-1');
  });

  test('says when only the first pages were read', () => {
    render(
      <ItemRecognition
        item={{ text: { recognized: { modelId: 'vision-1', pages: 50, truncated: true } } }}
      />
    );
    expect(screen.getByTestId('item-recognition')).toHaveTextContent(
      'Text recognized from the first 50 page(s) only'
    );
  });

  test('shows nothing for a document whose text was extracted as usual', () => {
    const { container } = render(<ItemRecognition item={{ text: { chars: 120 } }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('a failed item with an OCR error', () => {
  test('gets a translated reason', () => {
    render(
      <ProjectItemStatus
        item={{ status: 'failed', error: { code: 'OCR_NO_TEXT', message: 'raw' } }}
      />
    );
    expect(screen.getByText('No text was found in this image or scan.')).toBeInTheDocument();
  });
});
