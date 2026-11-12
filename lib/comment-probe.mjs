/**
 * lib/comment-probe.mjs —— 评论区接口「签名自检」的判定器
 * ============================================================================
 * 背景（2026-11-13 实测，别再照抄别人的结论）：
 *   这个接口的门槛**不是**「签名正确」，而是「query 里带了个 a_bogus」+ cookie 里有 ttwid：
 *     · 正常签名            → 200 + status_code 0 + 有评论
 *     · 随便编一个 a_bogus  → 200 + 有评论（签名当前**不被校验**）
 *     · 完全不签名          → 200 + **空 body**（一个字节都没有，连 JSON 都不是）
 *     · cookie 只留 ttwid   → 200 + 有评论（**不需要登录态**）
 *     · 无 cookie           → 200 + 空 body
 *     · 缺 aweme_id         → 200 + status_code 5
 *     · 缺 count            → 200 + status_code 0 但 comments:null（静默空）
 *     · 连打 8 次           → 没有 429、没有空 body
 *   所以「空 body」这一个现象对应好几种坏法 —— 必须做**对照实验**才能分清，
 *   单看一次响应只能报「不确定」。
 *
 * 自检做法：同一时刻打三次（正常签名 / 假签名 / 不签名），拿三次结果交叉判断。
 *   纯函数，不碰网络，方便单测。
 * ============================================================================
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const is429 = (r) => num(r && r.http) === 429
const isEmptyBody = (r) => !!r && (r.ok_json === false || (r.empty === true))
const hasItems = (r) => !!r && num(r.n) > 0

/** 自检结论 */
export const PROBE = {
  OK: 'ok',                    // 能拿到评论
  COOKIE_MISSING: 'cookie_missing', // 没 cookie / 没 ttwid
  SIGN_STALE: 'sign_stale',    // 我们的签名被拒，但假签名反而能过 ⇒ 签名实现跟不上了
  SIGN_UNCHECKED: 'sign_unchecked', // 假签名也能过 ⇒ 签名当前不被校验（不算故障，但要记着）
  PARAMS_BAD: 'params_bad',    // status_code 非 0 / status_msg 有内容
  RISK: 'risk',                // 429 / 验证码
  EMPTY_SILENT: 'empty_silent',// 三次全空，连假签名也空 ⇒ 说不清，别猜
  // 2026-11-13（Codex 审查 P2）：本机没有签名器 —— 这是"没装"，不是"说不清"。
  //   以前一路 spawnSync 失败，doctor 报 unknown，看着像接口坏了。
  NOT_INSTALLED: 'probe_not_installed',
  UNKNOWN: 'unknown',
}

/**
 * @param {object} s
 * @param {object} s.signed    正常签名的结果 {http,status_code,n,ok_json,empty,status_msg}
 * @param {object} s.badSign   假签名的结果
 * @param {object} s.unsigned  不签名的结果
 * @param {object} s.cookie    { file:boolean, ttwid:boolean, session:boolean }
 * @returns {{state:string, evidence:string, sign_checked:boolean|null}}
 */
export function classifyCommentProbe(s = {}) {
  const signed = s.signed || {}
  const badSign = s.badSign || {}
  const unsigned = s.unsigned || {}
  const cookie = s.cookie || {}

  // ① 风控：这个最硬，先判
  if (is429(signed) || is429(badSign) || is429(unsigned)) {
    return { state: PROBE.RISK, evidence: '接口返回 429（限流）', sign_checked: null }
  }
  if (/验证码|安全验证|captcha/i.test(String(signed.head || '') + String(badSign.head || ''))) {
    return { state: PROBE.RISK, evidence: '响应里出现验证码页', sign_checked: null }
  }

  // ② 本地就知道的：cookie 缺失
  if (cookie.file === false) return { state: PROBE.COOKIE_MISSING, evidence: 'cookie 文件不存在或为空', sign_checked: null }
  if (cookie.ttwid === false) return { state: PROBE.COOKIE_MISSING, evidence: 'cookie 里没有 ttwid（评论区接口要它）', sign_checked: null }

  // ③ 参数问题：状态码/提示明确
  const sc = num(signed.status_code)
  if (sc !== 0 && signed.status_code !== undefined && signed.status_code !== null) {
    return { state: PROBE.PARAMS_BAD, evidence: `status_code=${sc}${signed.status_msg ? '（' + signed.status_msg + '）' : ''}`, sign_checked: null }
  }
  if (signed.status_msg) return { state: PROBE.PARAMS_BAD, evidence: 'status_msg：' + String(signed.status_msg).slice(0, 80), sign_checked: null }

  // ④ 有数据 → 正常；顺便记下「签名到底有没有被校验」
  if (hasItems(signed)) {
    if (hasItems(badSign)) {
      return { state: PROBE.OK, evidence: '正常签名拿到评论；注意：假签名也能拿到 ⇒ 这个接口目前不校验 a_bogus 对错', sign_checked: false }
    }
    return { state: PROBE.OK, evidence: '正常签名拿到评论；假签名拿不到 ⇒ 签名确实被校验', sign_checked: true }
  }

  // ⑤ 正常签名空、假签名有数据 ⇒ 是我们签名实现的问题
  if (hasItems(badSign)) {
    return { state: PROBE.SIGN_STALE, evidence: '正常签名返回空，而随便编的 a_bogus 反而拿到数据 ⇒ 签名实现跟不上了', sign_checked: true }
  }

  // ⑥ 三次都空：说清看到了什么，不猜
  if (isEmptyBody(signed) && isEmptyBody(badSign)) {
    return {
      state: PROBE.EMPTY_SILENT,
      evidence: `三次请求都是 200 + 空 body（正常签名/假签名/不签名都是），cookie 在（ttwid 也在）⇒ 说不清是哪一层拦的`,
      sign_checked: null,
    }
  }
  return { state: PROBE.UNKNOWN, evidence: '结果组合没对上已知形态：' + JSON.stringify({ signed: !!signed.n, bad: !!badSign.n, nosign: !!unsigned.n }), sign_checked: null }
}

/** 给设置页/日志的一句话 */
export function probeText(state) {
  switch (state) {
    case PROBE.OK: return '评论区接口正常'
    case PROBE.COOKIE_MISSING: return '评论区接口用不了：本机没有 cookie 或缺 ttwid，需要重新登录一次并保存登录态'
    case PROBE.SIGN_STALE: return '评论区接口用不了：签名实现过期了（a_bogus 跟不上了）'
    case PROBE.SIGN_UNCHECKED: return '能拿到评论，但签名其实没被校验（编的也能过）'
    case PROBE.PARAMS_BAD: return '评论区接口提示参数不对（aweme_id/count 之类缺了或写错）'
    case PROBE.RISK: return '被风控了（429 / 验证码），先停手'
    case PROBE.EMPTY_SILENT: return '接口一直返回空 body，分不清是风控还是接口变了 —— 别猜，先如实报'
    case PROBE.NOT_INSTALLED: return '没装签名器：评论区接口体检跑不了（这是「没装」，不是「接口坏了」）。README 里有装法，或把 DOUYIN_PROBE_SCRIPT / DOUYIN_SIGN_PY 指到已装好的那两份'
    default: return '评论区接口状态没看懂：' + state
  }
}