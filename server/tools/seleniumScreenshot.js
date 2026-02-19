import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import pdfParse from 'pdf-parse';

/**
 * Take a screenshot or generate a PDF of a web page using Selenium WebDriver
 * @param {Object} params - The screenshot parameters
 * @param {string} params.url - The URL to capture
 * @param {string} [params.format='png'] - Output format ('png' or 'pdf')
 * @param {boolean} [params.fullPage=true] - Whether to capture the full page
 * @param {string} [params.chatId='default'] - The chat ID for file storage
 * @returns {Promise<{attachmentId: string, type: string, text: string|undefined, downloadUrl: string}>} The screenshot result
 * @throws {Error} If URL is not provided or screenshot fails
 */
export default async function seleniumScreenshot({
  url,
  format = 'png',
  fullPage = true,
  chatId = 'default'
}) {
  if (!url) {
    throw new Error('url parameter is required');
  }
  const dataDir = config.DATA_DIR;
  const toolId = 'seleniumScreenshot';
  const ext = format === 'pdf' ? 'pdf' : 'png';
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const baseDir = path.join(getRootDir(), dataDir, 'chats', chatId, 'tools', toolId);
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, fileName);

  const options = new chrome.Options();
  options.addArguments('--headless', '--disable-gpu');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  try {
    await driver.get(url);
    if (format === 'pdf') {
      const session = await driver.getDevToolsSession();
      const { data } = await session.send('Page.printToPDF', { printBackground: true });
      await fs.writeFile(filePath, Buffer.from(data, 'base64'));
    } else {
      if (fullPage) {
        const height = await driver.executeScript('return document.body.scrollHeight');
        await driver
          .manage()
          .window()
          .setRect({ width: 1200, height: height + 100 });
      }
      const image = await driver.takeScreenshot();
      await fs.writeFile(filePath, image, 'base64');
    }
  } finally {
    await driver.quit();
  }

  let text;
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
