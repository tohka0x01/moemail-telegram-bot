// 验证码提取默认配置
const DEFAULT_CODE_DETECTION_CONFIG = {
  minLength: 4,
  maxLength: 10,
  contextWindow: 40,
  scoreThreshold: 2,
  positiveKeywords: {
    zh: ['验证码', '动态码', '登录', '安全验证', '校验码', '一次性密码'],
    en: ['verification', 'verify', 'code', 'otp', 'passcode', '2fa', 'login', 'security', 'auth', 'authentication']
  },
  negativeKeywords: ['订单', '金额', '电话', 'phone', 'customer', 'invoice', 'order', 'tracking', 'amount', 'tel'],
  patterns: [
    { name: 'numeric', regex: /(?:^|[^0-9A-Za-z])((?:\d[\s-]?){4,8})(?=[^0-9A-Za-z]|$)/g, group: 1 },
    { name: 'alphanumUpper', regex: /(?:^|[^0-9A-Za-z])([A-Z0-9][A-Z0-9\s-]{3,9}[A-Z0-9])(?=[^0-9A-Za-z]|$)/g, group: 1 },
    { name: 'alphanumMixed', regex: /(?:^|[^0-9A-Za-z])([A-Za-z0-9][A-Za-z0-9\s-]{3,9}[A-Za-z0-9])(?=[^0-9A-Za-z]|$)/g, group: 1 },
    { name: 'wrapped', regex: /[【\(\[\{]([A-Za-z0-9][A-Za-z0-9\s-]{3,9}[A-Za-z0-9])[】\)\]\}]/g, group: 1 }
  ]
};

// 将逗号分隔的字符串解析为数组
function parseKeywordList(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return null;
  }
  const list = rawValue.split(',').map(item => item.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

// 合并中英文关键词
function mergeKeywordConfig(target, overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  if (Array.isArray(overrides.zh) && overrides.zh.length > 0) {
    target.zh = overrides.zh;
  }
  if (Array.isArray(overrides.en) && overrides.en.length > 0) {
    target.en = overrides.en;
  }
}

// 构建验证码提取配置（支持环境变量覆盖）
function buildVerificationConfig(env) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CODE_DETECTION_CONFIG));
  if (!env) {
    return config;
  }

  if (env.CODE_DETECTION_CONFIG_JSON) {
    try {
      const overrides = JSON.parse(env.CODE_DETECTION_CONFIG_JSON);
      if (overrides && typeof overrides === 'object') {
        if (typeof overrides.minLength === 'number') config.minLength = overrides.minLength;
        if (typeof overrides.maxLength === 'number') config.maxLength = overrides.maxLength;
        if (typeof overrides.contextWindow === 'number') config.contextWindow = overrides.contextWindow;
        if (typeof overrides.scoreThreshold === 'number') config.scoreThreshold = overrides.scoreThreshold;
        if (overrides.positiveKeywords) {
          mergeKeywordConfig(config.positiveKeywords, overrides.positiveKeywords);
        }
        if (Array.isArray(overrides.negativeKeywords) && overrides.negativeKeywords.length > 0) {
          config.negativeKeywords = overrides.negativeKeywords;
        }
      }
    } catch (error) {
      console.error('解析 CODE_DETECTION_CONFIG_JSON 失败:', error);
    }
  }

  const minLength = parseInt(env.CODE_MIN_LENGTH, 10);
  if (!Number.isNaN(minLength) && minLength > 0) {
    config.minLength = minLength;
  }

  const maxLength = parseInt(env.CODE_MAX_LENGTH, 10);
  if (!Number.isNaN(maxLength) && maxLength >= config.minLength) {
    config.maxLength = maxLength;
  }

  const contextWindow = parseInt(env.CODE_CONTEXT_WINDOW, 10);
  if (!Number.isNaN(contextWindow) && contextWindow >= 0) {
    config.contextWindow = contextWindow;
  }

  const scoreThreshold = parseInt(env.CODE_SCORE_THRESHOLD, 10);
  if (!Number.isNaN(scoreThreshold)) {
    config.scoreThreshold = scoreThreshold;
  }

  const zhKeywords = parseKeywordList(env.CODE_POSITIVE_KEYWORDS_ZH);
  if (zhKeywords) {
    config.positiveKeywords.zh = zhKeywords;
  }

  const enKeywords = parseKeywordList(env.CODE_POSITIVE_KEYWORDS_EN);
  if (enKeywords) {
    config.positiveKeywords.en = enKeywords;
  }

  const negativeKeywords = parseKeywordList(env.CODE_NEGATIVE_KEYWORDS);
  if (negativeKeywords) {
    config.negativeKeywords = negativeKeywords;
  }

  return config;
}


// 将 HTML 实体转为普通字符
function decodeHtmlEntities(input) {
  if (!input) {
    return '';
  }
  const entities = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'"
  };
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    const lower = entity.toLowerCase();
    if (entities[`&${lower};`]) {
      return entities[`&${lower};`];
    }
    if (lower.startsWith('#x')) {
      const codePoint = parseInt(lower.slice(2), 16);
      if (!Number.isNaN(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
    } else if (lower.startsWith('#')) {
      const codePoint = parseInt(lower.slice(1), 10);
      if (!Number.isNaN(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
    }
    return entities[`&${entity};`] || '';
  });
}

// 对邮件内容做预处理，输出纯文本
function preprocessEmailContent(rawContent) {
  if (!rawContent) {
    return { text: '', lowerText: '' };
  }
  let text = rawContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*?>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[\u00A0\s]+/g, ' ').trim();
  return { text, lowerText: text.toLowerCase() };
}

// 计算关键词得分，支持中英文列表
function calculateKeywordScore(text, keywordList, weight = 1, isLowerCase = false) {
  if (!text || !Array.isArray(keywordList) || keywordList.length === 0) {
    return 0;
  }
  const target = isLowerCase ? text.toLowerCase() : text;
  return keywordList.reduce((score, keyword) => {
    if (!keyword) return score;
    const key = isLowerCase ? keyword.toLowerCase() : keyword;
    return target.includes(key) ? score + weight : score;
  }, 0);
}

// 提取验证码候选集合
function extractVerificationCodes(subject = '', rawContent = '', config = DEFAULT_CODE_DETECTION_CONFIG) {
  const resultMap = new Map();
  const { text, lowerText } = preprocessEmailContent(rawContent);
  const subjectLower = (subject || '').toLowerCase();
  const positiveZh = config.positiveKeywords?.zh || [];
  const positiveEn = config.positiveKeywords?.en || [];
  const negativeKeywords = config.negativeKeywords || [];
  const subjectPositiveScore =
    calculateKeywordScore(subject, positiveZh, 1, false) +
    calculateKeywordScore(subjectLower, positiveEn, 1, true) -
    calculateKeywordScore(subjectLower, negativeKeywords, 1, true);
  for (const pattern of config.patterns || []) {
    const regex = pattern.regex;
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const matchedText = pattern.group ? match[pattern.group] : match[0];
      if (!matchedText) continue;
      let candidateText = matchedText.trim().replace(/\s+/g, ' ');
      const firstDigitPos = candidateText.search(/\d/);
      if (firstDigitPos > 0) {
        const spaceIndex = candidateText.lastIndexOf(' ', firstDigitPos);
        if (spaceIndex !== -1) {
          candidateText = candidateText.slice(spaceIndex + 1);
        }
      }
      candidateText = candidateText.replace(/[^\dA-Za-z]+$/g, '');
      const lastDigitPos = candidateText.search(/\d(?!.*\d)/);
      if (lastDigitPos !== -1) {
        const suffix = candidateText.slice(lastDigitPos + 1);
        if (suffix && !/\d/.test(suffix)) {
          candidateText = candidateText.slice(0, lastDigitPos + 1);
        }
      }
      const normalized = candidateText.replace(/[^A-Za-z0-9]/g, '');
      if (normalized.length < config.minLength || normalized.length > config.maxLength) {
        continue;
      }
      if (!/\d/.test(normalized)) {
        continue;
      }
      const key = normalized.toUpperCase();
      const startIndex = match.index ?? text.indexOf(matchedText);
      const effectiveIndex = startIndex < 0 ? 0 : startIndex;
      const contextStart = Math.max(0, effectiveIndex - config.contextWindow);
      const contextEnd = Math.min(text.length, effectiveIndex + matchedText.length + config.contextWindow);
      const context = text.slice(contextStart, contextEnd);
      const contextLower = lowerText.slice(contextStart, contextEnd);
      let score = 0;
      score += calculateKeywordScore(context, positiveZh, 2, false);
      score += calculateKeywordScore(contextLower, positiveEn, 2, true);
      score -= calculateKeywordScore(contextLower, negativeKeywords, 2, true);
      if (/[A-Za-z]/.test(normalized)) {
        score += 1;
      }
      const existing = resultMap.get(key) || {
        code: normalized,
        displayCode: normalized,
        score: 0,
        contexts: [],
        patterns: new Set()
      };
      existing.score += score;
      existing.contexts.push(context.trim());
      existing.patterns.add(pattern.name);
      resultMap.set(key, existing);
    }
  }
  const candidates = Array.from(resultMap.values()).map(item => {
    const displayCode = /[A-Za-z]/.test(item.code) ? item.code.toUpperCase() : item.code;
    const totalScore = item.score + subjectPositiveScore;
    return {
      code: item.code,
      displayCode,
      score: totalScore,
      contexts: item.contexts,
      patterns: Array.from(item.patterns)
    };
  }).sort((a, b) => b.score - a.score);
  const highConfidence = [];
  const lowConfidence = [];
  const debug = candidates.map(candidate => ({
    code: candidate.displayCode,
    score: candidate.score,
    patterns: candidate.patterns,
    contexts: candidate.contexts
  }));
  for (const candidate of candidates) {
    if (!candidate.displayCode) continue;
    if (candidate.score >= config.scoreThreshold) {
      highConfidence.push(candidate.displayCode);
    } else {
      lowConfidence.push(candidate.displayCode);
    }
  }
  return {
    highConfidence,
    lowConfidence,
    debug
  };
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
    if (content) {
      // 使用预处理函数提取纯文本
      const { text: plainText } = preprocessEmailContent(content);
      textContent = plainText;
      if (textContent.length > 1000) {
        textContent = textContent.substring(0, 1000) + '...';
      }
    }
    // 检测验证码
    const detectionConfig = buildVerificationConfig(env);
    const extraction = extractVerificationCodes(subject, content, detectionConfig);
    const verificationCodes = extraction.highConfidence || [];
    const fallbackCodes = extraction.lowConfidence || [];
    let message = `📬 **邮件详情**\n\n`;
    message += `**主题：** ${subject}\n`;
    message += `**发件人：** ${fromAddress}\n`;
    message += `**时间：** ${receivedAt}\n\n`;

    if (verificationCodes.length > 0) {
      message += '【验证码】**检测到以下结果：**\n';
      verificationCodes.slice(0, 3).forEach(code => {
        const wrapper = String.fromCharCode(96);
        message += wrapper + code + wrapper + '\n';
      });
      message += '\n';
    }

    const extraCandidates = fallbackCodes.filter(code => !verificationCodes.includes(code));
    if (extraCandidates.length > 0) {
      message += '【提示】以下候选置信度较低，请自行核实：\n';
      extraCandidates.slice(0, 3).forEach(code => {
        const wrapper = String.fromCharCode(96);
        message += wrapper + code + wrapper + '\n';
      });
      message += '\n';
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
    if (content) {
      const { text: cleanText } = preprocessEmailContent(content);
      const normalizedPreview = cleanText.replace(/\s+/g, ' ').trim();
      preview = normalizedPreview.length > 150 ? normalizedPreview.substring(0, 150) + '...' : normalizedPreview;
    }
    // �����֤��
    const detectionConfig = buildVerificationConfig(env);
    const extraction = extractVerificationCodes(subject, content, detectionConfig);
    const verificationCodes = extraction.highConfidence || [];
    const fallbackCodes = extraction.lowConfidence || [];
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
    
    parts.push('📬 **新邮件通知**');
    parts.push('');
    parts.push(`📧 **收件邮箱：** \`${emailData.toAddress}\``);
    parts.push(`📩 **发件人：** ${fromAddress}`);
    parts.push(`📝 **主题：** ${subject}`);
    parts.push(`⏰ **接收时间：** ${new Date(emailData.receivedAt).toLocaleString('zh-CN')}`);
    
    if (emailData.messageId) {
      parts.push(`🆔 **邮件ID：** \`${emailData.messageId}\``);
    }
    
    // 添加验证码信息
    
    // 添加内容预览
    if (verificationCodes.length > 0) {
      parts.push('');
      parts.push('【验证码】**检测到以下结果：**');
      verificationCodes.slice(0, 3).forEach(code => {
        parts.push(`\`${code}\``);
      });
    }
    const extraCandidates = fallbackCodes.filter(code => !verificationCodes.includes(code));
    if (extraCandidates.length > 0) {
      parts.push('');
      parts.push('【提示】以下候选置信度较低，请自行核实：');
      extraCandidates.slice(0, 3).forEach(code => {
        const wrapper = String.fromCharCode(96);
        parts.push(wrapper + code + wrapper);
      });
      parts.push('');
    }
    if (preview) {
      parts.push('');
      parts.push('📄 **内容预览：**');
      parts.push(preview);
    }
    
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
  
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}


export { DEFAULT_CODE_DETECTION_CONFIG, buildVerificationConfig, extractVerificationCodes, preprocessEmailContent };

