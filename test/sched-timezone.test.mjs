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

test('② 跨零点尾段：00:30 时 18:30-09:00 还能排出点，尾段 per 继承这一行填的条数', () => {
  const now = at(0, 30)
  const segs = expandWindows(['18:30-09:00'], [3], now)
  assert.equal(segs.length, 2, '00:30 时应有两段：昨晚那段的后半夜 + 今晚 18:30 起的那段')
  const tail = segs[0]
  const tonight = segs[1]
  assert.ok(tail.tail === true, '第一段要标成尾段（tail）')
  assert.equal(tail.per, 3, '尾段继承这一行填的 3（不再强制 0 —— 强制 0 会把剩余额度全吃走）')
  assert.equal(tonight.per, 3, '今晚那段也是 3')
  assert.ok(tail.s < now && tail.e > now, 'now 必须真的落在尾段里面')
  assert.equal(fmt(tail.e), '09:00', '尾段在今天 09:00 结束')
  assert.equal(fmt(tonight.s), '18:30', '第二段是今晚 18:30 开始')
})

// 2026-11-18（MOSS 给的期望值，四条都钉住）：
//   ① 填 3、perDay=12 → 尾段 3 + 今晚 3 = 6 点（尾巴不抢额度，也不复制成 6 条）
//   ② 不填、perDay=12 → 两段按段长各 6 = 12 点
//   ③ 填 3、perDay=5  → 今晚 3 + 尾段 2 = 5 点（天花板卡住，尾巴拿剩下的）
//   ④ 不跨零点的段在 00:30 不许凭空长尾巴
const slotsAt0030 = (pers, perDay) => {
  const now = at(0, 30)
  const segs = expandWindows(['18:30-09:00'], pers, now)
  const r = planWindowSlots(segs, perDay, now, false, () => 0.5)
  return { segs, slots: r.slots }
}

test('② 填 3 条、perDay=12 → 尾段 3 + 今晚 3 = 6 个点', () => {
  const { slots } = slotsAt0030([3], 12)
  assert.equal(slots.length, 6, '总数必须是 6：' + slots.length)
  const tailPart = slots.filter((t) => t < at(12, 0))     // 今天中午之前 = 后半夜那半段
  const nightPart = slots.filter((t) => t >= at(12, 0))
  assert.equal(tailPart.length, 3, '尾段 3 个点')
  assert.equal(nightPart.length, 3, '今晚 3 个点')
})

test('② 不填条数、perDay=12 → 两段按段长各 6 = 12 个点', () => {
  const { segs, slots } = slotsAt0030([], 12)
  assert.equal(slots.length, 12, '总数必须是 12：' + slots.length)
  // 两段一样长（都是 14.5 小时）→ 各分 6
  assert.equal(segs[0].e - segs[0].s, segs[1].e - segs[1].s, '两段应该一样长，才能对半分')
  const tailPart = slots.filter((t) => t < at(12, 0))
  const nightPart = slots.filter((t) => t >= at(12, 0))
  assert.equal(tailPart.length, 6, '尾段 6 个点')
  assert.equal(nightPart.length, 6, '今晚 6 个点')
})

test('② 填 3 条、perDay=5 → 今晚 3 + 尾段 2 = 5 个点（今天优先，尾巴拿剩下的）', () => {
  const { slots } = slotsAt0030([3], 5)
  assert.equal(slots.length, 5, '总数必须是 5：' + slots.length)
  const tailPart = slots.filter((t) => t < at(12, 0))
  const nightPart = slots.filter((t) => t >= at(12, 0))
  assert.equal(nightPart.length, 3, '今晚先拿满 3')
  assert.equal(tailPart.length, 2, '尾段拿剩下的 2（不是 3）')
})

test('② 所有点都落在两段里，且同一条时间线不重复', () => {
  const now = at(0, 30)
  for (const [pers, perDay] of [[[3], 12], [[], 12], [[3], 5]]) {
    const { slots } = slotsAt0030(pers, perDay)
    assert.equal(new Set(slots).size, slots.length, '不许有重复时刻')
    for (const t of slots) {
      const okTail = t >= now && t <= now + 8.5 * 3600 * 1000
      const okTonight = t >= at(18, 30) && t <= at(18, 30) + 14.5 * 3600 * 1000
      assert.ok(okTail || okTonight, '有点跑到段外了：' + fmt(t))
    }
  }
})

test('② 反向：不跨零点的时段（09:00-18:00）在 00:30 不会凭空多出尾段', () => {
  const now = at(0, 30)
  const segs = expandWindows(['09:00-18:00'], [], now)
  assert.equal(segs.length, 1, '白天段在凌晨没有"尾段"可收')
  assert.equal(segs.filter((s) => s.tail).length, 0)
  assert.equal(planWindowSlots(segs, 12, now, false, () => 0.5).slots.length, 12, '只有今天这一段，12 点照排')
})

test('planWindowSlots 会就地改 per：注释里必须写明，别让人复用同一个数组', () => {
  const LIB = readFileSync(join(ROOT, 'lib', 'sched.mjs'), 'utf8')
  assert.match(LIB, /会\*\*就地\*\*改 `segs\[i\]\.per`/, '缺「会就地改 per」的警告')
  assert.match(LIB, /别连着算两次|重新\s*`?expandWindows/, '要说清怎么重算')
})
