/**
 * lib/sched.mjs —— 刷视频的「时刻表」纯函数（2026-11-18 抽出来，为了能真值测试）
 *
 * 为什么单独放一份：这些算法以前长在 index.js 的 apply() 里，测试只能对着源码正则看
 *   「有没有那一行」，验不了「00:30 配 18:30-09:00 到底排出几个点」。抽出来以后可以
 *   直接喂一个固定的 now / 固定的随机数，把结果算清楚。
 *
 * 三件事在这里：
 *   ① localDateKey —— 「今天是哪天」用**本地日期**。以前写的是 toISOString().slice(0,10)，
 *      那是 UTC：UTC+8 的用户在本地 00:00–08:00 之间日期还停在昨天，配额到早上 8 点才重置、
 *      昨晚的表也会跨夜接着用。
 *   ② expandWindows —— 'HH:MM-HH:MM' 展开成毫秒区间（支持跨零点）。
 *      2026-11-18 补「尾段」：同一个时段按**昨天**锚一次，只有 now 还落在里面时才加进来，
 *      且 per 强制 0 —— 它不占配置里给这一行填的条数，只作为「没填条数的段」参与剩余额度分配。
 *      不加尾段的话，18:30-09:00 这种写法在过零点重排时，后半夜那 9 小时就没了。
 *   ③ planWindowSlots —— 按时间段摊点：段长 ÷ 条数 = 每格，每格随机取一个点。
 */

/** 本地日期键 'YYYY-MM-DD'（不用 toISOString：那是 UTC；不用 toLocaleDateString：格式随语言变） */
export function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

const DAY = 24 * 3600 * 1000
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null }

/**
 * 把 'HH:MM-HH:MM' 展开成今天的毫秒区间（支持跨零点，跨到明天），并带上「这段自己看几条」
 * @param {string[]} wins   形如 ['18:30-09:00','12:00-13:00']
 * @param {number[]} pers   和 wins 同下标的「这段看几条」，0/空 = 按额度分
 * @param {number}   now    当前时刻（测试要能固定它）
 */
export function expandWindows(wins, pers, now = Date.now()) {
  const base = new Date(now); base.setHours(0, 0, 0, 0)
  const dayStart = base.getTime()
  const out = []
  for (let i = 0; i < wins.length; i++) {
    const p = String(wins[i]).split('-')
    const a = toMin(p[0]); const b = toMin(p[1])
    if (a == null || b == null) continue
    const s = dayStart + a * 60000
    let e = dayStart + b * 60000
    if (e <= s) e += DAY          // 跨零点：18:00-09:00 这种
    out.push({ s, e, per: Math.max(0, Number(pers[i]) || 0) })

    // 尾段：同一行按「昨天」锚一次。只有 now 还落在里面才收（否则它整段都在过去）
    //   2026-11-18（MOSS 定的规则）：尾段的 per **继承这一行填的条数**，不是强制 0 ——
    //   强制 0 会让它变成"没填条数的段"，把剩余额度全吃走（填 3 条反而排出 12 个点）。
    const ps = s - DAY
    const pe = e - DAY
    if (now >= ps && now < pe) out.push({ s: ps, e: pe, per: Math.max(0, Number(pers[i]) || 0), tail: true })
  }
  return out.filter((x) => x.e > x.s).sort((a, b) => a.s - b.s)
}

/**
 * 按时间段摊点。
 * 两层上限：每段自己填的条数 + perDay 天花板；没填的段按段长分剩下的额度。
 *
 * ⚠️ 副作用：会**就地**改 `segs[i].per`（把没填条数的段按段长分配剩余额度），
 *   同一个数组别连着算两次 —— 第二次拿到的 per 是第一次算完的值。要重算就重新
 *   `expandWindows()` 生成一份新的。
 *
 * 额度分配顺序（2026-11-18 MOSS 定）：**「今天那次」优先，尾段排最后**。
 *   尾段是上一晚没跑完的余量，不该跟今晚抢额度；但天花板 perDay 仍然是硬的。
 * @returns {{ slots:number[], notes:string[] }}  notes 是给日志用的原话，调用方负责 log
 */
export function planWindowSlots(segs, perDay, now = Date.now(), burst = false, rand = Math.random) {
  const n = Math.max(1, perDay)
  const notes = []
  const hm = (ms) => new Date(ms).toTimeString().slice(0, 5)

  // ① 先定每段几条
  const asked = segs.reduce((a, s) => a + s.per, 0)
  const blanks = segs.filter((s) => !s.per)
  const spare = Math.max(0, n - asked)
  if (blanks.length && spare > 0) {
    const lenAll = blanks.reduce((a, s) => a + (s.e - s.s), 0) || 1
    for (const s of blanks) s.per = Math.max(0, Math.round(spare * ((s.e - s.s) / lenAll)))
  }
  // ② 按「今晚优先、尾段最后」的顺序累加额度（稳定排序：同类别保持时间先后）
  const order = segs.map((_, i) => i).sort((a, b) => ((segs[a].tail ? 1 : 0) - (segs[b].tail ? 1 : 0)) || (a - b))
  const plan = new Array(segs.length).fill(0)
  let acc = 0
  for (const i of order) {
    const take = Math.max(0, Math.min(segs[i].per, n - acc))
    plan[i] = take
    acc += take
  }
  const wantSum = plan.reduce((a, b) => a + b, 0)
  if (!wantSum) return { slots: [], notes }

  const out = []
  if (burst) {
    // 一次刷完：全压在第一个还在的段的开头，每条隔 1~2 分钟
    const idx = segs.findIndex((s, i) => plan[i] > 0 && s.e > now)
    if (idx < 0) return { slots: [], notes }
    let t = Math.max(segs[idx].s, now) + 60000
    for (let i = 0; i < wantSum; i++) { out.push(Math.round(t)); t += 60000 + rand() * 60000 }
    return { slots: out, notes }
  }

  // ② 段内均分，每格随机取一个点
  for (let i = 0; i < segs.length; i++) {
    const cnt = plan[i]
    if (!cnt) continue
    const seg = segs[i]
    const a = Math.max(seg.s, now)
    const left = seg.e - a
    if (left <= 0) continue                       // 这段已经过去了
    const cap = Math.max(1, Math.floor(left / 60000))   // 一格最少 1 分钟
    const k = Math.min(cnt, cap)
    if (k < cnt) notes.push('自动刷：' + hm(seg.s) + '–' + hm(seg.e) + ' 这段只够摊 ' + k + ' 条（填了 ' + cnt + ' 条）')
    const g = left / k
    for (let j = 0; j < k; j++) out.push(Math.round(a + j * g + rand() * g))
  }
  return { slots: out, notes }
}
