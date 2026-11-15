/**
 * 回归测试：认领时从哪个来源取对端身份（issue #5，2026-11-14 抖音改版）
 *
 * 实测背景：改版后消息气泡的 fiber 里没有 conversation 了（58 个气泡 0 命中），
 *   但左侧会话列表「当前选中项」还挂着 → 必须优先看它。
 * 这里不复制逻辑，直接把 tools/claim-owner.mjs 里那段真实页面脚本抠出来，
 * 喂一个假 DOM 跑，断言取到的 sec / title / via。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'tools', 'claim-owner.mjs'), 'utf8')

// 抠出 const OPENED_PEER = `...`
const MARK = 'const OPENED_PEER = `'
const at = SRC.indexOf(MARK)
assert.ok(at >= 0, 'claim-owner.mjs 里找不到 OPENED_PEER（改名了？测试要跟着改）')
const start = at + MARK.length
const end = SRC.indexOf('`', start)
assert.ok(end > start, 'OPENED_PEER 模板没闭合')
const SNIPPET = SRC.slice(start, end)

const run = (doc) => JSON.parse(new Function('document', 'return ' + SNIPPET)(doc))

// 假 fiber 链：只在 memoizedProps.conversation 上给 sec
const fiberWith = (sec) => ({ memoizedProps: { conversation: { toParticipantSecUserId: sec } }, return: null })
const fiberEmpty = () => ({ memoizedProps: { message: {} }, return: null })
const node = (cls, fiber) => {
  const o = { className: cls }
  o['__reactFiber$t1'] = fiber || fiberEmpty()
  return o
}
const head = (text) => ({ innerText: text })

const fakeDoc = ({ items = [], msgs = [], headText = '' }) => ({
  querySelectorAll(sel) {
    if (sel.includes('conversationConversationItem')) return items
    if (sel.includes('messageMessageBox')) return msgs
    return []
  },
  querySelector(sel) {
    if (sel.includes('RightPanelHeadertitle')) return headText ? head(headText) : null
    return null
  },
})

const SEC = 'MS4wLjABAAAAcurr0000'

test('改版后的真实形态：气泡全空，靠会话列表当前项取到 ID', () => {
  const r = run(fakeDoc({
    items: [
      node('conversationConversationItemwrapper conversationConversationItemsomeone', fiberWith('MS4wLjABAAAAother')),
      node('conversationConversationItemwrapper conversationConversationItemcurConversation', fiberWith(SEC)),
    ],
    msgs: [node('messageMessageBox'), node('messageMessageBox')],
    headText: '叶藏在梦里',
  }))
  assert.equal(r.sec, SEC)
  assert.equal(r.via, 'conv')
  assert.equal(r.title, '叶藏在梦里', '昵称必须一起带出来，否则 owner.json 里 nick 会是空串')
})

test('只认"当前选中"那一项：别的会话行里有 ID 也不能拿（认错主人比拿不到更糟）', () => {
  const r = run(fakeDoc({
    items: [node('conversationConversationItemwrapper conversationConversationItemsomeone', fiberWith('MS4wLjABAAAAother'))],
    msgs: [],
    headText: '叶藏在梦里',
  }))
  assert.equal(r.sec, '', '非当前项不能兜底')
  assert.equal(r.via, 'none')
  assert.equal(r.title, '叶藏在梦里')
})

test('老页面（气泡还带 conversation）仍然走得通', () => {
  const r = run(fakeDoc({ items: [], msgs: [node('messageMessageBox', fiberWith('MS4wLjABAAAAold'))], headText: '老页面' }))
  assert.equal(r.sec, 'MS4wLjABAAAAold')
  assert.equal(r.via, 'msg')
})

test('什么都没取到 → sec 空、标题留着（调用方据此报「拿不到 ID」，不许写空串）', () => {
  const r = run(fakeDoc({ items: [], msgs: [], headText: '叶藏在梦里' }))
  assert.equal(r.sec, '')
  assert.equal(r.via, 'none')
  assert.equal(r.title, '叶藏在梦里')
})