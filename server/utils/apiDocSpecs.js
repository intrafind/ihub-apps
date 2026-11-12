// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The three OpenAPI documents served under `/api/docs` — what they are built
 * from, how they are built, and where a build puts them.
 *
 * The documents are a function of the route files alone, so they are the same
 * on every boot and in every worker. Building them is not free: `swagger-jsdoc`
 * globs and parses the JSDoc/YAML of every route file, about 70 MB of
 * transient heap and a quarter of a second per document set (#3624). They were
 * built at boot in every process; now the production build writes them to
 * {@link GENERATED_API_DOCS_DIR} (`scripts/build-api-docs.js`) and the server
 * reads those files on the first `/api/docs` request. Without the files — in
 * development, or a build that skipped the step — that first request builds
 * them instead, once per process. `swagger-jsdoc` is only ever imported here,
 * on that path.
 *
 * @module utils/apiDocSpecs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory holding the route files the documents are built from. */
export const ROUTES_DIR = path.join(serverDir, 'routes');

/** Where a production build writes the documents, one `<name>.json` each. */
export const GENERATED_API_DOCS_DIR = path.join(serverDir, 'generated', 'openapi');

/**
 * The three documents: their titles and descriptions. The order is the order
 * the Swagger UI lists them in.
 *
 * @type {Readonly<Record<'normal'|'admin'|'openai', {title: string, description: string}>>}
 */
export const API_DOC_SETS = Object.freeze({
  normal: Object.freeze({
    title: 'iHub Apps - Chat & General APIs',
    description:
      'APIs for chat functionality, models, tools, sessions, and general application features'
  }),
  admin: Object.freeze({
    title: 'iHub Apps - Admin APIs',
    description:
      'Administrative APIs for managing configurations, users, groups, and system settings'
  }),
  openai: Object.freeze({
    title: 'iHub Apps - OpenAI Compatible APIs',
    description:
      'OpenAI-compatible inference APIs: chat completions, responses, conversations and model listings, for models and iHub apps'
  })
});

/**
 * The route files each API document is built from, as glob patterns.
 *
 * swagger-jsdoc expands `apis` with glob, which takes `/` only: a Windows `\`
 * reads as an escape character, so a pattern built with `path.join` matches
 * nothing there and /api/docs comes up empty. Build the patterns with `/`.
 *
 * @param {string} routesDir - Absolute path of `server/routes`, in the platform's own form
 * @param {string} [sep] - The separator used in `routesDir` (defaults to the platform's)
 * @returns {{normal: string[], admin: string[], openai: string[]}}
 */
export function apiDocGlobs(routesDir, sep = path.sep) {
  const base = routesDir.split(sep).join('/');
  const at = rel => path.posix.join(base, rel);
  return {
    normal: [
      'generalRoutes.js',
      'modelRoutes.js',
      'appSessionRoutes.js',
      'pageRoutes.js',
      'magicPromptRoutes.js',
      'shortLinkRoutes.js',
      'auth.js',
      'scheduledTasks.js',
      'chat/**/*.js',
      'chats.js',
      'integrations/*.js',
      'oauth.js',
      'oauthRegister.js',
      'projectRoutes.js',
      'promptRoutes.js',
      'runs.js',
      'usageRoutes.js',
      'userSkillRoutes.js',
      'wellKnown.js',
      'workflow/*.js'
    ].map(at),
    admin: ['adminRoutes.js', 'admin/**/*.js'].map(at),
    openai: ['openaiProxy.js', 'inference/*.js'].map(at)
  };
}

/**
 * The `swagger-jsdoc` options for one document.
 *
 * `servers` names the API root without the installation's base path: the base
 * path is runtime configuration, so the server puts the real one in when it
 * serves the document ({@link withServerUrl}).
 *
 * @param {{title: string, description: string}} set - Title and description
 * @param {string[]} apis - Route file globs
 * @param {boolean} failOnErrors - Throw on a malformed `@swagger` block
 * @returns {Object}
 */
function swaggerOptions(set, apis, failOnErrors) {
  return {
    definition: {
      openapi: '3.0.0',
      info: {
        title: set.title,
        description: set.description,
        version: '1.0.0',
        contact: {
          name: 'iHub Apps',
          url: 'https://github.com/intrafind/ihub-apps'
        }
      },
      servers: [{ url: '/api', description: 'API Server' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          },
          sessionAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'connect.sid'
          }
        }
      },
      security: [{ bearerAuth: [] }, { sessionAuth: [] }]
    },
    apis,
    failOnErrors
  };
}

/**
 * Build the three documents from the route files.
 *
 * @param {Object} [options]
 * @param {string} [options.routesDir] - Route directory; `server/routes` by default
 * @param {boolean} [options.failOnErrors=false] - Throw on a malformed
 *   `@swagger` block instead of leaving its endpoint out. The build sets it, so
 *   a broken block fails the build the way it fails `api-docs-parse.test.js`.
 * @returns {Promise<{normal: Object, admin: Object, openai: Object}>}
 */
export async function buildApiDocSpecs({ routesDir = ROUTES_DIR, failOnErrors = false } = {}) {
  const { default: swaggerJSDoc } = await import('swagger-jsdoc');
  const globs = apiDocGlobs(routesDir);
  const specs = {};
  for (const [name, set] of Object.entries(API_DOC_SETS)) {
    specs[name] = swaggerJSDoc(swaggerOptions(set, globs[name], failOnErrors));
  }
  return specs;
}

/**
 * Write the documents a build produced.
 *
 * @param {{normal: Object, admin: Object, openai: Object}} specs - Built documents
 * @param {string} [dir] - Target directory; {@link GENERATED_API_DOCS_DIR} by default
 * @returns {Promise<string[]>} Paths written
 */
export async function writeApiDocSpecs(specs, dir = GENERATED_API_DOCS_DIR) {
  await fs.mkdir(dir, { recursive: true });
  const written = [];
  for (const name of Object.keys(API_DOC_SETS)) {
    const file = path.join(dir, `${name}.json`);
    await fs.writeFile(file, `${JSON.stringify(specs[name])}\n`, 'utf8');
    written.push(file);
  }
  return written;
}

/**
 * Read the documents a build wrote.
 *
 * @param {string} [dir] - Directory; {@link GENERATED_API_DOCS_DIR} by default
 * @returns {Promise<{normal: Object, admin: Object, openai: Object}|null>} The
 *   documents, or null when any of them is missing — the caller then builds them.
 * @throws {Error} When a file is present but not JSON (a broken build must not
 *   be papered over by a silent rebuild).
 */
export async function readApiDocSpecs(dir = GENERATED_API_DOCS_DIR) {
  const specs = {};
  for (const name of Object.keys(API_DOC_SETS)) {
    let text;
    try {
      text = await fs.readFile(path.join(dir, `${name}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    specs[name] = JSON.parse(text);
  }
  return specs;
}

/**
 * A document with the installation's own API root in `servers`.
 *
 * @param {Object} spec - Built document
 * @param {string} apiUrl - The API root, base path included (`buildServerPath('/api')`)
 * @returns {Object} A copy with `servers` replaced
 */
export function withServerUrl(spec, apiUrl) {
  return { ...spec, servers: [{ url: apiUrl, description: 'API Server' }] };
}
