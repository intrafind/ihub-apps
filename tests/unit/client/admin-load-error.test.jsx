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

  it('defaults the title to "Error"', () => {
    render(<AdminLoadError message="boom" />);

    expect(screen.getByRole('heading', { name: 'Error' })).toBeInTheDocument();
  });

  it('offers a custom action instead of Retry', () => {
    const onClick = jest.fn();

    render(<AdminLoadError message="boom" action={{ label: 'Back to Prompts', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Prompts' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows no button when action is null', () => {
    render(<AdminLoadError message="boom" action={null} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows Retry by default', () => {
    render(<AdminLoadError message="boom" />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('wraps the panel in the admin page container unless told not to', () => {
    const { container, rerender } = render(<AdminLoadError title="t" message="m" />);
    expect(container.firstChild).toHaveClass('max-w-7xl');

    rerender(<AdminLoadError title="t" message="m" framed={false} />);
    expect(container.firstChild).toBe(screen.getByRole('alert'));
  });
});
