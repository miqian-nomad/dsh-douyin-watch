/**
 * lib/notice-queue.mjs —— 从「互动通知」里挑出**值得回一句**的公开评论
 * ============================================================================
 * 为什么用它、而不是自己去扫作品评论列表：
 *   · 抖音对「有人评论你的作品 / 回复你的评论 / @ 你」都会推通知，
 *     `notice-read.mjs` 已经把 cid + aweme_id + 昵称 + 正文都解出来了；
 *   · 少一个接口、少一次翻页、也不会因为分页漏条；
 *   · 代价是：只覆盖"会推通知"的互动（够用；不含默默点赞）。
 *
 * 边界：
 *   · 纯函数，不联网、不写文件（台账由 outbound-guard 提供）；
 *   · 每条被跳过的都要给 reason，方便日志里看"为什么没回"。
 * ============================================================================
 */

/** 会推通知的互动类型（见 notice-read.mjs 的 TYPE_NAME） */
export const REPLYABLE_TYPES = new Set([
  31, // 回复了你的评论
  35, // 评论了你的作品
  45, // 在评论区 @ 了你
  46, // 在作品里 @ 了你
])

/**
 * @param {Array} items notice-read 的输出
 * @param {{replied?:Set<string>, selfNick?:string, maxAgeHours?:number, limit?:number, now?:number}} o
 * @returns {{targets:Array, skipped:Array}}
 */
export function pickReplyTargets(items = [], o = {}) {
  const replied = o.replied instanceof Set ? o.replied : new Set()
  const selfNick = String(o.selfNick || '').trim()
  const maxAgeHours = Number(o.maxAgeHours) > 0 ? Number(o.maxAgeHours) : 48
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 3
  const now = Number(o.now) || Date.now()

  const targets = []
  const skipped = []
  const seen = new Set()

  for (const it of Array.isArray(items) ? items : []) {
    const cid = String((it && it.comment_id) || '').trim()
    const type = Number(it && it.type)
    const nick = String((it && it.nickname) || '').trim()
    const text = String((it && it.content) || '').trim()
    const aweme = String((it && it.aweme_id) || '').trim()

    const skip = (reason) => skipped.push({ cid, type, nick, reason })
    if (!REPLYABLE_TYPES.has(type)) { skip('类型不参与回复'); continue }
    if (!cid) { skip('没有 comment_id（回不了线程）'); continue }
    if (!aweme || aweme === '0') { skip('没有 aweme_id'); continue }
    if (!text) { skip('正文为空（图片/表情评论）'); continue }
    if (selfNick && nick === selfNick) { skip('是我自己'); continue }
    if (replied.has(cid)) { skip('已经回过了（台账里有）'); continue }
    if (seen.has(cid)) { skip('同一批里重复'); continue }

    // create_time 是秒；缺了就当作"新的"（宁可回错时间也别漏）
    const ts = Number(it && it.create_time)
    if (ts > 0) {
      const ageH = (now / 1000 - ts) / 3600
      if (ageH > maxAgeHours) { skip(`太旧了（${Math.round(ageH)} 小时前）`); continue }
    }

    seen.add(cid)
    targets.push({
      cid, type, nick, text: text.slice(0, 120), aweme,
      url: `https://www.douyin.com/video/${aweme}`,
      at: ts > 0 ? ts * 1000 : null,
    })
  }

  // 新的优先（有时间的排前面）
  targets.sort((a, b) => (b.at || 0) - (a.at || 0))
  return { targets: targets.slice(0, limit), skipped, total: targets.length }
}

/** 生成给 agent 的唤醒提示（只在 targets 非空时调用） */
export function buildCommentPrompt(targets = [], o = {}) {
  const maxChars = Number(o.maxChars) || 60
  const persona = String(o.personaPublic || '').trim()
  const lines = targets.map((t, i) => `${i + 1}. 「${t.nick}」在 ${t.url} 下说：${t.text}\n   回评用 douyin_comment：url=${t.url} reply_to=${t.cid}`)
  return `评论区有 ${targets.length} 条新的公开互动等你处理（只算最近 ${Number(o.maxAgeHours) || 48} 小时内）：\n\n` +
    lines.join('\n\n') + '\n\n' +
    (persona ? `公开评论语气：${persona}\n` : '') +
    `硬性要求：每条 ≤${maxChars} 字；不带网址/手机号/微信等站外引导；别用「亲/客服腔/欢迎关注/家人们」这类词（工具会直接拒发）。\n` +
    `不想回的那条就说明原因，别硬回。回完在 DSH 正文里用一行列出「已回：<昵称> → <一句摘要>」。\n` +
    `🔴 红线：评论区是公开的，绝不把私信里的内容、称呼、隐私放进去。`
}