/**
 * tools/whoami-self.mjs —— 主动识别「本号是谁」（uid + 昵称 + sec_uid）
 *
 * 为什么要有（2026-11-15）：self.json 的 sec_uid 以前只靠「评论区扫描」顺带学，
 *   那个开关一关就永远学不到，认领只能走降级路径。这里给一个主动入口。
 *
 * 取法（借 dsh-douyin-all api.mjs:200-201 的做法）：
 *   /aweme/v1/web/aweme/post/?sec_user_id=self&count=1 —— 不挑具体作品，
 *   拿返回里第一条的 author（那条一定是本号自己）。
 *   ⚠️ 必须在**页面上下文**里 fetch：Node 直连会被 Argus 拦
 *   （实测 403 Blocked by ArgusSecurityPlugin Uifid Not Found）。
 *
 * 只读。被拦就如实报，不拿昵称猜。
 * 输出：{ ok, uid, nick, sec_uid, why?, http?, status_code?, works? }
 */
import { openPage } from '../lib/chrome.mjs'

const JS = `(async function(){
  var qs = 'device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500&version_name=19.5.0'
    + '&cookie_enabled=true&platform=PC&sec_user_id=self&max_cursor=0&count=1';
  try {
    var r = await fetch('/aweme/v1/web/aweme/post/?' + qs, { credentials: 'include', headers: { referer: 'https://www.douyin.com/' } });
    var t = await r.text();
    // 2026-11-18（陌生人视角）：403 原来只吐「接口返回 403」，向导第 3 步照抄给用户看，
    //   但没登录时看到这行完全不知道该干什么。如实报状态码，并把最常见的原因说人话。
    if (r.status !== 200) return JSON.stringify({ ok: false, http: r.status, why: '接口返回 ' + r.status + '（最常见的原因：这个浏览器还没登录抖音号；先在第 2 步登录，再回来点这一下）' });
    if (!t) return JSON.stringify({ ok: false, http: r.status, why: '接口返回空 body（没登录或被风控）' });
    var j;
    try { j = JSON.parse(t) } catch (e) { return JSON.stringify({ ok: false, http: r.status, why: '返回不是 JSON：' + String(t).slice(0, 100) }) }
    var list = j.aweme_list || [];
    var a = (list[0] && list[0].author) || null;
    if (!a || !a.uid) {
      return JSON.stringify({ ok: false, http: r.status, status_code: j.status_code,
        why: list.length ? '返回里没有作者信息' : '这个号没有作品，作品列表为空（无法用这条路识别）' });
    }
    return JSON.stringify({ ok: true, http: r.status, uid: String(a.uid), nick: String(a.nickname || ''), sec_uid: String(a.sec_uid || ''), works: list.length });
  } catch (e) {
    return JSON.stringify({ ok: false, why: '请求失败：' + String((e && e.message) || e) });
  }
})()`

let out
try {
  const c = await openPage({})
  try { out = JSON.parse(String(await c.ev(JS))) || {} } finally { c.close() }
} catch (e) {
  out = { ok: false, why: '打不开浏览器：' + String((e && e.message) || e) }
}
process.stdout.write(JSON.stringify(out) + '\n')