/**
 * lib/owner-claim.mjs —— 认领时「这个人的 ID 到底从哪来」的判定
 * ============================================================================
 * 为什么单独抽出来：issue #2。以前 claim-owner.mjs 只认页面 fiber 里的
 *   toParticipantSecUserId，取不到就写 sec_uid: ''（空串）**整份覆盖** owner.json ——
 *   于是每点一次「认领」，手工填的 sec_uid 就被清零，面板一直红叉。
 *
 * 现在的取 ID 顺序（拿不到就是拿不到，绝不写半截）：
 *   ① 页面上给出了 sec_uid            → 直接用（最新、最可信）
 *   ② 页面没给，但昵称跟上次认领的一样 → 保留 owner.json 里旧的 sec_uid
 *   ③ 页面没给，但昵称跟本地 peer.json 的一样 → 用 peer.json 的 sec_uid 兜底
 *   ④ 都不成立 → 返回 ok:false + sec_missing:true，**一个字节都不写**
 *
 * ⚠️ 昵称校验必须绑死（2026-11-13 特意写死这条）：
 *    ② 和 ③ 都是「沿用别人的 ID」。不校验昵称就会在换人认领时沿用前一个人的
 *    sec_uid，那比空 ID 更糟 —— 主人被锁在门外是看得见的错，认错人是看不见的错。
 *    所以：两边昵称都有、且完全相等，才允许沿用；任何一边为空、或对不上，一律不沿用。
 *
 * 纯函数：不读文件、不写文件、不看时间（now 由调用方传），所以能直接跑单测。
 * ============================================================================
 */

const trim = (v) => String(v == null ? '' : v).trim()

/**
 * @param {object} input
 * @param {object} input.page   页面上认出来的东西 { sec, title }
 * @param {object|null} input.old  现有 owner.json（没有就 null/{}）
 * @param {object|null} input.peer 本地 peer.json（没有就 null/{}）
 * @param {string} input.now    ISO 时间串（调用方给，测试才好固定）
 * @returns {object} ok:true 时带 record（可直接写盘）与 via；ok:false 时带 error 与 sec_missing
 */
export function resolveOwnerClaim({ page = {}, old = null, peer = null, now = '' } = {}) {
  const pageSec = trim(page.sec)
  const pageNick = trim(page.title)
  const oldSec = trim(old && old.sec_uid)
  const oldNick = trim(old && old.nick)
  const peerSec = trim(peer && peer.sec_uid)
  const peerNick = trim(peer && peer.nick)

  // 页面连「这是谁」都说不清：跟以前一样直接报错，别往下猜
  if (!pageSec && !pageNick) {
    return {
      ok: false,
      page_ok: false,
      sec_missing: true,
      error: '右栏没认出会话身份：确认已经点开某个人的聊天（停在会话列表页不算）',
    }
  }

  // ① 页面给了 sec_uid —— 认领即生效
  if (pageSec) {
    return {
      ok: true,
      via: 'page',
      record: {
        sec_uid: pageSec,
        nick: pageNick || oldNick,
        claimed_at: now,
        verified_at: now,
      },
    }
  }

  // ② 沿用上次认领的旧 sec_uid —— 昵称必须都有且相等
  if (oldSec && oldNick && pageNick && pageNick === oldNick) {
    return {
      ok: true,
      via: 'owner.json',
      record: {
        sec_uid: oldSec,
        nick: pageNick,
        claimed_at: now,
        // 旧记录里已经有验证时间就留着（那是真收到过消息的证据），没有就用这次认领时间
        verified_at: trim(old.verified_at) || now,
      },
    }
  }

  // ③ 用本地 peer.json 兜底 —— 同样绑死昵称
  if (peerSec && peerNick && pageNick && pageNick === peerNick) {
    return {
      ok: true,
      via: 'peer.json',
      record: {
        sec_uid: peerSec,
        nick: pageNick,
        claimed_at: now,
        verified_at: now,
      },
    }
  }

  // ④ 拿不到：说清楚为什么不沿用旧的，并且不写文件
  const why = oldSec
    ? `页面没给出「${pageNick}」的 ID；上次认领的是「${oldNick || '(没记名字)'}」，名字对不上，不敢沿用旧 ID`
    : `页面没给出「${pageNick}」的 ID，本地也没有能对上的旧记录`
  return {
    ok: false,
    page_ok: true,
    sec_missing: true,
    nick: pageNick,
    error: why + '。没有写 owner.json，原来的设置一个字都没动',
  }
}