/**
 * 回归测试：认领 → 收件人（2026-11-18 的真 bug）
 *
 * 症状：走完引导、认领成功、哨兵也能读私信，但发私信/发卡片全部失败 ——
 *   因为认领只写了 owner.json，`cfg.owner` 从来没被同步，发送侧读的是 `cfg.owner`（空串）。
 *   主人这台机器看不出，是因为他 watch-config.json 里早手填了 owner。
 *
 * 这里钉四件事：
 *   ① 收件人取值：cfg.owner 优先，其次 owner.json 的 nick，都没 → 空（调用方要报人话）
 *   ② 传给 im-send 的 `--to` 不是空串（mock 掉 execFile，直接断言参数）
 *   ③ 收件人空的时候**根本不启动**进程，只回一句人话
 *   ④ 认领 / 启动同步 / 三个发送默认收件人都要用这条兜底（源码形状）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveOwnerName, makeSendChatText, makeShareCardTo, NO_OWNER_MSG } from '../lib/outbound.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')
const IMSEND = readFileSync(join(ROOT, 'tools', 'im-send.mjs'), 'utf8')
const PATCH = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** 假的 execFile：只记录参数，立刻回一段 im-send 风格的 JSON */
function fakeExec(reply) {
  const calls = []
  const fn = (node, args, opts, cb) => {
    calls.push({ node, args, opts })
    if (cb) cb(null, JSON.stringify(reply || { ok: true, sent: true, readback: true, to: '迷迁' }))
  }
  fn.calls = calls
  return fn
}

test('① 收件人：cfg.owner 优先，其次 owner.json 的昵称，都没有才空', () => {
  assert.equal(resolveOwnerName('迷迁', '一条黄毛大肥鱼'), '迷迁', 'cfg.owner 有值就用它')
  assert.equal(resolveOwnerName('', '迷迁'), '迷迁', '认领过但配置没填 → 用 owner.json 的昵称')
  assert.equal(resolveOwnerName('  ', '迷迁'), '迷迁', '只有空白也算没填')
  assert.equal(resolveOwnerName('', ''), '', '两个都没有 → 空（调用方必须报人话）')
  assert.equal(resolveOwnerName(undefined, undefined), '', 'undefined 不许变成 "undefined" 字符串')
})

test('② 传到 im-send 的 --to 不是空串（mock execFile 看参数）', async () => {
  const exec = fakeExec()
  const send = makeSendChatText({
    node: 'node', script: 'im-send.mjs', env: () => ({ DOUYIN_HOME: 'x' }),
    peerName: () => resolveOwnerName('', '迷迁'),   // 配置空、认领有 → 必须还能发
    exec,
  })
  const r = await send('你好')
  assert.equal(exec.calls.length, 1, '应该只调一次 execFile')
  const args = exec.calls[0].args
  assert.deepEqual(args, ['im-send.mjs', '--to', '迷迁', '--text', '你好'], '参数必须带真实收件人')
  assert.notEqual(args[2], '', '--to 不许是空串')
  assert.equal(r.ok, true)
  assert.equal(r.readback, true, 'readback 要单独带出来（唯一的送达证据）')
  assert.equal(r.to, '迷迁')
})

test('③ 收件人为空时不许启动进程，只回一句人话', async () => {
  const exec = fakeExec()
  const send = makeSendChatText({
    node: 'node', script: 'im-send.mjs', env: () => ({}), peerName: () => '', exec,
  })
  const r = await send('你好')
  assert.equal(exec.calls.length, 0, '空收件人时不许白开浏览器')
  assert.equal(r.ok, false)
  assert.equal(r.error, NO_OWNER_MSG)
  assert.match(r.error, /还没认领主人/, '要说人话，别让用户看「没找到「」」')
})

test('② 分享卡片同样：收件人走兜底，空就不启动', async () => {
  const okExec = fakeExec({ ok: true, evidence: 'toast' })
  const share = makeShareCardTo({
    node: 'node', script: 'card-share.mjs', env: () => ({}),
    peerName: () => resolveOwnerName('', '迷迁'), exec: okExec,
  })
  await share('7703929158044290319')
  assert.deepEqual(okExec.calls[0].args, ['card-share.mjs', '7703929158044290319', '迷迁'], '卡片也要真实收件人')

  const emptyExec = fakeExec()
  const share2 = makeShareCardTo({
    node: 'node', script: 'card-share.mjs', env: () => ({}), peerName: () => '', exec: emptyExec,
  })
  const r2 = await share2('7703929158044290319')
  assert.equal(emptyExec.calls.length, 0, '没认领时不许开浏览器')
  assert.equal(r2.error, NO_OWNER_MSG)
})

test('④ 两条认领路都要同步 cfg.owner（设置页 + 引导，缺一条等于没修）', () => {
  // 设置页那条
  const i = SERVER.indexOf("pathname === '/api/douyin-watch/claim'")
  assert.ok(i > 0, '找不到设置页认领路由')
  const block = SERVER.slice(i, SERVER.indexOf("pathname === '/api/douyin-watch/config'", i))
  assert.match(block, /cfg\.owner = rec\.nick/, '设置页认领后要把 cfg.owner 补上')
  assert.match(block, /disk\.owner = rec\.nick/, '还要落盘 disk.owner')
  assert.match(block, /if \(rec && rec\.nick && !String\(cfg\.owner \|\| ''\)\.trim\(\)\)/, '只补空值，不覆盖手填的名字')

  // 引导那条（新用户基本都走这条）
  const j = SERVER.indexOf("pathname === '/api/douyin-watch/onboard/claim'")
  assert.ok(j > 0, '找不到引导认领路由')
  const wiz = SERVER.slice(j, SERVER.indexOf("pathname === '/api/douyin-watch/onboard/finish'", j))
  assert.match(wiz, /cfg\.owner = rec\.nick/, '引导认领也要同步 cfg.owner（新用户全走这条）')
  assert.match(wiz, /disk\.owner = rec\.nick/, '引导认领也要落盘')
})

test('④ 启动时补一次（老用户升级不该被迫重新认领）', () => {
  const i = SERVER.indexOf('启动同步 owner')
  assert.ok(i > 0, '找不到启动同步那段')
  const block = SERVER.slice(i, i + 900)
  assert.match(block, /if \(!String\(cfg\.owner \|\| ''\)\.trim\(\)\)/, '只在 owner 为空时补')
  assert.match(block, /readOwnerClaim\(\)/, '要从 owner.json 读昵称')
  assert.match(block, /disk\.owner = nick/, '补完要落盘')
})

test('④ 三个发送默认收件人都走同一条兜底（不再直接读 cfg.owner）', () => {
  assert.match(SERVER, /const ownerName = \(\) => resolveOwnerName\(cfg\.owner, \(readOwnerClaim\(\) \|\| \{\}\)\.nick\)/, '缺统一的收件人函数')
  // sendChatText / shareCardTo 两个壳子都吃 peerName: ownerName
  assert.equal((SERVER.match(/peerName: ownerName/g) || []).length, 2, 'sendChatText 与 shareCardTo 都要用它')
  // 逐个点：douyin_send / douyin_share / douyin_comment_at 的默认收件人
  assert.match(SERVER, /if \(!ownerName\(\)\) \{\s*\n\s*return \{ ok: false, delivered: false, read: false, detail: NO_OWNER_MSG \}/, 'douyin_send 要先用兜底判空')
  assert.match(SERVER, /const peer = String\(\(args && args\.peer\) \|\| ownerName\(\) \|\| ''\)\.trim\(\)/, 'douyin_share 的默认收件人')
  assert.match(SERVER, /const who = String\(\(args && args\.name\) \|\| ownerName\(\) \|\| ''\)\.trim\(\)/, 'douyin_comment_at 的默认 @ 对象')
  assert.match(SERVER, /const ownerNick = ownerName\(\)/, '判「这条是不是主人发的」也要用兜底（不然把主人当陌生人）')
})

test('回归：im-send --to 为空时仍然不许点第一条会话', () => {
  assert.match(IMSEND, /if \(whoId\) \{[\s\S]{0,200}\} else if \(who\) \{[\s\S]{0,200}\} else \{[\s\S]{0,120}return \{ status: 'not-found'/, '空 who / 空 whoId 必须直接 not-found，不许默认选第一个会话')
})

test('cordis.patch.yml 的说明要跟真实行为一致', () => {
  assert.equal(/认领主人功能上线后，peer \/ owner 已经不用手填了/.test(PATCH), false, '那句旧话必须改掉（只写 owner.json，不同步配置）')
  assert.match(PATCH, /认领成功后会写 owner\.json，并同步进 watch-config\.json/, '要写清现在到底会同步什么')
})
