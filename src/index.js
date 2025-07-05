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
    // Extract content from the article URL
    const articleContent = await extractContentFromUrl(item.link);
    
    // Process with Gemini
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
    
    const geminiResponse = await makeGeminiRequest(prompt, env.GEMINI_API_KEY);
    const content = geminiResponse.candidates[0].content.parts[0].text;
    
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
    const siteResult = await postToSite(content, title, hashtags, env);
    
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
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.102 Safari/537.36',
        'Referer': 'https://google.com'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    
    // Simple HTML content extraction (without BeautifulSoup)
    let content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '');
    
    // Try to find main content
    const contentSelectors = [
      /<article[\s\S]*?<\/article>/gi,
      /<main[\s\S]*?<\/main>/gi,
      /<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/gi,
      /<div[^>]*class="[^"]*post-content[^"]*"[\s\S]*?<\/div>/gi
    ];
    
    for (const selector of contentSelectors) {
      const matches = content.match(selector);
      if (matches && matches.length > 0) {
        content = matches[0];
        break;
      }
    }
    
    // Extract text content
    content = content.replace(/<[^>]*>/g, ' ');
    content = content.replace(/\s+/g, ' ');
    content = content.trim();
    
    return content.substring(0, MAX_CONTENT_LENGTH);
    
  } catch (error) {
    return `Failed to extract content from URL: ${error.message}`;
  }
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
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
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
            parse_mode: 'Markdown'
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
