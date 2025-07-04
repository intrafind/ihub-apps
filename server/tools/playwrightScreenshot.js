import fs from 'fs/promises';
import crypto from "crypto";
import path from 'path';
import { chromium } from 'playwright';
import pdfParse from 'pdf-parse';
import { getRootDir } from '../pathUtils.js';

export default async function playwrightScreenshot({ url, format = 'png', fullPage = true, chatId = 'default' }) {
  if (!url) {
    throw new Error('url parameter is required');
  }
  const dataDir = process.env.DATA_DIR || 'data';
  const toolId = 'playwrightScreenshot';
  const ext = format === 'pdf' ? 'pdf' : 'png';
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const baseDir = path.join(getRootDir(), dataDir, 'chats', chatId, 'tools', toolId);
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, fileName);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  if (format === 'pdf') {
    await page.pdf({ path: filePath, printBackground: true });
  } else {
    await page.screenshot({ path: filePath, fullPage });
  }
  await browser.close();

  let text = undefined;
  if (format === 'pdf') {
    const data = await fs.readFile(filePath);
    const parsed = await pdfParse(data);
    text = parsed.text.trim();
  }

  return {
    attachmentId: fileName,
    type: format,
    text,
    downloadUrl: `/api/chat/${chatId}/tools/${toolId}/attachments/${fileName}`
  };
}
