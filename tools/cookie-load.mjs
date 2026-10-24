#!/usr/bin/env node
/**
 * tools/cookie-load.mjs —— 把 douyin_cookie.txt 里的登录 cookie 灌进 9334 Chrome
 * ============================================================================
 * 无头侧登录态丢失时调用（或插件 douyin_relogin 调用它），把 cookie-save.mjs 存下来的
 * cookie 通过 CDP Network.setCookies 灌回浏览器（能设 HttpOnly，绕开浏览器安全限制）。
 *
 * 用法:
 *   node tools/cookie-load.mjs
 *
 * 输出一行 JSON：{ ok, count }
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'
import { openPage, sleep } from '../lib/chrome.mjs'

const HOME = homeDir()
const COOKIE_FILE = join(HOME, 'douyin_cookie.txt')

try {
  const c = await openPage()
  await c.send('Network.enable')
  const raw = readFileSync(COOKIE_FILE, 'utf8').trim()
  const cookies = []
  for (const p of raw.split(';')) {
    const s = p.trim()
    const i = s.indexOf('=')
    if (i <= 0) continue
    const name = s.slice(0, i).trim()
    const value = s.slice(i + 1).trim()
    if (!name) continue
    cookies.push({ name, value, domain: '.douyin.com', path: '/' })
  }
  await c.send('Network.setCookies', { cookies })
  c.close()
  await sleep(200)
  console.log(JSON.stringify({ ok: true, count: cookies.length }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
}
