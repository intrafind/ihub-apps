// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InstallationSkillsPanel from '../../../client/src/features/admin/components/integrations/InstallationSkillsPanel';
import {
  approveInstallationSkill,
  fetchInstallationSkillFile,
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
  fetchInstallationSkillFile: jest.fn(async (_id, _name, path) => ({
    path,
    size: 9,
    text: 'FILE TEXT'
  })),
  approveInstallationSkill: jest.fn(async () => ({})),
  revokeInstallationSkill: jest.fn(async () => {})
}));

const ITEMS = [
  {
    name: 'deploy',
    description: 'Deploy safely',
    uri: 'skill://deploy/SKILL.md',
    digest: 'sha256:deploy',
    status: 'available',
    files: [{ path: 'SKILL.md', size: 100 }],
    size: 100
  },
  {
    name: 'report',
    description: 'Monthly report',
    uri: 'skill://report/SKILL.md',
    digest: 'sha256:report',
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
  fetchInstallationSkillFile
    .mockReset()
    .mockImplementation(async (_id, _name, path) => ({ path, size: 9, text: 'FILE TEXT' }));
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
    await waitFor(() =>
      expect(approveInstallationSkill).toHaveBeenCalledWith('billing', 'deploy', 'sha256:deploy')
    );
    await waitFor(() => expect(fetchInstallationSkills).toHaveBeenCalledTimes(2));
  });

  it('lists the files and opens one read-only before approving', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'SKILL.md' }));
    await waitFor(() =>
      expect(fetchInstallationSkillFile).toHaveBeenCalledWith(
        'billing',
        'deploy',
        'SKILL.md',
        ITEMS[0].digest
      )
    );
    expect(await screen.findByText('FILE TEXT')).toBeInTheDocument();
  });

  it('reloads and asks for a new review when the server changed the skill meanwhile', async () => {
    approveInstallationSkill.mockRejectedValueOnce({
      response: { data: { code: 'SKILL_LISTING_CHANGED', detail: 'changed' } }
    });
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Review it again/);
    expect(fetchInstallationSkills).toHaveBeenCalledTimes(2);
  });

  it('shows the file opened last, whichever read answers first', async () => {
    const answers = {};
    fetchInstallationSkillFile.mockImplementation(
      (_id, _name, path) => new Promise(resolve => (answers[path] = resolve))
    );
    fetchInstallationSkills.mockResolvedValue({
      items: [
        {
          ...ITEMS[0],
          files: [
            { path: 'SKILL.md', size: 1 },
            { path: 'references/A.md', size: 1 }
          ]
        }
      ]
    });
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'SKILL.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'references/A.md' }));
    answers['references/A.md']({ path: 'references/A.md', size: 1, text: 'TEXT OF A' });
    expect(await screen.findByText('TEXT OF A')).toBeInTheDocument();
    // The superseded read answers last: it is not shown.
    await act(async () => {
      answers['SKILL.md']({ path: 'SKILL.md', size: 1, text: 'TEXT OF SKILL' });
    });
    expect(screen.queryByText('TEXT OF SKILL')).not.toBeInTheDocument();
    expect(screen.getByText('TEXT OF A')).toBeInTheDocument();
  });

  it('drops an open preview once the server changed the skill', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'SKILL.md' }));
    expect(await screen.findByText('FILE TEXT')).toBeInTheDocument();
    // The approval finds the skill changed; the list reloads with a new digest.
    fetchInstallationSkills.mockResolvedValueOnce({
      items: [{ ...ITEMS[0], digest: 'sha256:deploy-2' }, ITEMS[1], ITEMS[2]]
    });
    approveInstallationSkill.mockRejectedValueOnce({
      response: { data: { code: 'SKILL_LISTING_CHANGED', detail: 'changed' } }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Review it again/);
    expect(screen.queryByText('FILE TEXT')).not.toBeInTheDocument();
  });

  it('reloads instead of showing a file of a skill the server changed since', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fetchInstallationSkills.mockResolvedValueOnce({
      items: [{ ...ITEMS[0], digest: 'sha256:deploy-2' }, ITEMS[1], ITEMS[2]]
    });
    fetchInstallationSkillFile.mockRejectedValueOnce({
      response: { data: { code: 'SKILL_LISTING_CHANGED', detail: 'changed' } }
    });
    fireEvent.click(await screen.findByRole('button', { name: 'SKILL.md' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Review it again/);
    expect(fetchInstallationSkills).toHaveBeenCalledTimes(2);
    // The list shows the new version, with no file of either version open.
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('withdraws an approval', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw approval' }));
    await waitFor(() => expect(revokeInstallationSkill).toHaveBeenCalledWith('billing', 'report'));
  });

  it('shows the listing loaded last, whichever reload answers first', async () => {
    render(<InstallationSkillsPanel instanceId="billing" />);
    expect(await screen.findByRole('button', { name: 'Withdraw approval' })).toBeInTheDocument();
    const answers = [];
    fetchInstallationSkills.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    // A refused file read reloads the listing, then a withdrawal reloads it again.
    fetchInstallationSkillFile.mockRejectedValueOnce({
      response: { data: { code: 'SKILL_LISTING_CHANGED', detail: 'changed' } }
    });
    fireEvent.click(screen.getByRole('button', { name: 'SKILL.md' }));
    await waitFor(() => expect(answers).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw approval' }));
    await waitFor(() => expect(answers).toHaveLength(2));
    const withdrawn = { ...ITEMS[1], status: 'available', approvedAt: undefined };
    await act(async () => answers[1]({ items: [ITEMS[0], withdrawn, ITEMS[2]] }));
    expect(screen.queryByRole('button', { name: 'Withdraw approval' })).not.toBeInTheDocument();
    // The reload started first answers last, with the listing before the withdrawal.
    await act(async () => answers[0]({ items: ITEMS }));
    expect(screen.queryByRole('button', { name: 'Withdraw approval' })).not.toBeInTheDocument();
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
