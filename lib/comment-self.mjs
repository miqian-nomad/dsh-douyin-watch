/**
 * lib/comment-self.mjs —— 「这条评论是不是我自己发的」
 * ============================================================================
 * 为什么单拎出来（2026-11-13 自查发现，和 issue #2 同族：**拿不到就当成"不是我"**）：
 *   work-comments.mjs 用「本账号 uid」判断"我回过没有"，但 uid 来自作品详情接口；
 *   详情接口被拦时 authorUid 为空 —— 于是：
 *     · answered_by_me 永远 false（靠台账兜住，不会重复回）
 *     · 但"这条是不是我自己发的" 也跟着判不出来
 *   而 index.js 传给 pickReplyTargets 的 selfNick 是 `author.nick || cfg.owner`，
 *   新用户常常两个都空 → 昵称过滤整个失效 → **可能去回自己发的那条评论**。
 *   用户看到的就是「Bot 在自己视频下面自己回自己」。
 *
 * 判定顺序（uid 永远比昵称可信）：
 *   ① mine === true            → 是我（脚本按 uid 比出来的，最准）
 *   ② mine === false           → 不是我（uid 明明不一样，昵称撞了也不认）
 *   ③ mine 未知（null）        → 退化成比昵称：两边都有且相等 → 是我；
 *                                任一边为空或不等 → 不是我
 *   ④ 昵称也对不上号（两边有一边空）→ 'unknown'：**分不清，宁可跳过**
 *      这一条是关键：以前"分不清"被当成"不是我"，等于默认放过。
 *
 * 纯函数，不读文件不看时间。
 * ============================================================================
 */
export function classifyCommentSelf({ mine = null, nick = '', selfNick = '', uid = '', selfUid = '' } = {}) {
  const n = String(nick == null ? '' : nick).trim()
  const s = String(selfNick == null ? '' : selfNick).trim()
  const u = String(uid == null ? '' : uid).trim()
  const su = String(selfUid == null ? '' : selfUid).trim()

  if (mine === true) return 'self'
  if (mine === false) return 'ok'

  // mine 未知：本机缓存能给出"我自己的 uid"时，按 uid 精确比（比昵称可靠）
  if (su) {
    if (u) return u === su ? 'self' : 'ok'
    if (n && s) return n === s ? 'self' : 'ok'
    return 'unknown'
  }

  // 只有昵称可比
  if (n && s) return n === s ? 'self' : 'ok'
  return 'unknown'
}

/** 给日志/状态卡用的一句话原因 */
export function selfSkipReason(kind) {
  if (kind === 'self') return '这是我自己发的'
  if (kind === 'unknown') return '拿不到本账号 uid 和昵称，分不清是不是我发的，先不回'
  return ''
}