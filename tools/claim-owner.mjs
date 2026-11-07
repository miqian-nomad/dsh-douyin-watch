/**
 * 认领主人：把「当前打开的那条私信会话」的对端身份记下来（owner.json）
 *
 *   为什么要这么做：昵称会重复、会改；sec_uid 不会。
 *   用法：先在抖音里点开那个人的聊天，再跑
 *     node tools/claim-owner.mjs
 *   输出一行 JSON：{ ok, sec_uid, nick, claimed_at, verified_at } 或 { ok:false, error }
 *
 *   认领即生效：verified_at 直接写认领时间。点错了就再点一次「重新认领」。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openPage, sleep } from '../lib/chrome.mjs'
import { homeDir } from '../lib/paths.mjs'

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n') }

// 从右栏会话里取对端身份：先看消息节点的 React 数据，再退一步看右栏标题
const OPENED_PEER = `(function () {
  var secOf = function (n) {
    var fk = Object.keys(n).find(function (k) { return k.indexOf('__reactFiber$') === 0 });
    if (!fk) return '';
    var f = n[fk], d = 0;
    while (f && d < 14) {
      var p = f.memoizedProps;
      if (p && p.conversation && p.conversation.toParticipantSecUserId) return String(p.conversation.toParticipantSecUserId);
      f = f.return; d++;
    }
    return '';
  };
  var msgs = document.querySelectorAll('[class*="messageMessageBox"]');
  for (var i = 0; i < msgs.length; i++) { var s = secOf(msgs[i]); if (s) return JSON.stringify({ sec: s, via: 'msg' }); }
  var h = document.querySelector('[class*="RightPanelHeadertitle"]');
  var title = h ? String(h.innerText || '').trim() : '';
  var t = h;
  for (var j = 0; t && j < 6; j++) { var s2 = secOf(t); if (s2) return JSON.stringify({ sec: s2, title: title, via: 'head' }); t = t.parentElement; }
  return JSON.stringify({ sec: '', title: title, via: 'none' });
})()`

try {
  const c = await openPage({})
  const href = String(await c.ev('location.href'))
  if (!href.includes('/chat')) {
    c.close()
    out({
      ok: false,
      error: '当前页面不在私信页。先在抖音里打开私信、点开要认领的那个会话，再回来点「认领当前会话」',
    })
    process.exit(0)
  }
  await sleep(900)                       // 右栏渲染比页面慢一拍
  let idn = {}
  try { idn = JSON.parse(String(await c.ev(OPENED_PEER))) || {} } catch { idn = {} }
  c.close()
  if (!idn.sec && !idn.title) {
    out({ ok: false, error: '右栏没认出会话身份：确认已经点开某个人的聊天（停在会话列表页不算）' })
    process.exit(0)
  }
  const rec = {
    sec_uid: String(idn.sec || ''),
    nick: String(idn.title || '').trim(),
    claimed_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
  }
  writeFileSync(join(homeDir({ create: false }), 'owner.json'), JSON.stringify(rec, null, 2))
  out({ ok: true, ...rec })
} catch (e) {
  out({ ok: false, error: String((e && e.message) || e) })
}
