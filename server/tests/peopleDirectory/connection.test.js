// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): connections, against a real LDAP protocol
 * exchange with the fake server in fakeLdapServer.js and certificates
 * generated for the test.
 *
 * Covered: certificate verification against `tlsCa` (and the missing issuer
 * named on refusal), the host name check while the socket goes to the pinned
 * address, the SSL whitelist as the only way verification is switched off —
 * also when a referenced sign-in provider asks for it — for both ldaps:// and
 * StartTLS; the SSRF check and its allow-lists; transport rules; what a search
 * actually sends (size and time limit, filter, attributes, base); partial
 * results; the shared throttle queue; and the structured errors the model gets.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import configCache from '../../configCache.js';
import credentialService from '../../services/CredentialService.js';
import {
  DirectoryClient,
  buildDirectoryTlsOptions,
  openDirectoryConnection,
  resolveTarget
} from '../../services/peopleDirectory/connection.js';
import {
  clearUnitsCache,
  getPerson,
  listUnits,
  searchPeople
} from '../../services/peopleDirectory/LdapDirectory.js';
import { resolveDirectory } from '../../services/peopleDirectory/PeopleDirectoryService.js';
import {
  runPeopleDirectoryTool,
  testDirectory
} from '../../services/peopleDirectory/peopleDirectoryRunner.js';
import { ToolArgumentError } from '../../services/peopleDirectory/query.js';
import { dnEquals } from '../../services/peopleDirectory/dn.js';
import { generateCertificates, hasOpenssl, startFakeLdapServer } from './fakeLdapServer.js';

const skip = !hasOpenssl() && 'openssl CLI not available to generate test certificates';

const state = {
  platform: {},
  directories: [],
  groups: {
    admins: { inherits: ['users'] },
    users: { inherits: ['authenticated'] },
    authenticated: {}
  }
};
configCache.getPlatform = () => state.platform;
configCache.getPeopleDirectories = () => ({ data: { directories: state.directories } });
configCache.getGroups = () => ({ data: { groups: state.groups } });
credentialService.resolveSecret = ref => (ref === 'svc' ? 'bind-secret' : undefined);

const PEOPLE = Array.from({ length: 30 }, (_, i) => ({
  dn: `cn=Muster${i} Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE`,
  objectClass: ['ivbbPerson', 'inetOrgPerson'],
  cn: `Muster${i} Erika`,
  sn: `Muster${i}`,
  givenName: 'Erika',
  mail: `erika.muster${i}@example.org`,
  role: 'Referentin'
}));
const UNITS = [
  { dn: 'ou=THW,o=Bund,c=DE', objectClass: 'organizationalUnit' },
  { dn: 'ou=MRI,o=Bund,c=DE', objectClass: 'organizationalUnit' }
];

/** Units the server lists before its own size limit stops it (null: no limit). */
const unitLimit = { value: null };

function onSearch(request) {
  if (request.scope === 'one') {
    // A server-side size limit answers with what fits and result code 4.
    return unitLimit.value === null
      ? { entries: UNITS }
      : { entries: UNITS.slice(0, unitLimit.value), code: 4 };
  }
  if (request.scope === 'base') {
    // Like a real server, the base DN matches whatever case it is written in.
    const candidates = request.filter.startsWith('(!') ? UNITS : PEOPLE;
    return { entries: candidates.filter(entry => dnEquals(entry.dn, request.base)) };
  }
  return { entries: PEOPLE };
}

/** Resolver that answers every host with fixed addresses, like DNS pointed at the fake server. */
const lookupTo =
  (...addresses) =>
  (hostname, options, callback) =>
    callback(
      null,
      addresses.map(address => ({ address, family: net.isIP(address) }))
    );

describe('people directory connections', { skip }, () => {
  let certs;
  let ldaps;
  let starttls;
  let plain;
  let anchors;

  before(async () => {
    certs = generateCertificates('ldap.test');
    const serverTls = { key: certs.key, cert: certs.chain };
    ldaps = await startFakeLdapServer({ tlsOptions: serverTls, onSearch });
    starttls = await startFakeLdapServer({ startTls: serverTls, onSearch });
    plain = await startFakeLdapServer({ onSearch });
    anchors = async names =>
      names.map(name => (name === 'test-root' ? certs.rootPem : null)).filter(Boolean);
  });

  after(async () => {
    await Promise.all([ldaps?.close(), starttls?.close(), plain?.close()]);
  });

  beforeEach(() => {
    state.platform = {};
    unitLimit.value = null;
    clearUnitsCache();
  });

  const connectOptions = extra => ({
    lookup: lookupTo('127.0.0.1'),
    loadAnchors: anchors,
    ...extra
  });

  const ldapsDirectory = overrides =>
    resolveDirectory({
      id: 'testdir',
      url: `ldaps://ldap.test:${ldaps.port}`,
      baseDn: 'o=Bund,c=DE',
      preset: 'ivbb',
      bind: { mode: 'anonymous' },
      allowedHosts: ['ldap.test'],
      tlsCa: ['test-root'],
      maxResults: 25,
      units: true,
      ...overrides
    });

  const starttlsDirectory = overrides =>
    ldapsDirectory({ url: `ldap://ldap.test:${starttls.port}`, starttls: true, ...overrides });

  describe('TLS (ldaps://)', () => {
    it('trusts only the tlsCa root and connects to the pinned address while checking the host name', async () => {
      const seen = [];
      const result = await searchPeople(
        ldapsDirectory(),
        { query: 'Muster1' },
        {
          connectOptions: connectOptions({
            createClient: options => {
              seen.push(options);
              return new DirectoryClient(options);
            }
          })
        }
      );
      assert.equal(result.directory, 'testdir');
      assert.ok(result.results.length > 0);
      // The socket goes to the validated address, never to the name again ...
      assert.equal(seen[0].url, `ldaps://127.0.0.1:${ldaps.port}`);
      assert.equal(ldaps.connections.at(-1).remoteAddress.replace('::ffff:', ''), '127.0.0.1');
      // ... while TLS checks the certificate against the host name.
      assert.equal(seen[0].tlsOptions.servername, 'ldap.test');
      assert.equal(seen[0].tlsOptions.host, 'ldap.test');
      assert.deepEqual(seen[0].tlsOptions.ca, [certs.rootPem]);
      assert.equal('rejectUnauthorized' in seen[0].tlsOptions, false);
    });

    it('refuses a server whose chain ends in a root that is not in tlsCa, and names the missing issuer', async () => {
      await assert.rejects(
        openDirectoryConnection(ldapsDirectory({ tlsCa: undefined }), connectOptions()),
        error => {
          assert.equal(error.code, 'tls_untrusted');
          assert.equal(error.step, 'connect');
          assert.equal(error.details.missingIssuer, 'Test Root CA');
          assert.match(error.message, /issuer "Test Root CA" is not trusted/);
          assert.deepEqual(
            error.details.certificateChain.map(cert => cert.subject),
            ['ldap.test', 'Test Intermediate CA']
          );
          assert.match(error.details.certificateChain[0].fingerprint256, /^[0-9A-F:]+$/);
          return true;
        }
      );
    });

    it('refuses a certificate issued for another host name', async () => {
      await assert.rejects(
        openDirectoryConnection(
          ldapsDirectory({ url: `ldaps://wrong.test:${ldaps.port}`, allowedHosts: ['wrong.test'] }),
          connectOptions()
        ),
        error => error.code === 'tls_hostname'
      );
    });

    it('switches verification off only for a host on the SSL whitelist', async () => {
      state.platform = { ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['ldap.test'] } };
      const directory = ldapsDirectory({ tlsCa: undefined });
      assert.equal(buildDirectoryTlsOptions(directory).rejectUnauthorized, false);
      const { client } = await openDirectoryConnection(directory, connectOptions());
      await client.unbind();

      state.platform = {
        ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['other.test'] }
      };
      assert.equal('rejectUnauthorized' in buildDirectoryTlsOptions(directory), false);
      await assert.rejects(openDirectoryConnection(directory, connectOptions()), {
        code: 'tls_untrusted'
      });
    });

    it('ignores rejectUnauthorized: false of a referenced sign-in provider', async () => {
      state.platform = {
        ldapAuth: {
          providers: [
            {
              name: 'corp',
              url: `ldaps://ldap.test:${ldaps.port}`,
              baseDn: 'o=Bund,c=DE',
              tlsOptions: { rejectUnauthorized: false, minVersion: 'TLSv1.2' }
            }
          ]
        }
      };
      const directory = resolveDirectory({
        id: 'corp',
        authProvider: 'corp',
        bind: { mode: 'anonymous' }
      });
      assert.deepEqual(directory.tlsOptions, { minVersion: 'TLSv1.2' });
      assert.deepEqual(directory.ignoredTlsOptionKeys, ['rejectUnauthorized']);
      assert.ok(directory.warnings.some(warning => warning.includes('rejectUnauthorized')));
      // The provider's host is an allowed internal target, no allow-list needed.
      await assert.rejects(openDirectoryConnection(directory, connectOptions()), error => {
        assert.equal(error.code, 'tls_untrusted');
        return true;
      });

      // The admin test reports the ignored key.
      const report = await testDirectory(
        { id: 'corp', authProvider: 'corp', bind: { mode: 'anonymous' } },
        { deps: { connectOptions: connectOptions() } }
      );
      assert.deepEqual(report.steps[0].details.ignoredTlsOptionKeys, ['rejectUnauthorized']);
      assert.ok(report.steps[0].hints.some(hint => hint.includes('rejectUnauthorized')));
      assert.equal(
        report.steps.find(step => step.id === 'network').details.allowedBy,
        'authProvider'
      );
      assert.equal(report.success, false);
    });
  });

  describe('TLS (StartTLS)', () => {
    it('upgrades with the same TLS options and searches over the encrypted connection', async () => {
      const seen = [];
      const before = starttls.requests.length;
      const result = await searchPeople(
        starttlsDirectory(),
        { query: 'Muster2' },
        {
          connectOptions: connectOptions({
            createClient: options => {
              const client = new DirectoryClient(options);
              const startTLS = client.startTLS.bind(client);
              client.startTLS = tlsOptions => {
                seen.push({ ...tlsOptions });
                return startTLS(tlsOptions);
              };
              return client;
            }
          })
        }
      );
      assert.ok(result.results.length > 0);
      assert.equal(seen[0].servername, 'ldap.test');
      assert.deepEqual(seen[0].ca, [certs.rootPem]);
      assert.equal('rejectUnauthorized' in seen[0], false);
      const search = starttls.requests.slice(before).find(request => request.type === 'search');
      assert.equal(search.secure, true);
    });

    it('refuses an untrusted chain at the StartTLS step and names the missing issuer', async () => {
      await assert.rejects(
        openDirectoryConnection(starttlsDirectory({ tlsCa: undefined }), connectOptions()),
        error => {
          assert.equal(error.code, 'tls_untrusted');
          assert.equal(error.step, 'starttls');
          assert.equal(error.details.missingIssuer, 'Test Root CA');
          return true;
        }
      );
    });

    it('switches verification off only for a whitelisted host, also with a provider asking for it', async () => {
      state.platform = {
        ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['ldap.test'] }
      };
      const { client } = await openDirectoryConnection(
        starttlsDirectory({ tlsCa: undefined }),
        connectOptions()
      );
      await client.unbind();

      state.platform = {
        ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['other.test'] },
        ldapAuth: {
          providers: [
            {
              name: 'corp',
              url: `ldap://ldap.test:${starttls.port}`,
              starttls: true,
              baseDn: 'o=Bund,c=DE',
              tlsOptions: { rejectUnauthorized: false }
            }
          ]
        }
      };
      const directory = resolveDirectory({
        id: 'corp',
        authProvider: 'corp',
        bind: { mode: 'anonymous' }
      });
      assert.equal(directory.transport, 'starttls');
      await assert.rejects(openDirectoryConnection(directory, connectOptions()), {
        code: 'tls_untrusted',
        step: 'starttls'
      });
    });
  });

  describe('SSRF check', () => {
    const plainResolved = (overrides = {}) => ({
      allowedHosts: [],
      providerHost: null,
      ...overrides
    });

    it('refuses a private address without an allow-list entry', async () => {
      await assert.rejects(
        resolveTarget('intranet.test', plainResolved(), { lookup: lookupTo('10.1.2.3') }),
        { code: 'ssrf_blocked' }
      );
      await assert.rejects(
        resolveTarget('mixed.test', plainResolved(), {
          lookup: lookupTo('93.184.216.34', '192.168.0.9')
        }),
        { code: 'ssrf_blocked' }
      );
      await assert.rejects(
        resolveTarget('mapped.test', plainResolved(), { lookup: lookupTo('::ffff:a9fe:a9fe') }),
        { code: 'ssrf_blocked' }
      );
      await assert.rejects(
        resolveTarget('localhost', plainResolved(), { lookup: lookupTo('127.0.0.1') }),
        {
          code: 'ssrf_blocked'
        }
      );
      await assert.rejects(resolveTarget('10.0.0.1', plainResolved()), { code: 'ssrf_blocked' });
    });

    it('accepts it with allowedHosts, ssrf.allowedHosts or the sign-in provider host', async () => {
      const viaDirectory = await resolveTarget(
        'intranet.test',
        plainResolved({ allowedHosts: ['intranet.test'] }),
        {
          lookup: lookupTo('10.1.2.3')
        }
      );
      assert.equal(viaDirectory.allowedBy, 'allowedHosts');
      assert.equal(viaDirectory.pinnedAddress, '10.1.2.3');

      state.platform = { ssrf: { allowedHosts: ['*.corp.example'] } };
      const viaPlatform = await resolveTarget('ldap.corp.example', plainResolved(), {
        lookup: lookupTo('10.1.2.3')
      });
      assert.equal(viaPlatform.allowedBy, 'ssrf.allowedHosts');

      const viaProvider = await resolveTarget(
        'DC1.corp.local',
        plainResolved({ providerHost: 'dc1.corp.local' }),
        {
          lookup: lookupTo('10.1.2.3')
        }
      );
      assert.equal(viaProvider.allowedBy, 'authProvider');

      const publicHost = await resolveTarget('x500.example', plainResolved(), {
        lookup: lookupTo('93.184.216.34')
      });
      assert.equal(publicHost.allowedBy, null);
      assert.equal(publicHost.pinnedAddress, '93.184.216.34');
    });

    it('checks inline test entries too, before any connection is opened', async () => {
      const connectionsBefore = ldaps.connections.length;
      const report = await testDirectory(
        {
          id: 'inline',
          url: `ldaps://intranet.test:${ldaps.port}`,
          baseDn: 'o=Bund,c=DE',
          bind: { mode: 'anonymous' }
        },
        {
          query: 'Muster',
          deps: { connectOptions: connectOptions({ lookup: lookupTo('127.0.0.1') }) }
        }
      );
      const network = report.steps.find(step => step.id === 'network');
      assert.equal(network.status, 'fail');
      assert.equal(report.success, false);
      assert.equal(ldaps.connections.length, connectionsBefore);
    });
  });

  describe('transport', () => {
    it('refuses plain ldap:// without allowPlaintext, before resolving the host', async () => {
      let looked = false;
      await assert.rejects(
        openDirectoryConnection(ldapsDirectory({ url: `ldap://ldap.test:${plain.port}` }), {
          ...connectOptions(),
          lookup: (...args) => {
            looked = true;
            return lookupTo('127.0.0.1')(...args);
          }
        }),
        { code: 'plaintext_refused' }
      );
      assert.equal(looked, false);
    });

    it('never sends a service bind in plain text, even with allowPlaintext', async () => {
      await assert.rejects(
        openDirectoryConnection(
          ldapsDirectory({
            url: `ldap://ldap.test:${plain.port}`,
            allowPlaintext: true,
            bind: { mode: 'service', dn: 'cn=svc,o=Bund,c=DE', passwordRef: 'svc' }
          }),
          connectOptions()
        ),
        { code: 'plaintext_refused' }
      );
      assert.ok(
        !plain.requests.some(
          request => request.type === 'bind' && request.name === 'cn=svc,o=Bund,c=DE'
        )
      );
    });

    it('allows anonymous plain text with allowPlaintext, and warns', async () => {
      const directory = ldapsDirectory({
        url: `ldap://ldap.test:${plain.port}`,
        allowPlaintext: true
      });
      assert.equal(directory.transport, 'plaintext');
      assert.ok(directory.warnings.some(warning => warning.includes('not encrypted')));
      const result = await searchPeople(
        directory,
        { query: 'Muster3' },
        { connectOptions: connectOptions() }
      );
      assert.ok(result.results.length > 0);
    });

    it('binds a service account over TLS with the password from the credential store', async () => {
      const before = ldaps.requests.length;
      const { client } = await openDirectoryConnection(
        ldapsDirectory({ bind: { mode: 'service', dn: 'cn=svc,o=Bund,c=DE', passwordRef: 'svc' } }),
        connectOptions()
      );
      await client.unbind();
      const bind = ldaps.requests.slice(before).find(request => request.type === 'bind');
      assert.equal(bind.name, 'cn=svc,o=Bund,c=DE');
      assert.equal(bind.password, 'bind-secret');
    });
  });

  describe('search', () => {
    it('clamps maxResults, sends sizeLimit = limit + 1, and reports truncation', async () => {
      const before = ldaps.requests.length;
      const result = await searchPeople(
        ldapsDirectory({ maxResults: 25 }),
        { query: 'Muster', maxResults: 50 },
        { connectOptions: connectOptions() }
      );
      const search = ldaps.requests.slice(before).find(request => request.type === 'search');
      assert.equal(search.sizeLimit, 26);
      assert.equal(result.results.length, 25);
      assert.equal(result.truncated, true);
      assert.match(result.hint, /Narrow the search/);
    });

    it('reports a partial result when the server stops at its own size limit', async () => {
      const limited = await startFakeLdapServer({
        tlsOptions: { key: certs.key, cert: certs.chain },
        onSearch: () => ({ entries: PEOPLE.slice(0, 10), code: 4 })
      });
      try {
        const result = await searchPeople(
          ldapsDirectory({ url: `ldaps://ldap.test:${limited.port}` }),
          { query: 'Muster' },
          { connectOptions: connectOptions() }
        );
        assert.equal(result.results.length, 10);
        assert.equal(result.truncated, true);
      } finally {
        await limited.close();
      }
    });

    it('rejects maxResults 0, -1, 2.5 and "10" without sending a search', async () => {
      const connections = ldaps.connections.length;
      const requests = ldaps.requests.length;
      for (const maxResults of [0, -1, 2.5, '10']) {
        await assert.rejects(
          searchPeople(
            ldapsDirectory(),
            { query: 'Muster', maxResults },
            { connectOptions: connectOptions() }
          ),
          ToolArgumentError
        );
      }
      assert.equal(ldaps.connections.length, connections);
      assert.equal(ldaps.requests.length, requests);
    });

    it('sends the time limit in seconds', async () => {
      for (const [timeoutMs, expected] of [
        [8000, 8],
        [1500, 2]
      ]) {
        const before = ldaps.requests.length;
        await searchPeople(
          ldapsDirectory({ timeoutMs }),
          { query: 'Muster' },
          { connectOptions: connectOptions() }
        );
        const search = ldaps.requests.slice(before).find(request => request.type === 'search');
        assert.equal(search.timeLimit, expected);
      }
    });

    it('sends an escaped filter and only the mapped attributes', async () => {
      const before = ldaps.requests.length;
      await searchPeople(
        ldapsDirectory(),
        { query: 'Erika (x)', jobTitle: 'Referent' },
        { connectOptions: connectOptions() }
      );
      const search = ldaps.requests.slice(before).find(request => request.type === 'search');
      assert.equal(search.base, 'o=Bund,c=DE');
      assert.equal(search.scope, 'sub');
      assert.match(search.filter, /\(objectclass=ivbbPerson\)/i);
      assert.match(search.filter, /\(cn=\*Erika\*\)/);
      assert.match(search.filter, /\\28x\\29/);
      assert.match(search.filter, /\(role=Referent\*\)/);
      assert.ok(!search.attributes.includes('*'));
      assert.ok(search.attributes.includes('role'));
    });

    it('narrows to a unit from list_units, and refuses any other unit', async () => {
      const units = await listUnits(ldapsDirectory(), {}, { connectOptions: connectOptions() });
      assert.deepEqual(units.units, [
        { unitId: 'ou=MRI', name: 'MRI' },
        { unitId: 'ou=THW', name: 'THW' }
      ]);

      for (const unit of ['ou=THW', 'thw', 'OU=thw']) {
        const before = ldaps.requests.length;
        await searchPeople(
          ldapsDirectory(),
          { query: 'Muster', unit },
          { connectOptions: connectOptions() }
        );
        const search = ldaps.requests
          .slice(before)
          .find(request => request.type === 'search' && request.scope === 'sub');
        assert.equal(search.base, 'ou=THW,o=Bund,c=DE');
      }

      await assert.rejects(
        searchPeople(
          ldapsDirectory(),
          { query: 'Muster', unit: 'ou=Evil,o=Other' },
          { connectOptions: connectOptions() }
        ),
        ToolArgumentError
      );
      await assert.rejects(
        searchPeople(
          ldapsDirectory({ units: false }),
          { query: 'Muster', unit: 'ou=THW' },
          { connectOptions: connectOptions() }
        ),
        ToolArgumentError
      );
    });

    it('caches the unit list per directory config, so a changed config never reuses it', async () => {
      const unitSearches = () =>
        ldaps.requests.filter(request => request.type === 'search' && request.scope === 'one')
          .length;
      const before = unitSearches();
      await listUnits(ldapsDirectory(), {}, { connectOptions: connectOptions() });
      await listUnits(ldapsDirectory(), {}, { connectOptions: connectOptions() });
      assert.equal(unitSearches(), before + 1);
      // Another bind, as another worker would see it after a config change.
      await listUnits(
        ldapsDirectory({ bind: { mode: 'service', dn: 'cn=svc', passwordRef: 'svc' } }),
        {},
        { connectOptions: connectOptions() }
      );
      assert.equal(unitSearches(), before + 2);
    });

    it('reports a unit list the server cut short, and still finds a unit beyond the cut by its id', async () => {
      unitLimit.value = 1;
      const units = await listUnits(ldapsDirectory(), {}, { connectOptions: connectOptions() });
      assert.equal(units.truncated, true);
      assert.deepEqual(units.units, [{ unitId: 'ou=THW', name: 'THW' }]);

      // MRI is beyond the cut: its id is looked up below the search base.
      const before = ldaps.requests.length;
      await searchPeople(
        ldapsDirectory(),
        { query: 'Muster', unit: 'OU=mri' },
        { connectOptions: connectOptions() }
      );
      const searches = ldaps.requests.slice(before).filter(request => request.type === 'search');
      const lookup = searches.find(request => request.scope === 'base');
      assert.equal(lookup.base, 'OU=mri,o=Bund,c=DE');
      assert.match(lookup.filter, /^\(!/);
      assert.equal(searches.find(request => request.scope === 'sub').base, 'OU=mri,o=Bund,c=DE');

      // A name, a unit that does not exist and a DN outside the base are refused.
      for (const unit of ['MRI', 'ou=Nope', 'ou=MRI,o=Other']) {
        await assert.rejects(
          searchPeople(
            ldapsDirectory(),
            { query: 'Muster', unit },
            { connectOptions: connectOptions() }
          ),
          error => error instanceof ToolArgumentError && /lists only part/.test(error.message),
          unit
        );
      }
    });

    it('reads a person inside the search base and refuses one outside it without connecting', async () => {
      const person = await getPerson(
        ldapsDirectory(),
        { personId: PEOPLE[4].dn },
        { connectOptions: connectOptions() }
      );
      assert.equal(person.lastName, 'Muster4');
      assert.equal(person.location, 'Karlsruhe');

      const connections = ldaps.connections.length;
      for (const personId of [
        'cn=CA,o=PKI-1-VERWALTUNG,c=DE',
        'o=Bund,c=DE',
        'cn=x,o=Bund,c=DE.evil',
        'garbage'
      ]) {
        await assert.rejects(
          getPerson(ldapsDirectory(), { personId }, { connectOptions: connectOptions() }),
          ToolArgumentError
        );
      }
      assert.equal(ldaps.connections.length, connections);

      const missing = await getPerson(
        ldapsDirectory(),
        { personId: 'cn=Nobody,ou=MRI,o=Bund,c=DE' },
        { connectOptions: connectOptions() }
      );
      assert.equal(missing.error.code, 'not_found');
    });
  });

  describe('tool calls', () => {
    const user = { id: 'u1', groups: ['users'] };
    const tool = action => ({
      id: `testdir__${action}`,
      _peopleDirectory: { id: 'testdir', action }
    });
    const configure = overrides => {
      state.directories = [
        {
          id: 'testdir',
          url: `ldaps://ldap.test:${ldaps.port}`,
          baseDn: 'o=Bund,c=DE',
          preset: 'ivbb',
          bind: { mode: 'anonymous' },
          allowedHosts: ['ldap.test'],
          tlsCa: ['test-root'],
          groups: ['users'],
          ...overrides
        }
      ];
    };

    it('share one queue per directory: search and get_person never overlap at concurrency 1', async () => {
      const slow = await startFakeLdapServer({
        tlsOptions: { key: certs.key, cert: certs.chain },
        onSearch,
        delayMs: 150
      });
      try {
        configure({ url: `ldaps://ldap.test:${slow.port}`, concurrency: 1 });
        const deps = { connectOptions: connectOptions() };
        const results = await Promise.all([
          runPeopleDirectoryTool(tool('search_people'), { query: 'Muster', user }, deps),
          runPeopleDirectoryTool(tool('get_person'), { personId: PEOPLE[1].dn, user }, deps),
          runPeopleDirectoryTool(tool('search_people'), { query: 'Erika', user }, deps)
        ]);
        assert.ok(results.every(result => !result.error));
        assert.equal(slow.maxActiveSearches(), 1);
      } finally {
        await slow.close();
      }
    });

    it('queue the tests of unsaved entries by host, so two new directories do not wait on each other', async () => {
      const servers = await Promise.all([
        startFakeLdapServer({ onSearch, delayMs: 400 }),
        startFakeLdapServer({ onSearch })
      ]);
      try {
        const entry = (host, server) => ({
          id: 'unsaved',
          url: `ldap://${host}:${server.port}`,
          baseDn: 'o=Bund,c=DE',
          preset: 'ivbb',
          bind: { mode: 'anonymous' },
          allowPlaintext: true,
          allowedHosts: [host],
          concurrency: 1
        });
        const deps = { connectOptions: connectOptions() };
        const started = Date.now();
        let fastDoneAfter = null;
        await Promise.all([
          testDirectory(entry('slow.test', servers[0]), { query: 'Muster', deps, unsaved: true }),
          testDirectory(entry('fast.test', servers[1]), {
            query: 'Muster',
            deps,
            unsaved: true
          }).then(() => {
            fastDoneAfter = Date.now() - started;
          })
        ]);
        assert.ok(fastDoneAfter < 350, `the second test waited ${fastDoneAfter} ms`);
      } finally {
        await Promise.all(servers.map(server => server.close()));
      }
    });

    it('turn a refused connection, a timeout and a bad argument into results the model can act on', async () => {
      const closed = await new Promise(resolve => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      });
      configure({ url: `ldaps://ldap.test:${closed}` });
      const refused = await runPeopleDirectoryTool(
        tool('search_people'),
        { query: 'Muster', user },
        {
          connectOptions: connectOptions()
        }
      );
      assert.equal(refused.directory, 'testdir');
      assert.equal(refused.error.code, 'connection_refused');
      assert.doesNotMatch(refused.error.message, /127\.0\.0\.1|ldap\.test/);

      const slow = await startFakeLdapServer({
        tlsOptions: { key: certs.key, cert: certs.chain },
        onSearch,
        delayMs: 1600
      });
      try {
        configure({ url: `ldaps://ldap.test:${slow.port}`, timeoutMs: 1000 });
        const timedOut = await runPeopleDirectoryTool(
          tool('search_people'),
          { query: 'Muster', user },
          {
            connectOptions: connectOptions()
          }
        );
        assert.equal(timedOut.error.code, 'timeout');
      } finally {
        await slow.close();
      }

      configure();
      const bad = await runPeopleDirectoryTool(
        tool('search_people'),
        { query: 'Muster', maxResults: 0, user },
        {
          connectOptions: connectOptions()
        }
      );
      assert.equal(bad.error.code, 'invalid_arguments');
      assert.match(bad.error.message, /maxResults/);
    });

    it('refuse a user outside the directory groups, and a disabled directory', async () => {
      configure();
      await assert.rejects(
        runPeopleDirectoryTool(tool('search_people'), {
          query: 'Muster',
          user: { id: 'x', groups: ['guests'] }
        }),
        /not available/
      );
      await assert.rejects(
        runPeopleDirectoryTool(tool('search_people'), { query: 'Muster' }),
        /not available/
      );
      configure({ enabled: false });
      await assert.rejects(
        runPeopleDirectoryTool(tool('search_people'), { query: 'Muster', user }),
        /not available/
      );
    });

    it('run the admin test step by step and map the first hits next to their raw attributes', async () => {
      configure();
      const report = await testDirectory(state.directories[0], {
        query: 'Muster1',
        deps: { connectOptions: connectOptions() }
      });
      assert.equal(report.success, true);
      assert.deepEqual(
        report.steps.map(step => [step.id, step.status]),
        [
          ['configuration', 'ok'],
          ['network', 'ok'],
          ['connect', 'ok'],
          ['bind', 'ok'],
          ['search', 'ok'],
          ['mapping', 'ok']
        ]
      );
      const mapped = report.steps.at(-1).details.people[0];
      assert.equal(mapped.person.jobTitle, 'Referentin');
      assert.equal(mapped.raw.role, 'Referentin');
      assert.equal(mapped.usedSources.jobTitle, 'role');
      assert.ok(report.results.length > 0);
    });
  });
});
