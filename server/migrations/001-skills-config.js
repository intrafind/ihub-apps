/**
 * Migration 001 — Skills config
 *
 * Adds the `skills` section to contents/config/platform.json and
 * the `skills` feature flag to contents/config/features.json for
 * existing installations that pre-date the Agent Skills integration.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getRootDir } from '../pathUtils.js';

export const id = '001-skills-config';
export const describe = 'Add skills section to platform.json and skills flag to features.json';

const rootDir = getRootDir();
const contentsConfig = path.join(rootDir, 'contents', 'config');

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function run() {
  // ── 1. platform.json ──────────────────────────────────────────────────────
  const platformPath = path.join(contentsConfig, 'platform.json');
  try {
    const platform = await readJson(platformPath);

    if (!platform.skills) {
      platform.skills = {
        skillsDirectory: 'contents/skills',
        maxSkillBodyTokens: 5000
      };
      await writeJson(platformPath, platform);
      console.log('[001-skills-config] Added skills section to platform.json');
    }
  } catch (err) {
    // platform.json may not exist yet for fresh installs — that's fine,
    // copyDefaultConfiguration will create it from defaults (which already
    // include the skills section).
    if (err.code !== 'ENOENT') throw err;
    console.log('[001-skills-config] platform.json not found — skipping (fresh install)');
  }

  // ── 2. features.json ──────────────────────────────────────────────────────
  const featuresPath = path.join(contentsConfig, 'features.json');
  try {
    const features = await readJson(featuresPath);

    if (!('skills' in features)) {
      features.skills = false;
      await writeJson(featuresPath, features);
      console.log('[001-skills-config] Added skills flag to features.json');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.log('[001-skills-config] features.json not found — skipping (fresh install)');
  }
}
