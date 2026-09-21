import net from 'net';
import tls from 'tls';
import { authenticateResult, AUTH_RESULT_SUCCESS } from 'ldap-authentication';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import configCache from '../../configCache.js';
import credentialService from '../../services/CredentialService.js';
import {
  getPermissionsForUser,
  loadGroupMapping,
  mapExternalGroups,
  getAuthenticatedGroup
} from '../../utils/authorization.js';
import {
  buildLdapAuthOptions,
  describeLdapProvider,
  extractGroupNames,
  mapLdapUserAttributes
} from '../../utils/ldapProviderConfig.js';
import { DiagnosticsReport, STATUS } from '../../services/integrations/integrationDiagnostics.js';
import logger from '../../utils/logger.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';

/**
 * Admin route that dry-runs an LDAP login.
 *
 * Configuring LDAP used to be guesswork: an admin filled in half a dozen DNs,
 * saved, and then found out from a user that the login failed — with no way to
 * see whether the bind account worked, whether the user was found at all, which
 * attributes came back, or which internal groups the directory groups mapped
 * to. This endpoint answers exactly those questions, step by step, and changes
 * nothing: no user is persisted, no session is created and no token is issued.
 *
 * The provider can be named (`providerName`, a saved provider) or passed inline
 * (`provider`), so an admin can test the form before saving it. Inline
 * configuration grants no extra reach: a caller who passes `adminAuth` can
 * already write the same values to `platform.json` through the admin API.
 */

/** Attributes never echoed back, whatever the directory returns for them. */
const SECRET_ATTRIBUTES = new Set([
  'userpassword',
  'unicodepwd',
  'password',
  'ntpassword',
  'lmpassword',
  'sambantpassword',
  'sambalmpassword',
  'krbprincipalkey'
]);

/** Attributes that are large binary blobs and only add noise to the report. */
const BULKY_ATTRIBUTES = new Set([
  'jpegphoto',
  'thumbnailphoto',
  'thumbnaillogo',
  'usercertificate',
  'objectsid',
  'objectguid',
  'msexchmailboxsecuritydescriptor',
  'msexchsafesendershash'
]);

const MAX_ATTRIBUTE_LENGTH = 300;
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Reduce a raw LDAP entry to something safe and readable for the report:
 * secrets removed, binary blobs summarized, long values truncated.
 * @param {Object} entry - Raw LDAP entry
 * @returns {Object} Display-safe copy
 */
function presentableAttributes(entry) {
  const output = {};
  for (const [key, rawValue] of Object.entries(entry || {})) {
    // `groups` is reported separately by its own step.
    if (key === 'groups') continue;

    const lowerKey = key.toLowerCase();
    if (SECRET_ATTRIBUTES.has(lowerKey)) {
      output[key] = '[redacted]';
      continue;
    }
    if (BULKY_ATTRIBUTES.has(lowerKey) || Buffer.isBuffer(rawValue)) {
      const size = Buffer.isBuffer(rawValue) ? rawValue.length : String(rawValue).length;
      output[key] = `[binary, ${size} bytes]`;
      continue;
    }

    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(value => {
      const asString = typeof value === 'string' ? value : String(value);
      return asString.length > MAX_ATTRIBUTE_LENGTH
        ? `${asString.slice(0, MAX_ATTRIBUTE_LENGTH)}… (${asString.length} chars)`
        : asString;
    });
    output[key] = values.length === 1 ? values[0] : values;
  }
  return output;
}

/**
 * Parse an LDAP URL into the pieces the connectivity probe needs.
 * @param {string} rawUrl - Configured LDAP URL
 * @returns {{hostname: string, port: number, secure: boolean}}
 * @throws {Error} When the URL is not a usable ldap:// or ldaps:// URL
 */
function parseLdapUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error(
      `"${rawUrl}" is not a valid URL. Expected ldap://host:389 or ldaps://host:636.`
    );
  }

  if (url.protocol !== 'ldap:' && url.protocol !== 'ldaps:') {
    throw new Error(
      `Unsupported protocol "${url.protocol}". Use ldap:// (port 389) or ldaps:// (port 636).`
    );
  }

  const secure = url.protocol === 'ldaps:';
  return {
    hostname: url.hostname,
    port: Number(url.port) || (secure ? 636 : 389),
    secure
  };
}

/**
 * Open a TCP (or TLS) connection to the directory, so an unreachable host or a
 * rejected certificate is reported as itself instead of as "authentication
 * failed".
 *
 * @param {{hostname: string, port: number, secure: boolean}} target
 * @param {Object} [tlsOptions] - Provider TLS options; `rejectUnauthorized:
 *   false` is honoured here so the probe agrees with what the login path does.
 * @returns {Promise<Object>} Probe outcome
 */
function probeLdapEndpoint({ hostname, port, secure }, tlsOptions = {}) {
  const startedAt = Date.now();

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // socket already gone
      }
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const socket = secure
      ? tls.connect({
          host: hostname,
          port,
          // RFC 6066 forbids an IP address as the SNI server name.
          ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
          rejectUnauthorized: tlsOptions?.rejectUnauthorized !== false
        })
      : net.connect({ host: hostname, port });

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('timeout', () =>
      finish({
        connected: false,
        error: `Connection to ${hostname}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`,
        code: 'ETIMEDOUT'
      })
    );
    socket.on('error', error =>
      finish({ connected: false, error: error.message, code: error.code })
    );

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      if (!secure) {
        finish({ connected: true, remoteAddress: socket.remoteAddress });
        return;
      }
      const cert = socket.getPeerCertificate() || {};
      finish({
        connected: true,
        remoteAddress: socket.remoteAddress,
        certificateAuthorized: socket.authorized,
        certificateError: socket.authorizationError ? String(socket.authorizationError) : undefined,
        certificateSubject: cert.subject?.CN,
        certificateIssuer: cert.issuer?.CN,
        certificateValidTo: cert.valid_to
      });
    });
  });
}

/**
 * Turn an LDAP error into a message plus what the admin should check.
 * @param {Error} error
 * @returns {{message: string, hints: string[]}}
 */
function describeLdapError(error) {
  const message = error?.message || String(error);
  const hints = [];
  const lower = message.toLowerCase();

  if (error?.code === 'ENOTFOUND' || lower.includes('getaddrinfo')) {
    hints.push('The host name in the LDAP URL does not resolve from this server.');
  }
  if (error?.code === 'ECONNREFUSED') {
    hints.push('Nothing is listening on that port — check the port (389 plain, 636 ldaps).');
  }
  if (
    lower.includes('certificate') ||
    lower.includes('self-signed') ||
    lower.includes('self signed')
  ) {
    hints.push(
      'The TLS certificate was rejected. For a private or internal CA, enable "Allow self-signed / internal CA certificates" on this provider.'
    );
  }
  if (lower.includes('invalid credentials') || lower.includes('49')) {
    hints.push('The directory rejected the credentials (LDAP result 49).');
  }
  if (lower.includes('no such object') || lower.includes('32')) {
    hints.push('A search base does not exist in this directory — check the base DN.');
  }
  if (lower.includes('size limit') || lower.includes('time limit')) {
    hints.push('The directory cut the search short. Narrow the search base.');
  }
  return { message, hints };
}

/**
 * Locate the provider to test: either a saved one by name, or the inline draft
 * the admin is editing.
 * @param {Object} body - Request body
 * @returns {Object} Raw provider config
 * @throws {Error} When no provider can be determined
 */
function selectProvider(body) {
  if (body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider)) {
    return body.provider;
  }

  const name = typeof body.providerName === 'string' ? body.providerName.trim() : '';
  if (!name) {
    throw new Error('Either "provider" (inline configuration) or "providerName" is required');
  }

  const platform = configCache.getPlatform() || {};
  const providers = platform.ldapAuth?.providers || [];
  const match = providers.find(entry => entry.name === name);
  if (!match) {
    throw new Error(`No LDAP provider named "${name}" is configured`);
  }
  return match;
}

export default function registerAdminLdapTestRoutes(app) {
  /**
   * @swagger
   * /api/admin/auth/ldap/_test:
   *   post:
   *     summary: Dry-run an LDAP login
   *     description: |
   *       Runs the LDAP login path for one username without creating a session,
   *       persisting the user or issuing a token, and reports every step: the
   *       effective (derived) configuration, connectivity, the bind, the
   *       directory entry that was found, the attributes it maps to, the LDAP
   *       groups and the internal groups those map to.
   *
   *       Pass `provider` to test configuration that has not been saved yet, or
   *       `providerName` to test a saved provider. `password` is optional: with
   *       a bind account configured, the user can be looked up without it, and
   *       only the final "would this password be accepted" check is skipped.
   *     tags:
   *       - Admin
   *       - Authentication
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - username
   *             properties:
   *               username:
   *                 type: string
   *               password:
   *                 type: string
   *               providerName:
   *                 type: string
   *               provider:
   *                 type: object
   *     responses:
   *       200:
   *         description: The test ran; `success` reports the outcome
   *       400:
   *         description: Missing username or provider
   *       500:
   *         description: The test could not be run
   */
  app.post(buildServerPath('/api/admin/auth/ldap/_test'), adminAuth, async (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username) {
      return sendBadRequest(res, 'A username is required to test the LDAP configuration');
    }

    let provider;
    try {
      provider = selectProvider(body);
    } catch (error) {
      return sendBadRequest(res, error.message);
    }

    const report = new DiagnosticsReport();

    try {
      const { resolved, fields, problems, warnings } = describeLdapProvider(provider);

      // Step 1 — what the half-dozen fields actually resolve to.
      report.add({
        id: 'configuration',
        label: 'Effective configuration',
        status: problems.length > 0 ? STATUS.FAIL : warnings.length > 0 ? STATUS.WARN : STATUS.OK,
        message:
          problems.length > 0
            ? problems.join(' ')
            : `Directory preset "${resolved.preset}", users under ${resolved.userSearchBase}`,
        details: {
          url: resolved.url,
          baseDn: resolved.baseDn || null,
          bindDn: resolved.adminDn || null,
          // `explicit` = typed by the admin; anything else was derived here.
          values: Object.fromEntries(
            fields.map(field => [field.key, `${field.value ?? '—'}  (${field.source})`])
          )
        },
        hints: problems.length > 0 ? [...problems, ...warnings] : warnings
      });

      if (problems.length > 0) {
        return res.json({
          success: false,
          message: 'The provider configuration is incomplete.',
          summary: report.summary(),
          steps: report.steps
        });
      }

      // Step 2 — is the directory reachable at all from this server?
      let target;
      const connectivityStep = await report.run(
        'connectivity',
        'Connect to directory',
        async () => {
          target = parseLdapUrl(resolved.url);
          const probe = await probeLdapEndpoint(target, resolved.tlsOptions);
          if (!probe.connected) {
            return {
              status: STATUS.FAIL,
              message: probe.error,
              details: { host: target.hostname, port: target.port, tls: target.secure },
              hints: describeLdapError({ message: probe.error, code: probe.code }).hints
            };
          }
          const certificateProblem = target.secure && probe.certificateAuthorized === false;
          return {
            status: certificateProblem ? STATUS.WARN : STATUS.OK,
            message: certificateProblem
              ? `Connected to ${target.hostname}:${target.port}, but the certificate is not trusted: ${probe.certificateError}`
              : `Connected to ${target.hostname}:${target.port}`,
            details: { ...probe, host: target.hostname, port: target.port, tls: target.secure },
            hints: certificateProblem
              ? [
                  'The login path uses the same trust settings. Install the issuing CA on this server, or enable "Allow self-signed / internal CA certificates" on this provider.'
                ]
              : []
          };
        }
      );

      if (connectivityStep.status === STATUS.FAIL) {
        return res.json({
          success: false,
          message: 'The LDAP server could not be reached.',
          summary: report.summary(),
          steps: report.steps
        });
      }

      // Resolve the bind password up front, so a missing credential profile is
      // reported as a configuration problem and not as a failed bind.
      let adminPassword;
      if (resolved.adminDn) {
        try {
          adminPassword = credentialService.resolveSecret(resolved.adminPasswordRef);
        } catch (error) {
          report.add({
            id: 'bind-credential',
            label: 'Bind credential',
            status: STATUS.FAIL,
            message: error.message,
            hints: [
              `Check that the credential profile "${resolved.adminPasswordRef}" exists under Admin → Credentials.`
            ]
          });
          return res.json({
            success: false,
            message: 'The bind password could not be resolved.',
            summary: report.summary(),
            steps: report.steps
          });
        }
      }

      const useBindAccount = Boolean(resolved.adminDn && adminPassword);

      // Step 3 — find the user. With a bind account this needs no password, so
      // an admin can inspect any account's attributes and groups.
      let entry = null;
      let passwordVerified = null;

      if (useBindAccount) {
        const lookupStep = await report.run(
          'directory-lookup',
          'Bind and find the user',
          async () => {
            const result = await authenticateResult(
              buildLdapAuthOptions(resolved, {
                username,
                adminPassword,
                verifyUserExists: true
              })
            );
            if (result.code !== AUTH_RESULT_SUCCESS) {
              return {
                status: STATUS.FAIL,
                message: result.messages.join(' — '),
                details: {
                  bindDn: resolved.adminDn,
                  searchBase: resolved.userSearchBase,
                  filter: `(${resolved.usernameAttribute}=${username})`
                },
                hints: [
                  `No single entry matched (${resolved.usernameAttribute}=${username}) under ${resolved.userSearchBase}.`,
                  'Check the bind account, the user search base, and whether the username attribute matches this directory (uid for OpenLDAP, sAMAccountName for Active Directory).'
                ]
              };
            }
            entry = result.user;
            return {
              status: STATUS.OK,
              message: `Found ${entry.dn}`,
              details: {
                dn: entry.dn,
                searchBase: resolved.userSearchBase,
                filter: `(${resolved.usernameAttribute}=${username})`
              }
            };
          }
        );

        if (lookupStep.status === STATUS.FAIL) {
          return res.json({
            success: false,
            message: `The user "${username}" could not be found in the directory.`,
            summary: report.summary(),
            steps: report.steps
          });
        }
      } else {
        report.skip(
          'directory-lookup',
          'Bind and find the user',
          'No bind account is configured, so the user is looked up while binding as themselves — this needs the password below.'
        );
      }

      // Step 4 — would this password be accepted?
      if (password) {
        const loginStep = await report.run('login', 'Verify the password', async () => {
          const result = await authenticateResult(
            buildLdapAuthOptions(resolved, { username, password, adminPassword })
          );
          if (result.code !== AUTH_RESULT_SUCCESS) {
            passwordVerified = false;
            return {
              status: STATUS.FAIL,
              message: result.messages.join(' — '),
              details: { code: result.code, bindAccountUsed: useBindAccount },
              hints: useBindAccount
                ? ['The user was found, so this is the password itself being rejected.']
                : [
                    `Without a bind account the user is bound as "${resolved.userDn}". If that DN template does not match this directory, configure a bind account instead.`
                  ]
            };
          }
          passwordVerified = true;
          entry = result.user;
          return { status: STATUS.OK, message: 'The directory accepted these credentials' };
        });

        if (loginStep.status === STATUS.FAIL && !entry) {
          return res.json({
            success: false,
            message: 'The login was rejected by the directory.',
            summary: report.summary(),
            steps: report.steps
          });
        }
      } else {
        report.skip(
          'login',
          'Verify the password',
          'No password was supplied — everything except the password check was verified.'
        );
      }

      if (!entry) {
        return res.json({
          success: false,
          message: 'No directory entry was read, so there is nothing to map.',
          summary: report.summary(),
          steps: report.steps
        });
      }

      // Step 5 — the attributes, and which of them become the iHub user fields.
      const mapped = mapLdapUserAttributes(entry, resolved, username);
      report.add({
        id: 'attributes',
        label: 'Attributes read and mapped',
        status: mapped.email ? STATUS.OK : STATUS.WARN,
        message: mapped.email
          ? `id "${mapped.id}", name "${mapped.name}", email "${mapped.email}"`
          : `id "${mapped.id}", name "${mapped.name}" — no e-mail attribute had a value`,
        details: {
          mapping: Object.fromEntries(
            Object.entries(resolved.attributeMapping).map(([field, candidates]) => [
              field,
              `${candidates.join(' → ')}  (used: ${mapped.usedAttributes[field] || 'none, fell back to the login name'})`
            ])
          ),
          entry: presentableAttributes(entry)
        },
        hints: mapped.email
          ? []
          : [
              `None of ${resolved.attributeMapping.email.join(', ')} carried a value. Set "attributeMapping.email" on this provider if the directory uses a different attribute.`
            ]
      });

      // Step 6 — the LDAP groups themselves.
      const ldapGroups = extractGroupNames(entry.groups);
      report.add({
        id: 'groups',
        label: 'LDAP groups',
        status: ldapGroups.length > 0 ? STATUS.OK : STATUS.WARN,
        message:
          ldapGroups.length > 0
            ? `${ldapGroups.length} group(s): ${ldapGroups.join(', ')}`
            : 'The directory returned no groups for this user',
        details: {
          groupSearchBase: resolved.groupSearchBase || null,
          groupClass: resolved.groupClass,
          groupMemberAttribute: resolved.groupMemberAttribute,
          groupMemberUserAttribute: resolved.groupMemberUserAttribute,
          groups: ldapGroups
        },
        hints:
          ldapGroups.length > 0
            ? []
            : [
                resolved.groupSearchBase
                  ? `Nothing under ${resolved.groupSearchBase} has objectClass "${resolved.groupClass}" with ${resolved.groupMemberAttribute} pointing at this user's ${resolved.groupMemberUserAttribute}. Active Directory uses "group"/"member"; OpenLDAP usually "groupOfNames"/"member".`
                  : 'No base DN or group search base is set, so no group search runs.'
              ]
      });

      // Step 7 — how those become internal groups.
      const groupMapping = loadGroupMapping();
      const unmapped = ldapGroups.filter(group => !Array.isArray(groupMapping[group]));
      const mappedGroups = mapExternalGroups(ldapGroups);
      const defaultGroups = Array.isArray(resolved.defaultGroups) ? resolved.defaultGroups : [];
      const platform = configCache.getPlatform() || {};
      const authenticatedGroup = getAuthenticatedGroup(platform.auth || {});
      const finalGroups = Array.from(
        new Set([...mappedGroups, ...defaultGroups, authenticatedGroup])
      );

      report.add({
        id: 'group-mapping',
        label: 'Internal groups',
        status: unmapped.length > 0 ? STATUS.WARN : STATUS.OK,
        message: `${finalGroups.join(', ')}`,
        details: {
          fromMappings: mappedGroups,
          unmappedLdapGroups: unmapped,
          providerDefaultGroups: defaultGroups,
          authenticatedGroup,
          finalGroups
        },
        hints:
          unmapped.length > 0
            ? [
                `These LDAP groups have no mapping and were ignored: ${unmapped.join(', ')}. Add them to the "mappings" of an internal group under Admin → Groups.`
              ]
            : []
      });

      // Step 8 — the resulting user, and what that grants.
      const permissions = getPermissionsForUser(finalGroups);
      const previewUser = {
        id: mapped.id,
        name: mapped.name,
        email: mapped.email,
        groups: finalGroups,
        authMethod: 'ldap',
        provider: resolved.name || 'ldap'
      };

      report.add({
        id: 'result',
        label: 'Resulting iHub user',
        status: STATUS.OK,
        message: `${previewUser.name} (${previewUser.id})${permissions.adminAccess ? ' — administrator' : ''}`,
        details: {
          user: previewUser,
          access: {
            adminAccess: permissions.adminAccess === true,
            apps: permissions.apps?.has('*') ? 'all' : (permissions.apps?.size ?? 0),
            prompts: permissions.prompts?.has('*') ? 'all' : (permissions.prompts?.size ?? 0),
            models: permissions.models?.has('*') ? 'all' : (permissions.models?.size ?? 0)
          }
        },
        hints: [
          'Nothing was saved: this test creates no session, writes no user and issues no token.'
        ]
      });

      const success = !report.hasFailure() && passwordVerified !== false;
      return res.json({
        success,
        message: success
          ? passwordVerified === true
            ? `"${username}" can log in and would be ${previewUser.name} in the groups ${finalGroups.join(', ')}.`
            : `"${username}" was found and would be ${previewUser.name} in the groups ${finalGroups.join(', ')}. Supply a password to verify the login itself.`
          : 'The test found problems — see the steps below.',
        user: previewUser,
        summary: report.summary(),
        steps: report.steps
      });
    } catch (error) {
      const described = describeLdapError(error);
      logger.warn('LDAP test failed', {
        component: 'AdminLdapTest',
        provider: provider?.name,
        error: described.message
      });
      report.add({
        id: 'error',
        label: 'Unexpected error',
        status: STATUS.FAIL,
        message: described.message,
        hints: described.hints
      });
      try {
        return res.json({
          success: false,
          message: described.message,
          summary: report.summary(),
          steps: report.steps
        });
      } catch (responseError) {
        return sendInternalError(res, responseError, 'test LDAP configuration');
      }
    }
  });
}
