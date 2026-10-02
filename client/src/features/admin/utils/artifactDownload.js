/**
 * Artifact download helpers — fetch an agent run's artifact and save it in
 * the format the operator picked.
 *
 * The artifact text is fetched through an authenticated request (a native
 * `<a download>` cannot cross origins in dev, :5173 → :3000), then handed to
 * the server-side export (`POST /api/exports`, `source: 'artifact'`), which
 * renders the file, adds the AI label and signs it (EU AI Act Art. 50(2),
 * issues #2571/#2576). There is no browser-side conversion or print dialog.
 */

import { exportMarkdownDocument } from '../../../shared/utils/markdownExports';

/**
 * Fetch the artifact's raw text via authenticated request.
 *
 * @param {string} runId
 * @param {string} artifactName
 * @returns {Promise<string>}
 */
export async function fetchArtifactText(runId, artifactName) {
  const url =
    `/api/agents/runs/${encodeURIComponent(runId)}` +
    `/artifacts/${encodeURIComponent(artifactName)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Artifact fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Fetch an artifact and save it through the server-side export.
 *
 * @param {string} runId - Agent run id
 * @param {string} artifactName - Artifact name (e.g. `report.md`), also the document title
 * @param {'markdown'|'html'|'pdf'|'docx'} format - Download format
 * @returns {Promise<{filename: string, manifestId: (string|null)}>}
 * @throws {Error} When the artifact cannot be fetched or the export fails
 */
export async function downloadArtifactAs(runId, artifactName, format) {
  const text = await fetchArtifactText(runId, artifactName);
  return exportMarkdownDocument({
    content: text,
    name: artifactName,
    format,
    source: 'artifact'
  });
}
