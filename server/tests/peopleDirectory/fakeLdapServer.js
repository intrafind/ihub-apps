// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A minimal LDAP server for the people directory tests: it answers bind,
 * search (honouring the request's size limit like a real server, with result
 * code 4), StartTLS and unbind, and records every request it gets, so a test
 * can check what the client actually sent — size and time limits, filter,
 * attributes, base — and how the connection was protected.
 *
 * It is plain LDAP over TCP, LDAPS (`tlsOptions`), or plain with StartTLS
 * (`startTls`), always on 127.0.0.1.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { BerReader, BerWriter, FilterParser } from 'ldapts';

/** The openssl binary, by absolute path so the tests never run whatever PATH offers. */
const OPENSSL = ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl'].find(
  candidate => fs.existsSync(candidate)
);

const OP = { bind: 0x60, unbind: 0x42, search: 0x63, extended: 0x77 };
const START_TLS_OID = '1.3.6.1.4.1.1466.20037';

function message(id, write) {
  const writer = new BerWriter();
  writer.startSequence();
  writer.writeInt(id);
  write(writer);
  writer.endSequence();
  return writer.buffer;
}

function resultOp(tag, code = 0, diagnostic = '') {
  return writer => {
    writer.startSequence(tag);
    writer.writeEnumeration(code);
    writer.writeString('');
    writer.writeString(diagnostic);
    writer.endSequence();
  };
}

function entryOp(entry) {
  return writer => {
    writer.startSequence(0x64);
    writer.writeString(entry.dn);
    writer.startSequence();
    for (const [name, raw] of Object.entries(entry)) {
      if (name === 'dn') continue;
      writer.startSequence();
      writer.writeString(name);
      writer.startSequence(0x31);
      for (const value of Array.isArray(raw) ? raw : [raw]) writer.writeString(value);
      writer.endSequence();
      writer.endSequence();
    }
    writer.endSequence();
    writer.endSequence();
  };
}

/** Length of the complete BER message at the start of `buffer`, or 0 when incomplete. */
function messageLength(buffer) {
  if (buffer.length < 2) return 0;
  const first = buffer[1];
  if (first < 0x80) return buffer.length >= 2 + first ? 2 + first : 0;
  const bytes = first & 0x7f;
  if (buffer.length < 2 + bytes) return 0;
  const length = buffer.readUIntBE(2, bytes);
  return buffer.length >= 2 + bytes + length ? 2 + bytes + length : 0;
}

function parseRequest(buffer) {
  const reader = new BerReader(buffer);
  reader.readSequence();
  const id = reader.readInt();
  const op = reader.peek();
  if (op === OP.bind) {
    reader.readSequence(OP.bind);
    const version = reader.readInt();
    const name = reader.readString();
    const password = reader.readString(0x80);
    return { id, type: 'bind', version, name, password };
  }
  if (op === OP.search) {
    reader.readSequence(OP.search);
    const base = reader.readString();
    const scope = reader.readEnumeration();
    reader.readEnumeration(); // derefAliases
    const sizeLimit = reader.readInt();
    const timeLimit = reader.readInt();
    reader.readBoolean(); // typesOnly
    const filter = FilterParser.parse(reader).toString();
    reader.readSequence();
    const end = reader.offset + reader.length;
    const attributes = [];
    while (reader.offset < end) attributes.push(reader.readString());
    return {
      id,
      type: 'search',
      base,
      scope: ['base', 'one', 'sub'][scope],
      sizeLimit,
      timeLimit,
      filter,
      attributes
    };
  }
  if (op === OP.extended) {
    reader.readSequence(OP.extended);
    return { id, type: 'extended', name: reader.readString(0x80) };
  }
  if (op === OP.unbind) return { id, type: 'unbind' };
  return { id, type: 'unknown', op };
}

/**
 * @param {Object} options
 * @param {tls.TlsOptions} [options.tlsOptions] - Serve LDAPS with these (key/cert)
 * @param {tls.TlsOptions} [options.startTls] - Accept StartTLS with these (key/cert)
 * @param {(request: Object) => {entries?: Object[], code?: number}|Promise<...>} [options.onSearch]
 * @param {(request: Object) => number} [options.onBind] - LDAP result code for a bind
 * @param {number} [options.delayMs] - Delay before each search answer
 * @returns {Promise<{port: number, requests: Object[], connections: Object[], maxActiveSearches: () => number, close: () => Promise<void>}>}
 */
export async function startFakeLdapServer({
  tlsOptions,
  startTls,
  onSearch = () => ({ entries: [] }),
  onBind = () => 0,
  delayMs = 0
} = {}) {
  const requests = [];
  const connections = [];
  const sockets = new Set();
  let activeSearches = 0;
  let maxActive = 0;

  const serve = (socket, connection) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    const onData = async chunk => {
      pending = Buffer.concat([pending, chunk]);
      let length;
      while ((length = messageLength(pending)) > 0) {
        // BerReader reads the underlying ArrayBuffer from offset 0, so a
        // message must not be a view into Node's pooled socket buffers.
        const raw = Buffer.alloc(length);
        pending.copy(raw, 0, 0, length);
        pending = pending.subarray(length);
        const request = parseRequest(raw);
        request.secure = connection.secure;
        requests.push(request);
        if (request.type === 'bind') {
          socket.write(message(request.id, resultOp(0x61, onBind(request))));
        } else if (request.type === 'extended' && request.name === START_TLS_OID && startTls) {
          socket.write(message(request.id, resultOp(0x78, 0)));
          socket.removeListener('data', onData);
          const secure = new tls.TLSSocket(socket, { isServer: true, ...startTls });
          connection.secure = true;
          secure.on('error', () => {});
          serve(secure, connection);
          return;
        } else if (request.type === 'search') {
          activeSearches++;
          maxActive = Math.max(maxActive, activeSearches);
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          const { entries = [], code = 0 } = (await onSearch(request)) || {};
          const limited =
            request.sizeLimit > 0 && entries.length > request.sizeLimit
              ? entries.slice(0, request.sizeLimit)
              : entries;
          for (const entry of limited) socket.write(message(request.id, entryOp(entry)));
          const done = limited.length < entries.length ? 4 : code;
          socket.write(message(request.id, resultOp(0x65, done)));
          activeSearches--;
        } else if (request.type === 'unbind') {
          socket.end();
          return;
        } else {
          socket.write(message(request.id, resultOp(0x78, 2, 'unsupported')));
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  };

  const server = tlsOptions
    ? tls.createServer(tlsOptions, socket => {
        const connection = { secure: true, remoteAddress: socket.remoteAddress };
        connections.push(connection);
        serve(socket, connection);
      })
    : net.createServer(socket => {
        const connection = { secure: false, remoteAddress: socket.remoteAddress };
        connections.push(connection);
        serve(socket, connection);
      });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    requests,
    connections,
    maxActiveSearches: () => maxActive,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

/**
 * A root, an intermediate and a server certificate for `hostname`, made with
 * the openssl CLI in a temp directory.
 * @param {string} [hostname]
 * @returns {{rootPem: string, intermediatePem: string, key: string, cert: string, chain: string, dir: string}}
 */
export function generateCertificates(hostname = 'ldap.test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-dir-certs-'));
  const run = args => execFileSync(OPENSSL, args, { cwd: dir, stdio: 'pipe' });
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'root.key',
    '-out',
    'root.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Test Root CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'int.key',
    '-out',
    'int.csr',
    '-subj',
    '/CN=Test Intermediate CA'
  ]);
  write('int.ext', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run([
    'x509',
    '-req',
    '-in',
    'int.csr',
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-CAcreateserial',
    '-out',
    'int.pem',
    '-days',
    '2',
    '-extfile',
    'int.ext'
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'srv.key',
    '-out',
    'srv.csr',
    '-subj',
    `/CN=${hostname}`
  ]);
  write('srv.ext', `subjectAltName=DNS:${hostname}\nbasicConstraints=CA:FALSE\n`);
  run([
    'x509',
    '-req',
    '-in',
    'srv.csr',
    '-CA',
    'int.pem',
    '-CAkey',
    'int.key',
    '-CAcreateserial',
    '-out',
    'srv.pem',
    '-days',
    '2',
    '-extfile',
    'srv.ext'
  ]);
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  return {
    dir,
    rootPem: read('root.pem'),
    rootKey: read('root.key'),
    intermediatePem: read('int.pem'),
    key: read('srv.key'),
    cert: read('srv.pem'),
    chain: read('srv.pem') + read('int.pem')
  };
}

/** Whether the openssl CLI is available to generate test certificates. */
export function hasOpenssl() {
  if (!OPENSSL) return false;
  try {
    execFileSync(OPENSSL, ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
