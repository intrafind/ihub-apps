// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InstallationSkillsPanel from '../../../client/src/features/admin/components/integrations/InstallationSkillsPanel';
import {
  approveInstallationSkill,
  fetchInstallationSkills,
  revokeInstallationSkill
} from '../../../client/src/api/integrationsAdminApi';

/**
 * The Skills tab of an MCP installation: the server's skills with their
 * approval, approved and withdrawn one by one.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: () => <div>loading</div>
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  __esModule: true,
  fetchInstallationSkills: jest.fn(),
  approveInstallationSkill: jest.fn(async () => ({})),
  revokeInstallationSkill: jest.fn(async () => {})
}));

const ITEMS = [
  {
    name: 'deploy',
    description: 'Deploy safely',
    uri: 'skill://deploy/SKILL.md',
    status: 'available',
    files: [{ path: 'SKILL.md', size: 100 }],
    size: 100
  },
  {
    name: 'report',
    description: 'Monthly report',
    uri: 'skill://report/SKILL.md',
    status: 'changed',
    files: [],
    size: 0,
    approvedAt: '2026-11-26T10:00:00.000Z'
  },
  {
    name: 'archive',
    description: '',
    uri: 'skill://archive/SKILL.md',
    status: 'not_approvable',
    reason: 'dynamic'
  }
];

beforeEach(() => {
  fetchInstallationSkills.mockReset().mockResolvedValue({ items: ITEMS });
  approveInstallationSkill.mockClear();
  revokeInstallationSkill.mockClear();
});

describe('the Skills tab', () => {
  it('lists the skills with their status and what can be done', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    expect(await screen.findByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('Not approved')).toBeInTheDocument();
    expect(screen.getByText('Changed on the server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw approval' })).toBeInTheDocument();
    expect(screen.getByText(/does not list this skill’s files/)).toBeInTheDocument();
  });

  it('approves a skill and lists anew', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveInstallationSkill).toHaveBeenCalledWith('billing', 'deploy'));
    await waitFor(() => expect(fetchInstallationSkills).toHaveBeenCalledTimes(2));
  });

  it('withdraws an approval', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw approval' }));
    await waitFor(() => expect(revokeInstallationSkill).toHaveBeenCalledWith('billing', 'report'));
  });

  it('says so when the server offers no skills, or the admin must connect first', async () => {
    fetchInstallationSkills.mockRejectedValueOnce({
      response: { data: { code: 'SKILLS_NOT_SUPPORTED', detail: 'x' } }
    });
    const { unmount } = render(<InstallationSkillsPanel instanceId="billing" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This server offers no skills.');
    unmount();
    fetchInstallationSkills.mockRejectedValueOnce({
      response: { data: { code: 'INTEGRATION_AUTH_REQUIRED', detail: 'x' } }
    });
    render(<InstallationSkillsPanel instanceId="billing" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Connect your own account/);
  });
});
