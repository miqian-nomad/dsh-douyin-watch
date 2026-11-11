/**
 * lib/self-identity.mjs —— 「这台机器上，我（这个抖音账号）是谁」
 * ============================================================================
 * 一定要和 owner.json 分清（2026-11-11 主人当面纠正过）：
 *   · owner.json = **能命令我的人**（主人账号）—— 私信对端的 sec_uid，用途是"谁的话算命令"
 *   · self.json  = **我自己的账号**（本账号）—— uid + 昵称，用途是"这条评论是不是我发的"
 *   两个文件不合并、不互相兜底。之前拿 cfg.owner 当"我自己"，结果自己的评论认不出来。
 *
 * 为什么要缓存：本账号 uid/昵称来自作品详情接口；详情接口被拦时它俩都拿不到，
 *   于是判不出"是不是我发的"。缓存一份，下次拿不到时还能用。
 *
 * 规矩（用户定的六条，写死在实现里）：
 *   ① 一个账号一条，覆盖更新、不追加（同 uid 就改写，不同 uid 才算换号）
 *   ② 只存 uid、昵称、学到的时间；**不存 cookie / 任何凭据**
 *   ③ 失效规则：uid 对不上 或 昵称对不上 → 旧记录作废重学，绝不沿用
 *   ④ 有上限（默认 3 条，超了删最旧的）
 *   ⑤ 设置页有「清除本机记录」
 *   ⑥ README 写明存什么、存哪、怎么清
 * ============================================================================
 */

export const SELF_MAX = 3

const trim = (v) => String(v == null ? '' : v).trim()
const entryOf = (uid, nick, at) => ({ uid: trim(uid), nick: trim(nick), learned_at: String(at || '') })

/**
 * 把「这次从详情接口学到的」合并进缓存。
 * @param {object} s
 * @param {{uid?:string,nick?:string}} s.learned  这次真正学到的（详情接口给的）
 * @param {object} s.store    现有缓存 { current:{uid,nick,learned_at}, known:[...] }
 * @param {string} s.now      ISO 时间
 * @returns {{store:object, changed:boolean, reason:string}}
 */
export function mergeLearned({ learned = {}, store = null, now = '' } = {}) {
  const uid = trim(learned.uid)
  const nick = trim(learned.nick)
  const base = normalizeStore(store)
  if (!uid && !nick) return { store: base, changed: false, reason: '没学到东西' }

  const cur = base.current
  if (cur && uid && cur.uid && cur.uid === uid) {
    // ① 同一个账号 → 覆盖更新（昵称变了也认，uid 才是身份）
    const next = entryOf(uid, nick || cur.nick, now)
    const changed = next.nick !== cur.nick || next.learned_at !== cur.learned_at
    return { store: { ...base, current: next }, changed, reason: '同一个账号，覆盖更新' }
  }
  if (cur && uid && cur.uid && cur.uid !== uid) {
    // ③ 账号换了 → 旧记录挪进历史（不参与判断），当前换成新的
    const known = [cur, ...base.known].slice(0, SELF_MAX)
    return { store: { ...base, current: entryOf(uid, nick, now), known }, changed: true, reason: '换了账号，旧记录作废' }
  }
  // 没 uid（详情接口只给了昵称）或还没记录 → 记一条，等下次用 uid 校准
  const next = entryOf(uid, nick, now)
  const known = base.known.filter((x) => !(uid && x.uid === uid)).slice(0, SELF_MAX)
  return { store: { ...base, current: next, known }, changed: true, reason: uid ? '第一次学到这个账号' : '只学到昵称，先记着' }
}

/** 规范化存储结构（永远只有 current + 有上限的 known） */
export function normalizeStore(store) {
  const s = store && typeof store === 'object' ? store : {}
  const cur = s.current && (s.current.uid || s.current.nick) ? entryOf(s.current.uid, s.current.nick, s.current.learned_at) : null
  const known = (Array.isArray(s.known) ? s.known : [])
    .filter((x) => x && (x.uid || x.nick))
    .map((x) => entryOf(x.uid, x.nick, x.learned_at))
    .slice(0, SELF_MAX)
  return { current: cur, known }
}

/**
 * 决定「这次判断自己身份时，该用谁」。
 * 缓存只在详情接口拿不到时兜底；拿得到就以详情为准（并会顺手更新缓存）。
 *
 * @returns {{uid:string, nick:string, source:'learned'|'cache'|'none', invalidated:boolean, why:string}}
 */
export function resolveSelfIdentity({ learned = {}, store = null } = {}) {
  const lUid = trim(learned.uid)
  const lNick = trim(learned.nick)
  const st = normalizeStore(store)
  const cur = st.current

  if (lUid) {
    // 详情接口给了 uid：它就是权威。缓存里 uid 不同 ⇒ 说明换号了，缓存作废
    if (cur && cur.uid && cur.uid !== lUid) {
      return { uid: lUid, nick: lNick || '', source: 'learned', invalidated: true, why: '缓存里的账号和当前账号不是同一个，已作废' }
    }
    return { uid: lUid, nick: lNick || (cur && cur.uid === lUid ? cur.nick : ''), source: 'learned', invalidated: false, why: '' }
  }

  // 详情只给了昵称、没给 uid：昵称对不上就绝不用缓存（③ 昵称对不上 → 作废）
  if (lNick && cur && cur.nick && lNick !== cur.nick) {
    return { uid: '', nick: lNick, source: 'learned', invalidated: true, why: '缓存昵称和现在的不一样，已作废' }
  }

  // 详情啥都没给 → 用缓存；但要标清来源，让调用方知道这是"上次学到的"
  if (cur && (cur.uid || cur.nick)) {
    return { uid: cur.uid || '', nick: lNick || cur.nick || '', source: 'cache', invalidated: false, why: '详情接口没给，用本机记录' }
  }
  return { uid: lNick ? '' : '', nick: lNick, source: 'none', invalidated: false, why: '没有可用的身份' }
}