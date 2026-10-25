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
  out({
    ok: true,
    mode,
    mode_before: before,
    port: r.port,
    closed: closed.closed,
    note: mode === 'headed' ? '有头窗口已弹出，请在屏幕上手动过验证码；过完可以切回无头' : '已收回无头模式',
  })
} catch (e) {
  out({ ok: false, mode, mode_before: before, error: String((e && e.message) || e) })
}
