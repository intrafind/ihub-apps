import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate to the demo HTML file
  const filePath = path.join(__dirname, 'tests', 'demo-ai-disclaimer-banner-fix.html');
  await page.goto(`file://${filePath}`);
  
  // Wait for page to load
  await page.waitForTimeout(1000);
  
  // Take screenshot
  await page.screenshot({ 
    path: 'ai-disclaimer-banner-fix-demo.png',
    fullPage: true 
  });
  
  console.log('Screenshot saved to ai-disclaimer-banner-fix-demo.png');
  
  await browser.close();
})();
