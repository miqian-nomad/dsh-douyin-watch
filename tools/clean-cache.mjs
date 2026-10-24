#!/usr/bin/env node
/**
 * tools/clean-cache.mjs —— 清浏览器缓存 + 收件箱旧图（**绝不动登录态**）
 * ============================================================================
 * 为什么要有：无头 Chrome 长期跑，Cache / Code Cache 会涨到几百 MB（实测 471 MB）。
 * 这些目录删了 Chrome 会自己重建，但 Cookies / Local Storage 删了就等于退登。
 *
 * 所以这里用**白名单**：只删下面 CACHE_DIRS 里点名的目录，其余一概不碰。
 * 执行顺序：先 Browser.close 关掉浏览器（否则文件被占用删不干净）→ 删缓存 →
 * 删 inbox 里 N 天前的图。下一次 ensureChrome 会自动重新拉起（登录态还在 profile 里）。
 *
 * 用法: node tools/clean-cache.mjs [--inbox-days 7] [--dry]
 * 输出: { ok, freedMB, removed:[...], skipped:[...], errors:[...] }
 */
import { existsSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { profileDir } from '../lib/paths.mjs'
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const INBOX_DAYS = Math.max(0, Number(argOf('--inbox-days', '7')) || 0)
// 视频分析产物（联系表 + 文案）：默认放在 $HOME/analyses/<视频id>/
// --analyses-days 0 = 全清（按钮用）；不传 = 14 天（自动清理用）
const ANALYSES_DIR = String(argOf('--analyses-dir', '')).trim()
const ANALYSES_DAYS = Number(argOf('--analyses-days', '14'))
const SKIP_BROWSER = argv.includes('--skip-browser')
const SKIP_INBOX = argv.includes('--skip-inbox')
const HOME = (() => { try { return join(profileDir(), '..') } catch { return '' } })()

// ⚠️ 只删这些（相对 profile 根）。它们都能重建，且不含登录态。
const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'Default/GrShaderCache',
  'Default/ShaderCache',
  'Default/Service Worker',
  'GrShaderCache',
  'ShaderCache',
  'component_crx_cache',
  'Safe Browsing',
  'CertificateRevocation',
  'WasmTtsEngine',
]
// 🔴 这些**永远不能删**（列出来是为了让读代码的人一眼看到边界）
const PROTECTED = [
  'Default/Network/Cookies', 'Default/Cookies', 'Default/Preferences', 'Local State',
  'Default/Local Storage', 'Default/IndexedDB', 'Default/Web Data',
]

function dirSize(p) {
  try {
    let total = 0
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      if (e.isDirectory()) total += dirSize(full)
      else { try { total += statSync(full).size } catch { /* 单个文件读不到就跳过 */ } }
    }
    return total
  } catch { return 0 }
}

const result = { ok: true, freedMB: 0, removed: [], skipped: [], errors: [], dryRun: DRY }

// 0) 确认受保护文件都还在（清之前拍个快照，清完再比一次）
const prof = profileDir()
const before = PROTECTED.map((rel) => ({ rel, exists: existsSync(join(prof, rel)) }))

// 1) 先关浏览器（复用连接里的 Browser.close）。--dry 时不关，避免"只是试算却把浏览器弄停"
if (!DRY && !SKIP_BROWSER) {
  let port = 0
  try {
    const c = await openPage({ url: 'about:blank' })
    port = c.port
    try { await c.send('Browser.close') } catch { /* 有些 Chrome 版本不响应也正常 */ }
    await sleep(1200)
  } catch {
    // 连不上说明本来就没开，继续删文件
  }
  // 等 CDP 端口真的死掉再动手：否则文件还被占着，删一半就 EPERM
  if (port) {
    for (let i = 0; i < 20; i++) {
      const alive = await (async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false } })()
      if (!alive) break
      await sleep(500)
    }
  }
}

// 2) 删缓存目录
for (const rel of CACHE_DIRS) {
  const p = join(prof, rel)
  if (!existsSync(p)) { result.skipped.push(rel); continue }
  const size = dirSize(p)
  if (DRY) { result.removed.push(`${rel} (${(size / 1048576).toFixed(1)} MB, dry)`); result.freedMB += size / 1048576; continue }
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 3 })
    result.removed.push(`${rel} (${(size / 1048576).toFixed(1)} MB)`)
    result.freedMB += size / 1048576
  } catch (e) {
    result.errors.push(`${rel}: ${(e && e.message) || e}`)
  }
}

// 3) 收件箱里 N 天前的图（我们自己落的聊天图片）
if (!SKIP_INBOX && INBOX_DAYS > 0 && HOME) {
  const inbox = join(HOME, 'inbox')
  try {
    if (existsSync(inbox)) {
      const cutoff = Date.now() - INBOX_DAYS * 86400000
      let n = 0
      let bytes = 0
      for (const e of readdirSync(inbox, { withFileTypes: true })) {
        if (!e.isFile()) continue
        const full = join(inbox, e.name)
        try {
          const st = statSync(full)
          if (st.mtimeMs >= cutoff) continue
          if (!DRY) rmSync(full, { force: true })
          n++
          bytes += st.size
        } catch { /* 单个文件跳过 */ }
      }
      result.freedMB += bytes / 1048576
      result.removed.push(`inbox 里 ${n} 张 ${INBOX_DAYS} 天前的图 (${(bytes / 1048576).toFixed(1)} MB)`)
    }
  } catch (e) {
    result.errors.push('inbox: ' + ((e && e.message) || e))
  }
}

// 3.2) 视频分析产物（联系表 + 文案）：--analyses-days 0 = 全清；>0 = 只清更老的
if (ANALYSES_DIR) {
  try {
    if (existsSync(ANALYSES_DIR)) {
      const cutoff = Number.isFinite(ANALYSES_DAYS) && ANALYSES_DAYS > 0 ? Date.now() - ANALYSES_DAYS * 86400000 : Infinity
      let n = 0
      let bytes = 0
      for (const e of readdirSync(ANALYSES_DIR, { withFileTypes: true })) {
        const full = join(ANALYSES_DIR, e.name)
        try {
          const st = statSync(full)
          const at = st.mtimeMs
          if (at >= cutoff) continue
          const size = e.isDirectory() ? dirSize(full) : st.size
          if (!DRY) rmSync(full, { recursive: true, force: true, maxRetries: 2 })
          n++
          bytes += size
        } catch { /* 单项跳过 */ }
      }
      result.freedMB += bytes / 1048576
      result.removed.push(`分析产物 ${n} 份（${ANALYSES_DAYS > 0 ? ANALYSES_DAYS + ' 天前的' : '全部'}，${(bytes / 1048576).toFixed(1)} MB）`)
    }
  } catch (e) {
    result.errors.push('analyses: ' + ((e && e.message) || e))
  }
}

// 3.5) 对 EPERM 的目录再试一次（常见于刚关浏览器、句柄还没完全释放）
if (!DRY && result.errors.length) {
  await sleep(1500)
  for (const err of [...result.errors]) {
    const rel = String(err).split(':')[0]
    const p = join(prof, rel)
    if (!existsSync(p)) { result.errors = result.errors.filter((x) => x !== err); continue }
    const size = dirSize(p)
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3 })
      result.removed.push(`${rel} (${(size / 1048576).toFixed(1)} MB, retry)`)
      result.freedMB += size / 1048576
      result.errors = result.errors.filter((x) => x !== err)
    } catch { /* 还是删不掉就保留报错 */ }
  }
}

// 4) 清完再验一遍受保护文件还在不在（防止误删登录态）
const after = PROTECTED.map((rel) => ({ rel, exists: existsSync(join(prof, rel)) }))
const lost = after.filter((a) => {
  const b = before.find((x) => x.rel === a.rel && x.exists)
  return b && !a.exists
})
if (lost.length) {
  result.ok = false
  result.errors.push('⚠️ 受保护文件丢了（不该发生）：' + lost.map((x) => x.rel).join(', '))
}

result.freedMB = Math.round(result.freedMB * 10) / 10

// 5) 顺便报一下旧的无用 profile（只报告，不删——那是插件目录之外的东西，交给调用方决定）
try {
  const cfgPath = join(HOME, 'watch-config.json')
  if (existsSync(cfgPath)) JSON.parse(readFileSync(cfgPath, 'utf8'))
} catch { /* 无所谓 */ }

console.log(JSON.stringify(result))
