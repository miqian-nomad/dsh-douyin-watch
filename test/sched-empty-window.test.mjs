/**
 * 回归测试：2026-11-18「按时间段但一段没填 = 今天不刷」这条规则
 *
 * 这几条是自审补的，盯的都是**上一个 commit 之后**才暴露出来的缝：
 *   ① 规则本身（inAutoWindow / buildSlotTimes 双闸）—— 别哪天又退回「空 = 不限」
 *   ② 规则版本进签名 —— 不然今天已排的旧表会照老规则跑完
 *   ③ 设置页那条警告的判据：要按「填完的段」算，不是按「列表里有几行」
 *      （点了 + 但没选时间时 rows.length=1、真正保存的段还是 0）
 *   ④ 静默问题：window 且没有可用时段时，inAutoWindow 先 return，导致
 *      buildSlotTimes 里那句「今天不刷」根本打不出来 → 现在改成每个签名打一次
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('规则①：window + 空列表 → inAutoWindow 返回 false（不再当"不限"）', () => {
  assert.match(SRC, /if \(String\(cfg\.autoScrollWhen \|\| 'uptime'\) !== 'window'\) return true/, 'uptime 那条早返回不能丢')
  assert.match(SRC, /if \(!wins\.length\) return false/, '空时段又变回「不限」了')
  // 顺序：uptime 早返回必须在前，否则 uptime 模式会被空列表挡住
  const iUptime = SRC.indexOf("!== 'window') return true")
  const iEmpty = SRC.indexOf('if (!wins.length) return false')
  assert.ok(iUptime > 0 && iEmpty > iUptime, '两个闸的顺序反了（uptime 会被误伤）')
})

test('规则②：window 但没有可用段 → 不排表、不回落「开机就刷」算法', () => {
  assert.match(SRC, /if \(byWindow && !segs\.length\) \{/, '缺新分支')
  const i = SRC.indexOf('if (byWindow && !segs.length) {')
  assert.match(SRC.slice(i, i + 400), /return \[\]/, '新分支要直接返回空表')
  // 回落分支只能在没有 segs 且不是 window 时进
  assert.match(SRC, /if \(!segs\.length\) \{\r?\n\s*\/\/ ── ① 开机自动刷/, '开机就刷那段还在（给 uptime 用）')
})

test('规则③：规则版本号进签名（今天已排的旧表要被顶掉）', () => {
  assert.match(SRC, /const SCHED_RULE_VERSION = 2/, '版本号不是 2')
  assert.match(SRC, /const schedSig = \(\) => \['v' \+ SCHED_RULE_VERSION/, '版本号没进签名')
})

test('静默问题：每个签名只解释一次「今天不刷」', () => {
  assert.match(SRC, /function logIdleScheduleOnce\(\)/, '缺这条日志函数')
  assert.match(SRC, /if \(idleLoggedSig === sig\) return/, '没有去重，会每 60 秒刷一条')
  assert.match(SRC, /if \(!inAutoWindow\(\)\) \{ logIdleScheduleOnce\(\); return \}/, '早返回那行没接上日志')
})

test('设置页警告：按「填完的段」判，不是按 rows.length', () => {
  assert.match(CLIENT, /!rows\.some\(\(r\) => r && r\.start && r\.end\)/, '警告判据不对（点 + 没填时会漏掉）')
  assert.match(CLIENT, /还没有一段填完整 = 今天不刷/, '警告文案没了')
})

test('设置页文案：每段条数的占位符不再写「不限」', () => {
  assert.match(CLIENT, /placeholder: '按额度分'/, '占位符还写着「不限」，会和「空=不刷」混起来')
  assert.equal(/placeholder: '不限'/.test(CLIENT), false, '又出现「不限」占位符了')
})

test('配置默认值注释跟着规则改（不然下一个人照着注释又写回"不限"）', () => {
  assert.match(SRC, /autoScrollWindows: \[\], \/\/[^\n]*空 = 今天不刷/, '默认值那行注释还写着「不限定」')
  assert.equal(/只在 when='window' 时用；空 = 不限定/.test(SRC), false, '旧注释还在')
})
