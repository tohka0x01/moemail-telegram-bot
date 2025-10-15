export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log('[Fetch] Incoming request', { method: request.method, path: url.pathname });

    try {
      if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
        const webhookEvent = request.headers.get('X-Webhook-Event');
        console.log('[Fetch] Telegram webhook event', webhookEvent);

        if (webhookEvent === 'new_message') {
          const emailData = await request.json();
          await handleEmailWebhook(emailData, env, request);
        } else {
          const update = await request.json();
          await handleUpdate(update, env);
        }

        return new Response('OK');
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return new Response('OK');
      }

      const viewMatch = url.pathname.match(/^\/view\/(\d+)\/([^\/]+)\/([^\/]+)$/);
      if (request.method === 'GET' && viewMatch) {
        const [, userId, emailId, messageId] = viewMatch;
        console.log('[Fetch] View email request', { userId, emailId, messageId });
        return await handleEmailView(parseInt(userId, 10), emailId, messageId, env);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[Fetch] Unhandled error', error);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

function decodeHtmlEntities(input) {
  if (!input) return '';
  return input
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function preprocessEmailContent(rawContent) {
  if (!rawContent) {
    return { text: '', lowerText: '' };
  }
  let text = rawContent
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*?>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[\u00A0\s]+/g, ' ').trim();
  return { text, lowerText: text.toLowerCase() };
}

function extractTextFromMessageContent(content) {
  // 将模型返回的多段内容折叠为首个可用的文本
  if (!content) return null;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content) && typeof content === 'object') {
    const segmentType = typeof content.type === 'string' ? content.type.toLowerCase() : '';
    if (!segmentType.includes('think')) {
      if (typeof content.text === 'string') {
        const text = content.text.trim();
        if (text) return text;
      }
      if (typeof content.content === 'string') {
        const wrapped = content.content.trim();
        if (wrapped) return wrapped;
      }
      if (Array.isArray(content.content)) {
        const nested = extractTextFromMessageContent(content.content);
        if (nested) return nested;
      }
    }
    return null;
  }
  if (Array.isArray(content)) {
    for (const segment of content) {
      if (!segment) continue;
      if (typeof segment === 'string') {
        const str = segment.trim();
        if (str) return str;
        continue;
      }
      const segmentType = typeof segment.type === 'string' ? segment.type.toLowerCase() : '';
      if (segmentType.includes('think')) {
        // 跳过模型的思考片段
        continue;
      }
      let nestedText = null;
      if (typeof segment.text === 'string') {
        nestedText = segment.text.trim();
      } else if (typeof segment.content === 'string') {
        nestedText = segment.content.trim();
      } else if (Array.isArray(segment.content)) {
        nestedText = extractTextFromMessageContent(segment.content);
      }
      if (nestedText) return nestedText;
    }
  }
  return null;
}

function extractFinalAssistantText(choices) {
  // 从 choices 中解析出最终的助手回复文本
  if (!Array.isArray(choices)) {
    return { text: null, reason: 'choices 不是数组' };
  }
  for (const choice of choices) {
    if (!choice) continue;
    const message = choice.message;
    const textFromMessage = extractTextFromMessageContent(message?.content);
    if (textFromMessage) {
      return { text: textFromMessage };
    }
    if (typeof choice.output_text === 'string') {
      const trimmed = choice.output_text.trim();
      if (trimmed) {
        return { text: trimmed };
      }
    }
    if (Array.isArray(choice.output_text)) {
      const nested = extractTextFromMessageContent(choice.output_text);
      if (nested) {
        return { text: nested };
      }
    }
    if (typeof choice.content === 'string') {
      const trimmed = choice.content.trim();
      if (trimmed) {
        return { text: trimmed };
      }
    }
  }
  return { text: null, reason: '未找到助手文本内容' };
}

async function extractVerificationCodeWithAI(subject, text, env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return { code: null, error: '缺少 OPENAI_API_KEY 配置' };
  }
  const apiBase = env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = env.OPENAI_MODEL || 'glm-4.5';

  const truncatedSubject = (subject || '').slice(0, 200);
  const truncatedText = (text || '').slice(0, 6000);
  const prompt = `请扮演专业的验证码识别助手，分析邮件内容并提取验证码。
如果找到验证码，请直接返回验证码本身（例如 "123456" 或 "AB12CD"），不要包含其他文本。
如果无法找到任何验证码，请返回 "NOT_FOUND"。

邮件主题:
---
${truncatedSubject}
---

邮件正文:
---
${truncatedText}
---`;

  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  const requestPayload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 50,
    thinking: {
      type: 'disabled' // 关闭混合推理的思考模式，避免返回中混入 thinking 段落导致验证码解析失败
    }
  };

  console.log('[AI] 发起请求', { base: apiBase, model, subjectSnippet: truncatedSubject.slice(0, 40), textLength: truncatedText.length });
  console.log('[AI] 请求详情', {
    url: `${apiBase}/chat/completions`,
    method: 'POST',
    headers: { ...requestHeaders, Authorization: 'Bearer [REDACTED]' },
    body: requestPayload
  });
  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestPayload)
    });

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const responseClone = response.clone();
    const rawResponseText = await responseClone.text();
    let data = null;
    if (rawResponseText) {
      try {
        data = JSON.parse(rawResponseText);
      } catch (parseError) {
        console.error('[AI] 响应 JSON 解析失败', {
          message: parseError instanceof Error ? parseError.message : String(parseError),
          rawBody: rawResponseText
        });
      }
    } else {
      console.warn('[AI] 响应体为空字符串');
    }
    console.log('[AI] 响应详情', {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: rawResponseText
    });
    if (!response.ok) {
      console.error('[AI] 响应非 200', { status: response.status, body: rawResponseText || response.statusText });
      return { code: null, error: `AI接口返回错误 ${response.status}: ${rawResponseText || response.statusText}` };
    }

    console.log('[AI] 响应内容', data);
    const { text: assistantMessage, reason: missingReason } = extractFinalAssistantText(data?.choices);
    if (!assistantMessage) {
      console.warn('[AI] 未解析到助手文本', { reason: missingReason });
    }
    if (assistantMessage && assistantMessage !== 'NOT_FOUND') {
      const cleaned = assistantMessage.trim();
      if (/^[A-Za-z0-9-]{3,32}$/.test(cleaned) && !cleaned.includes('/') && !cleaned.includes(':')) {
        console.log('[AI] 提取验证码成功', cleaned);
        return { code: cleaned };
      }
      return { code: null, error: `AI返回非预期格式: ${assistantMessage}` };
    }

    return {
      code: null,
      error: assistantMessage === 'NOT_FOUND' ? 'AI未找到验证码' : 'AI未返回有效内容'
    };
  } catch (error) {
    console.error('[AI] 请求异常', error);
    return { code: null, error: error instanceof Error ? error.message : 'AI请求异常' };
  }
}

// 处理 Telegram 更新
async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }
}

// 处理消息
async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text || '';
  
  if (!userId) return;
  
  // 检查是否在等待自定义前缀输入
  const waitingFor = await env.USER_DATA.get(`temp_create_${userId}_waiting`);
  if (waitingFor === 'prefix') {
    await handleCustomPrefix(chatId, userId, text, env);
    return;
  }
  
  if (text.startsWith('/')) {
    await handleCommand(chatId, userId, text, env);
  } else {
    await sendMessage(chatId, '请使用 /help 查看可用命令', env);
  }
}

// 处理自定义前缀输入
async function handleCustomPrefix(chatId, userId, prefix, env) {
  // 验证前缀格式
  const cleanPrefix = prefix.trim();
  
  if (!/^[a-zA-Z0-9]{4,20}$/.test(cleanPrefix)) {
    await sendMessage(chatId, `
❌ **前缀格式不正确**

前缀要求：
• 4-20个字符
• 只能包含字母和数字
• 不能包含空格或特殊字符

请重新输入：
`, env);
    return;
  }
  
  // 保存前缀并继续流程
  await env.USER_DATA.put(`temp_create_${userId}_prefix`, cleanPrefix);
  await env.USER_DATA.delete(`temp_create_${userId}_waiting`);
  
  await sendMessage(chatId, `✅ 前缀设置成功：\`${cleanPrefix}\``, env);
  await showExpirySelection(chatId, userId, env);
}

// 处理命令
async function handleCommand(chatId, userId, command, env) {
  const [cmd, ...args] = command.split(' ');
  
  switch (cmd) {
    case '/start':
    case '/help':
      await sendMessage(chatId, `
🤖 **临时邮箱机器人**

**命令列表：**
/start - 显示帮助
/key <API_KEY> - 设置邮件服务 API Key
/create - 交互式创建临时邮箱
/create <前缀> [过期时间] [域名] - 快速创建邮箱
/domains - 查看可用域名
/list - 查看邮箱列表
/delete <EMAIL_ID> - 删除邮箱

**创建邮箱参数：**
• 前缀: 自定义邮箱前缀，或用 "random" 生成随机前缀
• 过期时间: 1h(1小时), 1d(1天), 7d(7天), never(永久)
• 域名: 可通过 /domains 查看可用域名

**示例：**
\`/create random 1d\` - 随机前缀，1天有效期
\`/create myname 7d [域名]\` - 自定义前缀，7天有效期，指定域名

**使用步骤：**
1. 使用 /key 设置 API Key
2. 使用 /create 创建邮箱
3. 使用 /list 查看邮件

需要邮件服务 API Key 才能使用。
`, env);
      break;
      
    case '/key':
      if (args.length === 0) {
        await sendMessage(chatId, '请提供 API Key：\n`/key YOUR_API_KEY`', env);
      } else {
        await env.USER_DATA.put(`apikey:${userId}`, args[0]);
        
        // 设置bot主人（第一次设置API Key的用户）
        const currentOwner = await env.USER_DATA.get('bot_owner');
        if (!currentOwner) {
          await env.USER_DATA.put('bot_owner', userId.toString());
        }
        
        await sendMessage(chatId, '✅ API Key 已保存！现在所有邮箱的新邮件都会通知到您的Telegram。', env);
      }
      break;
      
    case '/create':
      if (args.length === 0) {
        // 交互式创建
        await createEmailInteractive(chatId, userId, env);
      } else {
        // 参数创建
        const [name, expiry, domain] = args;
        await createEmailWithParams(chatId, userId, name, expiry, domain, env);
      }
      break;
      
    case '/domains':
      await showAvailableDomains(chatId, userId, env);
      break;
      
    case '/list':
      await listEmails(chatId, userId, env);
      break;
      
    case '/delete':
      if (args.length === 0) {
        await sendMessage(chatId, '请提供邮箱ID：\n`/delete EMAIL_ID`', env);
      } else {
        await deleteEmail(chatId, userId, args[0], env);
      }
      break;
      

      
    default:
      await sendMessage(chatId, '未知命令，使用 /help 查看帮助', env);
  }
}

// 处理回调
async function handleCallback(callback, env) {
  const chatId = callback.message?.chat.id;
  const userId = callback.from.id;
  const data = callback.data;
  
  if (!chatId || !data) return;
  
  // 应答回调
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callback.id })
  });
  
  const [action, param] = data.split(':');
  
  try {
    switch (action) {
      case 'view':
        await viewMessages(chatId, userId, param, env);
        break;
      case 'view_email':
        await viewEmailDetails(chatId, userId, param, env);
        break;
      case 'view_message':
        const [emailId, messageId] = param.split(':');
        await viewSingleMessage(chatId, userId, emailId, messageId, env);
        break;
      case 'view_all_messages':
        await viewAllMessages(chatId, userId, param, env);
        break;
      case 'delete':
        await deleteEmail(chatId, userId, param, env);
        break;
      case 'list_emails':
        if (param === 'first' || param === 'refresh') {
          await listEmails(chatId, userId, env);
        } else {
          await listEmails(chatId, userId, env, param);
        }
        break;
      case 'create_prefix':
        await handlePrefixSelection(chatId, userId, param, env);
        break;
      case 'create_expiry':
        await handleExpirySelection(chatId, userId, param, env);
        break;
      case 'create_domain':
        await handleDomainSelection(chatId, userId, param, env);
        break;
      case 'create_final':
        await handleFinalCreation(chatId, userId, param, env);
        break;
      default:
        await sendMessage(chatId, '❌ 未知操作', env);
    }
  } catch (error) {
    console.error('处理回调时发生错误:', error);
    await sendMessage(chatId, '❌ 操作失败，请重试', env);
  }
}

// 创建临时邮箱（带参数）
async function createEmailWithParams(chatId, userId, name, expiry, domain, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '请先使用 /key 设置 API Key', env);
    return;
  }

  // 解析参数
  const emailName = name === 'random' ? generateRandomPrefix() : name;
  const expiryTime = parseExpiryTime(expiry); // parseExpiryTime已经处理了所有情况包括默认值
  let emailDomain = domain;

  // 如果没有提供域名，从API获取第一个可用域名
  if (!emailDomain) {
    try {
      const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/config`, {
        headers: { 'X-API-Key': apiKey }
      });
      
      if (response.ok) {
        const data = await response.json();
        const domains = parseDomains(data.emailDomains);
        if (domains && domains.length > 0) {
          emailDomain = domains[0];
        }
      }
    } catch (error) {
      console.error('获取域名失败:', error);
    }
    
    if (!emailDomain) {
      await sendMessage(chatId, '❌ 无法获取可用域名，请稍后重试或明确指定域名', env);
      return;
    }
  }

  await createEmailAPI(chatId, userId, apiKey, emailName, expiryTime, emailDomain, env);
}

// 交互式创建邮箱
async function createEmailInteractive(chatId, userId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '请先使用 /key 设置 API Key', env);
    return;
  }

  const message = `
🛠️ **创建临时邮箱**

请选择邮箱前缀类型：
`;

  const buttons = [
    [
      { text: '🎲 随机前缀', callback_data: 'create_prefix:random' },
      { text: '✏️ 自定义前缀', callback_data: 'create_prefix:custom' }
    ]
  ];

  await sendMessage(chatId, message, env, { inline_keyboard: buttons });
}

// 显示可用域名
async function showAvailableDomains(chatId, userId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '请先使用 /key 设置 API Key', env);
    return;
  }

  try {
    const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/config`, {
      headers: { 'X-API-Key': apiKey }
    });

    if (!response.ok) {
      await sendMessage(chatId, '❌ 获取域名列表失败', env);
      return;
    }

    const data = await response.json();
    const domains = parseDomains(data.emailDomains);

    if (!domains || domains.length === 0) {
      await sendMessage(chatId, '❌ 无法获取可用域名，请稍后重试或联系管理员', env);
      return;
    }

    let message = '🌐 **可用域名列表：**\n\n';
    domains.forEach((domain, index) => {
      message += `${index + 1}. \`${domain}\`\n`;
    });

    message += '\n💡 **使用方法：**\n';
    message += '在创建邮箱时指定域名，如：\n';
    message += `\`/create myname 1d ${domains[0]}\``;

    await sendMessage(chatId, message, env);
  } catch (error) {
    console.error('获取域名失败:', error);
    await sendMessage(chatId, '❌ 获取域名列表失败', env);
  }
}

// 解析域名字符串
function parseDomains(emailDomainsString) {
  if (!emailDomainsString) return null;
  return emailDomainsString.split(',').map(domain => domain.trim()).filter(domain => domain);
}

// 实际创建邮箱的API调用
async function createEmailAPI(chatId, userId, apiKey, name, expiryTime, domain, env) {
  const requestBody = {
    domain: domain,
    expiryTime: expiryTime  // 始终包含过期时间，0表示永久
  };

  // 只有在非随机前缀时才添加name参数
  if (name && name !== 'random') {
    requestBody.name = name;
  }

  const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/generate`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (response.ok) {
    const data = await response.json();
    const emailAddress = data.email; // API文档显示返回格式为 {id, email}
    
    const expiryText = formatExpiryTime(expiryTime);
      
    await sendMessage(chatId, `✅ 邮箱创建成功！\n\n📧 **地址：** \`${emailAddress}\`\n🆔 **ID：** \`${data.id}\`\n⏰ **有效期：** ${expiryText}\n🌐 **域名：** ${domain}\n\n💡 **提示：** 有新邮件时会自动通知您`, env);
  } else {
    const errorText = await response.text();
    console.error('创建邮箱失败:', response.status, errorText);
    await sendMessage(chatId, '❌ 创建失败，请检查参数或 API Key', env);
  }
}

// 生成随机前缀
function generateRandomPrefix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 解析过期时间
function parseExpiryTime(expiry) {
  if (!expiry) {
    return 86400000; // 默认24小时
  }
  
  // 直接处理数字（永久邮箱）
  if (expiry === '0') {
    return 0;
  }
  
  const timeMap = {
    '1h': 3600000,       // 1小时
    '1d': 86400000,      // 1天
    '7d': 604800000      // 7天
  };
  
  return timeMap[expiry.toLowerCase()] || 86400000;
}

// 格式化过期时间显示
function formatExpiryTime(expiryTime) {
  if (expiryTime === 0) {
    return '永久';
  }
  if (expiryTime === 3600000) return '1小时';
  if (expiryTime === 86400000) return '1天';
  if (expiryTime === 604800000) return '7天';
  
  return `${Math.round(expiryTime / 86400000)}天`;
}

// 处理前缀选择
async function handlePrefixSelection(chatId, userId, type, env) {
  if (type === 'random') {
    // 使用随机前缀，直接进入过期时间选择
    await env.USER_DATA.put(`temp_create_${userId}_prefix`, 'random');
    await showExpirySelection(chatId, userId, env);
  } else if (type === 'custom') {
    // 自定义前缀，提示用户输入
    await env.USER_DATA.put(`temp_create_${userId}_waiting`, 'prefix');
    await sendMessage(chatId, `
✏️ **自定义邮箱前缀**

请输入您想要的邮箱前缀（4-20个字符，只能包含字母和数字）：

示例：myname、test123、work2024

输入前缀后，系统将继续引导您选择其他选项。
`, env);
  }
}

// 显示过期时间选择
async function showExpirySelection(chatId, userId, env) {
  const message = `
⏰ **选择邮箱有效期**

请选择邮箱的有效期：
`;

  const buttons = [
    [
      { text: '1小时', callback_data: 'create_expiry:1h' },
      { text: '1天', callback_data: 'create_expiry:1d' }
    ],
    [
      { text: '7天', callback_data: 'create_expiry:7d' },
      { text: '永久', callback_data: 'create_expiry:0' }
    ]
  ];

  await sendMessage(chatId, message, env, { inline_keyboard: buttons });
}

// 处理过期时间选择
async function handleExpirySelection(chatId, userId, expiry, env) {
  await env.USER_DATA.put(`temp_create_${userId}_expiry`, expiry);
  await showDomainSelection(chatId, userId, env);
}

// 显示域名选择
async function showDomainSelection(chatId, userId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  
  try {
    const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/config`, {
      headers: { 'X-API-Key': apiKey }
    });

    let domains = [];
    if (response.ok) {
      const data = await response.json();
      const parsedDomains = parseDomains(data.emailDomains);
      if (parsedDomains && parsedDomains.length > 0) {
        domains = parsedDomains;
      }
    }

    if (domains.length === 0) {
      await sendMessage(chatId, '❌ 无法获取可用域名，请稍后重试或联系管理员', env);
      return;
    }

    const message = `
🌐 **选择邮箱域名**

请选择邮箱域名：
`;

    const buttons = domains.slice(0, 6).map(domain => [
      { text: domain, callback_data: `create_domain:${domain}` }
    ]);

    await sendMessage(chatId, message, env, { inline_keyboard: buttons });
  } catch (error) {
    console.error('获取域名失败:', error);
    await sendMessage(chatId, '❌ 获取域名失败，请稍后重试', env);
  }
}

// 处理域名选择
async function handleDomainSelection(chatId, userId, domain, env) {
  await env.USER_DATA.put(`temp_create_${userId}_domain`, domain);
  await showCreationSummary(chatId, userId, env);
}

// 显示创建摘要
async function showCreationSummary(chatId, userId, env) {
  const prefix = await env.USER_DATA.get(`temp_create_${userId}_prefix`) || 'random';
  const expiry = await env.USER_DATA.get(`temp_create_${userId}_expiry`) || '1d';
  const domain = await env.USER_DATA.get(`temp_create_${userId}_domain`);

  // 检查域名是否存在
  if (!domain) {
    await sendMessage(chatId, '❌ 域名信息丢失，请重新开始创建流程', env);
    await cleanupTempData(userId, env);
    return;
  }

  const prefixText = prefix === 'random' ? '🎲 随机生成' : `✏️ ${prefix}`;
  const expiryText = formatExpiryTime(parseExpiryTime(expiry));

  const message = `
📋 **创建邮箱确认**

**配置信息：**
📧 前缀：${prefixText}
⏰ 有效期：${expiryText}
🌐 域名：${domain}

确认创建邮箱吗？
`;

  const buttons = [
    [
      { text: '✅ 确认创建', callback_data: `create_final:confirm` },
      { text: '❌ 取消', callback_data: `create_final:cancel` }
    ]
  ];

  await sendMessage(chatId, message, env, { inline_keyboard: buttons });
}

// 处理最终创建
async function handleFinalCreation(chatId, userId, action, env) {
  if (action === 'cancel') {
    // 清理临时数据
    await cleanupTempData(userId, env);
    await sendMessage(chatId, '❌ 已取消创建邮箱', env);
    return;
  }

  if (action === 'confirm') {
    const prefix = await env.USER_DATA.get(`temp_create_${userId}_prefix`) || 'random';
    const expiry = await env.USER_DATA.get(`temp_create_${userId}_expiry`) || '1d';
    const domain = await env.USER_DATA.get(`temp_create_${userId}_domain`);

    // 清理临时数据
    await cleanupTempData(userId, env);

    // 创建邮箱
    await createEmailWithParams(chatId, userId, prefix, expiry, domain, env);
  }
}

// 清理临时数据
async function cleanupTempData(userId, env) {
  await env.USER_DATA.delete(`temp_create_${userId}_prefix`);
  await env.USER_DATA.delete(`temp_create_${userId}_expiry`);
  await env.USER_DATA.delete(`temp_create_${userId}_domain`);
  await env.USER_DATA.delete(`temp_create_${userId}_waiting`);
}

// 列出邮箱
async function listEmails(chatId, userId, env, cursor = null) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '请先使用 /key 设置 API Key', env);
    return;
  }
  
  // 构建API URL
  let apiUrl = `${env.MOEMAIL_API_BASE_URL}/api/emails`;
  if (cursor) {
    apiUrl += `?cursor=${encodeURIComponent(cursor)}`;
  }
  
  const response = await fetch(apiUrl, {
    headers: { 'X-API-Key': apiKey }
  });
  
  if (!response.ok) {
    await sendMessage(chatId, '❌ 获取邮箱列表失败', env);
    return;
  }
  
  const data = await response.json();
  const emails = data.emails || [];
  const nextCursor = data.nextCursor;
  const total = data.total || emails.length;
  
  if (emails.length === 0) {
    if (cursor) {
      await sendMessage(chatId, '📪 没有更多邮箱了', env);
    } else {
      await sendMessage(chatId, '📪 您还没有创建任何邮箱\n使用 /create 创建新邮箱', env);
    }
    return;
  }
  
  // 构建消息文本
  let message = `📧 **您的邮箱列表** (共 ${total} 个)\n\n`;
  
  emails.forEach((email, index) => {
    const address = email.address;
    const createdAt = new Date(email.createdAt).toLocaleString('zh-CN');
    const expiresAt = email.expiresAt ? new Date(email.expiresAt).toLocaleString('zh-CN') : '永久';
    
    message += `**${index + 1}.** \`${address}\`\n`;
    message += `📅 创建：${createdAt}\n`;
    message += `⏰ 过期：${expiresAt}\n`;
    message += `🆔 ID：\`${email.id}\`\n\n`;
  });
  
  // 构建按钮
  const buttons = [];
  
  // 为每个邮箱创建查看和删除按钮
  emails.forEach((email, index) => {
    buttons.push([
      { text: `📬 查看邮箱 ${index + 1}`, callback_data: `view_email:${email.id}` },
      { text: `🗑 删除邮箱 ${index + 1}`, callback_data: `delete:${email.id}` }
    ]);
  });
  
  // 添加分页按钮
  const paginationButtons = [];
  if (cursor) {
    paginationButtons.push({ text: '⬅️ 返回首页', callback_data: 'list_emails:first' });
  }
  if (nextCursor) {
    paginationButtons.push({ text: '➡️ 下一页', callback_data: `list_emails:${nextCursor}` });
  }
  
  if (paginationButtons.length > 0) {
    buttons.push(paginationButtons);
  }
  
  // 添加刷新按钮
  buttons.push([{ text: '🔄 刷新列表', callback_data: 'list_emails:refresh' }]);
  
  await sendMessage(chatId, message, env, { inline_keyboard: buttons });
}

// 查看邮件
async function viewMessages(chatId, userId, emailId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) return;
  
  const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}`, {
    headers: { 'X-API-Key': apiKey }
  });
  
  if (!response.ok) {
    await sendMessage(chatId, '❌ 获取邮件失败', env);
    return;
  }
  
  const data = await response.json();
  const messages = data.messages || [];
  
  if (messages.length === 0) {
    await sendMessage(chatId, '📪 此邮箱暂无邮件', env);
    return;
  }
  
  let text = '📬 **收件箱：**\n\n';
  messages.slice(0, 10).forEach((msg, index) => {
    // API文档显示received_at是时间戳格式
    const time = msg.received_at ? new Date(msg.received_at).toLocaleString('zh-CN') : '未知时间';
    text += `${index + 1}. **${msg.subject || '无主题'}**\n`;
    text += `📩 ${msg.from_address || '未知发件人'}\n`;
    text += `⏰ ${time}\n\n`;
  });
  
  await sendMessage(chatId, text, env);
}

// 查看邮箱详情
async function viewEmailDetails(chatId, userId, emailId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '❌ 请先设置 API Key', env);
    return;
  }
  
  try {
    // 根据API文档，获取指定邮箱的邮件列表
    const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}`, {
      headers: { 'X-API-Key': apiKey }
    });
    
    if (!response.ok) {
      await sendMessage(chatId, '❌ 获取邮箱详情失败', env);
      return;
    }
    
    const data = await response.json();
    const messages = data.messages || [];
    const total = data.total || messages.length;
    
    // 由于API没有单独返回邮箱信息，我们需要从用户列表中获取或构建基本信息
    let message = `📧 **邮箱详情**\n\n`;
    message += `🆔 **邮箱ID：** \`${emailId}\`\n`;
    message += `📬 **邮件数量：** ${total} 封\n\n`;
    
    // 显示邮件列表
    if (messages.length === 0) {
      message += '📪 **暂无邮件**\n\n';
      message += '💡 **提示：** 有新邮件时会自动通知您';
    } else {
      message += '📬 **邮件列表：**\n\n';
      
      // 显示最近的5封邮件
      const recentMessages = messages.slice(0, 5);
      recentMessages.forEach((msg, index) => {
        const subject = msg.subject || '无主题';
        const fromAddress = msg.from_address || '未知发件人';
        // API文档显示received_at是时间戳格式
        const receivedAt = msg.received_at ? new Date(msg.received_at).toLocaleString('zh-CN') : '未知时间';
        
        message += `**${index + 1}.** ${subject}\n`;
        message += `📩 ${fromAddress}\n`;
        message += `⏰ ${receivedAt}\n\n`;
      });
      
      if (messages.length > 5) {
        message += `📄 **还有 ${messages.length - 5} 封邮件...**\n\n`;
      }
    }
    
    // 构建按钮
    const buttons = [];
    
    if (messages.length > 0) {
      // 为每封邮件添加查看按钮（最多显示5个）
      const recentMessages = messages.slice(0, 5);
      recentMessages.forEach((msg, index) => {
        buttons.push([
          { text: `📖 查看邮件 ${index + 1}`, callback_data: `view_message:${emailId}:${msg.id}` }
        ]);
      });
      
      if (messages.length > 5) {
        buttons.push([
          { text: '📄 查看全部邮件', callback_data: `view_all_messages:${emailId}` }
        ]);
      }
    }
    
    // 添加操作按钮
    buttons.push([
      { text: '🔄 刷新', callback_data: `view_email:${emailId}` },
      { text: '🗑 删除邮箱', callback_data: `delete:${emailId}` }
    ]);
    
    buttons.push([
      { text: '⬅️ 返回列表', callback_data: 'list_emails:first' }
    ]);
    
    await sendMessage(chatId, message, env, { inline_keyboard: buttons });
  } catch (error) {
    console.error('查看邮箱详情失败:', error);
    await sendMessage(chatId, '❌ 查看邮箱详情失败，请稍后重试', env);
  }
}

// 查看单封邮件详情
async function viewSingleMessage(chatId, userId, emailId, messageId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '❌ 请先设置 API Key', env);
    return;
  }

  try {
    const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}/${messageId}`, {
      headers: { 'X-API-Key': apiKey }
    });

    if (!response.ok) {
      await sendMessage(chatId, '❌ 获取邮件失败', env);
      return;
    }

    const data = await response.json();
    const email = data.message || data;
    const subject = email.subject || '无主题';
    const fromAddress = email.from_address || '未知发件人';
    // API文档显示received_at是时间戳格式
    const receivedAt = email.received_at ? new Date(email.received_at).toLocaleString('zh-CN') : '未知时间';
    const content = email.html || email.content || '';

    // 提取纯文本内容
    let textContent = '';
    let plainTextForAI = '';
    if (content) {
      // 使用预处理函数提取纯文本
      const plainTextResult = preprocessEmailContent(content);
      const plainText = plainTextResult ? plainTextResult.text : '';
      plainTextForAI = plainText;
      textContent = plainText;
      if (textContent.length > 1000) {
        textContent = textContent.substring(0, 1000) + '...';
      }
    }
    const aiExtractionResult = await extractVerificationCodeWithAI(subject, plainTextForAI || subject || '', env);
    const aiCode = aiExtractionResult ? aiExtractionResult.code : null;
    const aiError = aiExtractionResult ? aiExtractionResult.error : null;
    let message = `📬 **邮件详情**\n\n`;
    message += `**主题：** ${subject}\n`;
    message += `**发件人：** ${fromAddress}\n`;
    message += `**时间：** ${receivedAt}\n\n`;

    if (aiCode) {
      message += '【验证码】**检测到以下结果：**\n';
      message += `\`${aiCode}\`\n\n`;
    } else if (aiError) {
      message += `【提示】AI 未返回验证码：${aiError}\n\n`;
    }
    if (textContent) {
      message += '📄 **内容预览：**\n';
      message += textContent + '\n\n';
    } else {
      message += '📄 **内容：** 暂无可显示的文本内容\n\n';
    }

    const buttons = [];
    
    // 添加查看完整内容的提示（需要在浏览器中查看）
    if (content) {
      message += '💡 **提示：** 完整的HTML内容需要在浏览器中查看\n';
      message += `**查看链接：** \`/view/${userId}/${emailId}/${messageId}\`\n\n`;
    }

    buttons.push([
      { text: '⬅️ 返回邮箱', callback_data: `view_email:${emailId}` }
    ]);

    await sendMessage(chatId, message, env, { inline_keyboard: buttons });
  } catch (error) {
    console.error('查看单封邮件详情失败:', error);
    await sendMessage(chatId, '❌ 查看邮件详情失败，请稍后重试', env);
  }
}

// 查看所有邮件
async function viewAllMessages(chatId, userId, emailId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    await sendMessage(chatId, '❌ 请先设置 API Key', env);
    return;
  }

  try {
    // 根据API文档，获取指定邮箱的邮件列表
    const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}`, {
      headers: { 'X-API-Key': apiKey }
    });

    if (!response.ok) {
      await sendMessage(chatId, '❌ 获取邮件列表失败', env);
      return;
    }

    const data = await response.json();
    const messages = data.messages || [];
    const total = data.total || messages.length;

    if (messages.length === 0) {
      await sendMessage(chatId, '📪 此邮箱暂无邮件', env);
      return;
    }

    let text = `📬 **收件箱** (共 ${total} 封邮件)\n\n`;
    
    // 显示最多20封邮件
    messages.slice(0, 20).forEach((msg, index) => {
      // API文档显示received_at是时间戳格式
      const time = msg.received_at ? new Date(msg.received_at).toLocaleString('zh-CN') : '未知时间';
      text += `${index + 1}. **${msg.subject || '无主题'}**\n`;
      text += `📩 ${msg.from_address || '未知发件人'}\n`;
      text += `⏰ ${time}\n\n`;
    });

    if (messages.length > 20) {
      text += `📄 **还有 ${messages.length - 20} 封邮件...**\n\n`;
    }

    // 添加返回按钮
    const buttons = [[
      { text: '⬅️ 返回邮箱详情', callback_data: `view_email:${emailId}` }
    ]];

    await sendMessage(chatId, text, env, { inline_keyboard: buttons });
  } catch (error) {
    console.error('查看所有邮件失败:', error);
    await sendMessage(chatId, '❌ 查看邮件失败，请稍后重试', env);
  }
}

// 删除邮箱
async function deleteEmail(chatId, userId, emailId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) return;
  
  const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': apiKey }
  });
  
  if (response.ok) {
    await sendMessage(chatId, '✅ 邮箱已删除', env);
  } else {
    console.error('邮箱删除失败:', emailId, response.status);
    await sendMessage(chatId, '❌ 删除失败', env);
  }
}

// 邮件查看页面
async function handleEmailView(userId, emailId, messageId, env) {
  const apiKey = await env.USER_DATA.get(`apikey:${userId}`);
  if (!apiKey) {
    return new Response('Unauthorized', { status: 403 });
  }
  
  const response = await fetch(`${env.MOEMAIL_API_BASE_URL}/api/emails/${emailId}/${messageId}`, {
    headers: { 'X-API-Key': apiKey }
  });
  
  if (!response.ok) {
    return new Response('Email not found', { status: 404 });
  }
  
  const data = await response.json();
  const email = data.message || data;
  
  // 构建邮件内容
  const subject = email.subject || '无主题';
  const fromAddress = email.from_address || '未知发件人';
  const receivedAt = email.received_at ? new Date(email.received_at) : new Date();
  const content = email.html || email.content || '';
  
  const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${subject}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 20px; line-height: 1.6; }
        .header { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .content { border: 1px solid #ddd; padding: 20px; border-radius: 8px; min-height: 200px; }
        .empty { color: #666; font-style: italic; text-align: center; padding: 40px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>${subject}</h1>
        <p><strong>发件人:</strong> ${fromAddress}</p>
        <p><strong>时间:</strong> ${receivedAt.toLocaleString('zh-CN')}</p>
    </div>
    
    <div class="content">
        ${content || '<div class="empty">此邮件没有可显示的内容</div>'}
    </div>
</body>
</html>`;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}



// 处理邮件Webhook通知
async function handleEmailWebhook(emailData, env, request) {
  console.log('[EmailWebhook] Received payload summary', {
    to: emailData?.toAddress,
    subject: emailData?.subject,
    messageId: emailData?.messageId,
    emailId: emailData?.emailId
  });
  try {
    if (!emailData.toAddress) {
      console.error('缺少toAddress字段');
      return;
    }
    
    // 获取bot主人的用户ID（第一个设置API Key的用户）
    const ownerUserId = await env.USER_DATA.get('bot_owner');
    
    if (!ownerUserId) {
      console.error('未设置bot主人，无法发送通知');
      return;
    }
    
    // 处理邮件内容
    const content = emailData.content || '';
    const subject = emailData.subject || '无主题';
    const fromAddress = emailData.fromAddress || '未知发件人';
    
    // 生成内容预览
    let preview = '';
    let plainContentText = '';
    if (content) {
      const plainTextResult = preprocessEmailContent(content);
      const cleanText = plainTextResult ? plainTextResult.text : '';
      plainContentText = cleanText;
      const normalizedPreview = cleanText.replace(/\s+/g, ' ').trim();
      preview = normalizedPreview.length > 150 ? normalizedPreview.substring(0, 150) + '...' : normalizedPreview;
    }

    const aiExtractionResult = await extractVerificationCodeWithAI(subject, plainContentText || subject || '', env);
    const aiCode = aiExtractionResult ? aiExtractionResult.code : null;
    const aiError = aiExtractionResult ? aiExtractionResult.error : null;
    // 检测是否为重要邮件
    const importantWords = ['验证码', 'verification', 'code', '登录', 'login'];
    const isImportant = importantWords.some(word => 
      subject.toLowerCase().includes(word) || content.toLowerCase().includes(word)
    );
    
    // 构建基础通知消息
    let parts = [];
    if (isImportant) {
      parts.push('🚨 **重要邮件提醒** 🚨');
      parts.push('');
    }
    
    // parts.push('📬 **新邮件通知**');
    // parts.push('');
    parts.push(`📧 **收件邮箱：** \`${emailData.toAddress}\``);
    parts.push(`📩 **发件人：** ${fromAddress}`);
    parts.push(`📝 **主题：** ${subject}`);
    parts.push(`⏰ **接收时间：** ${new Date(emailData.receivedAt).toLocaleString('zh-CN')}`);
    
    if (emailData.messageId) {
      parts.push(`🆔 **邮件ID：** \`${emailData.messageId}\``);
    }
    
    if (aiCode) {
      parts.push('');
      parts.push('【验证码】**AI 检测到以下结果：**');
      parts.push(`\`${aiCode}\``);
    } else if (aiError) {
      parts.push('');
      parts.push(`【提示】AI 未返回验证码：${aiError}`);
    }
    // if (preview) {
    //   parts.push('');
    //   parts.push('📄 **内容预览：**');
    //   parts.push(preview);
    // }
    
    // 添加操作提示
    parts.push('');
    parts.push('📋 **操作提示：**');
    parts.push('• 使用 /list 查看所有邮箱');
    
    if (emailData.emailId && emailData.messageId) {
      const workerUrl = new URL(request.url).origin;
      const viewUrl = `${workerUrl}/view/${ownerUserId}/${emailData.emailId}/${emailData.messageId}`;
      parts.push(`• [查看完整邮件](${viewUrl})`);
    }
    
    const notificationText = parts.join('\n');

    await sendMessage(parseInt(ownerUserId), notificationText, env);
  } catch (error) {
    console.error('处理邮件webhook失败:', error);
  }
}

// 发送消息
async function sendMessage(chatId, text, env, replyMarkup) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  };
  
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Telegram] sendMessage failed', { chatId, status: response.status, body: errorText });
    } else {
      console.log('[Telegram] Message sent', { chatId, textLength: text ? text.length : 0 });
    }
  } catch (error) {
    console.error('[Telegram] sendMessage exception', error);
  }
}


export { extractVerificationCodeWithAI, preprocessEmailContent };

