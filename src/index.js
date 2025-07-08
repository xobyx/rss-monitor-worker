// Enhanced Cloudflare Worker for RSS Feed Monitoring
// Improved error handling, logging, configuration, and code organization
// Configuration constants
const CONFIG = {
  TELEGRAM_MAX_LENGTH: 4096,
  SAFE_MESSAGE_LENGTH: 3800,
  MAX_CONTENT_LENGTH: 5000,
  MAX_RETRIES: 2,
  RETRY_DELAY_BASE: 1000,
  ITEM_TTL: 604800, // 7 days
  REQUEST_TIMEOUT: 30000,
  MESSAGE_DELAY: 1000,
  GEMINI_MAX_TOKENS: 2048,
  GEMINI_TEMPERATURE: 0.7
};

// Error classes for better error handling
class RSSError extends Error {
  constructor(message, code = 'RSS_ERROR') {
    super(message);
    this.name = 'RSSError';
    this.code = code;
  }
}

class TelegramError extends Error {
  constructor(message, code = 'TELEGRAM_ERROR') {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
  }
}

class GeminiError extends Error {
  constructor(message, code = 'GEMINI_ERROR') {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
  }
}

// Main worker export
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    try {
      // Validate environment variables
      validateEnvironment(env);
      
      // Route handling
      switch (url.pathname) {
        case '/check-rss':
          return await handleRSSCheck(env);
        case '/health':
          return new Response(JSON.stringify({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            version: '2.0'
          }), { 
            headers: { 'Content-Type': 'application/json' },
            status: 200 
          });
        case '/status':
          return await handleStatus(env);
        default:
          return new Response(JSON.stringify({
            service: 'RSS Monitor Worker',
            version: '2.0',
            endpoints: ['/check-rss', '/health', '/status']
          }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({
        error: error.message,
        code: error.code || 'UNKNOWN_ERROR'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event, env, ctx) {
    console.log('Scheduled RSS check triggered');
    ctx.waitUntil(handleRSSCheck(env));
  }
};

// MODIFIED: Updated environment validation to include Telegraph variables
function validateEnvironment(env) {
  const required = ['RSS_FEED_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY', 'RSS_STORAGE'];
  const optional = ['TELEGRAPH_ACCESS_TOKEN', 'TELEGRAPH_AUTHOR_NAME', 'TELEGRAPH_AUTHOR_URL'];
  
  const missing = required.filter(key => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // Log Telegraph configuration status
  if (env.TELEGRAPH_ACCESS_TOKEN) {
    console.log('Telegraph integration: ENABLED');
  } else {
    console.log('Telegraph integration: DISABLED (no access token)');
  }
}

// Status endpoint handler
async function handleStatus(env) {
  try {
    const stats = await getStorageStats(env);
    return new Response(JSON.stringify({
      status: 'operational',
      timestamp: new Date().toISOString(),
      storage_stats: stats
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    });
  } catch (error) {
    return new Response(JSON.stringify({
      status: 'error',
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get storage statistics
async function getStorageStats(env) {
  try {
    const keys = await env.RSS_STORAGE.list({ prefix: 'processed_item_' });
    return {
      processed_items: keys.keys.length,
      last_check: new Date().toISOString()
    };
  } catch (error) {
    console.warn('Could not get storage stats:', error);
    return { error: 'Stats unavailable' };
  }
}

// Main RSS check handler with improved error handling
async function handleRSSCheck(env) {
  const startTime = Date.now();
  
  try {
    console.log('Starting RSS check...');
    
    // Get the latest RSS item
    const latestItem = await getLatestRSSItem(env.RSS_FEED_URL);
    
    if (!latestItem) {
      console.log('No items found in RSS feed');
      return createResponse({ message: 'No items found' }, 200);
    }
    
    // Check if item is new
    const itemId = latestItem.guid || latestItem.link || generateItemId(latestItem);
    const {isNew,gemini_output} = await isItemNew(itemId, env);
    
    if (!isNew) {
      console.log('Item already processed:', itemId);
      return createResponse({ message: 'Item already processed', content :gemini_output}, 200);
    }
    
    console.log('Processing new item:', latestItem.title);
    
    // Process the new item
    const result = await processRSSItem(latestItem, env);
    
    // Mark as processed only if successful
    if (result.status === 'success') {
      await markItemAsProcessed(itemId, result, env);
    }
    
    const duration = Date.now() - startTime;
    console.log(`RSS check completed in ${duration}ms`);
    
    return createResponse({
      ...result,
      processing_time_ms: duration,
      item_id: itemId
    });
    
  } catch (error) {
    console.error('RSS check failed:', error);
    
    return createResponse({
      status: 'error',
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      processing_time_ms: Date.now() - startTime
    }, 500);
  }
}

// Helper function to create consistent responses
function createResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Generate item ID from content if no GUID/link available
function generateItemId(item) {
  const content = (item.title || '') + (item.description || '');
  return btoa(content.substring(0, 100)).replace(/[^a-zA-Z0-9]/g, '');
}

// Enhanced RSS fetching with better error handling
async function getLatestRSSItem(rssUrl) {
  try {
    console.log('Fetching RSS from:', rssUrl);
    
    const response = await fetchWithTimeout(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-Monitor/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new RSSError(`HTTP ${response.status}: ${response.statusText}`, 'HTTP_ERROR');
    }
    
    const xmlText = await response.text();
    
    if (!xmlText || xmlText.trim().length === 0) {
      throw new RSSError('Empty RSS feed received', 'EMPTY_FEED');
    }
    
    const items = parseRSSItems(xmlText);
    
    if (items.length === 0) {
      console.log('No items found in RSS feed');
      return null;
    }
    
    console.log(`Found ${items.length} items in RSS feed`);
    return items[0];
    
  } catch (error) {
    if (error instanceof RSSError) {
      throw error;
    }
    throw new RSSError(`Failed to fetch RSS: ${error.message}`, 'FETCH_ERROR');
  }
}

// Enhanced RSS parser with better error handling
function parseRSSItems(xmlText) {
  try {
    const items = [];
    
    // Support both RSS and Atom feeds
    const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || 
                       xmlText.match(/<entry[\s\S]*?<\/entry>/gi);
    
    if (!itemMatches) {
      console.log('No RSS items found in feed');
      return items;
    }
    
    for (const itemXml of itemMatches) {
      const item = parseRSSItem(itemXml);
      if (item && item.title) {
        items.push(item);
      }
    }
    
    // Sort by date (most recent first)
    return items.sort((a, b) => {
      const dateA = new Date(a.pubDate || 0);
      const dateB = new Date(b.pubDate || 0);
      return dateB - dateA;
    });
    
  } catch (error) {
    throw new RSSError(`Failed to parse RSS: ${error.message}`, 'PARSE_ERROR');
  }
}

// Parse individual RSS item
function parseRSSItem(itemXml) {
  return {
    title: extractXMLContent(itemXml, 'title'),
    link: extractXMLContent(itemXml, 'link'),
    description: extractXMLContent(itemXml, 'description') || 
                extractXMLContent(itemXml, 'summary') ||
                extractXMLContent(itemXml, 'content'),
    pubDate: extractXMLContent(itemXml, 'pubDate') || 
             extractXMLContent(itemXml, 'published') ||
             extractXMLContent(itemXml, 'updated'),
    guid: extractXMLContent(itemXml, 'guid') || 
          extractXMLContent(itemXml, 'id'),
    author: extractXMLContent(itemXml, 'author') ||
            extractXMLContent(itemXml, 'creator')
  };
}

// Enhanced XML content extraction
function extractXMLContent(xml, tag) {
  try {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'is');
    const match = xml.match(regex);
    
    if (match) {
      let content = match[1];
      
      // Handle CDATA
      content = content.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
      
      // For link tags, handle both text content and href attribute
      if (tag === 'link' && !content.trim()) {
        const hrefMatch = xml.match(new RegExp(`<${tag}[^>]*href="([^"]*)"`, 'i'));
        if (hrefMatch) {
          content = hrefMatch[1];
        }
      }
      
      // Clean HTML and decode entities
      content = content.replace(/<[^>]*>/g, '');
      content = decodeHTMLEntities(content);
      
      return content.trim();
    }
    
    return null;
  } catch (error) {
    console.warn(`Error extracting ${tag}:`, error);
    return null;
  }
}

// HTML entity decoder
function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' '
  };
  
  return text.replace(/&[#\w]+;/g, (entity) => {
    return entities[entity] || entity;
  });
}
function validateRSSItem(item) {
  if (!item) {
    throw new RSSError('RSS item is null or undefined', 'INVALID_ITEM');
  }
  
  if (!item.title || item.title.trim().length === 0) {
    throw new RSSError('RSS item missing title', 'MISSING_TITLE');
  }
  
  if (!item.link || item.link.trim().length === 0) {
    throw new RSSError('RSS item missing link', 'MISSING_LINK');
  }
  
  // Validate URL format
  try {
    new URL(item.link);
  } catch (error) {
    throw new RSSError('RSS item has invalid URL format', 'INVALID_URL');
  }
  
  return true;
}

// MODIFIED: Enhanced item processing with Telegraph support
async function processRSSItem(item, env) {
  try {
    console.log('Processing RSS item:', item.title);
    validateRSSItem(item);
    let content;
    
    // Try Gemini with URL context first
    try {
      console.log('Attempting Gemini with URL context...');
      const mprompt = getPrompt(item.link);
      content = await makeGeminiRequestWithRetry(mprompt, env.GEMINI_API_KEY, true);
      
      console.log('Successfully processed with Gemini URL context');
    } catch (urlError) {
      console.log('Gemini URL context failed, trying manual extraction...', urlError.message);
      
      // Fallback to manual html extraction
      const articleContent = await extractContentFromUrl(item.link);
      const prompt = createGeminiPrompt(item.link, articleContent);
      
      content = await makeGeminiRequestWithRetry(prompt, env.GEMINI_API_KEY);
      
      console.log('Successfully processed with manual extraction');
    }
    
    // Process and clean content
    const processedContent = processContent(content);
    
    // Create Telegraph page if access token is available
    let telegraphResult = null;
    if (env.TELEGRAPH_ACCESS_TOKEN) {
      try {
        console.log('Creating Telegraph page...');
        
        const title = extractTitleFromContent(content);
        const telegraphContent = convertToTelegraphFormat(content);
        
        const telegraphPage = await createTelegraphPage(
          env.TELEGRAPH_ACCESS_TOKEN,
          title,
          telegraphContent,
          env.TELEGRAPH_AUTHOR_NAME || 'RSS Monitor',
          env.TELEGRAPH_AUTHOR_URL || ''
        );
        
        telegraphResult = {
          success: true,
          url: telegraphPage.url,
          path: telegraphPage.path,
          title: telegraphPage.title
        };
        
        console.log('Telegraph page created:', telegraphPage.url);
      } catch (telegraphError) {
        console.warn('Telegraph page creation failed:', telegraphError.message);
        telegraphResult = { 
          success: false, 
          error: telegraphError.message 
        };
      }
    }
    
    // Send to Telegram with Telegraph link if available
    const telegramResults = await sendToTelegramWithRateLimit(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      processedContent.messages,
      item,
      telegraphResult // Pass Telegraph result
    );
    
    return {
      status: 'success',
      item_title: item.title,
      content_length: content.length,
      telegram_results: telegramResults,
      telegraph_result: telegraphResult,
      processed_at: new Date().toISOString(),
      gemini_output: content
    };
    
  } catch (error) {
    console.error('Error processing RSS item:', error);
    return {
      status: 'error',
      error: error.message,
      code: error.code || 'PROCESSING_ERROR',
      item_title: item.title || 'Unknown',
      gemini_output: content || 'no Gemini output'
    };
  }
}

// Extract content from Gemini response
async function extractGeminiContent(res) {
  const response= await res.json();
  if (!response.candidates || response.candidates.length === 0) {
    throw new GeminiError('No candidates in Gemini response', 'NO_CANDIDATES');
  }
  
  
  const candidate = response.candidates[0];
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new GeminiError('No content in Gemini response', 'NO_CONTENT');
  }
  if (candidate.content.parts[0].text.toLowerCase().includes("###error1###"))
  {
    throw new GeminiError('fail to get article using url_context', 'URL_CONTEXT_FAIL');
  }
  if (candidate.content.parts[0].text.toLowerCase().includes("###error2###"))
  {
    throw new GeminiError('fail to get article using html content', 'HTML_CONTENT_FAIL');
  }
  return candidate.content.parts[0].text;
}

// Create Gemini prompt
function createGeminiPrompt(url, articleContent) {
  return `
Rewrite the article found below into a professional and comprehensive article in Modern Standard Arabic. The article should cover the topic thoroughly, utilizing subheadings to organize ideas and enhance readability.

Requirements:

1. **Title:** Begin the article with an engaging and professional Arabic title using \`<b>\` tag that accurately reflects its content.

2. **Language and Tone:** Write in clear, professional, and contemporary Modern Standard Arabic, suitable for specialized articles.

3. **HTML Formatting:** Use ONLY the following Telegram-supported HTML tags:
   - \`<b>bold</b>\` or \`<strong>bold</strong>\` for bold text
   - \`<i>italic</i>\` or \`<em>italic</em>\` for italic text
   - \`<u>underline</u>\` or \`<ins>underline</ins>\` for underlined text
   - \`<s>strikethrough</s>\` or \`<strike>strikethrough</strike>\` or \`<del>strikethrough</del>\` for strikethrough
   - \`<code>inline code</code>\` for inline monospace text
   - \`<pre>preformatted text</pre>\` for code blocks
   - \`<blockquote>quoted text</blockquote>\` for quotations
   - \`<a href="URL">link text</a>\` for hyperlinks

4. **HTML Entity Escaping:** All \`<\`, \`>\`, and \`&\` symbols that are NOT part of HTML tags MUST be replaced with:
   - \`<\` → \`&lt;\`
   - \`>\` → \`&gt;\`
   - \`&\` → \`&amp;\`
   - \`"\` → \`&quot;\` (if needed in attributes)

5. **Content and Length:** 
   - Maximum 4096 characters (Telegram's message limit)
   - Highly informative content covering all key aspects from the provided URL
   - Well-structured and comprehensive

6. **Structure:**
   - Use 2-4 clear Arabic subheadings with \`<b>\` or \`<u>\` tags
   - Separate paragraphs with double line breaks (\`\\n\\n\`)
   - Logical flow of information

7. **Links:** Format any references using \`<a href="URL">descriptive Arabic text</a>\`

8. **Technical Terms:** Include English terms in parentheses after Arabic translation on first mention for clarity: \`المصطلح العربي (English Term)\`

9. **Hashtags:** End with 3-5 relevant Arabic hashtags using \`<code>\` tags:
   - Use underscores instead of spaces: \`<code>#الذكاء_الاصطناعي</code>\`
   - Separate hashtags with single spaces
   - Example: \`<code>#تقنية #ذكاء_اصطناعي #تطوير</code>\`

Output Format:
- Begin immediately with the Arabic title in \`<b>\` tags
- No introductory phrases or explanations
- End strictly with the final hashtag in \`<code>\` tags
- Ensure all text is properly escaped for HTML entities

Error Handling:
If unable to process the URL or generate the article, respond with ONLY: \`###error2###\`


Source URL: ${url} (reference only)

Article content:
${articleContent}

`.trim();
}

// Process content for Telegram
function processContent(content) {
  let processedOutput = content.trim();
        
        // Remove ```html at the beginning and ``` at the end
  if (processedOutput.startsWith('```html')) {
     processedOutput = processedOutput.replace(/^```html\n?/, '');
  }
  if (processedOutput.endsWith('```')) {
      processedOutput = processedOutput.replace(/\n?```$/, '');
  }
        
        // Trim again after removing code blocks
  processedOutput = processedOutput.trim();
  //const { title, rest } = extractTitle(cleanedContent);
  //const hashtags = extractHashtags(cleanedContent);
  const messages = splitMessageSmart(processedOutput);
  
  return {
    //title,
    //hashtags,
    messages,
    original_length: content.length
  };
}

// Enhanced content extraction with better error handling
async function extractContentFromUrl(url) {
  return await retryOperation(async () => {
    console.log('Extracting content from URL:', url);
    
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    if (!html || html.trim().length === 0) {
      throw new Error('Empty response received');
    }
    
    const content = extractMainContent(html);
    
    if (!content || content.trim().length < 100) {
      throw new Error('Insufficient content extracted');
    }
    
    return content.substring(0, CONFIG.MAX_CONTENT_LENGTH);
  });
}

// Generic retry operation helper
async function retryOperation(operation, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.log(`Operation attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = CONFIG.RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError;
}

// Fetch with timeout
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Enhanced main content extraction
function extractMainContent(html) {
  try {
    // Remove unwanted elements more thoroughly
    let cleanHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<div[^>]*class="[^"]*(?:sidebar|menu|advertisement|ads|related|comments|social|share)[^"]*"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*id="[^"]*(?:sidebar|menu|advertisement|ads|related|comments|social|share)[^"]*"[\s\S]*?<\/div>/gi, '');
    
    // Enhanced content selectors with priority order
    const contentSelectors = [
      // Article tags (highest priority)
      /<article[\s\S]*?<\/article>/gi,
      // Main content areas
      /<main[\s\S]*?<\/main>/gi,
      /<div[^>]*class="[^"]*(?:post-content|entry-content|article-content|main-content|content-body)[^"]*"[\s\S]*?<\/div>/gi,
      // ID-based selectors
      /<div[^>]*id="[^"]*(?:content|main|article|post|entry)[^"]*"[\s\S]*?<\/div>/gi,
      // Role-based selectors
      /<div[^>]*role="main"[\s\S]*?<\/div>/gi,
      /<section[^>]*role="main"[\s\S]*?<\/section>/gi,
      // Fallback to any content-like div
      /<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/gi
    ];
    
    let extractedContent = '';
    
    // Try each selector in order
    for (const selector of contentSelectors) {
      const matches = cleanHtml.match(selector);
      if (matches && matches.length > 0) {
        // Find the longest match (likely the main content)
        extractedContent = matches.reduce((longest, current) => 
          current.length > longest.length ? current : longest, '');
        
        // If we found substantial content, use it
        if (extractedContent.length > 500) {
          break;
        }
      }
    }
    
    // Strategy 2: Extract paragraphs if no main content found
    if (!extractedContent || extractedContent.length < 200) {
      const paragraphs = cleanHtml.match(/<p[\s\S]*?<\/p>/gi) || [];
      if (paragraphs.length > 0) {
        extractedContent = paragraphs.join('\n');
      }
    }
    
    // Strategy 3: Try to extract from common news site structures
    if (!extractedContent || extractedContent.length < 200) {
      const newsSelectors = [
        /<div[^>]*class="[^"]*(?:story|news|article)[^"]*"[\s\S]*?<\/div>/gi,
        /<section[^>]*class="[^"]*(?:story|news|article)[^"]*"[\s\S]*?<\/section>/gi
      ];
      
      for (const selector of newsSelectors) {
        const matches = cleanHtml.match(selector);
        if (matches && matches.length > 0) {
          extractedContent = matches[0];
          break;
        }
      }
    }
    
    // Strategy 4: Last resort - extract all text
    if (!extractedContent || extractedContent.length < 100) {
      extractedContent = cleanHtml;
    }
    
    // Clean up extracted content
    const cleanedContent = cleanTextContent(extractedContent);
    
    // Final validation
    if (!cleanedContent || cleanedContent.length < 100) {
      throw new Error('Insufficient content extracted from HTML');
    }
    
    return cleanedContent;
    
  } catch (error) {
    console.error('Error extracting main content:', error);
    throw new Error(`Content extraction failed: ${error.message}`);
  }
}

// Clean text content helper
function cleanTextContent(htmlContent) {
  return htmlContent
    .replace(/<[^>]*>/g, ' ')  // Remove HTML tags
    .replace(/&nbsp;/g, ' ')  // Replace &nbsp;
    .replace(/&amp;/g, '&')   // Decode entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .replace(/^(Advertisement|Sponsored|Related:|Share this:|Tags:|Categories:|Read more|Continue reading|Click here).*$/gm, '')
    .replace(/^\s*\n/gm, '')  // Remove empty lines
    .trim();
}
 function getPrompt(url){
   return `
Rewrite the article found at the link below into a professional and comprehensive article in Modern Standard Arabic. The article should cover the topic thoroughly, utilizing subheadings to organize ideas and enhance readability.

Requirements:

1. **Title:** Begin the article with an engaging and professional Arabic title using \`<b>\` tag that accurately reflects its content.

2. **Language and Tone:** Write in clear, professional, and contemporary Modern Standard Arabic, suitable for specialized articles.

3. **HTML Formatting:** Use ONLY the following Telegram-supported HTML tags:
   - \`<b>bold</b>\` or \`<strong>bold</strong>\` for bold text
   - \`<i>italic</i>\` or \`<em>italic</em>\` for italic text
   - \`<u>underline</u>\` or \`<ins>underline</ins>\` for underlined text
   - \`<s>strikethrough</s>\` or \`<strike>strikethrough</strike>\` or \`<del>strikethrough</del>\` for strikethrough
   - \`<code>inline code</code>\` for inline monospace text
   - \`<pre>preformatted text</pre>\` for code blocks
   - \`<blockquote>quoted text</blockquote>\` for quotations
   - \`<a href="URL">link text</a>\` for hyperlinks

4. **HTML Entity Escaping:** All \`<\`, \`>\`, and \`&\` symbols that are NOT part of HTML tags MUST be replaced with:
   - \`<\` → \`&lt;\`
   - \`>\` → \`&gt;\`
   - \`&\` → \`&amp;\`
   - \`"\` → \`&quot;\` (if needed in attributes)

5. **Content and Length:** 
   - Maximum 4096 characters (Telegram's message limit)
   - Highly informative content covering all key aspects from the provided URL
   - Well-structured and comprehensive

6. **Structure:**
   - Use 2-4 clear Arabic subheadings with \`<b>\` or \`<u>\` tags
   - Separate paragraphs with double line breaks (\`\\n\\n\`)
   - Logical flow of information

7. **Links:** Format any references using \`<a href="URL">descriptive Arabic text</a>\`

8. **Technical Terms:** Include English terms in parentheses after Arabic translation on first mention for clarity: \`المصطلح العربي (English Term)\`

9. **Hashtags:** End with 3-5 relevant Arabic hashtags using \`<code>\` tags:
   - Use underscores instead of spaces: \`<code>#الذكاء_الاصطناعي</code>\`
   - Separate hashtags with single spaces
   - Example: \`<code>#تقنية #ذكاء_اصطناعي #تطوير</code>\`

Output Format:
- Begin immediately with the Arabic title in \`<b>\` tags
- No introductory phrases or explanations
- End strictly with the final hashtag in \`<code>\` tags
- Ensure all text is properly escaped for HTML entities

Error Handling:
If unable to process the URL or generate the article, respond with ONLY: \`###error1###\`

URL: ${url}
`.trim();
 }
// Enhanced Gemini API calls


// Enhanced Gemini request with retry
async function makeGeminiRequestWithRetry(prompt, apiKey,use_context) {
  return await retryOperation(async () => {
    const response = await makeGeminiRequest(prompt, apiKey,use_context);
    
    
    
    return response;
  });
}

// Basic Gemini request
async function makeGeminiRequest(prompt, apiKey,use_url_context=false) {
  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: CONFIG.GEMINI_TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
      
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };
  
  if (use_url_context) {
    payload.tools = [{
      url_context: {}
    }];
  }
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new GeminiError(`API error: ${response.status} - ${errorText}`, 'API_ERROR');
  }
  
  
  const content = await extractGeminiContent(response);
  
  return content 
}

// Enhanced Telegram messaging
// MODIFIED: Enhanced Telegram messaging with Telegraph link support
async function sendToTelegramWithRateLimit(botToken, chatId, messages, item, telegraphResult = null) {
  const results = [];
  const maxRequestsPerMinute = 20; // Telegram limit
  const delayBetweenRequests = Math.max(CONFIG.MESSAGE_DELAY, 60000 / maxRequestsPerMinute);
  
  for (let i = 0; i < messages.length; i++) {
    const startTime = Date.now();
    
    try {
      // Prepare inline keyboard
      const inlineKeyboard = [];
      
      // Add original link button
      if (item.link) {
        inlineKeyboard.push([{ 
          text: item.title || "المقال الأصلي", 
          url: item.link 
        }]);
      }
      
      // Add Telegraph link button if available
      if (telegraphResult && telegraphResult.success && telegraphResult.url) {
        inlineKeyboard.push([{ 
          text: "📖 اقرأ على Telegraph", 
          url: telegraphResult.url 
        }]);
      }
      
      const requestBody = {
        chat_id: chatId,
        text: messages[i],
        parse_mode: 'HTML',
        reply_to_message_id: 10913,
        disable_web_page_preview: true
      };
      
      // Add inline keyboard if we have buttons
      if (inlineKeyboard.length > 0) {
        requestBody.reply_markup = {
          inline_keyboard: inlineKeyboard
        };
      }
      
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );
      
      const responseData = await response.json();
      const duration = Date.now() - startTime;
      
      results.push({
        message_index: i,
        status: response.ok ? 'success' : 'failed',
        response: responseData,
        duration_ms: duration,
        telegraph_included: telegraphResult && telegraphResult.success
      });
      
      if (!response.ok) {
        console.error(`Telegram message ${i} failed:`, responseData);
        
        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = responseData.parameters?.retry_after || 60;
          console.log(`Rate limited. Waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        }
        
        console.log(`Telegram message ${i} : send unformatted text`);
        const nm = messages.map(msg => cleanHtmlForDisplay(msg));
        await sendToTelegramWithRateLimit(botToken, chatId, nm, item, telegraphResult);
      }
      
      logOperation('telegram_send', {
        message_index: i,
        status: response.ok ? 'success' : 'failed',
        message_length: messages[i].length,
        telegraph_included: telegraphResult && telegraphResult.success
      }, duration);
      
      // Rate limiting delay
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
      }
      
    } catch (error) {
      console.error(`Telegram message ${i} error:`, error);
      results.push({
        message_index: i,
        status: 'error',
        error: error.message
      });
      
      logOperation('telegram_error', {
        message_index: i,
        error: error.message
      });
    }
  }
  
  return results;
}

// Enhanced site posting
async function postToSite(content, title, tags, env) {
  try {
    const postData = {
      content,
      title,
      tags,
      timestamp: Math.floor(Date.now() / 1000),
      source: 'rss_monitor'
    };
    
    const response = await fetchWithTimeout("https://nuxt-drk.pages.dev/api/posts", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SITE_AUTH_TOKEN}`
      },
      body: JSON.stringify(postData)
    });
    
    if (response.ok) {
      const result = await response.json();
      return {
        success: true,
        stored_key: result.body?.stored_key,
        title,
        tags,
        timestamp: postData.timestamp
      };
    } else {
      const errorText = await response.text();
      return {
        success: false,
        error: `API error: ${response.status} - ${errorText}`,
        status_code: response.status
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Storage operations
async function isItemNew(itemId, env) {
  try {
    const key = `processed_item_${itemId}`;
    
    const value = await env.RSS_STORAGE.get(key, { type: 'json' });
    
    return {
      isNew: value === null,
      gemini_output: value === null ? 'not available' : (value.gemini_output || 'not available')
    };
  } catch (error) {
    console.error('Error checking item status:', error);
    return { isNew: true, gemini_output: null }; // Assume new if we can't check
  }
}

async function markItemAsProcessed(itemId,result, env) {
  try {
    const key = `processed_item_${itemId}`;
    await env.RSS_STORAGE.put(key, JSON.stringify({
      processed_at: new Date().toISOString(),
      item_id: itemId,
      gemini_output: result.gemini_output|| 'not available'
    }), { expirationTtl: CONFIG.ITEM_TTL });
  } catch (error) {
    console.error('Error marking item as processed:', error);
  }
}

// Text processing utilities
function splitMessageSmart(text, maxLength = CONFIG.SAFE_MESSAGE_LENGTH) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const messages = [];
  let currentMessage = "";
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      // Split long paragraphs by sentences
      const sentences = paragraph.split(/[.!?]+\s+/);
      for (const sentence of sentences) {
        if (!sentence.trim()) continue;
        
        const sentenceWithPunctuation = sentence + (sentence.match(/[.!?]$/) ? '' : '.');
        
        if ((currentMessage + sentenceWithPunctuation).length > maxLength) {
          if (currentMessage.trim()) {
            messages.push(currentMessage.trim());
            currentMessage = sentenceWithPunctuation;
          } else {
            // Single sentence is too long, truncate it
            messages.push(sentence.substring(0, maxLength - 3) + '...');
          }
        } else {
          currentMessage += (currentMessage ? ' ' : '') + sentenceWithPunctuation;
        }
      }
    } else {
      if ((currentMessage + '\n\n' + paragraph).length > maxLength) {
        if (currentMessage.trim()) {
          messages.push(currentMessage.trim());
          currentMessage = paragraph;
        } else {
          messages.push(paragraph);
        }
      } else {
        currentMessage += (currentMessage ? '\n\n' : '') + paragraph;
      }
    }
  }
  
  if (currentMessage.trim()) {
    messages.push(currentMessage.trim());
  }
  
  return messages.filter(msg => msg.trim().length > 0);
}


function extractTitle(text) {
  const lines = text.trim().split('\n').filter(line => line.trim());
  if (lines.length === 0) return { title: 'بدون عنوان', rest: '' };
  
  const firstLine = lines[0].replace(/[#*_`]/g, '').trim();
  const title = firstLine || 'بدون عنوان';
  const rest = lines.slice(1).join('\n').trim();
  
  return { title, rest };
}

function extractHashtags(text) {
  // Extract Arabic and English hashtags
  const hashtags = text.match(/#[\u0600-\u06FF\w]+/g) || [];
  return [...new Set(hashtags)]; // Remove duplicates
}

function logOperation(operation, data, duration = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    operation,
    data,
    duration_ms: duration
  };
  
  console.log(`[${operation}]`, JSON.stringify(logEntry));
}



// Clean HTML for display (remove HTML tags)
function cleanHtmlForDisplay(html) {
    return html
        .replace(/<[^>]*>/g, '') // Remove all HTML tags
        .replace(/&nbsp;/g, ' ') // Replace HTML entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
}


// NEW: Telegraph API integration functions

// Create Telegraph account (call once to get access token)
async function createTelegraphAccount(shortName, authorName, authorUrl = '') {
  try {
    const response = await fetch('https://api.telegra.ph/createAccount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        short_name: shortName,
        author_name: authorName,
        author_url: authorUrl
      })
    });
    
    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegraph account creation failed: ${data.error}`);
    }
    
    return data.result;
  } catch (error) {
    throw new Error(`Telegraph account creation error: ${error.message}`);
  }
}

// Create Telegraph page
async function createTelegraphPage(accessToken, title, content, authorName = '', authorUrl = '') {
  try {
    const response = await fetch('https://api.telegra.ph/createPage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: accessToken,
        title: title,
        content: content,
        author_name: authorName,
        author_url: authorUrl,
        return_content: false
      })
    });
    
    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegraph page creation failed: ${data.error}`);
    }
    
    return data.result;
  } catch (error) {
    throw new Error(`Telegraph page creation error: ${error.message}`);
  }
}

// Convert HTML content to Telegraph format
// Telegraph.ph compatible HTML string parser for Cloudflare Workers
function convertToTelegraphFormat(htmlContent) {
  const telegraphContent = [];
  
  // Split content into paragraphs and headings
  const elements = htmlContent.split(/\n\n+/);
  
  for (const element of elements) {
    const trimmed = element.trim();
    if (!trimmed) continue;
    
    // Check if it's a heading (starts with <b> or <u>)
    if (trimmed.match(/^<[bu]>/i)) {
      telegraphContent.push({
        tag: 'h3',
        children: parseInlineHTML(cleanTextForTelegraph(trimmed))
      });
    } 
    // Check if it's a blockquote
    else if (trimmed.match(/^<blockquote>/i)) {
      telegraphContent.push({
        tag: 'blockquote',
        children: parseInlineHTML(cleanTextForTelegraph(trimmed))
      });
    }
    // Check if it's code block
    else if (trimmed.match(/^<pre>/i)) {
      telegraphContent.push({
        tag: 'pre',
        children: parseInlineHTML(cleanTextForTelegraph(trimmed))
      });
    }
    // Regular paragraph
    else {
      telegraphContent.push({
        tag: 'p',
        children: parseInlineHTML(cleanTextForTelegraph(trimmed))
      });
    }
  }
  
  return telegraphContent;
}

// Parse inline HTML elements within text
function parseInlineHTML(htmlString) {
  const result = [];
  let html = htmlString.trim();
  
  // Handle simple cases where there's no HTML
  if (!html.includes('<')) {
    return [html];
  }
  
  const tagRegex = /<(\/?)(b|strong|i|em|u|s|code|a)([^>]*)>/g;
  let lastIndex = 0;
  let match;
  const tagStack = [];
  
  while ((match = tagRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const attributes = match[3];
    const startPos = match.index;
    
    // Add text before this tag
    if (startPos > lastIndex) {
      const textContent = html.substring(lastIndex, startPos);
      if (textContent.trim()) {
        if (tagStack.length > 0) {
          const currentNode = tagStack[tagStack.length - 1];
          if (!currentNode.children) currentNode.children = [];
          currentNode.children.push(textContent);
        } else {
          result.push(textContent);
        }
      }
    }
    
    if (isClosing) {
      // Close tag
      if (tagStack.length > 0) {
        const closedNode = tagStack.pop();
        if (tagStack.length > 0) {
          const parentNode = tagStack[tagStack.length - 1];
          if (!parentNode.children) parentNode.children = [];
          parentNode.children.push(closedNode);
        } else {
          result.push(closedNode);
        }
      }
    } else {
      // Open tag
      const nodeElement = { tag: tagName };
      
      // Parse attributes for links
      if (tagName === 'a' && attributes) {
        const hrefMatch = attributes.match(/href\s*=\s*["']([^"']+)["']/i);
        if (hrefMatch) {
          nodeElement.attrs = { href: hrefMatch[1] };
        }
      }
      
      tagStack.push(nodeElement);
    }
    
    lastIndex = tagRegex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < html.length) {
    const remainingText = html.substring(lastIndex);
    if (remainingText.trim()) {
      if (tagStack.length > 0) {
        const currentNode = tagStack[tagStack.length - 1];
        if (!currentNode.children) currentNode.children = [];
        currentNode.children.push(remainingText);
      } else {
        result.push(remainingText);
      }
    }
  }
  
  // Close any remaining open tags
  while (tagStack.length > 0) {
    const unclosedNode = tagStack.pop();
    if (tagStack.length > 0) {
      const parentNode = tagStack[tagStack.length - 1];
      if (!parentNode.children) parentNode.children = [];
      parentNode.children.push(unclosedNode);
    } else {
      result.push(unclosedNode);
    }
  }
  
  return result.length > 0 ? result : [html];
}

// Clean text for Telegraph (preserve some HTML tags)
function cleanTextForTelegraph(text) {
  // Telegraph supports: a, aside, b, blockquote, br, code, em, figcaption, figure, h3, h4, hr, i, iframe, img, li, ol, p, pre, s, strong, u, ul, video
  // Remove unsupported tags but keep supported ones
  return text
    .replace(/<\/?(strike|del|ins)>/gi, '') // Remove unsupported tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}


// Extract title from HTML content
function extractTitleFromContent(content) {
  const titleMatch = content.match(/<b>(.*?)<\/b>/i);
  if (titleMatch) {
    return cleanTextForTelegraph(titleMatch[1]).substring(0, 100); // Telegraph title limit
  }
  
  // Fallback: use first 50 characters
  const plainText = content.replace(/<[^>]*>/g, '').trim();
  return plainText.substring(0, 50) + (plainText.length > 50 ? '...' : '');
}
