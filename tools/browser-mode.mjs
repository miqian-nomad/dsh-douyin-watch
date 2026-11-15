#!/usr/bin/env node
/**
 * tools/browser-mode.mjs —— 切换 9334 浏览器的「无头 / 有头」并立刻生效
 * ============================================================================
 * 为什么要这个东西：抖音的滑块验证**只有人能划**。以前要过验证，得去改命令行、
 * 手动杀进程再起窗口；现在只需要在设置页选一次，脚本把这件事做完：
 *
 *   写 $HOME/browser-mode.json（保证以后自动拉起的浏览器也是这个模式）
 *   → Browser.close 关掉当前实例 → 等 CDP 端口真的死掉 → 按新模式重新拉起
 *
 * 用法:
 *   node tools/browser-mode.mjs --mode headed      # 弹窗给你过验证
 *   node tools/browser-mode.mjs --mode headless    # 收回去，平时跑的样子
 *   node tools/browser-mode.mjs --status           # 只报当前模式，不动浏览器
 *   node tools/browser-mode.mjs --mode headed --port 9361   # 指定端口（验证/测试场景必须这样用）
 *
 * ⚠️ --port / IM_CDP_PORT：**临时家目录做验证时必须指定一个自己的端口**。
 *   2026-11-15 踩过：不指定端口时 lib/chrome.mjs 会扫 9334–9373「有 CDP 就复用」，
 *   结果复用了主人正在用的真实例。现在 pickPort 会先比对 profile（不一致不复用），
 *   但验证场景还是应该显式占一个端口，谁都别碰。
 *
 * 输出一行 JSON：{ ok, mode, port, mode_before }
 */
import { ensureChrome, openPage, readBrowserMode, sleep, writeBrowserMode } from '../lib/chrome.mjs'
import { readRuntime, homeDir } from '../lib/paths.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

// 指定端口（等价于 IM_CDP_PORT，但要赶在任何 pickPort 之前设好）
const PORT_ARG = String(argOf('--port', '')).trim()
if (PORT_ARG) process.env.IM_CDP_PORT = PORT_ARG

// 2026-11-15（主人要求）：新装 / 还没走完引导时，**不要一打开就落在私信页**。
//   老用户（watch-config.json 里 onboarded:true）行为不变，仍旧直接开 /chat。
//   向导第 2 步（登录）显式带 --goto 首页 —— 没登录时 /chat 是空白骨架屏，没有登录入口。
function readOnboarded() {
  try {
    const f = join(homeDir({ create: false }), 'watch-config.json')
    const j = JSON.parse(readFileSync(f, 'utf8')) || {}
    return j.onboarded === true
  } catch { return false }
}
const LANDING = readOnboarded() ? 'https://www.douyin.com/chat' : 'https://www.douyin.com/'
const STATUS_ONLY = argv.includes('--status')
const mode = String(argOf('--mode', '')).trim()
// ⭐ 切到有头之后，顺手把页面开到**会触发滑块的地方**（默认视频页）——
//    否则窗口停在私信页，人根本找不到滑块（2026-10-25 实测过：开窗口看不到验证）。
const GOTO = String(argOf('--goto', '')).trim()
// --click-login：导航完之后**试着**把首页右上角的「登录」点开，让二维码直接出来（向导第 2 步用）。
//   ⚠️ 纯加分项：按钮找不到 / 点不动 / 二维码没弹出来，都只是少一层便利，**不许影响主流程**、不许报错。
const CLICK_LOGIN = argv.includes('--click-login')
const before = readBrowserMode()
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }

if (STATUS_ONLY) {
  out({ ok: true, mode: before, port: Number(readRuntime().cdpPort || 0) })
  process.exit(0)
}
if (mode !== 'headed' && mode !== 'headless') {
  out({ ok: false, error: '缺 --mode headed|headless' })
  process.exit(1)
}

/** 关掉当前实例：走 CDP 的 Browser.close，比 taskkill 温和，profile 不会写坏 */
async function closeCurrent() {
  try {
    const c = await openPage({ url: 'about:blank' })
    const port = c.port
    try { await c.send('Browser.close') } catch { /* 有的版本不响应，靠下面等端口死掉兜底 */ }
    await sleep(1200)
    for (let i = 0; i < 24; i++) {
      const alive = await (async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false } })()
      if (!alive) return { closed: true, port }
      await sleep(500)
    }
    return { closed: false, port }
  } catch {
    // 连不上 = 本来就没开，直接往下走（重新拉起）
    return { closed: true, port: 0 }
  }
}

// ── 首页上找「登录」并点开（--click-login 用；纯加分项）──────────────────────
//   2026-11-15 实测（临时 profile 冷启动 + CDP 截图确认）：
//     首页右上角那个「登录」是一个 <p>（class VQdYTqcZ），点它就会弹出「扫码登录」弹层（class douyin_login_new_class）；
//     ⚠️ 但冷启动后 3 秒内页面上**还没有**这个按钮，得等——所以外面是「每秒试一次，最多 9 秒」。
//   只认文字刚好是「登录 / 立即登录 / 登录/注册」的可见节点，限定视口顶部 300px，
//   多个候选取**面积最小**那个（大容器也含这几个字，点它没反应）。
const FIND_LOGIN = `(function(){
  function vis(el){
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.right < 0 || r.top < 0 || r.top > 300 || r.left > innerWidth) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.2) return false;
    return true;
  }
  var all = document.querySelectorAll('button, a, div, span, p');
  var cands = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var t = String(el.textContent || '').replace(/[\\s\\u00a0]+/g, '');
    if (t !== '登录' && t !== '立即登录' && t !== '登录/注册') continue;
    if (!vis(el)) continue;
    var r = el.getBoundingClientRect();
    cands.push({ el: el, area: r.width * r.height, label: t });
  }
  if (!cands.length) return JSON.stringify({ clicked: false, why: '还没渲染出「登录」按钮' });
  cands.sort(function(a, b){ return a.area - b.area; });
  var pick = cands[0];
  var label = pick.label;
  try { pick.el.click(); } catch (e) { return JSON.stringify({ clicked: false, why: '点不动：' + String((e && e.message) || e) }); }
  return JSON.stringify({ clicked: true, label: label });
})()`
// 点完之后看二维码到底有没有浮出来（扫码提示文字 / 二维码图 / qrcode 类名）
const POPUP_SHOWN = `(function(){
  var t = String(document.body ? document.body.innerText : '');
  var qr = document.querySelector('[class*="qrcode"], [class*="qr-code"], [class*="QRCode"], img[alt*="二维码"]');
  return JSON.stringify({ shown: /扫码登录|扫码授权|打开抖音/.test(t) || !!qr });
})()`

try {
  const closed = await closeCurrent()
  writeBrowserMode(mode)
  // 按新模式拉起（ensureChrome 会读 browser-mode.json 决定带不带 --headless）
  const r = await ensureChrome({ url: LANDING })

  // 有头 +（指定了 goto，或要试着弹二维码）：把页面开到目标地址，看滑块在不在、二维码弹没弹
  let probe = null
  let loginPopup = null
  if (mode === 'headed' && (GOTO || CLICK_LOGIN)) {
    const target = GOTO || LANDING
    let c = null
    try {
      c = await openPage({ url: target })
      // ⚠️ openPage 只负责「连上页面」，不会导航——必须自己调 Page.navigate，
      //    否则人看到的还是原来那一页，当然找不到滑块（2026-10-25 实测踩到）
      await c.send('Page.enable')
      const here = String(await c.ev('location.href')).split('#')[0].replace(/\/+$/, '')
      if (here !== target.replace(/\/+$/, '')) {
        await c.send('Page.navigate', { url: target })
        await sleep(9000)
      } else {
        await sleep(3000)   // 本来就在这个地址：别重复导航（等于刷新），等它渲染完就行
      }
      try {
        const raw = String(await c.ev(`(function(){
          var t = String(document.title || '');
          var vf = document.querySelector('iframe[src*="rc-verifycenter"], iframe[src*="verifycenter"], iframe[src*="/captcha"]');
          var vis = !!(vf && vf.offsetWidth > 2 && vf.offsetHeight > 2 && getComputedStyle(vf).visibility !== 'hidden');
          return JSON.stringify({ href: String(location.href).slice(0, 120), title: t.slice(0, 60), verify: /验证码|安全验证/.test(t) || vis, hasVideo: !!document.querySelector('video') });
        })()`))
        probe = JSON.parse(raw || '{}')
      } catch (e) {
        probe = { error: String((e && e.message) || e) }
      }
      if (CLICK_LOGIN) {
        try {
          // 冷启动实测（2026-11-15）：首页会 SPA 跳到 /jingxuan 并重渲染头部，
          //   早点点到的那个「登录」节点可能在渲染中就被换掉了（点了没反应）。
          //   所以：点 → 看 2.4 秒有没有二维码 → 没出来就重新找一次再点，最多 4 轮。
          loginPopup = { clicked: false, why: '还没试' }
          for (let attempt = 0; attempt < 4; attempt++) {
            const f = JSON.parse(String(await c.ev(FIND_LOGIN)) || '{}')
            if (!f.clicked) {
              loginPopup = { clicked: false, why: f.why || '还没渲染出「登录」按钮' }
              await sleep(1200)
              continue
            }
            loginPopup = { clicked: true, label: f.label, popupShown: false }
            for (let j = 0; j < 3; j++) {
              await sleep(800)
              const p2 = JSON.parse(String(await c.ev(POPUP_SHOWN)) || '{}')
              if (p2 && p2.shown) { loginPopup.popupShown = true; break }
            }
            if (loginPopup.popupShown) break
            await sleep(600)   // 没弹出来 → 重新找一次再试（页面这会儿可能才渲染好）
          }
          if (loginPopup.clicked && !loginPopup.popupShown) loginPopup.why = '点了「登录」但二维码没浮出来（可能还没渲染完），自己点一下右上角'
          if (!loginPopup.clicked) loginPopup = { clicked: false, why: '首页上一直没等到「登录」按钮，自己点右上角那个就行' }
        } catch (e) {
          loginPopup = { clicked: false, why: '试着弹二维码时出错：' + String((e && e.message) || e) }
        }
      }
      c.close()
      await sleep(200)
    } catch (e) {
      // 打不开页面本身要如实报；但「点不到登录」绝不许把整件事判失败
      probe = probe || { error: String((e && e.message) || e) }
      if (CLICK_LOGIN && !loginPopup) loginPopup = { clicked: false, why: '页面没打开成功，没法点登录' }
      try { if (c) c.close() } catch { /* ignore */ }
    }
  }

  out({
    ok: true,
    mode,
    mode_before: before,
    port: r.port,
    closed: closed.closed,
    goto: GOTO || '',
    probe,
    loginPopup,
    note: mode === 'headed'
      ? (GOTO
        ? (probe && probe.verify ? '有头窗口已弹出，验证码就在这个页面上，去划吧' : '有头窗口已弹出并打开了目标页；这次没弹验证码（没触发就说明暂时不需要）')
        : '有头窗口已弹出，请在屏幕上手动过验证码；过完可以切回无头')
      : '已收回无头模式',
  })
} catch (e) {
  out({ ok: false, mode, mode_before: before, error: String((e && e.message) || e) })
}
