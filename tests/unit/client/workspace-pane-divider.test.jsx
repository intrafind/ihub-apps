// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The divider between the chat and the docked workspace pane: a focusable vertical
 * `role="separator"` with a value, resized by keyboard, pointer and reset by double-click.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) =>
      String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
  })
}));

// jsdom has no PointerEvent: a MouseEvent with a pointer id stands in.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId;
    }
  };
}

const PaneDivider =
  require('../../../client/src/features/workspace/components/PaneDivider').default;

function Harness({ initial = 800, container = 1600, onEnd = () => {}, onReset }) {
  const [width, setWidth] = useState(initial);
  return (
    <>
      <PaneDivider
        width={width}
        containerWidth={container}
        onResize={setWidth}
        onResizeEnd={onEnd}
        onReset={onReset || (() => setWidth(800))}
        controls="workspace-pane"
      />
      <output data-testid="width">{width}</output>
    </>
  );
}

describe('PaneDivider', () => {
  test('is a focusable vertical separator with its value and limits', () => {
    render(<Harness />);
    const divider = screen.getByRole('separator', { name: 'Resize workspace' });
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    expect(divider).toHaveAttribute('aria-controls', 'workspace-pane');
    expect(divider).toHaveAttribute('aria-valuenow', '800');
    expect(divider).toHaveAttribute('aria-valuemin', '360');
    expect(divider).toHaveAttribute('aria-valuemax', '1120');
    expect(divider).toHaveAttribute('aria-valuetext', 'Workspace 50 percent');
    expect(divider).toHaveAttribute('tabindex', '0');
  });

  test('arrow keys resize (left grows the pane), Home/End snap, and each step is saved', () => {
    const onEnd = jest.fn();
    render(<Harness onEnd={onEnd} />);
    const divider = screen.getByRole('separator');
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(screen.getByTestId('width')).toHaveTextContent('816');
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByTestId('width')).toHaveTextContent('752');
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(screen.getByTestId('width')).toHaveTextContent('360');
    fireEvent.keyDown(divider, { key: 'End' });
    expect(screen.getByTestId('width')).toHaveTextContent('1120');
    expect(onEnd).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(divider, { key: 'a' });
    expect(onEnd).toHaveBeenCalledTimes(4);
  });

  test('drags with a pointer and saves when the drag ends', () => {
    const onEnd = jest.fn();
    render(<Harness onEnd={onEnd} />);
    const divider = screen.getByRole('separator');
    fireEvent.pointerDown(divider, { clientX: 800, button: 0, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 700, pointerId: 1 });
    expect(screen.getByTestId('width')).toHaveTextContent('900');
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(divider, { clientX: 700, pointerId: 1 });
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Moving after the drag ended does nothing.
    fireEvent.pointerMove(divider, { clientX: 100, pointerId: 1 });
    expect(screen.getByTestId('width')).toHaveTextContent('900');
  });

  test('a double-click resets the width', () => {
    const onReset = jest.fn();
    render(<Harness onReset={onReset} />);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
