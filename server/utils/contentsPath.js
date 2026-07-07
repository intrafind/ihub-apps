import { join } from 'path';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';

export function getContentsPath(...segments) {
  return join(getRootDir(), config.CONTENTS_DIR, ...segments);
}
