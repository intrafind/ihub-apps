// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Guard for the invariant behind EU AI Act Art. 50(2) provider marks (#3328):
 * no image or audio decode/encode between the provider response and the final
 * response. A re-encode drops C2PA/XMP and weakens signal watermarks such as
 * SynthID, and would make this installation the party that removed the mark.
 *
 * The server has no image library today. This fails when one is imported on the
 * server's request path; `pngjs` stays allowed in the OCR and PDF-page files
 * (it rasterises documents there, it never touches a generated image).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](sharp|jimp|canvas|@napi-rs\/canvas|jpeg-js|upng-js|image-size|pica|@jsquash\/[\w-]+|fluent-ffmpeg|@ffmpeg\/[\w-]+|lamejs|node-lame)['"]/;
const PNGJS = /['"]pngjs['"]/;
const PNGJS_ALLOWED = [
  'services/documents/pdf/PdfService.js',
  'routes/toolsService/processors/ocrProcessor.js'
];

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      yield* sources(full);
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('no image or audio codec on the generated-media path', () => {
  it('imports no image/audio library under services, routes, adapters, tts and utils', () => {
    const offenders = [];
    for (const area of ['services', 'routes', 'adapters', 'tts', 'utils']) {
      for (const file of sources(path.join(serverRoot, area))) {
        const rel = path.relative(serverRoot, file).split(path.sep).join('/');
        const text = readFileSync(file, 'utf8');
        if (FORBIDDEN.test(text)) offenders.push(rel);
        if (PNGJS.test(text) && !PNGJS_ALLOWED.includes(rel)) offenders.push(`${rel} (pngjs)`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the generated-image serve routes send the stored bytes as they are', () => {
    // The routes stream the payload from the store to the response: the stream
    // the repository opened is the one `sendStream` is given, with nothing in
    // between that could decode or re-encode it.
    const untouched =
      /getArtifactRepository\(\)\.openRead\(([\s\S]{0,4000}?)sendStream\(req, res, artifact\.stream,/;
    const between = source => {
      const match = untouched.exec(source);
      assert.ok(match, 'the artifact route hands the stored stream to sendStream');
      return match[1];
    };
    const reshaped = /\.pipe\(|pipeline\(|Transform|compose\(|artifact\.stream\s*=/;
    const chats = readFileSync(path.join(serverRoot, 'routes/chats.js'), 'utf8');
    assert.doesNotMatch(between(chats), reshaped);
    const shares = readFileSync(path.join(serverRoot, 'routes/chatShares.js'), 'utf8');
    assert.doesNotMatch(between(shares), reshaped);
    // The one payload a share rewrites is a downloaded HTML file (its library
    // kit), read whole for that; a picture never takes that branch.
    assert.match(
      shares,
      /rewritten = download && \/\\\.html\?\$\/i\.test\(downloadName\(found\)\)/
    );
    assert.match(shares, /if \(rewritten\) \{[\s\S]{0,300}withKitLibraries\(artifact\.data/);
    // And `sendStream` pipes what it is given into the response, unchanged.
    const sender = readFileSync(path.join(serverRoot, 'utils/streamResponse.js'), 'utf8');
    assert.match(sender, /stream\.pipe\(res\)/);
    assert.doesNotMatch(sender, /Transform|PassThrough|pipeline\(|zlib/);
  });
});
