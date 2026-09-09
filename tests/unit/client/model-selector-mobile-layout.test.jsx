import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ModelSelector mobile layout regression tests.
 *
 * The open menu used to be a fixed 20rem panel anchored with `left-0` to a
 * trigger that sits at the right end of the chat toolbar. On a phone that
 * pushed most of the panel past the right edge of the viewport, so model names
 * and descriptions were cut off mid-word; the mix of one- and two-line
 * descriptions also made row heights alternate, which read as random gaps
 * between models (intrafind/ihub-apps#2287).
 *
 * jsdom does not evaluate media queries, so these tests assert the responsive
 * class contract that produces the layout rather than the computed geometry.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

const ModelSelector = require('../../../client/src/features/chat/components/ModelSelector').default;

const models = [
  {
    id: 'model-short-desc',
    name: { en: 'Mistral Large' },
    description: { en: "Mistral's fast model for general tasks" }
  },
  {
    id: 'model-long-desc',
    name: { en: 'Gemini 3.1 Flash Image Preview' },
    description: {
      en: "Google's state-of-the-art image generation and editing model optimized for professional asset production"
    }
  },
  {
    id: 'model-no-desc',
    name: { en: 'Local vLLM' }
  }
];

function renderSelector(props = {}) {
  const onModelChange = jest.fn();
  const utils = render(
    <ModelSelector
      models={models}
      selectedModel="model-short-desc"
      onModelChange={onModelChange}
      currentLanguage="en"
      {...props}
    />
  );
  return { ...utils, onModelChange };
}

function openMenu() {
  fireEvent.click(screen.getByTitle('Select Model'));
  return screen.getByRole('menu');
}

describe('ModelSelector menu layout', () => {
  test('is a full-width bottom sheet below `sm` and an anchored dropdown from `sm` up', () => {
    renderSelector();
    const menu = openMenu();

    // Mobile: pinned to both viewport edges so nothing can be clipped.
    expect(menu).toHaveClass('fixed', 'inset-x-0', 'bottom-0');
    // Desktop: back to the panel anchored next to the trigger.
    expect(menu).toHaveClass('sm:absolute', 'sm:inset-x-auto', 'sm:left-0', 'sm:w-80');
    // A width that ignores the viewport must not leak into the mobile sheet.
    expect(menu.className).not.toMatch(/(^|\s)w-80(\s|$)/);
  });

  test('keeps every row one name line and, on mobile, one description line', () => {
    renderSelector();
    openMenu();

    for (const model of models) {
      const row = screen.getByRole('menuitem', { name: new RegExp(model.name.en, 'i') });
      const [name, desc] = row.querySelectorAll('div.flex-1 > div');

      expect(name).toHaveTextContent(model.name.en);
      expect(name).toHaveClass('truncate');

      if (model.description) {
        // `truncate` rather than `line-clamp-1`: a `-webkit-line-clamp`
        // element inside a flex item keeps its full unclamped height in
        // WebKit, so long descriptions rendered one line of text followed by
        // a tall empty box. Two lines are allowed from `sm` up, bounded by
        // max-h so the same quirk cannot add height there either.
        expect(desc).toHaveClass('truncate', 'sm:whitespace-normal', 'sm:line-clamp-2');
        expect(desc).toHaveClass('sm:max-h-8');
        expect(desc.className).not.toMatch(/(^|\s)line-clamp-1(\s|$)/);
      } else {
        expect(desc).toBeUndefined();
      }
    }
  });

  test('tapping the scrim closes the sheet', () => {
    const { container } = renderSelector();
    openMenu();

    const scrim = container.querySelector('div[aria-hidden="true"].fixed.inset-0');
    expect(scrim).toBeTruthy();
    // The scrim is hidden once the anchored dropdown takes over.
    expect(scrim).toHaveClass('sm:hidden');

    fireEvent.click(scrim);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('opens downward from `sm` up when asked, without moving the mobile sheet', () => {
    renderSelector({ dropdownDirection: 'down' });
    const menu = openMenu();

    expect(menu).toHaveClass('sm:top-full', 'sm:bottom-auto');
    // Unprefixed positioning would fight the sheet's `bottom-0` on mobile.
    expect(menu.className).not.toMatch(/(^|\s)top-full(\s|$)/);
  });

  test('selects a model and closes', () => {
    const { onModelChange } = renderSelector();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /Local vLLM/i }));

    expect(onModelChange).toHaveBeenCalledWith('model-no-desc');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
