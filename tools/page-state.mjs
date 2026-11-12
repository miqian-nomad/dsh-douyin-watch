/**
 * tools/page-state.mjs —— 轻量只读探针：页面现在是什么状态（不导航、不点、不写文件）
 *
 * 用途：闸门挡住之后，每隔几分钟用它看一眼「主人处理完没有」——
 *   只看页面真实状态，不发起任何会触发拦截的动作。
 * 输出一行 JSON：{ ok, state, evidence, page:{ href, title, verifyVisible, textlen, boxes } }
 */
import { openPage } from '../lib/chrome.mjs'
import { classifyPageState, isDouyinUrl } from '../lib/gate-state.mjs'

const JS = `(function(){
  var frs = document.querySelectorAll('iframe[src*="verifycenter"], iframe[src*="/captcha"], [class*="captcha"]');
  var vis = false;
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  Array.prototype.forEach.call(frs, function(el){
    var r = el.getBoundingClientRect();
    // 只看"看得见"的：尺寸够大、且真的在视口里（老代码只看元素存在 → 误报）
    if (r.width > 40 && r.height > 40 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) vis = true;
  });
  var t = String(document.title || '');
  var body = String(document.body && document.body.innerText || '');
  return JSON.stringify({
    href: String(location.href), title: t,
    verifyVisible: vis,
    bodyText: body.slice(0, 600),
    boxes: document.querySelectorAll('[class*="messageMessageBox"]').length,
  });
})()`

/**
 * 2026-11-13（Codex 审查 P2）：**先确认这是抖音页，再谈"恢复没有"**
 *   `connectPage()` 在找不到抖音页时会退到「随便哪个 page」（lib/chrome.mjs:190），
 *   拿一个无关页面去判定「正常」，会把 verify/login 闸门误解除，下一次又撞上。
 */
const write = (o) => process.stdout.write(JSON.stringify(o) + '\n')

try {
  const c = await openPage({})
  let page = {}
  try { page = JSON.parse(String(await c.ev(JS))) || {} } catch { page = {} }
  c.close()

  const href = String(page.href || '')
  const pageInfo = {
    href: href.slice(0, 120),
    title: String(page.title || '').slice(0, 40),
    verifyVisible: !!page.verifyVisible,
    textlen: String(page.bodyText || '').length,
    boxes: Number(page.boxes) || 0,
  }

  if (!isDouyinUrl(href)) {
    // 不是抖音页 ⇒ 说不出任何关于抖音状态的结论。宁可报 unknown（闸门不动），也别给"恢复正常"。
    write({
      ok: false,
      state: 'unknown',
      evidence: '当前页不是抖音（' + (href ? href.slice(0, 80) : '地址是空的') + '）⇒ 不能拿它判断恢复没有',
      page: pageInfo,
    })
  } else {
    const verdict = classifyPageState({
      title: page.title, href,
      verifyVisible: page.verifyVisible,
      bodyText: page.bodyText,
      messageCount: page.boxes,
    })
    write({
      ok: verdict.kind === 'ok',
      state: verdict.kind,
      evidence: verdict.evidence,
      page: pageInfo,
    })
  }
} catch (e) {
  write({ ok: false, state: 'unknown', evidence: '探页面失败：' + String((e && e.message) || e) })
}