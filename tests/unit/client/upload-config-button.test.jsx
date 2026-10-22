import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * UploadConfigButton — one labelled, keyboard-operable control that opens the
 * file picker. The native input behind it is hidden from Tab and the
 * accessibility tree (an invisible input laid over a button is focusable with
 * no name and no visible focus ring).
 */
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const UploadConfigButton =
  require('../../../client/src/features/admin/components/UploadConfigButton').default;

function setup(props = {}) {
  const onChange = jest.fn();
  const { container } = render(
    <UploadConfigButton
      onChange={onChange}
      label="Upload Config"
      uploadingLabel="Uploading..."
      title="Upload App Config"
      {...props}
    />
  );
  return { onChange, input: container.querySelector('input[type="file"]') };
}

describe('UploadConfigButton', () => {
  it('opens the file picker when the button is activated', () => {
    const { input } = setup();
    const click = jest.spyOn(input, 'click').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: 'Upload Config' }));

    expect(click).toHaveBeenCalledTimes(1);
  });

  it('keeps the file input out of the tab order and the accessibility tree', () => {
    const { input } = setup();

    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('accept', '.json');
  });

  it('forwards the selected file to onChange', () => {
    const { input, onChange } = setup();

    fireEvent.change(input, { target: { files: [new File(['{}'], 'a.json')] } });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the uploading label and disables the control while uploading', () => {
    const { input } = setup({ uploading: true });

    expect(screen.getByRole('button', { name: 'Uploading...' })).toBeDisabled();
    expect(input).toBeDisabled();
  });
});
