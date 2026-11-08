// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { buildServerPath } from './basePath.js';

/**
 * Answer `201 Created` with the new resource and its `Location` (docs/api-guidelines.md).
 *
 * @param {import('express').Response} res
 * @param {string} path - Server path of the new resource, without the base path
 *   (`/api/admin/apps/${id}`); each id segment is encoded here.
 * @param {*} body - The created resource
 */
export function sendCreated(res, path, body) {
  res.status(201).setHeader('Location', buildServerPath(path));
  return res.json(body);
}

/**
 * Answer with `status` and, when it is `201` or `202`, the `Location` of the new resource (or of
 * the job that will make it). For a call that answers `201` or `202` depending on the outcome.
 */
export function sendWithLocation(res, status, path, body) {
  res.status(status);
  if (status === 201 || status === 202) res.setHeader('Location', buildServerPath(path));
  return res.json(body);
}

/** One path segment, safe to put into a `Location`. */
export const segment = value => encodeURIComponent(String(value));
