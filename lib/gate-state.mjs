/**
 * lib/gate-state.mjs —— 「页面被拦了没有 / 要不要停手」的唯一判定
 * ============================================================================
 * 为什么要有（2026-11-13）：以前遇到验证码只写一行日志 + `return` 跳过这一轮，
 *   下一轮照旧去撞 —— 验证码不会自己消失，撞十次还是十次，还可能把账号撞坏；
 *   主人不翻日志根本不知道。
 *
 * 硬约束（README 2026-10-25 的教训）：**不许误报验证码**。
 *   那次是拿「元素存在」当判据（页面里只要有个 captcha 的 DOM 就报），
 *   结果把主人骗去重新登录了一遍。所以这里：
 *     · 只有**看得见的**滑块（尺寸够大、在视口里）或**明确是验证页**才算 verify；
 *     · 拿不准一律 unknown，并在证据里写清看到了什么，绝不冒充验证码。
 *
 * 四类坏法分开（判据都来自页面真实状态，不靠猜）：
 *   verify  二次验证 / 滑块     → 停手等主人，不自动重试
 *   login   登录态失效         → 停手等主人重新登录
 *   rate    429 / 请求频繁      → 这是唯一允许「冷却等待」的
 *   unknown 页面没内容/没加载   → 报不确定，短冷却后重试（不冒充验证码）
 * ============================================================================
 */

/** 闸门种类 */
export const GATE = {
  OK: 'ok',
  VERIFY: 'verify',
  LOGIN: 'login',
  RATE: 'rate',
  UNKNOWN: 'unknown',
}

/** 这两种必须主人本人处理，插件不再自动发起会触发拦截的动作 */
export const NEEDS_OWNER = new Set([GATE.VERIFY, GATE.LOGIN])

/** rate 冷却 10 分钟；unknown 短冷却 2 分钟（可能只是没加载完） */
export const COOLDOWN_MS = { [GATE.RATE]: 10 * 60e3, [GATE.UNKNOWN]: 2 * 60e3 }

const trim = (v) => String(v == null ? '' : v).trim()

// 只扫页面**开头**一小段正文：整页正文里「验证码」三个字常出现在别人的评论/聊天里，
//   拿它当判据就是 2026-10-25 那种误报。
const head = (body) => trim(body).slice(0, 400)

const LOGIN_RE = /扫码登录|密码登录|验证码登录|登录后查看|立即登录|登录已过期|登录已失效/
const VERIFY_TITLE_RE = /验证码中间页|安全验证|二次验证|请完成验证|验证中|验证失败/
const VERIFY_TEXT_RE = /拖动滑块|请完成下方验证|请完成验证|按住左边滑块/

/**
 * 判定一次页面/接口回包的真实状态。
 * 输入尽量给全，缺的当"没看到"（不会因为缺字段就判成故障）。
 *
 * @param {object} s
 * @param {string} [s.title]        页签标题
 * @param {string} [s.href]         当前 URL
 * @param {boolean} [s.verifyVisible] 有**看得见**的验证码框（尺寸+可见性都满足）
 * @param {string} [s.bodyText]     页面正文（只用前 400 字判断）
 * @param {number} [s.messageCount] 能数到的私信条数（有内容 = 不是登录页）
 * @param {number} [s.httpStatus]   接口 HTTP 状态（429 用）
 * @param {string} [s.code]         脚本自己报的码（如 verify_required）
 * @returns {{kind:string, evidence:string}}
 */
export function classifyPageState(s = {}) {
  const title = trim(s.title)
  const body = head(s.bodyText)
  const http = Number(s.httpStatus) || 0
  const code = trim(s.code)
  const msgs = Number(s.messageCount) || 0

  // ① 限流：唯一可以「等一会儿」的
  if (http === 429 || code === 'rate_limited' || /请求过于频繁|操作太频繁|稍后再试/.test(body)) {
    return { kind: GATE.RATE, evidence: http === 429 ? '接口返回 429' : '页面/接口提示请求频繁' }
  }

  // ② 验证码：只认「看得见的滑块」或「明确是验证页」
  if (s.verifyVisible === true) {
    return { kind: GATE.VERIFY, evidence: '页面上有一个看得见的验证码框（尺寸够大、在视口里）' }
  }
  if (code === 'verify_required') {
    return { kind: GATE.VERIFY, evidence: '扫描脚本报 verify_required' }
  }
  if (VERIFY_TITLE_RE.test(title)) {
    return { kind: GATE.VERIFY, evidence: `页签标题是「${title}」` }
  }
  if (!msgs && VERIFY_TEXT_RE.test(body)) {
    return { kind: GATE.VERIFY, evidence: '页面正文要求拖动滑块完成验证' }
  }

  // ③ 登录态失效：有登录按钮/文案，且页面里根本读不到聊天内容
  if (!msgs && LOGIN_RE.test(body)) {
    return { kind: GATE.LOGIN, evidence: '页面出现登录入口，且一条聊天都读不到' }
  }

  // ④ 页面没内容：明确说"不确定"，不往验证码上靠
  //   2026-11-13 真机踩到：标题空、正文只有 175 个字的浏览器外壳、聊天 0 条 ——
  //   这其实是「页面根本没渲染出来」，要是判成 ok，闸门会以为主人处理完了自动放行。
  const bodyLen = trim(s.bodyText).length
  if (!msgs && title === '') {
    return { kind: GATE.UNKNOWN, evidence: `页签没有标题、聊天 0 条（正文 ${bodyLen} 字）⇒ 页面没渲染出来` }
  }
  if (!msgs && bodyLen < 20) {
    return { kind: GATE.UNKNOWN, evidence: `页面没内容（标题「${title}」、正文 ${bodyLen} 字）` }
  }
  if (code === 'page_not_loaded') {
    return { kind: GATE.UNKNOWN, evidence: '脚本报页面没加载出来' }
  }

  return { kind: GATE.OK, evidence: '' }
}

/**
 * 这次判定之后，插件该怎么走。
 * @returns {{action:'clear'|'block'|'cooldown', kind:string, needsOwner:boolean, retryAt:number|null, reason:string}}
 */
export function decideGate({ verdict, now = Date.now() } = {}) {
  const kind = (verdict && verdict.kind) || GATE.UNKNOWN
  const evidence = (verdict && verdict.evidence) || ''
  if (kind === GATE.OK) return { action: 'clear', kind, needsOwner: false, retryAt: null, reason: '' }
  if (NEEDS_OWNER.has(kind)) {
    return { action: 'block', kind, needsOwner: true, retryAt: null, reason: evidence }
  }
  const ms = COOLDOWN_MS[kind] || COOLDOWN_MS[GATE.UNKNOWN]
  return { action: 'cooldown', kind, needsOwner: false, retryAt: now + ms, reason: evidence }
}

/** 现在能不能动手（blocked = runtime.gate 那个对象） */
export function gateAllows(gate, now = Date.now()) {
  if (!gate || !gate.kind || gate.kind === GATE.OK) return true
  if (NEEDS_OWNER.has(gate.kind)) return false          // 只有主人手动恢复 / 探测确认恢复才会清掉
  return now >= Number(gate.retryAt || 0)
}

/**
 * 2026-11-13（Codex 审查 P2）：冷却类闸门**已经过期、该摘掉了**。
 *   光靠 gateAllows() 只解决"能不能干活"，状态对象还挂着 → 设置页一直显示「已暂停」。
 *   需要主人处理的（verify/login）永不过期，只能等主人点或探针确认。
 */
export function gateExpired(gate, now = Date.now()) {
  if (!gate || !gate.kind || gate.kind === GATE.OK) return false
  if (gate.needsOwner || NEEDS_OWNER.has(gate.kind)) return false
  return now >= Number(gate.retryAt || 0)
}

/** 这个地址是不是抖音页（探针只认它，别拿别的页判"恢复正常"） */
export function isDouyinUrl(href) {
  return /^https?:\/\/([^/]+\.)?douyin\.com(\/|$)/i.test(String(href || ''))
}

/** 给设置页/日志看的一句话 */
export function gateText(gate) {
  if (!gate || !gate.kind || gate.kind === GATE.OK) return ''
  if (gate.kind === GATE.VERIFY) {
    return '需要你过验证码：设置页 → 维护 →「切有头 + 触发验证」，在有头窗口里把滑块划一次，完了点「我已处理，继续」'
  }
  if (gate.kind === GATE.LOGIN) {
    return '登录态失效了：设置页 → 维护 →「切有头 + 触发验证」，在弹出的窗口里重新登录一次，完了点「我已处理，继续」'
  }
  if (gate.kind === GATE.RATE) {
    return `被限流了，先歇到 ${new Date(Number(gate.retryAt || 0)).toLocaleTimeString(undefined, { hour12: false })} 再自动继续`
  }
  return `页面状态没看懂，先停一会儿：${gate.reason || '（没拿到原因）'}`
}