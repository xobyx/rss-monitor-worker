// Cloudflare Worker for RSS Feed Monitoring with Cron Job
// Runs every 15 minutes to check for new RSS items

// Constants
const TELEGRAM_MAX_LENGTH = 4096;
const SAFE_MESSAGE_LENGTH = 3800;
const MAX_CONTENT_LENGTH = 5000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle manual trigger
    if (url.pathname === '/check-rss') {
      return await handleRSSCheck(env);
    }
    
    // Handle health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    
    return new Response('RSS Monitor Worker', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // This runs every 15 minutes via cron trigger
    ctx.waitUntil(handleRSSCheck(env));
  }
};

async function handleRSSCheck(env) {
  try {
    console.log('Checking RSS feed for new items...');
    
    // Get the latest RSS item
    const latestItem = await getLatestRSSItem(env.RSS_FEED_URL);
    
    if (!latestItem) {
      console.log('No new items found');
      return new Response('No new items', { status: 200 });
    }
    
    // Check if this item was already processed
    const isNewItem = await isItemNew(latestItem.guid || latestItem.link, env);
    
    if (!isNewItem) {
      console.log('Item already processed');
      return new Response('Item already processed', { status: 200 });
    }
    
    // Process the new item
    const result = await processRSSItem(latestItem, env);
    
    // Mark item as processed
    await markItemAsProcessed(latestItem.guid || latestItem.link, env);
    
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error in RSS check:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function getLatestRSSItem(rssUrl) {
  try {
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-Monitor/1.0)',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch RSS: ${response.status}`);
    }
    
    const xmlText = await response.text();
    
    // Parse RSS XML (simple parser for common RSS formats)
    const items = parseRSSItems(xmlText);
    
    return items.length > 0 ? items[0] : null;
    
  } catch (error) {
    console.error('Error fetching RSS:', error);
    throw error;
  }
}

function parseRSSItems(xmlText) {
  const items = [];
  
  // Simple regex-based XML parsing (for basic RSS/Atom feeds)
  const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || 
                     xmlText.match(/<entry[\s\S]*?<\/entry>/gi);
  
  if (!itemMatches) return items;
  
  for (const itemXml of itemMatches) {
    const item = {
      title: extractXMLContent(itemXml, 'title'),
      link: extractXMLContent(itemXml, 'link'),
      description: extractXMLContent(itemXml, 'description') || 
                  extractXMLContent(itemXml, 'summary') ||
                  extractXMLContent(itemXml, 'content'),
      pubDate: extractXMLContent(itemXml, 'pubDate') || 
               extractXMLContent(itemXml, 'published') ||
               extractXMLContent(itemXml, 'updated'),
      guid: extractXMLContent(itemXml, 'guid') || 
            extractXMLContent(itemXml, 'id')
    };
    
    items.push(item);
  }
  
  // Sort by date (most recent first)
  return items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

function extractXMLContent(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'i');
  const match = xml.match(regex);
  
  if (match) {
    // Remove CDATA and HTML tags, decode entities
    let content = match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
    content = content.replace(/<[^>]*>/g, '');
    content = content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return content.trim();
  }
  
  return null;
}

async function isItemNew(itemId, env) {
  try {
    const key = `processed_item_${itemId}`;
    const value = await env.RSS_STORAGE.get(key);
    return value === null;
  } catch (error) {
    console.error('Error checking if item is new:', error);
    return true; // Assume new if we can't check
  }
}

async function markItemAsProcessed(itemId, env) {
  try {
    const key = `processed_item_${itemId}`;
    // Store with TTL of 7 days to prevent infinite storage growth
    await env.RSS_STORAGE.put(key, Date.now().toString(), { expirationTtl: 604800 });
  } catch (error) {
    console.error('Error marking item as processed:', error);
  }
}

async function processRSSItem(item, env) {
  try {
    // First attempt: Use Gemini with URL context tool
    let content;
    let geminiResponse;
    
    try {
      console.log('Attempting Gemini with URL context tool...');
      geminiResponse = await makeGeminiRequestWithUrlContext(item.link, env.GEMINI_API_KEY);
      content = geminiResponse.candidates[0].content.parts[0].text;
      console.log('Successfully processed with Gemini URL context tool');
    } catch (urlContextError) {
      console.log('Gemini URL context failed, trying manual extraction...', urlContextError.message);
      
      // Fallback: Extract content manually and use Gemini
      const articleContent = await extractContentFromUrl(item.link);
      
      const prompt = `
      Rewrite the article at this link: ${item.link} following these guidelines:
      
      1. Start with an Arabic title
      2. Write in professional Modern Standard Arabic
      3. Use minimal formatting (plain text preferred)
      4. Keep content concise but informative (max 3000 characters)
      5. End with a brief summary section
      6. Add 3-5 relevant Arabic hashtags at the end
      
      Article content to rewrite:
      ${articleContent}
      
      Return only the formatted article with hashtags.
      `;
      
      geminiResponse = await makeGeminiRequestWithRetry(prompt, env.GEMINI_API_KEY);
      content = geminiResponse.candidates[0].content.parts[0].text;
      console.log('Successfully processed with manual extraction + Gemini');
    }
    
    // Process content
    const cleanedContent = cleanMarkdownForTelegram(content);
    const { title, rest } = extractTitle(cleanedContent);
    
    // Extract hashtags
    const hashtags = extractHashtags(rest);
    
    // Send to Telegram
    const messages = splitMessageSmart(rest);
    const telegramResults = await sendToTelegram(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      messages
    );
    
    // Post to site
    //const siteResult = await postToSite(content, title, hashtags, env);
    
    return {
      content: content,
      telegram_results: telegramResults,
      site_result: siteResult,
      status: "success"
    };
    
  } catch (error) {
    console.error('Error processing RSS item:', error);
    return {
      status: "error",
      error: error.message
    };
  }
}

async function extractContentFromUrl(url) {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Content extraction attempt ${attempt}/${maxRetries} for URL: ${url}`);
      
      const response = await fetch(url, {
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
        },
        cf: {
          timeout: 30000,
          cacheTtl: 300
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const html = await response.text();
      
      if (!html || html.trim().length === 0) {
        throw new Error('Empty response received');
      }
      
      // Enhanced content extraction with multiple strategies
      let content = await extractMainContent(html);
      
      if (!content || content.trim().length < 100) {
        throw new Error('Insufficient content extracted');
      }
      
      return content.substring(0, MAX_CONTENT_LENGTH);
      
    } catch (error) {
      lastError = error;
      console.log(`Content extraction attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error(`Failed to extract content after ${maxRetries} attempts:`, lastError.message);
  return `Failed to extract content from URL: ${lastError.message}`;
}

async function extractMainContent(html) {
  try {
    // Remove unwanted elements
    let cleanHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<div[^>]*class="[^"]*sidebar[^"]*"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class="[^"]*menu[^"]*"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class="[^"]*advertisement[^"]*"[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class="[^"]*ads[^"]*"[\s\S]*?<\/div>/gi, '');
    
    // Strategy 1: Look for specific content containers
    const contentSelectors = [
      // Article tags
      /<article[\s\S]*?<\/article>/gi,
      /<main[\s\S]*?<\/main>/gi,
      
      // Common content classes
      /<div[^>]*class="[^"]*(?:content|post-content|entry-content|article-content|main-content)[^"]*"[\s\S]*?<\/div>/gi,
      /<div[^>]*class="[^"]*post-body[^"]*"[\s\S]*?<\/div>/gi,
      /<div[^>]*class="[^"]*entry[^"]*"[\s\S]*?<\/div>/gi,
      
      // ID-based selectors
      /<div[^>]*id="[^"]*(?:content|main|article|post)[^"]*"[\s\S]*?<\/div>/gi,
      
      // Role-based selectors
      /<div[^>]*role="main"[\s\S]*?<\/div>/gi,
      /<section[^>]*role="main"[\s\S]*?<\/section>/gi
    ];
    
    let extractedContent = '';
    
    for (const selector of contentSelectors) {
      const matches = cleanHtml.match(selector);
      if (matches && matches.length > 0) {
        // Take the longest match (likely the main content)
        extractedContent = matches.reduce((longest, current) => 
          current.length > longest.length ? current : longest, '');
        break;
      }
    }
    
    // Strategy 2: If no content containers found, extract all paragraphs
    if (!extractedContent || extractedContent.length < 200) {
      console.log('Using fallback paragraph extraction');
      const paragraphs = cleanHtml.match(/<p[\s\S]*?<\/p>/gi) || [];
      extractedContent = paragraphs.join('\n');
    }
    
    // Strategy 3: Last resort - get all text content
    if (!extractedContent || extractedContent.length < 100) {
      console.log('Using last resort text extraction');
      extractedContent = cleanHtml;
    }
    
    // Clean up the extracted content
    let textContent = extractedContent
      .replace(/<[^>]*>/g, ' ')  // Remove HTML tags
      .replace(/&nbsp;/g, ' ')  // Replace &nbsp; with spaces
      .replace(/&amp;/g, '&')   // Decode HTML entities
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();
    
    // Remove common unwanted patterns
    textContent = textContent
      .replace(/^(Advertisement|Sponsored|Related:|Share this:|Tags:|Categories:).*$/gm, '')
      .replace(/^(Read more|Continue reading|Click here).*$/gm, '')
      .replace(/^\s*\n/gm, '')  // Remove empty lines
      .trim();
    
    return textContent;
    
  } catch (error) {
    console.error('Error in extractMainContent:', error);
    throw error;
  }
}

async function makeGeminiRequestWithUrlContext(url, apiKey) {
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `
            Rewrite the article at this URL following these guidelines:
            
            1. Start with an Arabic title
            2. Write in professional Modern Standard Arabic
            3. Use minimal formatting (plain text preferred)
            4. Keep content concise but informative (max 3000 characters)
            5. End with a brief summary section
            6. Add 3-5 relevant Arabic hashtags at the end
            
            URL: ${url}
            
            Return only the formatted article with hashtags.
            `
          }
        ]
      }
    ],
    tools: [
      {
        urlContext: {}
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      responseMimeType: "text/plain"
    }
  };
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini URL context API error: ${response.status} - ${errorText}`);
  }
  
  return await response.json();
}

async function makeGeminiRequestWithRetry(prompt, apiKey, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Gemini API attempt ${attempt}/${maxRetries}`);
      
      const response = await makeGeminiRequest(prompt, apiKey);
      
      // Check if response is valid
      if (response.candidates && response.candidates.length > 0 && 
          response.candidates[0].content && response.candidates[0].content.parts) {
        return response;
      } else {
        throw new Error('Invalid response structure from Gemini API');
      }
      
    } catch (error) {
      lastError = error;
      console.log(`Gemini API attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Exponential backoff: wait 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw new Error(`Gemini API failed after ${maxRetries} attempts. Last error: ${lastError.message}`);
}

async function makeGeminiRequest(prompt, apiKey) {
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      responseMimeType: "text/plain"
    }
  };
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }
  
  return await response.json();
}

function splitMessageSmart(text, maxLength = SAFE_MESSAGE_LENGTH) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const messages = [];
  let currentMessage = "";
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      const sentences = paragraph.split('. ');
      for (const sentence of sentences) {
        if ((currentMessage + sentence + '. ').length > maxLength) {
          if (currentMessage) {
            messages.push(currentMessage.trim());
            currentMessage = sentence + '. ';
          } else {
            messages.push(sentence.substring(0, maxLength - 3) + '...');
          }
        } else {
          currentMessage += sentence + '. ';
        }
      }
    } else {
      if ((currentMessage + '\n\n' + paragraph).length > maxLength) {
        if (currentMessage) {
          messages.push(currentMessage.trim());
          currentMessage = paragraph;
        } else {
          messages.push(paragraph);
        }
      } else {
        if (currentMessage) {
          currentMessage += '\n\n' + paragraph;
        } else {
          currentMessage = paragraph;
        }
      }
    }
  }
  
  if (currentMessage) {
    messages.push(currentMessage.trim());
  }
  
  return messages;
}

function cleanMarkdownForTelegram(text) {
  text = text.replace(/\*{3,}/g, '**');
  text = text.replace(/_{3,}/g, '__');
  text = text.replace(/[*_`]$/g, '');
  text = text.replace(/(?<!\*)\*(?!\*)/g, '');
  text = text.replace(/(?<!_)_(?!_)/g, '');
  return text;
}

function extractTitle(text) {
  const lines = text.trim().split('\n');
  const firstLine = lines[0] || '';
  const title = firstLine.replace(/[#*_`]/g, '').trim() || 'بدون عنوان';
  const rest = lines.slice(1).join('\n');
  return { title, rest };
}

function extractHashtags(text) {
  const hashtags = text.match(/#[\u0600-\u06FF\w]+/g) || [];
  return hashtags;
}

async function sendToTelegram(botToken, chatId, messages) {
  const results = [];
  
  for (let i = 0; i < messages.length; i++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: messages[i],
            parse_mode: 'MarkdownV2',
            reply_to_message_id: 10913
          })
        }
      );
      
      const responseData = await response.json();
      
      results.push({
        message_index: i,
        status: response.ok ? 'success' : 'failed',
        response: responseData
      });
      
      // Add delay between messages
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      results.push({
        message_index: i,
        status: 'error',
        error: error.message
      });
    }
  }
  
  return results;
}

async function postToSite(content, title, tags, env) {
  try {
    const postData = {
      content: content,
      title: title,
      tags: tags,
      timestamp: Math.floor(Date.now() / 1000)
    };
    
    const response = await fetch("https://nuxt-drk.pages.dev/api/posts", {
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
        title: title,
        tags: tags,
        timestamp: postData.timestamp
      };
    } else {
      return {
        success: false,
        error: `API error: ${response.status}`,
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