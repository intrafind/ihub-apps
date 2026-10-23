// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Projects card of the app editor: the two switches (absent means on, so
 * switching back on drops the key) and the linked projects, which stay on
 * screen, disabled, while projects are off.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/features/admin/components/ProjectPicker', () => ({
  __esModule: true,
  default: () => <input aria-label="Search projects" />
}));

const ProjectsConfigSection =
  require('../../../client/src/features/admin/components/app-form/ProjectsConfigSection').default;

const t = (key, fallback) => fallback;

function renderSection(app) {
  const onChange = jest.fn();
  render(<ProjectsConfigSection app={app} onChange={onChange} t={t} />);
  return onChange;
}

test('both switches are on by default', () => {
  renderSection({ id: 'chat' });
  expect(screen.getByLabelText('Use projects in this app')).toBeChecked();
  expect(screen.getByLabelText('Allow personal projects')).toBeChecked();
  expect(screen.getByLabelText('Search projects')).toBeEnabled();
});

test('switching off writes false, switching back on removes the key', () => {
  let onChange = renderSection({ id: 'chat', features: { magicPrompt: { enabled: true } } });
  fireEvent.click(screen.getByLabelText('Use projects in this app'));
  expect(onChange).toHaveBeenCalledWith({
    id: 'chat',
    features: { magicPrompt: { enabled: true }, projects: false }
  });

  document.body.innerHTML = '';
  onChange = renderSection({ id: 'chat', features: { projects: false, feedback: false } });
  fireEvent.click(screen.getByLabelText('Use projects in this app'));
  expect(onChange).toHaveBeenCalledWith({ id: 'chat', features: { feedback: false } });
});

test('with projects off, personal projects and the links are disabled but kept on screen', () => {
  renderSection({ id: 'chat', projects: ['faq'], features: { projects: false } });
  expect(screen.getByLabelText('Allow personal projects')).toBeDisabled();
  expect(screen.getByLabelText('Allow personal projects')).not.toBeChecked();
  expect(screen.getByLabelText('Search projects')).toBeDisabled();
});
