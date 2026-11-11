/**
 * 回归测试：issue #2 第二条 —— 认领时 sec_uid 被清零
 *
 * 测的是 lib/owner-claim.mjs 的判定（纯函数，不碰文件、不碰浏览器）。
 * 重点三条：页面给了 ID 就用；页面没给但昵称一致就保留旧 ID；昵称不一致绝不沿用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveOwnerClaim } from '../lib/owner-claim.mjs'

const NOW = '2026-11-13T10:00:00.000Z'
const SEC = 'MS4wLjABAAAA_old_sec_uid_keep_me'
const SEC2 = 'MS4wLjABAAAA_page_sec_uid'
const PEER_SEC = 'MS4wLjABAAAA_peer_sec_uid'

test('页面给了 sec_uid → 直接用页面的，via=page', () => {
  const r = resolveOwnerClaim({
    page: { sec: SEC2, title: '迷迁' },
    old: { sec_uid: SEC, nick: '迷迁', verified_at: '2026-11-01T00:00:00.000Z' },
    peer: { nick: '迷迁', sec_uid: PEER_SEC },
    now: NOW,
  })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'page')
  assert.equal(r.record.sec_uid, SEC2)
  assert.equal(r.record.nick, '迷迁')
  assert.equal(r.record.claimed_at, NOW)
})

test('页面没给 sec_uid、昵称一致 → 保留旧 sec_uid（不清零）', () => {
  const r = resolveOwnerClaim({
    page: { sec: '', title: '迷迁' },
    old: { sec_uid: SEC, nick: '迷迁', verified_at: '2026-11-01T00:00:00.000Z' },
    peer: null,
    now: NOW,
  })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'owner.json')
  assert.equal(r.record.sec_uid, SEC, '旧 sec_uid 必须原样保留')
  assert.equal(r.record.claimed_at, NOW, '只更新时间戳')
  assert.equal(r.record.verified_at, '2026-11-01T00:00:00.000Z', '已有验证时间不该被冲掉')
})

test('页面没给 sec_uid、昵称不一致 → ok:false，且不产出 record（不沿用旧 ID）', () => {
  const r = resolveOwnerClaim({
    page: { sec: '', title: '另一个人' },
    old: { sec_uid: SEC, nick: '迷迁' },
    peer: { nick: '迷迁', sec_uid: PEER_SEC },   // peer 也不该被拿去顶
    now: NOW,
  })
  assert.equal(r.ok, false)
  assert.equal(r.sec_missing, true)
  assert.equal(r.page_ok, true, '页面本身是好的，只是没给 ID')
  assert.equal(r.record, undefined, '拿不到就不能产出记录 —— 否则又写半截文件')
  assert.match(r.error, /对不上/)
})

test('连旧值都没有 → ok:false，别写半截文件', () => {
  const r = resolveOwnerClaim({ page: { sec: '', title: '迷迁' }, old: null, peer: null, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.sec_missing, true)
  assert.equal(r.record, undefined)
})

test('旧记录只有 sec_uid 没有昵称 → 不敢沿用（昵称校验绑死）', () => {
  const r = resolveOwnerClaim({
    page: { sec: '', title: '迷迁' },
    old: { sec_uid: SEC, nick: '' },
    peer: null,
    now: NOW,
  })
  assert.equal(r.ok, false)
  assert.equal(r.record, undefined)
})

test('页面没给、昵称和 peer.json 一致 → 用 peer.json 兜底', () => {
  const r = resolveOwnerClaim({
    page: { sec: '', title: '迷迁' },
    old: null,
    peer: { nick: '迷迁', sec_uid: PEER_SEC },
    now: NOW,
  })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'peer.json')
  assert.equal(r.record.sec_uid, PEER_SEC)
})

test('peer.json 昵称对不上 → 不用它', () => {
  const r = resolveOwnerClaim({
    page: { sec: '', title: '别人' },
    old: null,
    peer: { nick: '迷迁', sec_uid: PEER_SEC },
    now: NOW,
  })
  assert.equal(r.ok, false)
  assert.equal(r.record, undefined)
})

test('页面连名字都没认出来 → ok:false 且 page_ok:false（这时候才算页面坏了）', () => {
  const r = resolveOwnerClaim({ page: { sec: '', title: '' }, old: null, peer: null, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.page_ok, false, '页面坏和"页面好但没 ID"要分开，设置页才不会误报')
  assert.match(r.error, /没认出会话身份/)
})