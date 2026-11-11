/**
 * 回归测试：签名自检的「四种坏法」判定
 * 判据全部来自 2026-11-13 的真机实测（见 lib/comment-probe.mjs 顶部那段结论）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyCommentProbe, PROBE } from '../lib/comment-probe.mjs'

const COOKIE_OK = { file: true, ttwid: true, session: true }
const R_ITEMS = { http: 200, status_code: 0, n: 14, ok_json: true, head: '{"status_code":0,"comments":[...' }
const R_EMPTY = { http: 200, status_code: null, n: 0, ok_json: false, head: '' }
const R_429 = { http: 429, status_code: null, n: 0, ok_json: false, head: '' }
const R_NO_ID = { http: 200, status_code: 5, n: 0, ok_json: true, head: '{"status_code":5,...' }

test('正常：签名有数据、假签名也有 ⇒ ok，但记下"签名没被校验"', () => {
  const v = classifyCommentProbe({ signed: R_ITEMS, badSign: R_ITEMS, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.OK)
  assert.equal(v.sign_checked, false)
  assert.match(v.evidence, /不校验/)
})

test('正常：假签名拿不到、正常签名拿得到 ⇒ ok 且签名真的被校验', () => {
  const v = classifyCommentProbe({ signed: R_ITEMS, badSign: R_EMPTY, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.OK)
  assert.equal(v.sign_checked, true)
})

test('签名过期：正常签名空、假签名反而有数据 ⇒ sign_stale（不是"不确定"）', () => {
  const v = classifyCommentProbe({ signed: R_EMPTY, badSign: R_ITEMS, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.SIGN_STALE)
})

test('参数问题：status_code 5 ⇒ params_bad（含 status_msg 也认）', () => {
  assert.equal(classifyCommentProbe({ signed: R_NO_ID, badSign: R_NO_ID, unsigned: R_EMPTY, cookie: COOKIE_OK }).state, PROBE.PARAMS_BAD)
  const v = classifyCommentProbe({ signed: { ...R_ITEMS, status_msg: '参数错误' }, badSign: R_ITEMS, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.PARAMS_BAD)
})

test('风控：429 ⇒ risk（先于其它判断，不能被"空 body"带偏）', () => {
  const v = classifyCommentProbe({ signed: R_429, badSign: R_429, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.RISK)
})

test('cookie 缺失 / 缺 ttwid ⇒ cookie_missing（本地就能判，不用猜）', () => {
  assert.equal(classifyCommentProbe({ signed: R_EMPTY, badSign: R_EMPTY, unsigned: R_EMPTY, cookie: { file: false, ttwid: false, session: false } }).state, PROBE.COOKIE_MISSING)
  assert.equal(classifyCommentProbe({ signed: R_EMPTY, badSign: R_EMPTY, unsigned: R_EMPTY, cookie: { file: true, ttwid: false, session: true } }).state, PROBE.COOKIE_MISSING)
})

test('三次全空 ⇒ empty_silent（如实说分不清，不冒充验证码/签名过期）', () => {
  const v = classifyCommentProbe({ signed: R_EMPTY, badSign: R_EMPTY, unsigned: R_EMPTY, cookie: COOKIE_OK })
  assert.equal(v.state, PROBE.EMPTY_SILENT)
  assert.match(v.evidence, /空 body/)
  assert.equal(/验证码/.test(v.evidence), false)
})

test('登录态有没有，不影响 comment/list 的判定（实测不需要登录）', () => {
  const a = classifyCommentProbe({ signed: R_ITEMS, badSign: R_ITEMS, unsigned: R_EMPTY, cookie: { file: true, ttwid: true, session: false } })
  assert.equal(a.state, PROBE.OK, '去掉 sessionid 也照样能读评论，不能因此报登录失效')
})