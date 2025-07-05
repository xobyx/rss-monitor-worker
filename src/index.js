// Enhanced Cloudflare Worker for RSS Feed Monitoring
// Improved error handling, logging, configuration, and code organization

// Configuration constants
const CONFIG = {
  TELEGRAM_MAX_LENGTH: 4096,
  SAFE_MESSAGE_LENGTH: 3800,
  MAX_CONTENT_LENGTH: 5000,
  MAX_RETRIES: 3,
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

// Environment validation
function validateEnvironment(env) {
  const required = ['RSS_FEED_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY', 'RSS_STORAGE'];
  const missing = required.filter(key => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
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
    const isNew = await isItemNew(itemId, env);
    
    if (!isNew) {
      console.log('Item already processed:', itemId);
      return createResponse({ message: 'Item already processed' }, 200);
    }
    
    console.log('Processing new item:', latestItem.title);
    
    // Process the new item
    const result = await processRSSItem(latestItem, env);
    
    // Mark as processed only if successful
    if (result.status === 'success') {
      await markItemAsProcessed(itemId, env);
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

// Enhanced item processing with better error handling
async function processRSSItem(item, env) {
  try {
    console.log('Processing RSS item:', item.title);
    
    let content;
    
    // Try Gemini with URL context first
    try {
      console.log('Attempting Gemini with URL context...');
      const response = await makeGeminiRequestWithUrlContext(item.link, env.GEMINI_API_KEY);
      content = extractGeminiContent(response);
      console.log('Successfully processed with Gemini URL context');
    } catch (urlError) {
      console.log('Gemini URL context failed, trying manual extraction...', urlError.message);
      
      // Fallback to manual extraction
      const articleContent = await extractContentFromUrl(item.link);
      const prompt = createGeminiPrompt(item.link, articleContent);
      
      const response = await makeGeminiRequestWithRetry(prompt, env.GEMINI_API_KEY);
      content = extractGeminiContent(response);
      console.log('Successfully processed with manual extraction');
    }
    
    // Process and clean content
    const processedContent = processContent(content);
    
    // Send to Telegram
    const telegramResults = await sendToTelegram(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      processedContent.messages
    );
    
    // Post to site (if enabled)
    let siteResult = null;
    if (env.SITE_AUTH_TOKEN) {
      try {
        siteResult = await postToSite(
          content,
          processedContent.title,
          processedContent.hashtags,
          env
        );
      } catch (siteError) {
        console.warn('Site posting failed:', siteError.message);
        siteResult = { success: false, error: siteError.message };
      }
    }
    
    return {
      status: 'success',
      item_title: item.title,
      content_length: content.length,
      telegram_results: telegramResults,
      site_result: siteResult,
      processed_at: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error processing RSS item:', error);
    return {
      status: 'error',
      error: error.message,
      code: error.code || 'PROCESSING_ERROR',
      item_title: item.title || 'Unknown'
    };
  }
}

// Extract content from Gemini response
function extractGeminiContent(response) {
  if (!response.candidates || response.candidates.length === 0) {
    throw new GeminiError('No candidates in Gemini response', 'NO_CANDIDATES');
  }
  
  const candidate = response.candidates[0];
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new GeminiError('No content in Gemini response', 'NO_CONTENT');
  }
  
  return candidate.content.parts[0].text;
}

// Create Gemini prompt
function createGeminiPrompt(url, articleContent) {
  return `
Rewrite the following article in professional Modern Standard Arabic following these guidelines:

1. Start with an engaging Arabic title
2. Write in clear, professional Modern Standard Arabic
3. Use minimal formatting (plain text preferred)
4. Keep content concise but informative (max 3000 characters)
5. Include a brief summary section at the end
6. Add 3-5 relevant Arabic hashtags at the end

Source URL: ${url}

Article content:
${articleContent}

Return only the formatted article with hashtags.
`.trim();
}

// Process content for Telegram
function processContent(content) {
  const cleanedContent = cleanMarkdownForTelegram(content);
  const { title, rest } = extractTitle(cleanedContent);
  const hashtags = extractHashtags(rest);
  const messages = splitMessageSmart(rest);
  
  return {
    title,
    hashtags,
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
    // Remove unwanted elements
    let cleanHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<div[^>]*class="[^"]*(?:sidebar|menu|advertisement|ads|related|comments)[^"]*"[\s\S]*?<\/div>/gi, '');
    
    // Strategy 1: Look for main content containers
    const contentSelectors = [
      /<article[\s\S]*?<\/article>/gi,
      /<main[\s\S]*?<\/main>/gi,
      /<div[^>]*class="[^"]*(?:content|post-content|entry-content|article-content|main-content|post-body|entry)[^"]*"[\s\S]*?<\/div>/gi,
      /<div[^>]*id="[^"]*(?:content|main|article|post)[^"]*"[\s\S]*?<\/div>/gi,
      /<div[^>]*role="main"[\s\S]*?<\/div>/gi,
      /<section[^>]*role="main"[\s\S]*?<\/section>/gi
    ];
    
    let extractedContent = '';
    
    for (const selector of contentSelectors) {
      const matches = cleanHtml.match(selector);
      if (matches && matches.length > 0) {
        extractedContent = matches.reduce((longest, current) => 
          current.length > longest.length ? current : longest, '');
        break;
      }
    }
    
    // Strategy 2: Extract paragraphs if no main content found
    if (!extractedContent || extractedContent.length < 200) {
      const paragraphs = cleanHtml.match(/<p[\s\S]*?<\/p>/gi) || [];
      extractedContent = paragraphs.join('\n');
    }
    
    // Strategy 3: Last resort - extract all text
    if (!extractedContent || extractedContent.length < 100) {
      extractedContent = cleanHtml;
    }
    
    // Clean up extracted content
    return cleanTextContent(extractedContent);
    
  } catch (error) {
    console.error('Error extracting main content:', error);
    throw error;
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

// Enhanced Gemini API calls
async function makeGeminiRequestWithUrlContext(url, apiKey) {
  const payload = {
    contents: [{
      role: "user",
      parts: [{
        text: `
Rewrite the article at this URL in professional Modern Standard Arabic:

1. Start with an engaging Arabic title
2. Write in clear, professional Modern Standard Arabic
3. Use minimal formatting (plain text preferred)
4. Keep content concise but informative (max 3000 characters)
5. Include a brief summary section
6. Add 3-5 relevant Arabic hashtags at the end

URL: ${url}

Return only the formatted article with hashtags.
        `.trim()
      }]
    }],
    
    generationConfig: {
      temperature: CONFIG.GEMINI_TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
      responseMimeType: "text/plain",
      thinkingConfig: {
        thinkingBudget: 0
      }
    },
    tools: [{ urlContext: {} }]
  };
  
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new GeminiError(`URL context API error: ${response.status} - ${errorText}`, 'API_ERROR');
  }
  
  return await response.json();
}

// Enhanced Gemini request with retry
async function makeGeminiRequestWithRetry(prompt, apiKey) {
  return await retryOperation(async () => {
    const response = await makeGeminiRequest(prompt, apiKey);
    
    if (!response.candidates || response.candidates.length === 0) {
      throw new GeminiError('Invalid response structure', 'INVALID_RESPONSE');
    }
    
    return response;
  });
}

// Basic Gemini request
async function makeGeminiRequest(prompt, apiKey) {
  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: CONFIG.GEMINI_TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
      responseMimeType: "text/plain",
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };
  
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
  
  return await response.json();
}

// Enhanced Telegram messaging
async function sendToTelegram(botToken, chatId, messages) {
  const results = [];
  
  for (let i = 0; i < messages.length; i++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: messages[i],
            parse_mode: 'MarkdownV2',
            reply_to_message_id: 10913,
            disable_web_page_preview: true
          })
        }
      );
      
      const responseData = await response.json();
      
      results.push({
        message_index: i,
        status: response.ok ? 'success' : 'failed',
        response: responseData
      });
      
      if (!response.ok) {
        console.error(`Telegram message ${i} failed:`, responseData);
      }
      
      // Rate limiting delay
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.MESSAGE_DELAY));
      }
      
    } catch (error) {
      console.error(`Telegram message ${i} error:`, error);
      results.push({
        message_index: i,
        status: 'error',
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
    const value = await env.RSS_STORAGE.get(key);
    return value === null;
  } catch (error) {
    console.error('Error checking item status:', error);
    return true; // Assume new if we can't check
  }
}

async function markItemAsProcessed(itemId, env) {
  try {
    const key = `processed_item_${itemId}`;
    await env.RSS_STORAGE.put(key, JSON.stringify({
      processed_at: new Date().toISOString(),
      item_id: itemId
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

function cleanMarkdownForTelegram(text) {
  return text
    .replace(/\*{3,}/g, '**')      // Fix multiple asterisks
    .replace(/_{3,}/g, '__')       // Fix multiple underscores
    .replace(/[*_`]$/g, '')        // Remove trailing markdown chars
    .replace(/(?<!\*)\*(?!\*)/g, '') // Remove single asterisks
    .replace(/(?<!_)_(?!_)/g, '')  // Remove single underscores
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') // Escape special chars for MarkdownV2
    .replace(/\\\*\\\*/g, '*')     // Restore bold formatting
    .replace(/\\_\\_/g, '_')       // Restore italic formatting
    .trim();
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