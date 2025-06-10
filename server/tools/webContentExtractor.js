import { JSDOM } from 'jsdom';

/**
 * Extract clean, readable content from a web page
 * Removes headers, footers, navigation, ads, and other non-content elements
 */
export default async function webContentExtractor({ url, uri, link, maxLength = 5000 }) {
  // Accept various URL parameter names for flexibility
  const targetUrl = url || uri || link;
  
  if (!targetUrl) {
    throw new Error('url parameter is required (use "url", "uri", or "link")');
  }

  // Validate URL format
  let validUrl;
  try {
    validUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(validUrl.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported');
    }
  } catch (error) {
    throw new Error(`Invalid URL: ${error.message}`);
  }

  try {
    // Fetch the webpage with appropriate headers and timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch webpage: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Remove unwanted elements
    const unwantedSelectors = [
      'script', 'style', 'noscript', 'iframe', 'embed', 'object',
      'header', 'footer', 'nav', 'aside', 'menu',
      '.advertisement', '.ad', '.ads', '.sidebar', '.popup',
      '.cookie-banner', '.newsletter', '.social-share',
      '.related-articles', '.comments', '.pagination',
      '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
      '.header', '.footer', '.nav', '.navbar', '.menu', '.sidebar',
      '.ad-container', '.advertisement-container', '.sponsored',
      '.cookie-notice', '.gdpr-banner', '.privacy-notice'
    ];

    unwantedSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    });

    // Try to find the main content area
    let contentElement = null;
    const contentSelectors = [
      'main', 'article', '[role="main"]',
      '.content', '.main-content', '.article-content', '.post-content',
      '.entry-content', '.page-content', '.body-content',
      '#content', '#main-content', '#article-content'
    ];

    for (const selector of contentSelectors) {
      contentElement = document.querySelector(selector);
      if (contentElement) break;
    }

    // If no main content area found, use body but filter more aggressively
    if (!contentElement) {
      contentElement = document.body;
      
      // Remove more elements that are typically not main content
      const additionalUnwanted = [
        '.breadcrumb', '.breadcrumbs', '.tags', '.categories',
        '.meta', '.metadata', '.author-info', '.date',
        '.share-buttons', '.social-buttons', '.widget',
        '.promo', '.promotion', '.banner', '.alert'
      ];
      
      additionalUnwanted.forEach(selector => {
        const elements = contentElement.querySelectorAll(selector);
        elements.forEach(el => el.remove());
      });
    }

    if (!contentElement) {
      throw new Error('Could not find content in the webpage');
    }

    // Extract text content
    let textContent = contentElement.textContent || '';
    
    // Clean up the text
    textContent = textContent
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
      .trim();

    // Remove empty lines and excessive whitespace
    textContent = textContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // Truncate if too long
    if (textContent.length > maxLength) {
      textContent = textContent.substring(0, maxLength) + '...';
    }

    // Extract some metadata
    const title = document.querySelector('title')?.textContent?.trim() || '';
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
    const author = document.querySelector('meta[name="author"]')?.getAttribute('content')?.trim() || '';

    return {
      url: targetUrl,
      title: title,
      description: description,
      author: author,
      content: textContent,
      wordCount: textContent.split(/\s+/).length,
      extractedAt: new Date().toISOString()
    };

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - webpage took too long to load');
    }
    throw new Error(`Failed to extract content from webpage: ${error.message}`);
  }
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  
  if (!url) {
    console.error('Usage: node webContentExtractor.js <URL>');
    console.error('Example: node webContentExtractor.js "https://example.com/article"');
    process.exit(1);
  }
  
  console.log(`Extracting content from: ${url}`);
  
  try {
    const result = await webContentExtractor({ url });
    console.log('\nExtracted Content:');
    console.log('==================');
    console.log(`Title: ${result.title}`);
    console.log(`Description: ${result.description}`);
    console.log(`Author: ${result.author}`);
    console.log(`Word Count: ${result.wordCount}`);
    console.log(`Extracted At: ${result.extractedAt}`);
    console.log('\nContent:');
    console.log('--------');
    console.log(result.content);
  } catch (error) {
    console.error('Error extracting content:', error.message);
    process.exit(1);
  }
}
