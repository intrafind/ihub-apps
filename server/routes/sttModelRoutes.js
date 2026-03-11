import path from 'path';
import { promises as fs, createReadStream } from 'fs';
import { authRequired } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import {
  validateIdForPath,
  sanitizeRelativePath,
  resolveAndValidateRealPath
} from '../utils/pathSecurity.js';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

const MIME_TYPES = {
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream'
};

export default function registerSttModelRoutes(app) {
  app.get(
    buildServerPath('/api/assets/models/stt/:modelId/:filePath(*)'),
    authRequired,
    async (req, res) => {
      try {
        const platformConfig = configCache.getPlatform() || {};
        const allowAnonDownload =
          platformConfig?.speechRecognition?.allowAnonymousModelDownload === true;
        const isAnonymous = !req.user || req.user.id === 'anonymous';

        if (isAnonymous && !allowAnonDownload) {
          return res
            .status(403)
            .json({ error: 'Authentication required to download STT model files' });
        }

        const { modelId, filePath: rawFilePath } = req.params;
        if (!validateIdForPath(modelId, 'model', res)) return;

        const safeRelative = sanitizeRelativePath(rawFilePath);
        if (!safeRelative) return res.status(400).json({ error: 'Invalid file path' });

        const rootDir = getRootDir();
        const modelBaseDir = path.join(rootDir, 'contents', 'models', 'stt', modelId);
        const realPath = await resolveAndValidateRealPath(safeRelative, modelBaseDir);
        if (!realPath) return res.status(404).json({ error: 'Model file not found' });

        let stat;
        try {
          stat = await fs.stat(realPath);
        } catch {
          return res.status(404).json({ error: 'Model file not found' });
        }
        if (!stat.isFile()) return res.status(404).json({ error: 'Model file not found' });

        const ext = path.extname(realPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const fileSize = stat.size;
        const rangeHeader = req.headers.range;

        if (rangeHeader) {
          const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
          if (!match) return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          if (start >= fileSize || end >= fileSize || start > end)
            return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=2592000, immutable'
          });
          return createReadStream(realPath, { start, end }).pipe(res);
        }

        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=2592000, immutable'
        });
        createReadStream(realPath).pipe(res);
      } catch (err) {
        logger.error('STT model serve error', {
          component: 'SttModelRoutes',
          error: err.message
        });
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      }
    }
  );
}
