import { promises as fs } from 'fs';
import path from 'path';
import https from 'https';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';

const KNOWN_STT_MODELS = {
  'whisper-tiny': 'onnx-community/whisper-tiny',
  'whisper-base': 'onnx-community/whisper-base',
  'parakeet-tdt-0.6b': 'onnx-community/parakeet-tdt-0.6b',
  'moonshine-tiny': 'onnx-community/moonshine-tiny-onnx',
  'moonshine-base': 'onnx-community/moonshine-base-onnx'
};

// SSRF allowlist — only this host is ever contacted
const HF_HOST = 'huggingface.co';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'ihub-apps/1.0' } }, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = targetUrl => {
      https
        .get(targetUrl, { headers: { 'User-Agent': 'ihub-apps/1.0' } }, res => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const redirectUrl = res.headers.location;
            if (!redirectUrl) return reject(new Error('Redirect with no Location header'));
            // Allow redirects only to the same HF host or HF CDN
            try {
              const parsed = new URL(redirectUrl);
              if (!parsed.hostname.endsWith('.huggingface.co') && parsed.hostname !== HF_HOST) {
                return reject(new Error(`Redirect to untrusted host: ${parsed.hostname}`));
              }
            } catch {
              return reject(new Error(`Invalid redirect URL: ${redirectUrl}`));
            }
            return follow(redirectUrl);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          }
          const file = fs.open(dest, 'w').then(fh => {
            res.on('data', chunk => fh.write(chunk));
            res.on('end', () => fh.close().then(resolve).catch(reject));
            res.on('error', err =>
              fh
                .close()
                .then(() => reject(err))
                .catch(reject)
            );
          });
          file.catch(reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

export default function registerAdminSttModelsRoutes(app) {
  // GET /api/admin/models/stt — list all known STT models + local availability
  app.get(buildServerPath('/api/admin/models/stt'), adminAuth, async (req, res) => {
    const sttDir = path.join(getRootDir(), 'contents', 'models', 'stt');
    let dirs = [];
    try {
      dirs = await fs.readdir(sttDir, { withFileTypes: true });
    } catch {
      // Not created yet — that's fine
    }
    const localIds = new Set(dirs.filter(d => d.isDirectory()).map(d => d.name));
    const models = Object.entries(KNOWN_STT_MODELS).map(([id, repo]) => ({
      id,
      knownSource: repo,
      available: localIds.has(id)
    }));
    res.json({ models });
  });

  // POST /api/admin/models/stt/:modelId/_download
  // Triggers server-side download from HuggingFace. Streams SSE progress back to client.
  // SSRF protection: modelId is used only as a key into KNOWN_STT_MODELS, never into a URL.
  app.post(
    buildServerPath('/api/admin/models/stt/:modelId/_download'),
    adminAuth,
    async (req, res) => {
      const { modelId } = req.params;
      if (!validateIdForPath(modelId, 'model', res)) return;

      const repoPath = KNOWN_STT_MODELS[modelId];
      if (!repoPath) {
        return res.status(400).json({
          error: `Unknown model: ${modelId}. Supported: ${Object.keys(KNOWN_STT_MODELS).join(', ')}`
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        send({ status: 'fetching_manifest', modelId });
        // Hostname is hardcoded; modelId never goes into the URL
        const manifest = await fetchJson(`https://${HF_HOST}/api/models/${repoPath}`);
        const files = (manifest?.siblings ?? [])
          .map(s => s.rfilename)
          .filter(n => /\.(onnx|json|txt|bin)$/.test(n));

        if (!files.length) {
          send({ status: 'error', message: 'No files found in model repo' });
          return res.end();
        }

        const modelDir = path.join(getRootDir(), 'contents', 'models', 'stt', modelId);
        let done = 0;
        for (const filename of files) {
          const dest = path.join(modelDir, filename);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          // URL constructed from hardcoded host + registry path — modelId never in URL
          await downloadFile(`https://${HF_HOST}/${repoPath}/resolve/main/${filename}`, dest);
          send({ status: 'file_done', file: filename, progress: ++done, total: files.length });
        }
        send({ status: 'complete', modelId, filesDownloaded: done });
      } catch (err) {
        logger.error('STT download failed', {
          component: 'AdminSttModels',
          error: err.message
        });
        send({ status: 'error', message: err.message });
      }
      res.end();
    }
  );
}
