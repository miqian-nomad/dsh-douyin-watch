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
 *
 * 输出一行 JSON：{ ok, mode, port, mode_before }
 */
import { ensureChrome, openPage, readBrowserMode, sleep, writeBrowserMode } from '../lib/chrome.mjs'
import { readRuntime } from '../lib/paths.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const STATUS_ONLY = argv.includes('--status')
const mode = String(argOf('--mode', '')).trim()
// ⭐ 切到有头之后，顺手把页面开到**会触发滑块的地方**（默认视频页）——
//    否则窗口停在私信页，人根本找不到滑块（2026-10-25 实测过：开窗口看不到验证）。
const GOTO = String(argOf('--goto', '')).trim()
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

try {
  const closed = await closeCurrent()
  writeBrowserMode(mode)
  // 按新模式拉起（ensureChrome 会读 browser-mode.json 决定带不带 --headless）
  const r = await ensureChrome({ url: 'https://www.douyin.com/chat' })

  // 有头 + 指定了 goto：把页面开到那个地址，并检查滑块到底有没有出现
  let probe = null
  if (mode === 'headed' && GOTO) {
    try {
      const c = await openPage({ url: GOTO })
      // ⚠️ openPage 只负责「连上页面」，不会导航——必须自己调 Page.navigate，
      //    否则人看到的还是 /chat，当然找不到滑块（2026-10-25 实测踩到）
      await c.send('Page.enable')
      await c.send('Page.navigate', { url: GOTO })
      await sleep(9000)
      const raw = String(await c.ev(`(function(){
        var t = String(document.title || '');
        var vf = document.querySelector('iframe[src*="rc-verifycenter"], iframe[src*="verifycenter"], iframe[src*="/captcha"]');
        var vis = !!(vf && vf.offsetWidth > 2 && vf.offsetHeight > 2 && getComputedStyle(vf).visibility !== 'hidden');
        return JSON.stringify({ href: String(location.href).slice(0, 120), title: t.slice(0, 60), verify: /验证码|安全验证/.test(t) || vis, hasVideo: !!document.querySelector('video') });
      })()`))
      probe = JSON.parse(raw || '{}')
      c.close()
      await sleep(200)
    } catch (e) {
      probe = { error: String((e && e.message) || e) }
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
    note: mode === 'headed'
      ? (GOTO
        ? (probe && probe.verify ? '有头窗口已弹出，验证码就在这个页面上，去划吧' : '有头窗口已弹出并打开了目标页；这次没弹验证码（没触发就说明暂时不需要）')
        : '有头窗口已弹出，请在屏幕上手动过验证码；过完可以切回无头')
      : '已收回无头模式',
  })
} catch (e) {
  out({ ok: false, mode, mode_before: before, error: String((e && e.message) || e) })
}
