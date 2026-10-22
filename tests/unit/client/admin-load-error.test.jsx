import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * AdminLoadError — the panel admin list pages show when their data failed to load.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, defaultValue) => defaultValue, i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const AdminLoadError =
  require('../../../client/src/features/admin/components/AdminLoadError').default;

describe('AdminLoadError', () => {
  it('announces the title and the error message as an alert', () => {
    render(<AdminLoadError title="Error loading tools" message="Request failed (500)" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Error loading tools');
    expect(alert).toHaveTextContent('Request failed (500)');
  });

  it('calls onRetry from the Retry button', () => {
    const onRetry = jest.fn();

    render(<AdminLoadError title="Error loading tools" message="boom" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('wraps the panel in the admin page container unless told not to', () => {
    const { container, rerender } = render(<AdminLoadError title="t" message="m" />);
    expect(container.firstChild).toHaveClass('max-w-7xl');

    rerender(<AdminLoadError title="t" message="m" framed={false} />);
    expect(container.firstChild).toBe(screen.getByRole('alert'));
  });
});
