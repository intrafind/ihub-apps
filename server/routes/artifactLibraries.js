// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Library kit for HTML artifacts (#3822): what the kit contains, and the
 * source of one library for the client to inline into a preview or a
 * download.
 *
 *   GET /api/artifact-libraries                      the kit
 *   GET /api/artifact-libraries/:libraryId/source    one library's source, as text
 *
 * Both are readable without signing in, on purpose: a public chat share is
 * opened by people who are not signed in, and its preview needs the
 * libraries. They are open-source files that ship with iHub and say nothing
 * about the installation. The id is matched exactly against the kit's
 * manifest (`shared/artifactLibraries.js`) and never becomes a path.
 *
 * The source goes out as `text/plain` with `nosniff`: the client reads it as
 * text and inlines it into the sandboxed preview, and nothing on the iHub
 * origin is meant to load it as a script.
 *
 * @module routes/artifactLibraries
 */
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { artifactPolicy } from '../services/artifacts/artifactPolicy.js';
import { authOptional } from '../middleware/authRequired.js';
import {
  artifactLibraryList,
  artifactLibrarySource,
  warmArtifactLibraries
} from '../services/artifacts/artifactLibraryKit.js';
import { artifactLibraryById } from '../../shared/artifactLibraries.js';

/**
 * Register the library kit routes.
 *
 * @param {import('express').Application} app
 * @returns {void}
 */
export default function registerArtifactLibraryRoutes(app) {
  warmArtifactLibraries();
  /**
   * @swagger
   * /api/artifact-libraries:
   *   get:
   *     summary: The library kit for HTML artifacts
   *     description: >-
   *       The vetted browser libraries iHub ships for HTML artifacts. An artifact asks for
   *       one with `<script data-ihub-lib="chart.js"></script>`, and iHub inlines it in the
   *       preview, the share embed page and every download. Readable without signing in.
   *       `available` is false when the server could not read or verify the file.
   *     tags:
   *       - Artifacts
   *     security: []
   *     responses:
   *       200:
   *         description: The kit
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled:
   *                   type: boolean
   *                   description: Whether the admin turned the kit on (artifacts.libraryKit.enabled)
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, example: chart.js }
   *                       name: { type: string, example: Chart.js }
   *                       version: { type: string, example: 4.5.1 }
   *                       global: { type: string, example: Chart }
   *                       use: { type: string }
   *                       license: { type: string, example: MIT }
   *                       homepage: { type: string }
   *                       bytes: { type: integer }
   *                       sha256: { type: string }
   *                       available: { type: boolean }
   */
  app.get(buildServerPath('/api/artifact-libraries'), authOptional, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ enabled: artifactPolicy().libraryKit.enabled, items: artifactLibraryList() });
  });

  /**
   * @swagger
   * /api/artifact-libraries/{libraryId}/source:
   *   get:
   *     summary: The source of one kit library
   *     description: >-
   *       The library's built file, unchanged from its npm package and checked against the
   *       kit's recorded SHA-256, as text. Readable without signing in. 404 for a name that
   *       is not in the kit, and for every name while the admin has the kit switched off.
   *     tags:
   *       - Artifacts
   *     security: []
   *     parameters:
   *       - in: path
   *         name: libraryId
   *         required: true
   *         schema: { type: string, example: chart.js }
   *     responses:
   *       200:
   *         description: The library source
   *         content:
   *           text/plain:
   *             schema: { type: string }
   *       404:
   *         description: Not in the kit, or the kit is off (`NOT_FOUND`)
   */
  app.get(
    buildServerPath('/api/artifact-libraries/:libraryId/source'),
    authOptional,
    (req, res) => {
      const library = artifactLibraryById(req.params.libraryId);
      if (!library || !artifactPolicy().libraryKit.enabled) {
        throw new ServiceError('NOT_FOUND', 'Library not found');
      }
      const source = artifactLibrarySource(library.id);
      if (source === null) throw new ServiceError('NOT_FOUND', 'Library not found');
      const etag = `"${library.sha256}"`;
      res.setHeader('ETag', etag);
      // Revalidated on every use (a 304 while the ETag matches): an admin who
      // switches the kit off, and an update that changes a library, take effect
      // at once.
      res.setHeader('Cache-Control', 'public, no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(source);
    }
  );
}
