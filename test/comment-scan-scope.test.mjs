/**
 * 回归测试：issue #2 第一条
 *   `addedWorks is not defined` —— 声明在 if 块内、读取在块外，块没进入时每轮扫描都抛
 *   ReferenceError，评论自动回一条也发不出来。
 *
 * 这里不复制一份逻辑来测（那只能证明我抄对了），而是把 index.js 里
 * **真实的** maybeScanComments 函数源码抠出来，塞上桩跑一遍：
 *   · 桩里没有任何叫 addedWorks 的东西，所以旧代码在这里一定抛 ReferenceError，
 *     被函数自己的 catch 接住 → 日志出现「评论区扫描失败」
 *   · 新代码（声明在块外）跑得过，并且 lastCommentScan.added 数字对得上
 * 所以这条测试在修复前的代码上是红的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyCommentSelf } from '../lib/comment-self.mjs'
import { gateAllows, GATE, NEEDS_OWNER } from '../lib/gate-state.mjs'
import { resolveSelfIdentity, mergeLearned, normalizeStore } from '../lib/self-identity.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')

// ── 从源码里抠一个函数（字符串 / 模板串 / 注释都跳过，只数真括号）──────────────
function skipQuoted(s, i, q) {
  i++
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (s[i] === q) return i + 1
    i++
  }
  return s.length
}
function skipTemplate(s, i) {
  i++
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (s[i] === '`') return i + 1
    if (s[i] === '$' && s[i + 1] === '{') { const e = scanBraces(s, i + 1); if (e < 0) return s.length; i = e; continue }
    i++
  }
  return s.length
}
function scanBraces(s, start) {
  let depth = 0
  let i = start
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"' || ch === "'") { i = skipQuoted(s, i, ch); continue }
    if (ch === '`') { i = skipTemplate(s, i); continue }
    if (ch === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); if (e < 0) return -1; i = e; continue }
    if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i + 1 }
    i++
  }
  return -1
}
function extractFunction(src, head) {
  const at = src.indexOf(head)
  assert.ok(at >= 0, 'index.js 里找不到 ' + head + '（函数被改名了？测试要跟着改）')
  const open = src.indexOf('{', at + head.length)
  const end = scanBraces(src, open)
  assert.ok(end > open, '函数体括号没配平，抠不出来')
  return src.slice(at, end)
}

const FN_SRC = extractFunction(SRC, 'async function maybeScanComments(')

// ── 桩：这里刻意不提供 addedWorks ─────────────────────────────────────────────
function harness(over = {}) {
  const logs = []
  const saved = []
  const pickedWith = []
  const pickedOpts = []
  const gates = []
  const selfWrites = []
  const runtime = { lastCommentScanAt: 0 }
  const cfg = {
    commentAutoReply: true,
    commentAutoReplyWork: true,
    commentAutoReplyOthers: false,
    commentScanMinutes: 10,
    commentMaxPerRound: 3,
    commentWorkMaxAgeDays: 0,
    noticeScript: 'notice',
    workCommentsScript: 'works',
    commentNoticeMaxAgeHours: 48,
    commentMaxChars: 60,
    commentSkipNicks: '',
    commentSkipPureMention: true,
    owner: '本账号',
    ...over.cfg,
  }
  const deps = {
    cfg,
    runtime,
    log: (m) => logs.push(String(m)),
    runNode: async (script) => {
      if (script === cfg.noticeScript) return { parsed: { items: over.noticeItems || [] } }
      return { parsed: over.workResult || { works: [], discovered: [], author: {} } }
    },
    myWorkIds: () => [...(over.known || [])],
    saveMyWorks: (list) => saved.push([...list]),
    pickReplyTargets: (items, opts) => { pickedWith.push(items); pickedOpts.push(opts); return { total: items.length, targets: [], skipped: [] } },
    repliedTargets: () => new Set(),
    ledgerHasTarget: () => false,
    recordPublicComment: () => {},
    sessionRoute: () => null,
    makeUserMessage: (x) => x,
    buildCommentPrompt: () => '',
    // index.js 顶部 import 进来的纯函数，抠出来的函数体里按模块作用域引用它
    classifyCommentSelf,
    gateAllows, GATE, NEEDS_OWNER,
    // 闸门那几个是闭包，这里只记录调用（真行为由 gate-state.test 覆盖）
    enterGate: (verdict, where) => { gates.push({ verdict, where }) },
    // 本机账号记录：用真实现 + 假文件（记到 selfWrites 里断言）
    readSelfStore: () => normalizeStore(over.selfStore || null),
    writeSelfStore: (st) => { selfWrites.push(st); return true },
    resolveSelfIdentity, mergeLearned,
    probeGateIfDue: async () => false,
  }
  const factory = new Function(
    'deps',
    'const {' + Object.keys(deps).join(',') + '} = deps;\n'
    + 'return (' + FN_SRC + ');',
  )
  const scan = factory(deps)
  return { scan, cfg, runtime, logs, saved, pickedWith, pickedOpts, gates, selfWrites }
}

/** 跑一轮扫描；顺手把"函数自己吞掉异常"这件事也检查了 */
async function runOnce(h) {
  await h.scan({})
  const crashed = h.logs.filter((l) => l.includes('评论区扫描失败'))
  assert.deepEqual(crashed, [], '扫描抛异常了：' + crashed.join(' / '))
  const selfErr = h.logs.filter((l) => l.includes('读写本机账号记录失败'))
  assert.deepEqual(selfErr, [], '本机账号记录那段被 catch 吞了：' + selfErr.join(' / '))
  return h
}

test('块未进入（还没有作品）：块外读取不报 ReferenceError', async () => {
  const h = harness({ known: [] })            // workIds 为空 → if (doWork && workIds.length) 整块跳过
  await runOnce(h)
  assert.ok(h.runtime.lastCommentScan, 'lastCommentScan 没写出来（说明那一行又炸了）')
  assert.equal(h.runtime.lastCommentScan.items, 0)
  assert.equal(h.runtime.lastCommentScan.works, 0)
  assert.equal(h.runtime.lastCommentScan.added, 0, '没进块时新增作品数必须是 0')
})

test('块进入但没有新作品：added 为 0', async () => {
  const h = harness({
    known: ['w1'],
    workResult: { works: [{ aweme: 'w1', items: [] }], discovered: [], author: { nick: '本账号' } },
  })
  await runOnce(h)
  assert.equal(h.runtime.lastCommentScan.added, 0)
  assert.equal(h.runtime.lastCommentScan.works, 1)
})

test('块进入并记住 2 个新作品：added 为 2（块外按差值算，不依赖块内变量）', async () => {
  const h = harness({
    known: ['w1'],
    workResult: { works: [], discovered: ['w2', 'w3'], author: { nick: '本账号' } },
  })
  await runOnce(h)
  assert.equal(h.runtime.lastCommentScan.added, 2)
  assert.equal(h.saved.length, 1, '新作品应该落盘一次')
  assert.deepEqual(h.saved[0], ['w1', 'w2', 'w3'])
  assert.ok(h.logs.some((l) => l.includes('记住我的作品 2 个')), '日志里的新增数量也要对')
})

// ── 自己回自己（2026-11-13 自查）：mine / 昵称判不出来时不能默认放过 ──────────
const WORK = (items, authorNick) => ({
  works: [{ aweme: 'w1', items }],
  discovered: [],
  author: authorNick ? { nick: authorNick } : {},
})

test('uid 说是我的评论 → 不进候选（不自己回自己）', async () => {
  const h = harness({
    known: ['w1'],
    workResult: WORK([{ cid: 'c1', nick: '本账号', text: '置顶一下', time: 1, mine: true }], '本账号'),
  })
  await runOnce(h)
  assert.equal(h.pickedWith.length, 0, '被过滤光了就不该再进挑选')
  assert.equal(h.runtime.lastCommentScan.items, 0)
  assert.ok(h.logs.some((l) => l.includes('我自己发的')), '要留下"跳过的是我自己"的日志')
})

test('uid 和昵称都拿不到 → 分不清就不回，并留下原因', async () => {
  const h = harness({
    known: ['w1'],
    cfg: { owner: '' },
    workResult: WORK([{ cid: 'c1', nick: '', text: '这是谁发的？', time: 1, mine: null }], null),
  })
  await runOnce(h)
  assert.equal(h.runtime.lastCommentScan.items, 0, '分不清的条目不该进候选')
  assert.match(String(h.runtime.lastError || ''), /分不清/, '状态卡要说清为什么没回')
})

test('uid 拿不到但昵称明确不是我 → 照常进候选', async () => {
  const h = harness({
    known: ['w1'],
    workResult: WORK([{ cid: 'c2', nick: '路人甲', text: '好看', time: 1, mine: null }], '本账号'),
  })
  await runOnce(h)
  assert.equal(h.pickedWith.length, 1)
  assert.equal(h.pickedWith[0].length, 1, '正常别人的评论不能被误伤')
  assert.equal(h.runtime.lastCommentScan.items, 1)
})

test('作者昵称拿不到时，不许拿配置里的 owner 当"我自己"（实测两者不是一个号）', async () => {
  // 真机数据：owner=迷迁（能命令我的人），账号昵称=一条黄毛大肥鱼
  const h = harness({
    known: ['w1'],
    cfg: { owner: '迷迁' },
    workResult: WORK([{ cid: 'c3', nick: '一条黄毛大肥鱼', text: '这条其实是我自己发的', time: 1, mine: null }], null),
  })
  await runOnce(h)
  assert.equal(h.runtime.lastCommentScan.items, 0, '认不出账号昵称时不能当成"别人"，否则就回自己了')
  assert.match(String(h.runtime.lastError || ''), /分不清/)
})
test('详情接口给了本账号 uid → 写进本机记录（身份只存账号自己）', async () => {
  const h = harness({
    known: ['w1'],
    workResult: {
      works: [], discovered: [],
      author: { nick: '一条黄毛大肥鱼', uid: '7607266828653659185' },
    },
  })
  await runOnce(h)
  assert.equal(h.selfWrites.length, 1, '应该写一次 self.json')
  assert.equal(h.selfWrites[0].current.uid, '7607266828653659185')
  assert.equal(h.selfWrites[0].current.nick, '一条黄毛大肥鱼')
  assert.ok(h.logs.some((l) => l.includes('本机账号身份记住了')))
})

test('详情给不出身份、本机也没有记录 → 不写文件，按"分不清"跳过', async () => {
  const h = harness({
    known: ['w1'],
    workResult: { works: [{ aweme: 'w1', items: [{ cid: 'c9', nick: '', text: 'x', time: 1, mine: null }] }], discovered: [], author: {} },
    selfStore: null,
  })
  await runOnce(h)
  assert.equal(h.selfWrites.length, 0, '没学到就不该写')
  assert.equal(h.runtime.lastCommentScan.items, 0)
})

// ── 2026-11-13（MOSS 专项）：selfNick 里绝不许混进 cfg.owner ─────────────────
test('pickReplyTargets 收到的 selfNick 用账号自己的昵称，不含 cfg.owner', async () => {
  const h = harness({
    known: ['w1'],
    cfg: { owner: '主人的号' },
    workResult: {
      works: [{ aweme: 'w1', items: [{ cid: 'x1', nick: '路人甲', text: '好看', time: 1, mine: null }] }],
      discovered: [], author: { nick: '账号自己的号' },
    },
  })
  await runOnce(h)
  assert.equal(h.pickedOpts.length, 1, '应该走到挑选这一步')
  assert.equal(h.pickedOpts[0].selfNick, '账号自己的号', 'selfNick 必须是账号自己的昵称')
  assert.equal(String(h.pickedOpts[0].selfNick).includes('主人的号'), false, '绝不能混进 owner')
})

test('账号身份拿不到时，selfNick 也必须是空，不能退化成 owner', async () => {
  const h = harness({
    known: ['w1'],
    cfg: { owner: '主人的号' },
    workResult: {
      works: [{ aweme: 'w1', items: [{ cid: 'x3', nick: '主人的号', text: '来评论区看看', time: 1, mine: null }] }],
      discovered: [], author: {},
    },
  })
  await runOnce(h)
  assert.equal(h.pickedOpts.length, 1)
  assert.equal(h.pickedOpts[0].selfNick, '', '账号身份为空时必须留空')
})

test('账号身份未知 + owner 有值：昵称等于 owner 的评论必须进候选（不是"我"）', async () => {
  const h = harness({
    known: ['w1'],
    cfg: { owner: '主人的号' },
    workResult: { works: [{ aweme: 'w1', items: [{ cid: 'x2', nick: '主人的号', text: '来评论区看看', time: 1, mine: null }] }], discovered: [], author: {} },
  })
  await runOnce(h)
  assert.equal(h.pickedWith.length, 1, '不能被当成"我自己"丢掉')
  assert.equal(h.pickedWith[0].length, 1)
  assert.equal(h.pickedWith[0][0].nickname, '主人的号')
})
