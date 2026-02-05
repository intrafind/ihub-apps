import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { chromium } from 'playwright';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

/**
 * Take a screenshot or generate a PDF of a web page using Playwright
 * @param {Object} params - The screenshot parameters
 * @param {string} params.url - The URL to capture
 * @param {string} [params.format='png'] - Output format ('png' or 'pdf')
 * @param {boolean} [params.fullPage=true] - Whether to capture the full page
 * @param {string} [params.chatId='default'] - The chat ID for file storage
 * @returns {Promise<{attachmentId: string, type: string, text: string|undefined, downloadUrl: string}>} The screenshot result
 * @throws {Error} If URL is not provided or screenshot fails
 */
export default async function playwrightScreenshot({
  url,
  format = 'png',
  fullPage = true,
  chatId = 'default'
}) {
  if (!url) {
    throw new Error('url parameter is required');
  }
  const dataDir = config.DATA_DIR;
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

  let text;
  if (format === 'pdf') {
    const data = await fs.readFile(filePath);

    // Use pdfjs-dist to parse the PDF
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      verbosity: 0
    });

    const pdf = await loadingTask.promise;
    let fullText = '';

    // Extract text from all pages
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }

    text = fullText.trim();
  }

  return {
    attachmentId: fileName,
    type: format,
    text,
    downloadUrl: `/api/chat/${chatId}/tools/${toolId}/attachments/${fileName}`
  };
}
