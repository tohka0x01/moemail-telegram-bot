# Telegram 临时邮箱机器人 - 部署说明

这是一个基于 Cloudflare Workers 的 Telegram 机器人， 提供临时邮箱管理服务，支持创建、查看、删除临时邮箱，并提供实时邮件通知功能。
邮箱服务基于[Moemail](https://github.com/beilunyang/moemail)。

## 🚀 主要功能

### 核心功能
- ✅ **临时邮箱管理**：创建、查看、删除临时邮箱
- ✅ **多种有效期**：1小时、1天、7天、永久
- ✅ **双创建模式**：交互式引导创建 + 快速命令创建
- ✅ **实时邮件通知**：新邮件自动推送到 Telegram
- ✅ **验证码识别**：自动检测和突出显示验证码
- ✅ **邮件查看**：支持在 Telegram 预览和 Web 完整查看
- ✅ **分页支持**：大量邮箱和邮件的分页浏览
- ✅ **域名动态获取**：自动从 API 获取可用域名
- ✅ **验证码增强**：支持多种匹配模式、双语关键词与低置信度候选提示

### 高级特性
- 🎲 **随机前缀生成**：支持随机和自定义邮箱前缀
- 🌐 **多域名支持**：动态显示所有可用域名选择
- 📬 **邮件详情查看**：每封邮件的完整信息展示
- 🔄 **实时刷新**：支持邮箱列表和邮件列表的实时刷新
- 🔗 **Web 查看**：支持在浏览器查看完整 HTML 邮件内容

## 📋 文件说明

- `telegram-bot.js` - 主程序文件（生产环境使用）
- `api.md` - API 接口文档

## 🛠️ 部署步骤

### 1. 环境准备

#### 1.1 注册 Cloudflare 账户
- 访问：https://dash.cloudflare.com/sign-up
- 完成注册和邮箱验证

#### 1.2 创建 Telegram Bot
1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新机器人
3. 设置机器人名称和用户名
4. **保存 Bot Token**（格式：`1234567890:ABCD...`）

#### 1.3 获取邮件服务 API Key
- 访问邮件服务商（支持临时邮箱的API服务）
- 注册账户并创建 API Key
- **保存 API Key**

### 2. Cloudflare Workers 部署

#### 2.1 创建 Worker
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **Create application**
4. 选择 **Create Worker**
5. 命名你的 Worker（如：`telegram-email-bot`）
6. 点击 **Deploy**

#### 2.2 部署代码
1. 在 Worker 页面点击 **Quick edit**
2. 删除默认代码
3. 复制 `telegram-bot.js` 的全部内容
4. 粘贴到编辑器中
5. 点击 **Save and deploy**

### 3. 配置环境

#### 3.1 设置环境变量
在 Worker 设置页面的 **Variables** 部分添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `TELEGRAM_BOT_TOKEN` | `1234567890:ABCD...` | 你的 Telegram Bot Token |
| `MOEMAIL_API_BASE_URL` | `https://api.example.com` | 邮件服务 API 基础地址 |

> **提示**：可在 Variables 中额外新增 `CODE_*` 环境变量以调整验证码规则，详见 5.3 节。
> ⚠️ **注意**：API 基础地址不要包含 `/api` 后缀

#### 3.2 创建并绑定 KV 存储
1. 在 Cloudflare Dashboard 中进入 **Workers & Pages** → **KV**
2. 点击 **Create a namespace**
3. 命名为 `USER_DATA`
4. 回到 Worker 设置页面的 **Settings** → **Variables**
5. 在 **KV Namespace Bindings** 部分添加：
   - **Variable name**: `USER_DATA`
   - **KV namespace**: 选择刚创建的 `USER_DATA`
6. 点击 **Save and deploy**

### 4. 设置 Webhook

#### 4.1 获取 Worker URL
在 Worker 概览页面复制你的 Worker URL：
```
https://your-worker-name.your-subdomain.workers.dev
```

#### 4.2 设置 Telegram Webhook
用你的实际信息替换以下命令中的占位符：

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://your-worker-name.your-subdomain.workers.dev/telegram-webhook"}'
```

**示例**：
```bash
curl -X POST "https://api.telegram.org/bot1234567890:ABCD.../setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://telegram-email-bot.myname.workers.dev/telegram-webhook"}'
```

#### 4.3 验证 Webhook 设置
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

成功的响应应显示你的 Webhook URL。

#### 4.4 设置邮件服务 Webhook
在你的邮件服务商后台配置：
- **Webhook URL**: `https://your-worker-name.your-subdomain.workers.dev/telegram-webhook`
- **事件类型**: 新邮件到达（new_message）
- **Header**: `X-Webhook-Event: new_message`

### 5. 初始配置和测试

#### 5.1 初始设置
1. 在 Telegram 中找到你的机器人
2. 发送 `/start` 查看帮助信息
3. 发送 `/key YOUR_API_KEY` 设置邮件服务 API Key
   > 💡 第一个设置 API Key 的用户自动成为 bot 主人，接收所有邮件通知

#### 5.2 功能测试
```
/domains          # 查看可用域名
/create           # 交互式创建邮箱
/create random 1d # 快速创建（随机前缀，1天有效期）
/list             # 查看邮箱列表
```

#### 5.3 验证码匹配配置（可选）
通过环境变量即可调整验证码提取策略：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CODE_MIN_LENGTH` | 最短验证码长度 | 4 |
| `CODE_MAX_LENGTH` | 最长验证码长度 | 10 |
| `CODE_CONTEXT_WINDOW` | 上下文窗口长度（字符数） | 40 |
| `CODE_SCORE_THRESHOLD` | 置信度阈值 | 2 |
| `CODE_POSITIVE_KEYWORDS_ZH` | 中文正向关键词（逗号分隔） | 验证码,动态码,登录,安全验证,校验码,一次性密码 |
| `CODE_POSITIVE_KEYWORDS_EN` | 英文正向关键词（逗号分隔） | verification,verify,code,otp,passcode,2fa,login,security,auth,authentication |
| `CODE_NEGATIVE_KEYWORDS` | 负面关键词（逗号分隔） | 订单,金额,电话,phone,customer,invoice,order,tracking,amount,tel |
| `CODE_DETECTION_CONFIG_JSON` | JSON 字符串（覆盖全部配置） | — |



## 🧪 本地测试

1. 安装 Node.js 18 及以上版本。
2. 首次运行前执行 `npm install` 安装依赖。 
3. 使用 `npm test` 验证验证码提取逻辑。 

## 📖 使用指南

### 基本命令

| 命令 | 功能 |
|------|------|
| `/start` `/help` | 显示帮助信息 |
| `/key <API_KEY>` | 设置邮件服务 API Key |
| `/domains` | 查看可用域名列表 |
| `/create` | 交互式创建邮箱 |
| `/create <前缀> [有效期] [域名]` | 快速创建邮箱 |
| `/list` | 查看邮箱列表 |
| `/delete <EMAIL_ID>` | 删除指定邮箱 |

### 创建邮箱示例

**交互式创建**：
```
/create
→ 选择前缀类型（随机/自定义）
→ 选择有效期（1小时/1天/7天/永久）
→ 选择域名
→ 确认创建
```

**快速创建**：
```
/create random 1d                    # 随机前缀，1天有效期
/create myname 7d                    # 自定义前缀，7天有效期
/create test123 never                # 自定义前缀，永久有效
/create work 1h example.com          # 完整参数指定
```

### 有效期参数

| 参数 | 有效期 |
|------|--------|
| `1h` | 1小时 |
| `1d` | 1天 |
| `7d` | 7天 |
| `0` 或 `never` | 永久 |

### 邮件查看功能

1. **邮箱列表**：`/list` 显示所有邮箱，支持分页浏览
2. **邮箱详情**：点击"查看邮箱"按钮查看该邮箱的邮件列表
3. **邮件预览**：在 Telegram 中查看邮件摘要和验证码
4. **完整查看**：点击 Web 链接在浏览器查看完整 HTML 邮件

## 🔧 高级配置

### 更换邮件服务商
只需修改环境变量 `MOEMAIL_API_BASE_URL`，无需更改代码：
```
MOEMAIL_API_BASE_URL = https://api.new-service.com
```

### 自定义域名
在 Cloudflare 中为你的 Worker 设置自定义域名：
1. 进入 Worker 设置
2. 添加 **Custom Domain**
3. 更新 Webhook URL

### 多用户支持
当前版本为个人使用设计，所有邮件通知发送给 bot 主人。如需多用户支持，需要修改代码逻辑。

## 🐛 故障排除

### 常见问题

**Q: 机器人不响应命令**
- 检查 Telegram Webhook 是否设置正确
- 查看 Cloudflare Workers 日志（在 Worker 页面点击 **Logs**）
- 确认 `TELEGRAM_BOT_TOKEN` 环境变量正确

**Q: 无法创建邮箱**
- 确认已设置 API Key：`/key YOUR_API_KEY`
- 检查 `MOEMAIL_API_BASE_URL` 是否正确
- 验证邮件服务 API Key 是否有效和有足够配额

**Q: 收不到邮件通知**
- 确认邮件服务 Webhook 设置正确
- 检查 Webhook URL 中的域名是否可访问
- 查看 Worker 日志中的错误信息

**Q: 创建永久邮箱显示为1天**
- 这是已知问题，现已修复
- 重新部署最新版本的代码

**Q: 部署时出现语法错误**
- 确保使用 `telegram-bot.js` 文件（JavaScript）
- 不要使用 `telegram-bot.ts` 文件（TypeScript）
- Cloudflare Workers 原生支持 JavaScript

### 调试技巧

1. **查看日志**：在 Worker 页面的 **Logs** 面板查看实时日志
2. **测试 Webhook**：使用 `curl` 手动发送测试请求
3. **验证环境变量**：确认所有必需的环境变量都已正确设置
4. **分步测试**：先测试基本命令，再测试邮件功能

## 📚 相关文档

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [项目 API 文档](./api.md)

## 🎯 下一步计划

- [ ] 支持邮件转发功能
- [ ] 添加邮件搜索功能
- [ ] 支持附件下载
- [ ] 多语言支持
- [ ] 邮件归档功能

---

如有问题，请检查 Worker 日志或提交 Issue。
