/**
 * 回归测试：「这条评论是不是我自己发的」
 *
 * 修的是和 issue #2 同族的一种 bug：拿不到本账号 uid/昵称时，"分不清"被当成了"不是我"，
 * 于是可能去回自己发的评论（用户看到的就是 Bot 在自己视频下面自己回自己）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyCommentSelf } from '../lib/comment-self.mjs'

test('uid 明确说是我 → self（昵称不一致也信 uid）', () => {
  assert.equal(classifyCommentSelf({ mine: true, nick: '别人', selfNick: '我' }), 'self')
})

test('uid 明确说不是我 → ok（哪怕昵称撞上了也不认）', () => {
  assert.equal(classifyCommentSelf({ mine: false, nick: '同名的人', selfNick: '同名的人' }), 'ok')
})

test('uid 拿不到、但昵称一致 → 仍然算 self（老兜底不丢）', () => {
  assert.equal(classifyCommentSelf({ mine: null, nick: '迷迁', selfNick: '迷迁' }), 'self')
})

test('uid 拿不到、昵称明确不同 → ok', () => {
  assert.equal(classifyCommentSelf({ mine: null, nick: '路人', selfNick: '迷迁' }), 'ok')
})

test('uid 和昵称都拿不到 → unknown（分不清就不回，绝不默认放过）', () => {
  assert.equal(classifyCommentSelf({ mine: null, nick: '路人', selfNick: '' }), 'unknown')
  assert.equal(classifyCommentSelf({ mine: null, nick: '', selfNick: '迷迁' }), 'unknown')
  assert.equal(classifyCommentSelf({ mine: null, nick: '', selfNick: '' }), 'unknown')
})

test('缓存给了自己 uid 时，按 uid 精确比（昵称不同也能认）', () => {
  assert.equal(classifyCommentSelf({ mine: null, uid: '760', selfUid: '760', nick: '一条黄毛大肥鱼', selfNick: '' }), 'self')
  assert.equal(classifyCommentSelf({ mine: null, uid: '777', selfUid: '760', nick: '同名的人', selfNick: '同名的人' }), 'ok')
  assert.equal(classifyCommentSelf({ mine: null, uid: '', selfUid: '760', nick: '', selfNick: '' }), 'unknown')
})

test('老版本脚本没给 mine 字段（undefined）时，按"拿不到"处理，不会误判成不是我', () => {
  assert.equal(classifyCommentSelf({ nick: '迷迁', selfNick: '迷迁' }), 'self')
  assert.equal(classifyCommentSelf({ nick: '', selfNick: '' }), 'unknown')
})