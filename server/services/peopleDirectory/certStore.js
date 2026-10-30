// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { X509Certificate } from 'node:crypto';
import configStore from '../config/ConfigStore.js';
import { CERTIFICATE_NAME_PATTERN } from '../../validators/peopleDirectorySchema.js';

/**
 * Trust anchors for directories whose CA is in no public trust store: PEM files
 * in `contents/config/certs/<name>.pem`, named by a directory's `tlsCa`. Only
 * those anchors are then trusted for that directory, and verification stays on.
 *
 * There is no upload: an admin puts the file there, or installs the CA in the
 * operating system's store (or `NODE_EXTRA_CA_CERTS`) like for every other
 * outbound connection. iHub ships one anchor, the Verwaltungs-PKI root that
 * x500.bund.de chains to.
 */

export const CERT_DIR = 'config/certs';

/**
 * The PEM of each named trust anchor, for `tlsOptions.ca`. A missing or
 * unreadable anchor fails the connection instead of quietly trusting less.
 *
 * @param {string[]} names - `tlsCa` of a directory
 * @returns {Promise<string[]>}
 * @throws {Error} With `code: 'trust_anchor_missing'`
 */
export async function loadTrustAnchors(names = []) {
  const anchors = [];
  for (const name of names) {
    let pem = null;
    try {
      if (CERTIFICATE_NAME_PATTERN.test(name)) {
        pem = await configStore.readText(`${CERT_DIR}/${name}.pem`);
        if (pem) new X509Certificate(pem);
      }
    } catch {
      pem = null;
    }
    if (!pem) {
      const error = new Error(
        `Trust anchor "${name}" is not in contents/${CERT_DIR}/${name}.pem or is not a valid PEM certificate.`
      );
      error.code = 'trust_anchor_missing';
      throw error;
    }
    anchors.push(pem);
  }
  return anchors;
}
