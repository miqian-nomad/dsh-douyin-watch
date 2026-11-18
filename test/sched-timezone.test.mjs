/**
 * 回归测试：时区 + 跨零点尾段（2026-11-18，MOSS 批的修法）
 *
 * 背景（真 bug）：`todayKeyLocal()` 用的是 `toISOString().slice(0,10)` —— 那是 **UTC 日期**。
 *   UTC+8 的用户在本地 00:00–08:00 之间 UTC 还停在昨天：配额到早上 8 点才重置，
 *   昨晚的排期表也继续有效（跨夜后 60 分钟内会把昨晚的点补跑一次）。
 *
 * 这里钉三件事（都是喂固定 now 的真值测试，不是盯源码）：
 *   ① 日期键按本地算：本地 0:30 → 2026-11-18（UTC 会给 11-17）
 *   ② 跨零点尾段：00:30 时 18:30-09:00 这段还能排出点，尾段 `per` 强制 0（不重复给额度），
 *      和晚上的点加起来不超过 perDay
 *   ③ 日期一变，配额/时刻表跟着换天（localDateKey 在本地零点跳变）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localDateKey, expandWindows, planWindowSlots } from '../lib/sched.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')
const fmt = (ms) => new Date(ms).toTimeString().slice(0, 5)

/** 把「今天」钉在 2026-11-18 00:30（本地时间） */
const at = (h, m) => new Date(2026, 10, 18, h, m, 0, 0).getTime()

test('① 日期键按本地算：本地 0:30 是 2026-11-18，不是 UTC 的 11-17', () => {
  const d = new Date(2026, 10, 18, 0, 30)
  assert.equal(localDateKey(d), '2026-11-18', '本地 0:30 必须是本地的 11-18')
  // 这条是「为什么以前错」的证据：同一个时刻，UTC 取法是 11-17
  assert.equal(d.toISOString().slice(0, 10), '2026-11-17', 'UTC 取法在本地凌晨会退到前一天（这就是老 bug）')
  assert.match(SERVER, /import \{ localDateKey[^}]*\} from '\.\/lib\/sched\.mjs'/, 'index.js 要真的用这个实现')
  assert.match(SERVER, /function todayKeyLocal\(\) \{ return localDateKey\(\) \}/, 'todayKeyLocal 要委托给 localDateKey')
  // 只看代码行：注释里写明「以前是 toISOString…」是历史说明，不算残留
  const code = SERVER.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.equal(/toISOString\(\)\.slice\(0, 10\)/.test(code), false, 'index.js 里不许再留 UTC 日期取法')
})

test('③ 本地零点一过就换天：配额与时刻表跟着归零/重建', () => {
  // 23:59 还是 11-18，0:01 已经是 11-19 —— 配额比较的就是这个键
  assert.equal(localDateKey(new Date(2026, 10, 18, 23, 59)), '2026-11-18')
  assert.equal(localDateKey(new Date(2026, 10, 19, 0, 1)), '2026-11-19')
  // 老写法在这两个时刻都是 11-18（所以配额要到早上 8 点才重置）
  assert.equal(new Date(2026, 10, 18, 23, 59).toISOString().slice(0, 10), '2026-11-18')
  assert.equal(new Date(2026, 10, 19, 0, 1).toISOString().slice(0, 10), '2026-11-18')
  // 配额状态比较的就是 localDateKey()，日期不匹配就返回 0
  assert.match(SERVER, /const today = localDateKey\(\)/, 'readPickerState 要用本地日期比较')
  assert.match(SERVER, /JSON\.stringify\(\{ date: localDateKey\(\), count \}/, 'writePickerState 要写本地日期')
})

test('② 跨零点尾段：00:30 时 18:30-09:00 还能排出点，尾段 per 强制 0', () => {
  const now = at(0, 30)
  const segs = expandWindows(['18:30-09:00'], [], now)
  assert.equal(segs.length, 2, '00:30 时应有两段：昨晚那段的后半夜 + 今晚 18:30 起的那段')
  const tail = segs[0]
  const tonight = segs[1]
  assert.ok(tail.tail === true, '第一段要标成尾段（tail）')
  assert.equal(tail.per, 0, '尾段不占配置里填的条数')
  assert.ok(tail.s < now && tail.e > now, 'now 必须真的落在尾段里面')
  assert.equal(fmt(tail.e), '09:00', '尾段在今天 09:00 结束')
  assert.equal(fmt(tonight.s), '18:30', '第二段是今晚 18:30 开始')
})

test('② 续：perDay=12 时，尾段 + 晚上加起来正好不超过 12', () => {
  const now = at(0, 30)
  const segs = expandWindows(['18:30-09:00'], [], now)
  const r = planWindowSlots(segs, 12, now, false, () => 0.5)
  assert.ok(r.slots.length > 0, '00:30 这个时点必须排得出点')
  assert.ok(r.slots.length <= 12, '总数不许超过 perDay：' + r.slots.length)
  const inTail = r.slots.filter((t) => t >= now && t < now + (9 * 3600 + 30 * 60) * 1000)
  assert.ok(inTail.length > 0, '后半夜（尾段）里要有点')
  // 每个点都落在「00:30 → 今天 09:00」或「今天 18:30 → 明天 09:00」里
  for (const t of r.slots) {
    const okTail = t >= now && t <= now + 8.5 * 3600 * 1000
    const okTonight = t >= at(18, 30) && t <= at(18, 30) + 14.5 * 3600 * 1000
    assert.ok(okTail || okTonight, '有点跑到段外了：' + fmt(t))
  }
})

test('② 续：填了 3 条时，尾段不跟着拿 3 条（不会 3+3=6）', () => {
  const now = at(0, 30)
  const per = [3]
  const segs = expandWindows(['18:30-09:00'], per, now)
  assert.equal(segs[0].per, 0, '尾段永远 per=0，不复制配置里的 3')
  assert.equal(segs[1].per, 3, '配置的 3 条属于今晚那一段')
  const r = planWindowSlots(segs, 12, now, false, () => 0.5)
  assert.ok(r.slots.length <= 12, '总数不许超过 12')
})

test('② 续：不跨零点的时段（09:00-18:00）在 00:30 不会凭空多出尾段', () => {
  const now = at(0, 30)
  const segs = expandWindows(['09:00-18:00'], [], now)
  assert.equal(segs.length, 1, '白天段在凌晨没有"尾段"可收')
  assert.equal(segs.filter((s) => s.tail).length, 0)
})
