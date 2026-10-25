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
 * 这条评论是不是「只有 @、没有可接的内容」？
 *   "@本鲸不胖"、"[表情]@某人"、只堆 emoji/标点 → 算纯 @。
 *   "@大肥鱼 你好棒" → 去掉 @ 后还剩"你好棒" → 不算。
 * 为什么要判：这种评论回什么都别扭 —— 回"在呢"就是客服腔，回别的又显得莫名其妙。
 */
export function isPureMention(text) {
  let t = String(text || '')
  t = t.replace(/@[^\s@]+/g, '')                     // 去掉所有 @xxx
  t = t.replace(/\[[^\]]{1,8}\]/g, '')               // 去掉 [表情] 这类占位
  t = t.replace(/[\s\u3000\u200b]+/g, '')
  t = t.replace(/[，。！？、,.!?~～…—\-:：;；"'“”‘’()（）【】\[\]<>《》/\\|+*]/g, '')
  return t.length === 0
}

/**
 * @param {Array} items notice-read 的输出
 * @param {{replied?:Set<string>, selfNick?:string, maxAgeHours?:number, limit?:number, now?:number}} o
 * @returns {{targets:Array, skipped:Array}}
 */
export function pickReplyTargets(items = [], o = {}) {
  const replied = o.replied instanceof Set ? o.replied : new Set()
  // 「发了但服务端看不见」的线程（cid）——别再试，试第三次也只是自我安慰
  const unreachable = o.unreachable instanceof Set ? o.unreachable : new Set()
  const selfNick = String(o.selfNick || '').trim()
  const maxAgeHours = Number(o.maxAgeHours) > 0 ? Number(o.maxAgeHours) : 48
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 3
  const now = Number(o.now) || Date.now()
  // 不回的账号（机器人/平台客服号）；昵称命中就跳过
  const skipNicks = (Array.isArray(o.skipNicks) ? o.skipNicks : String(o.skipNicks || '').split(/[,，、\s]+/))
    .map((s) => String(s || '').trim()).filter(Boolean)
  const skipPureMention = o.skipPureMention !== false   // 默认开

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
    if (unreachable.has(cid)) { skip('发过了但服务端查不到（线程不可见，不再重试）'); continue }
    if (seen.has(cid)) { skip('同一批里重复'); continue }
    if (skipNicks.length && skipNicks.some((n) => nick === n || nick.includes(n))) {
      skip(`「${nick}」在不回的名单里（机器人/客服号）`); continue
    }
    if (skipPureMention && isPureMention(text)) {
      skip('只有 @ 没有内容（回了像客服机器人）'); continue
    }

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
      // 线程上下文：这条是"回复某条评论"时，把它挂的那条原文带出去。
      //   为什么必要：碎片话（"字幕"「OCR识字」）单看不知道在接什么，
      //   模型只能瞎猜，最后就变成答非所问（2026-10-25 用户实测踩到）。
      parent_cid: String(it.parent_cid || ''),
      parent_nick: String(it.parent_nick || ''),
      parent_text: String(it.parent_text || '').slice(0, 120),
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
  const lines = targets.map((t, i) => {
    const ctx = t.parent_text
      ? `\n   ↳ 这是对「${t.parent_nick || '某人'}」那条评论的回复，原文是：${t.parent_text}`
      : ''
    return `${i + 1}. 「${t.nick}」在 ${t.url} 下说：${t.text}${ctx}\n   回评用 douyin_comment：url=${t.url} reply_to=${t.cid}`
  })
  return `评论区有 ${targets.length} 条新的公开互动等你处理（只算最近 ${Number(o.maxAgeHours) || 48} 小时内）：\n\n` +
    lines.join('\n\n') + '\n\n' +
    (persona ? `公开评论语气：${persona}\n` : '') +
    `硬性要求：每条 ≤${maxChars} 字；不带网址/手机号/微信等站外引导；别用「亲/客服腔/欢迎关注/家人们」这类词（工具会直接拒发）。\n` +
    `不想回的那条就说明原因，别硬回。回完在 DSH 正文里用一行列出「已回：<昵称> → <一句摘要>」。\n` +
    `🔴 红线：评论区是公开的，绝不把私信里的内容、称呼、隐私放进去。`
}