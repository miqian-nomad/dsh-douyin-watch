# @local/dsh-douyin-watch

DSH 插件：盯抖音私信 → 有新消息就叫醒指定会话的 agent，并提供 8 个抖音工具。

---

## 🔴 先看这个（凭据与开关，2026-10-24 加固）

- **`douyin_cookie.txt` 是密码级凭据**：含 HttpOnly `sessionid`，拿到它 = 拿到这个抖音账号。
  位置：`DOUYIN_HOME`（或 `~/.dsh/douyin-duty`、或配置里的 `home`）。`cookie-save.mjs` 保存后会
  **自动收紧权限**（Windows `icacls /inheritance:r`，只留当前用户/SYSTEM/Administrators；其它平台 `chmod 600`）。
  别把它 copy 进仓库、别贴进聊天、别放网盘。
- **配置接口有守卫**：`/api/douyin-watch/config` 拒绝跨站请求（挡 CSRF），并且**写操作只认本机回环**——
  局域网/隧道（`~/.dsh/mobile-access`）或手机上打开设置页可以读，但保存会 `403`，改设置要回本机改。
- **自动回复默认关**（`ownerAutoReply: false`）：默认只提醒、不替你说话。要自动回，去设置页显式打开。

---

## ⚠️ 给新会话的必读（动手改代码前，先把这段看完）

> 这个插件有很多**看起来像 bug、其实是抖音机制**的坑。过去已经因为「没搞清楚就乱改」返工了好几次。改任何流程前，先在真实页面上**点开对应面板、用浏览器 dump 一次**确认现状，再动手。

## 🔑 账号切换 / 二次验证（最常踩的坑，2026-10-24 血泪总结）

抖音账号一旦切换，或操作频繁，就会弹**二次验证**；无头模式下视频页还会弹「**验证码中间页**」反爬。**完整解法**：

1. 无头被拦（登出 / 验证码中间页）→ **切到有头模式**（改 `dsh-browser-playwright.state.json` 的 `headless: false`，或 DSH 设置里开）
2. 在有头窗口里**手动登录 + 完成二次验证 + 发一次评论**
3. **切回无头** → 验证已清，@ 就能正常发了

⚠️ 两个副作用，务必知道：

- **切有头/无头时，DSH 的 browser 服务会短暂 inactive → 抖音插件的工具被「移除」（GUI 提示「移除 10 个」）**。恢复办法：改 `cordis.patch.yml` 里 `- id: douyin-watch` 的 `reloadNote` 值触发重挂载（这是目前唯一不用重启 DSH 就能让工具回来的办法；直接改配置值，别只加注释——注释不触发）。
- **登录态备份/恢复**：`douyin_save_login`（把当前 cookie 存进 `douyin_cookie.txt`，含 HttpOnly）→ `douyin_relogin`（灌回）。换账号后先 save 一次，无头登出时 relogin 即可，不用手动再登。

1. **改 `index.js` 必须重启 DSH 才生效**。`cordis.patch.yml` 的配置是 `patchReload: live`（热重载），但 **JS 代码不是**——热重载即使重新 import 了模块，工具也会撞 `already registered in this scope`，等于没生效。所以改代码 → 重启。

2. **评论区还是老 Draft.js，别误判。** 评论编辑器是 `.public-DraftEditor-content`（**点开评论框才渲染**，点开前查是 0 个）；mention chip 是 `douyin_mention_word`。看到 `editor-kit-container` / `messageEditorinputArea` / `messageMsgInputmentionContainer` 这些是**私信聊天框**的组件，不是评论区。**不要**据此去改评论选择器。

3. **诊断前注意浏览器有多个 tab。** 哨兵 watcher 会自己开 tab 读私信，活动 tab 常在 /chat 和视频页之间跳。`browser_*` 工具可能落在错误 tab 上，dump 出来的 DOM 不可信。先 `browser_tabs` 确认在哪个 tab。

4. **@（真 @）必须走原始 CDP。** `session.press(ref, '@')` 发的事件**不带 `text` 字段**，mention 弹层不弹。要用 `session.cdp('Input.dispatchKeyEvent', { type:'keyDown', key:'@', code:'Digit2', text:'@', windowsVirtualKeyCode:50, nativeVirtualKeyCode:50 })` + 对应的 keyUp，然后**等 ≥1200ms** 再回车选人。这条是实测出来的，别改回 press。

5. **回评（回复某条评论）走接口，不走 UI、不走 @。** 就是 `POST /aweme/v1/web/comment/publish/` 时 body 里带 `reply_id` + `reply_to_reply_id`（都等于对方评论的 cid）。插件里 `douyin_comment` 的 `reply_to` 参数就是干这个。@ 和回评是两条完全不同的路。

6. **工具 output 里永远不要返回 `undefined`。** 返回值会过「lossless JSON」校验，`undefined` 直接报 `value is not lossless JSON`。可选字段要么省略、要么给默认值（`''` / `0`）。

7. **render 签名是 `render(args, value)`，第二个参数才是工具返回值。** 写成 `render: (value) => ...` 会拿到输入参数、显示全错（比如 douyin_send 永远显示「发送失败」）。统一用 `render: (_args, value) => ...`。

8. **分享卡片和私信同走 IM 通道，会被风控静默丢弃。** 从发送方账号看「已发出」，对方账号可能收不到。这是抖音 PC 端风控，插件只能如实报「已执行分享动作、送达未验证」，无法保证送达。

---

## 它做什么（watcher）

```
每 N 秒（可配）：打开抖音私信页 → 读「<对端>」会话
    → 有新消息 → followup 到**钉死的那条会话**（没开着就 resume 恢复）
    → agent 用 douyin_send 回过去
```

**两种绑定模式**（2026-10-24 起）：

| 模式 | 怎么工作 | 什么时候用 |
|---|---|---|
| `sessionId`（推荐） | 先找活着的该会话 agent；没有就 `ctx.agents.resume({ resumeSessionId })` 恢复它，再 `followup` | 就想固定一条会话，DSH 重启/换目录/会话没打开都不影响 |
| `targetCwd`（老） | 靠 `agent/created` + 枚举，逮 cwd 匹配的 agent | 只在不填 sessionId 时兜底；**目录不存在就永远空转**（踩过） |

⚠️ `enabled` 现在**立即生效**（改完就停/起哨兵）；以前它只在挂载时读一次，设置里拨动是假开关。

**设置页顶部有「运行状态」卡片**（每 5 秒刷新，不用看日志）：绿点=运行中 / 灰点=已停止 / 红点=出错，并显示「最后读取（N 条）」「最后唤醒」和最近一条错误。数据来自 `/api/douyin-watch/config` 响应里的 `status`（`index.js` 的 `runtime` 打点）。

⚠️ `watched` / `runtime` / `stateOf` / `pinnedAgents` 这些 `const` **必须声明在 `enabled=false` 的提前 return 之前**——放后面会让它们停在 TDZ，接口直接 400、设置页永远「加载中…」（2026-10-24 踩过）。

🔴 **`home` / `cfgFile` 必须在 patch 里写死**：同一个 DSH 会同时加载 web / desktop 两个 profile 的实例。不写死就会出现「设置页改的文件 ≠ 哨兵读的文件」——症状是：改了没用、重启后配置像丢了。两侧共用一个文件后，再由 **`watcher.lock`**（30 秒心跳）保证只有一个实例在盯；没拿到锁的实例只保留设置接口，并且**持锁实例每轮读一次配置文件**，所以从哪个实例的设置页改都能生效。

### resume 的模型路由（2026-10-24 血泪坑）

`ctx.agents.resume({ resumeSessionId })` **不传 `agentOptions`** 时，DSH 用空 `{}` 建 agent →
`agent.options.provider/model` 都是 `undefined`。而预设人设是严格插值的模板
`You are a coding agent powered by the {{model}} model.`，所以那一轮连系统提示词组装都过不去：

```
prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
```

现象是：唤醒消息投递成功、turn 开始，但第 1 步就 `turn/end error`，**没有 `request/header`**（请求根本没发）。
（GUI 自己恢复会话时是 `api-session` 的 `installModelSelection` 在补这个变量；ACP/headless 则显式传
`agentOptions`，所以只有裸 `ctx.agents.resume` 会踩。）

插件在 resume 的 `setup` 里补了两处（`installRouteForResumedAgent`，见 `index.js`）：

| 补哪里 | 作用 |
|---|---|
| `system-prompt/assemble` | 填 `{{provider}}` / `{{model}}` 变量，人设能渲染 |
| `agent/request` | 空路由会报 `agent "…" has no provider/model`，这里补成会话自己的路由 |

路由解析顺序：**会话待生效的 `model/selection` → 最近一次已发出的请求路由 → `agent.options` → 部署默认模型**。
全都解析不到时**不投递唤醒**（只记一行日志），避免再炸一轮。日志里会写
`已恢复会话 … （… 模型路由=deepseek-account/deepseek-flash）`，可据此确认补上了。

另外 `ensurePinnedAgent` 现在会先等 ≤1.2s 看有没有 GUI 正在创建/恢复的活 agent，避免抢在它前面多 resume 一份。

### 裸 resume 不会挂 preset（2026-10-24 血泪坑 ㉑）

`ctx.agents.resume()` 只恢复「会话 + agent」，**preset 的组成（工具/提示词/技能）不在它里面**。
GUI 打开会话走的是 api-session 的 `composeAgent()`，它做两件事：

```js
const presets = ctx.get('agentPresets')
const id = (await presets.resolve(session.header.agentPreset)).id   // 会话头里记录的 preset
// 然后在 setup 里：
await presets.mount(agentCtx, id)
```

插件以前是裸 resume → 恢复出来的 agent 没有 preset 的插件树 → **会话里没有 pwsh / read / edit**，
表现是：唤醒消息投递成功、turn 开始，但模型没工具可用（只能干看着）。
现在 `installPresetForResumedAgent` 在同一个 `setup` 里补上这一步（preset id 取会话头的
`agentPreset`，解析失败退回部署默认）。日志会写：

```
已给恢复出的 agent 挂上 preset=standard（工具/提示词按该 preset 组成）
```

### 读私信为什么必须 `--force-chat`（2026-10-24 血泪坑 ㉒）

`tools/chat-read-once.mjs` 老规矩是「只在非抖音页面上才导航」，本意是不抢用户正在看的视频页。
但**首页 /「验证码中间页」也算 `douyin.com`** —— 于是页面卡在那儿时：

- 哨兵不导航 → 读 DOM 读到 0 条 → 返回 `messages: []`
- 看起来和「没有新消息」一模一样：设置页「运行中 · 最后读取 0 条」，永不标已读、永不唤醒

现在哨兵调用时带 `--force-chat`：只要当前不在 `/chat` 就主动导航过去（工具操作期间哨兵是
`pauseWatcher()` 暂停的，所以不会抢 @/分享用的视频页）。另外脚本在读到 0 条时会多看一眼页面状态，
把原因写进 `note`、进日志和设置页的错误行，例如：

```
读私信受阻：页面停在「验证码中间页」，需要人工在有头窗口里过验证码（切 --headless=off 让用户手动过）
```


- 用 `targetCwd` 钉死要叫醒的会话工作目录（多开会话时只有这一个被叫醒）。
- 调用任何抖音工具时，watcher 会 `pauseWatcher()` / `resumeWatcher()` 自动暂停/恢复，避免和工具抢浏览器页面。

---

## 9 个工具

| 工具 | 作用 | 关键点 |
|---|---|---|
| `douyin_read` | 读「<对端>」会话最近消息（带 sid + 已读 + 卡片 itemId） | 只读 |
| `douyin_send` | 发一条文字私信 + 回读校验 | `delivered` 来自真回读（「我发的」消息里多出这条）；`read` 恒 false（页面读不到已读）。短消息（≤10 字）通过率高 |
| `douyin_comment` | 发顶层评论，或**回评**（传 `reply_to`） | 接口直发，不 @ 人，不弹验证 |
| `douyin_comment_at` | 发评论并**真 @** 主人（`text_extra` 接口直发） | 需要 `user_id + sec_uid + type:0 + start/end` 四件套，缺一个服务端就把 @ 剥掉 |
| `douyin_comment_delete` | 删自己发的评论 | 服务端校验是否本人 |
| `douyin_notice_read` | 读互动通知（谁 @/评/赞/关注） | 只读，不标已读；type=31 是回评通知 |
| `douyin_share` | 把视频以「分享卡片」发给主人 | 页面内 hover 分享面板 → 点好友；送达受风控影响 |
| `douyin_pick` | 刷推荐流取候选视频 | 返回标题/热度/作者/时长/链接 |
| `douyin_analyze` | 视频 → 文案 + 画面联系表 | 详情接口取直链 → faster-whisper 转写 + 抽帧；**收到分享卡片时自动跑**，不用主人开口 |

### 公开评论的三道闸（`lib/outbound-guard.mjs`）

`douyin_comment` / `douyin_comment_at` 发出去之前，全部**在本地**过一遍，拦下来就不发、并把原因原样返回：

| 闸 | 默认 | 说明 |
|---|---|---|
| 字数 | ≤ 60 字 | 公开评论越短越安全（设置页可改） |
| 禁止词 | `亲,客服腔,欢迎关注,家人们,已读,感谢您的支持` | AI 最容易顺嘴说的客服腔 |
| 站外引导 | 网址 / 裸域名 / 手机号 / 微信 / QQ / 邮箱 / 二维码 | 公开评论区最容易被判营销 |
| 去重 | 同一句 7 天内不许重发 | 台账 `comment-ledger.jsonl`，key = 视频 + 对端 + 归一化文本 |
| 频次 | 6 条/小时、30 条/天 | 防批量刷评；**只有真拿到 cid 才记账**，失败不占额度 |

### 评论区自动回（可选，默认关）

打开后挂在私信轮询里一起跑（不新增定时器，避免两个循环抢 9334 浏览器）：

```
每 commentScanMinutes（默认 10）分钟
  ├─ 自己作品下的评论：**读评论列表**（tools/work-comments.mjs）
  │    /aweme/v1/web/comment/list/ 拿 cid/昵称/正文/时间
  │    /aweme/v1/web/comment/list/reply/ 逐条探"我回过没有"（作者 uid 比对）
  │    —— 以服务端为准，不靠通知、也不靠 reply_comment（它经常是 undefined）
  ├─ 作品发布超过 commentWorkMaxAgeDays（默认 7）天的整条跳过（0 = 不限）
  └─ 通知：只补「别人回复了我的评论」（type 31）+ @你（45）
       顺带把 type 35/46 的作品 id 记进 my-works.json
  → pickReplyTargets()：丢掉无 cid、自己发的、已回过、超时限（默认 48h）的
  → 还有剩 → followup 叫醒 agent，把 cid + 链接 + 公开评论语气一起给它
  → agent 逐条 douyin_comment({ reply_to }) 回评（过上面三道闸）
```

「作品发布多久就不回」和「评论多久以内才回」是两个不同门槛：
前者按**作品发布时间**算（老视频下面冒出来的新评论也不回），后者按**评论时间**算。

同一批 40 分钟内不重复催；`commentMaxPerRound`（默认 3）限制一次丢几条。

**不回的几种情况**（都写在 `pickReplyTargets` 里，不是靠 agent 记）：

| 情况 | 判定 |
|---|---|
| 只有 @、没有内容 | `"@某人"`、`[表情]@某人` → 回“在呢”就像客服机器人 |
| 机器人 / 平台客服号 | `commentSkipNicks`（默认 `豆包`）按昵称命中 |
| 发了但服务端查不到 | 台账里有、子评论里却没有 → 线程不可见，**不再重试**（豆包那种“假成功”） |
| 自己发的 / 已回过 / 超时 / 作品太旧 | 见上 |

也可以随时手动批量看：工具 `douyin_work_comments`（只读，返回每条评论的 cid 和"是否已回"）。

---

## 关键机制速查

### @（真 @）—— douyin_comment_at

```
点开 #comment-input-container → 点 .public-DraftEditor-content（聚焦）
→ CDP Input.dispatchKeyEvent 打 @（带 text:'@'）
→ 等 1200ms
→ CDP Enter 选第一个候选
→ 检查 .public-DraftEditor-content 的 innerHTML 里有 douyin_mention_word
→ 补正文 → 点红色箭头（FE2C55）发布
```

### 回评 —— douyin_comment 传 reply_to

```
先 douyin_notice_read() 拿对方回评的 cid（type=31 条目）
→ douyin_comment(text=…, reply_to=<cid>, url=/video/<aweme_id>)
→ 内部 POST comment/publish，body 带 reply_id + reply_to_reply_id = <cid>
→ 挂到对方评论下面，不另开新楼
```

### 通知结构（douyin_notice_read 解析）

type=31（回评/评论通知）的结构是：

```
notice_list_v2[].comment.comment = {
  cid:     对方评论的 id（回评 reply_to 用它）
  text:    评论内容
  aweme_id:所在视频
  user:    { nickname, uid }
}
```

解析时循环里 `blk = it[keys[m]]`，当 `keys[m]==='comment'` 时 `blk = it.comment`，所以取 `cc = blk.comment` 就是上面那个对象。**别写成 `blk.comment.comment`**（多取一层，结果是 undefined）。

---

## 本机私有配置（不进仓库）

个人标识和运行态都放在 `$HOME`（默认 `~/.dsh/douyin-duty`，或 `DOUYIN_HOME` 指定的目录），**仓库里一个都不留**（见 `.gitignore`）：

| 文件 | 内容 | 为什么要隔离 |
|---|---|---|
| `peer.json` | `{ "nick": "示例好友", "sec_uid": "MS4wLjABAAAA…" }` | `sec_uid` 是账号唯一标识，公开出去等于把账号挂出来。`chat-read-once.mjs` 按 `--to/--to-id` → 环境变量 → `peer.json` 的优先级取值 |
| `douyin_cookie.txt` | 含 HttpOnly `sessionid` 的完整 cookie | 密码级凭据，泄露即账号被接管 |
| `watch-config.json` | 设置页写的那份 | 个人偏好（会话 id、间隔、自动回复开关） |
| `watch-known.json` / `watcher.lock` / `runtime.json` | 去重状态 / 单实例锁 / CDP 端口 | 纯运行态 |

## 配置（profile 的 cordis.patch.yml → `- id: douyin-watch`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `chatUrl` | `https://www.douyin.com/chat` | 私信页 |
| `peer` | 空 | 要盯的会话昵称（也可放在 `$HOME/peer.json`） |
| `intervalSeconds` | 30 | 轮询间隔 |
| `maxWakeText` | 3 | 一次唤醒最多带几条正文 |
| `owner` | 空 | 主人昵称（私信/分享的收件人） |
| `onlyNewest` | true | 只盯最新创建的会话 |
| `sessionId` | 空 | **钉死会话**（推荐）：只往这条会话投递；它没开着会自动 `ctx.agents.resume()` 恢复。留空才按 `targetCwd` 找 |
| `targetCwd` | 空 | 只叫醒这个工作目录的会话（`sessionId` 为空时才生效） |
| `ownerAutoReply` | **false** | 主人消息是否自动回；false=只提醒。默认关：自动替你说话必须显式打开 |
| `commentUrl` | 默认视频 | `douyin_comment`/`comment_at` 不传 url 时用 |
| `strangerPolicy` | `notify` | 非主人消息策略 |

改配置**热重载生效，不用重启**（patchReload: live）。改代码才要重启。

---

## 环境要求（对外分发必看，2026-10-24）

| 依赖 | 必须？ | 说明 |
|---|---|---|
| Node.js（DSH 自带） | ✅ | 所有工具都是 `.mjs`，用 `cfg.nodeBin`（默认 `process.execPath`）执行 |
| Chrome / Edge / Chromium | ✅ | 9334 无头实例；`lib/chrome.mjs` 自动找，找不到可用 `DOUYIN_BROWSER` 指定 |
| 抖音登录态 | ✅ | 在 9334 里登一次，`douyin_save_login` 存 cookie，之后 `douyin_relogin` 恢复 |
| **Python + curl_cffi** | ❌ **不再需要** | 取候选 / 读通知已改成页面内同源请求（`feed-pick.mjs` / `notice-read.mjs`）。`*.py` 仅作历史参考 |

## 已知限制 / 风控

- **私信 / 分享卡片会被风控静默丢**：发出方看着成功、接收方收不到（8101 / IM 静默丢弃）。无绕过手段，只能低频 + 短文本（实测 ≤10 字通过率高）。
- **换账号 / 操作频繁会弹「二次验证」**：无头下视频页还会弹「验证码中间页」（滑块）。解法见上方「🔑 账号切换 / 二次验证」。已给 9334 Chrome 加了反检测（`--disable-blink-features=AutomationControlled` + stealth 脚本），滑块基本不弹，但风控强时仍可能弹。
- **@ 在无头下偶尔要重试**：编辑器焦点会飘，`comment-mention-ui.mjs` 已带重试循环，但做不到 100% 一把过。失败时重跑一次即可。
- **删评论要靠「回评拿 cid」绕路**：评论列表接口按热门返回，自己的新评论（0 赞）沉底分页拿不到 cid。让主人回一条，从通知的 `parent_id` 拿自己的 cid 再删。
- 只盯 `peer` 一个会话；多会话列表还没做。
- 语音/图片等非文字消息只显示占位符。
- **无头 UA 会被抖音静默拒**：`HeadlessChrome/151` 打 `/tab/feed`、`/notice` 得到的是 **200 + 空 body**。走页面内请求前必须先用 `Network.setUserAgentOverride` 去掉 `Headless` 标记（`feed-pick.mjs` / `notice-read.mjs` 已内置；版本号用浏览器真实的，别硬写）。
- **页面内请求必须 `pauseWatcher()`**：哨兵会把页面导航回 `/chat`，一旦导航，页面里的 `fetch` 永远不 resolve —— 表现是"卡住不动"，既不报错也不超时。

## 架构（2026-10-24 定稿）

**单浏览器**：所有工具都走 **9334 Chrome**（`chrome.mjs` 通过 CDP 拉起，永远无头），**不依赖 DSH 的 browser 服务**。所以切 DSH 浏览器有头/无头不会再「移除工具」。

- 读私信（哨兵）→ `chat-read-once.mjs`
- @ → `comment-mention-ui.mjs`（CDP 真 @）
- 评论/回评 → `comment-api.mjs`；删评 → `comment-delete.mjs`；通知 → `notice-read.mjs`
- 发私信 → `im-send.mjs`；分享卡片 → `card-share.mjs`；刷候选 → `feed-pick.mjs`
- 登录备份/恢复 → `cookie-save.mjs` / `cookie-load.mjs`；关闭时停靠页面 → `park.mjs`

## 文件

- `index.js` —— 插件本体（watcher + 9 个工具）
- `cordis.patch.yml` —— 挂载声明（bundle patch）
- `locale/*.json`、`icon.svg` —— 插件列表里的中文名/描述/图标
- `tools/*.mjs` —— 10 个动作脚本（纯 Node，无 Python 依赖）
- `tools/*.py` —— **已弃用**，仅历史参考

## 维护：清浏览器缓存（2026-10-24 加）

设置页「维护 → 清理浏览器缓存」= POST /api/douyin-watch/cleanup → 	ools/clean-cache.mjs。

- **只删白名单目录**：Default/Cache、Default/Code Cache、*GPUCache、*ShaderCache、Service Worker、component_crx_cache、Safe Browsing、CertificateRevocation、WasmTtsEngine（删了 Chrome 会重建）
- **绝不碰**：Default/Network/Cookies、Preferences、Local State、Default/Local Storage、Default/IndexedDB —— 脚本清完会**再自检一遍**这些文件是否还在，丢了直接报错
- 先 Browser.close 再删（不然 EPERM），并等 CDP 端口真的死掉；删不掉的目录会二次重试
- 顺带清 $HOME/inbox 里 7 天前的聊天图片（表情/封面）
- 实测：profile 608.7 MB → 40.4 MB；清完浏览器自动重启，30 秒内恢复读取

## 人设（2026-10-24 加，省上下文设计）

两个字段，成本完全不同：

| 字段 | 何时进上下文 | 建议长度 | 成本 |
|---|---|---|---|
| `personaShort` | **每次唤醒**都带一行 | ≤60 字 | 每轮几十 token |
| `personaFull` | **只在点「注入到当前会话」时**进一次会话历史 | ≤300 字 | 一次性，之后靠记忆 |

为什么这么做：人设全文一旦进了会话，**之后每轮请求都会带着它**（上下文累积）。所以既不每轮拼进 prompt，也不自动注入——只在换会话 / 换人设时手动点一次。QQ 那类桥接插件的做法是「每 30 回合灌一次完整风格」，我们用「钉死会话 + 注入一次」更省。

接口：`POST /api/douyin-watch/persona/inject` → 优先 `agent.inject()`（只加上下文、不唤醒），老版本 DSH 没有 inject 就退化成 `followup()`（会多跑一轮），返回值里的 `via` 会告诉你走了哪条。

- **清缓存会短暂断读**：`clean-cache.mjs` 先关浏览器再删（否则 EPERM），重启后有概率撞「验证码中间页」，那 30–60 秒读不到私信，期间的消息会推迟到下一轮唤醒。看着像装死，其实没丢；碰上就切有头过验证。
