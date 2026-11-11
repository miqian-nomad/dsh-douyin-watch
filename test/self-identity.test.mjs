/**
 * 回归测试：本机记录的「这个账号自己是谁」（六条规矩）
 * 重点钉两件事：① 只存账号自己、不碰主人；② uid/昵称对不上就作废，绝不沿用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeLearned, resolveSelfIdentity, normalizeStore, SELF_MAX } from '../lib/self-identity.mjs'

const NOW1 = '2026-11-13T10:00:00.000Z'
const NOW2 = '2026-11-13T11:00:00.000Z'
const ME = { uid: '7607266828653659185', nick: '一条黄毛大肥鱼' }

test('第一次学到 → 记成 current，且只存 uid/昵称/时间（不存凭据）', () => {
  const r = mergeLearned({ learned: ME, store: null, now: NOW1 })
  assert.equal(r.changed, true)
  assert.deepEqual(Object.keys(r.store.current).sort(), ['learned_at', 'nick', 'uid'])
  assert.equal(r.store.current.uid, ME.uid)
  assert.equal(r.store.current.nick, ME.nick)
})

test('同一个账号再学到 → 覆盖更新，不追加', () => {
  const first = mergeLearned({ learned: ME, store: null, now: NOW1 }).store
  const again = mergeLearned({ learned: { uid: ME.uid, nick: '改了个名字' }, store: first, now: NOW2 })
  assert.equal(again.store.current.nick, '改了个名字')
  assert.equal(again.store.known.length, 0, '同账号不该进历史列表')
})

test('换了账号 → 旧记录作废（挪进历史），current 换成新的', () => {
  const first = mergeLearned({ learned: ME, store: null, now: NOW1 }).store
  const other = mergeLearned({ learned: { uid: '999', nick: '别的号' }, store: first, now: NOW2 })
  assert.equal(other.store.current.uid, '999')
  assert.equal(other.store.known[0].uid, ME.uid)
  assert.match(other.reason, /换/)
})

test('上限：历史最多 3 条，超了删最旧的', () => {
  let store = null
  for (let i = 0; i < SELF_MAX + 4; i++) store = mergeLearned({ learned: { uid: String(1000 + i), nick: 'n' + i }, store, now: NOW2 }).store
  assert.equal(store.known.length, SELF_MAX, '历史列表必须有上限')
})

test('详情给了 uid：和缓存一致 → 用详情的；不一致 → 标作废（不许沿用）', () => {
  const store = mergeLearned({ learned: ME, store: null, now: NOW1 }).store
  const same = resolveSelfIdentity({ learned: { uid: ME.uid, nick: '新昵称' }, store })
  assert.equal(same.uid, ME.uid)
  assert.equal(same.source, 'learned')
  assert.equal(same.invalidated, false)

  const diff = resolveSelfIdentity({ learned: { uid: '999', nick: '别的号' }, store })
  assert.equal(diff.uid, '999')
  assert.equal(diff.invalidated, true, '账号对不上必须作废缓存')
})

test('详情只给昵称、且和缓存不一致 → 作废，不拿缓存顶', () => {
  const store = mergeLearned({ learned: ME, store: null, now: NOW1 }).store
  const r = resolveSelfIdentity({ learned: { nick: '完全不同的名字' }, store })
  assert.equal(r.invalidated, true)
  assert.equal(r.uid, '', '不能把缓存的 uid 拿来用')
})

test('详情啥都没给 → 用缓存兜底（这才是缓存的用途）', () => {
  const store = mergeLearned({ learned: ME, store: null, now: NOW1 }).store
  const r = resolveSelfIdentity({ learned: {}, store })
  assert.equal(r.source, 'cache')
  assert.equal(r.uid, ME.uid)
  assert.equal(r.nick, ME.nick)
})

test('缓存里什么都没有 → none（调用方按"分不清"处理，绝不用主人身份顶）', () => {
  const r = resolveSelfIdentity({ learned: {}, store: normalizeStore(null) })
  assert.equal(r.source, 'none')
  assert.equal(r.uid, '')
  assert.equal(r.nick, '')
})