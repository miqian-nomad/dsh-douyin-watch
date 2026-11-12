/**
 * 回归测试：闸门（被拦了要停手，且不许误报）
 *
 * 背景：2026-10-25 那次误报「验证码中间页」把主人骗去重新登录了一遍 ——
 *   判据是「页面里有 captcha 元素」就报。这里钉死：只看**看得见**的滑块 / 明确验证页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyPageState, decideGate, gateAllows, gateExpired, gateText, isDouyinUrl, GATE } from '../lib/gate-state.mjs'

const NORMAL = {
  title: '迷迁 - 抖音', href: 'https://www.douyin.com/chat',
  verifyVisible: false, messageCount: 18,
  bodyText: '开启读屏标签 读屏标签已关闭 迷迁 周六 顺嘴一句：卡片写232……',
}
const CHAT_WITH_WORD = {
  ...NORMAL,
  bodyText: '迷迁 有人问我验证码怎么过，我说那是二次验证……还有别的消息',
}

test('正常页面 → ok', () => {
  assert.equal(classifyPageState(NORMAL).kind, GATE.OK)
})

test('正文里出现「验证码」三个字不算验证码（老误报的形态）', () => {
  assert.equal(classifyPageState(CHAT_WITH_WORD).kind, GATE.OK, '有聊天内容时，别人聊到验证码不能当成被拦')
})

test('看得见的滑块 → verify', () => {
  const v = classifyPageState({ ...NORMAL, verifyVisible: true })
  assert.equal(v.kind, GATE.VERIFY)
  assert.match(v.evidence, /看得见/)
})

test('标题是验证页 → verify', () => {
  assert.equal(classifyPageState({ ...NORMAL, title: '验证码中间页' }).kind, GATE.VERIFY)
})

test('没有验证框、只有正文要求拖滑块 → verify（确实停在那页了）', () => {
  const v = classifyPageState({ title: '', messageCount: 0, verifyVisible: false, bodyText: '请完成下方验证，按住左边滑块拖动' })
  assert.equal(v.kind, GATE.VERIFY)
})

test('登录页（有登录入口且一条聊天都没有）→ login', () => {
  const v = classifyPageState({ title: '抖音', messageCount: 0, verifyVisible: false, bodyText: '扫码登录 密码登录 验证码登录' })
  assert.equal(v.kind, GATE.LOGIN)
})

test('有聊天内容时出现「立即登录」字样 → 仍是 ok（不误报登录失效）', () => {
  assert.equal(classifyPageState({ ...NORMAL, bodyText: '立即登录可以看更多 迷迁 你好' }).kind, GATE.OK)
})

test('页面空白/没加载 → unknown，且不冒充验证码', () => {
  const v = classifyPageState({ title: '', messageCount: 0, verifyVisible: false, bodyText: '' })
  assert.equal(v.kind, GATE.UNKNOWN)
  assert.match(v.evidence, /没内容|没加载|没渲染/)
  assert.equal(/验证码/.test(v.evidence), false, '拿不准不能说是验证码')
})

test('真机踩到的形态：标题空、正文 175 字外壳、聊天 0 条 → unknown（不能判 ok）', () => {
  const v = classifyPageState({ title: '', messageCount: 0, verifyVisible: false, bodyText: '开启读屏标签 读屏标签已关闭 ' + 'x'.repeat(140) })
  assert.equal(v.kind, GATE.UNKNOWN, '页面没渲染出来却判 ok，闸门会自动化放行')
})

test('真的空会话页（有标题、没消息）→ ok，别误判成故障', () => {
  const v = classifyPageState({ title: '迷迁 - 抖音', messageCount: 0, verifyVisible: false, bodyText: '私信 会话列表 搜索 还没有新消息，点开某个会话开始聊天' })
  assert.equal(v.kind, GATE.OK)
})

test('429 → rate（唯一允许冷却等待的）', () => {
  assert.equal(classifyPageState({ ...NORMAL, httpStatus: 429 }).kind, GATE.RATE)
})

test('机审：verify/login 是 block 且必须等主人，不设自动重试时间', () => {
  for (const kind of [GATE.VERIFY, GATE.LOGIN]) {
    const d = decideGate({ verdict: { kind, evidence: 'x' }, now: 1000 })
    assert.equal(d.action, 'block')
    assert.equal(d.needsOwner, true)
    assert.equal(d.retryAt, null)
  }
})

test('机审：rate 冷却 10 分钟、unknown 冷却 2 分钟，到点自动放行', () => {
  const now = 1_000_000
  const r = decideGate({ verdict: { kind: GATE.RATE, evidence: '' }, now })
  assert.equal(r.action, 'cooldown')
  assert.equal(r.retryAt, now + 600e3)
  const u = decideGate({ verdict: { kind: GATE.UNKNOWN, evidence: '' }, now })
  assert.equal(u.retryAt, now + 120e3)

  assert.equal(gateAllows({ kind: GATE.RATE, retryAt: now + 600e3 }, now + 300e3), false)
  assert.equal(gateAllows({ kind: GATE.RATE, retryAt: now + 600e3 }, now + 601e3), true)
})

test('机审：verify 挡着时，时间再久也不自动放行', () => {
  assert.equal(gateAllows({ kind: GATE.VERIFY }, Date.now() + 86400e3), false)
})

test('提示话术分得清三种坏法（主人知道该去哪）', () => {
  assert.match(gateText({ kind: GATE.VERIFY }), /切有头 \+ 触发验证/)
  assert.match(gateText({ kind: GATE.LOGIN }), /重新登录/)
  assert.match(gateText({ kind: GATE.RATE }), /限流/)
  assert.match(gateText({ kind: GATE.UNKNOWN }), /没看懂|页面状态/)
})

// ── 2026-11-13（Codex 审查 P2）：冷却到点要能把闸门**真摘掉** ──────────────────
test('冷却到期 → gateExpired=true（状态该清了，不然界面一直显示暂停）', () => {
  const now = 1_000_000
  assert.equal(gateExpired({ kind: GATE.RATE, retryAt: now + 600e3, needsOwner: false }, now + 300e3), false)
  assert.equal(gateExpired({ kind: GATE.RATE, retryAt: now + 600e3, needsOwner: false }, now + 601e3), true)
  assert.equal(gateExpired({ kind: GATE.UNKNOWN, retryAt: now + 120e3, needsOwner: false }, now + 121e3), true)
})

test('需要主人的闸门永不过期（只能主人点或探针确认）', () => {
  for (const kind of [GATE.VERIFY, GATE.LOGIN]) {
    assert.equal(gateExpired({ kind, retryAt: null, needsOwner: true }, Date.now() + 31536e6), false)
    // needsOwner 字段丢了也不能被当成"可自动清"
    assert.equal(gateExpired({ kind, retryAt: Date.now() - 1 }, Date.now() + 31536e6), false)
  }
  assert.equal(gateExpired(null), false)
  assert.equal(gateExpired({ kind: GATE.OK }), false)
})

// ── 2026-11-13（Codex 审查 P2）：探针只认抖音页 ────────────────────────────────
test('isDouyinUrl：只认抖音域名，别的页一律不算', () => {
  for (const u of ['https://www.douyin.com/chat', 'http://douyin.com', 'https://live.douyin.com/123']) {
    assert.equal(isDouyinUrl(u), true, u)
  }
  for (const u of ['about:blank', '', 'https://douyin.com.evil.example/x', 'https://example.com/?r=douyin.com', 'https://notdouyin.com/']) {
    assert.equal(isDouyinUrl(u), false, u)
  }
})