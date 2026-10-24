#!/usr/bin/env node
/**
 * tools/cookie-save.mjs —— 把 9334 Chrome 的抖音登录 cookie 存进 douyin_cookie.txt
 * ============================================================================
 * 有头窗口登录+验证后调用它（或插件 douyin_save_login 调用它），把含 HttpOnly 的
 * 完整 cookie 存下来，供 cookie-load.mjs / notice-read.py 等无头侧恢复登录。
 *
 * 🔴 这个文件是**密码级凭据**：拿到它就等于拿到这个抖音账号（含 HttpOnly 的 sessionid）。
 *    所以写完立刻收紧权限：
 *      Windows → icacls /inheritance:r，只留 当前用户 / SYSTEM / Administrators
 *      其它     → chmod 600
 *    以前是直接继承目录 ACL（BUILTIN\Users 可读），本机任何进程都能读走账号 —— 2026-10-24 修。
 *
 * 用法:
 *   node tools/cookie-save.mjs
 *
 * 输出一行 JSON：{ ok, count, file, acl:{tightened,via|error} }
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'
import { openPage, sleep } from '../lib/chrome.mjs'

const HOME = homeDir()
const COOKIE_FILE = join(HOME, 'douyin_cookie.txt')

/** 把凭据文件收紧到「只有能拥有它的身份可读」。失败只报告，不影响保存本身。 */
function tighten(file) {
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
      return { tightened: true, via: 'chmod 600' }
    } catch (e) {
      return { tightened: false, error: String(e?.message ?? e) }
    }
  }
  const domain = String(process.env.USERDOMAIN || '').trim()
  const user = String(process.env.USERNAME || '').trim()
  const me = user ? (domain ? `${domain}\\${user}` : user) : ''
  const grants = ['NT AUTHORITY\\SYSTEM:F', 'BUILTIN\\Administrators:F']
  if (me) grants.push(`${me}:F`)
  // /inheritance:r 先切断从目录继承来的 EVERYONE / Users / Authenticated Users
  const args = [file, '/inheritance:r']
  for (const g of grants) args.push('/grant:r', g)
  try {
    execFileSync('icacls', args, { stdio: 'ignore' })
    return { tightened: true, via: 'icacls /inheritance:r', grants }
  } catch (e) {
    return { tightened: false, error: String(e?.message ?? e) }
  }
}

try {
  const c = await openPage()
  await c.send('Network.enable')
  const r = await c.send('Network.getAllCookies')
  const douyin = (r.cookies || []).filter((x) => /douyin\.com$/.test(x.domain))
  const header = douyin.map((x) => x.name + '=' + x.value).join('; ')
  writeFileSync(COOKIE_FILE, header, 'utf8')
  const acl = tighten(COOKIE_FILE)
  c.close()
  await sleep(200)
  console.log(JSON.stringify({ ok: true, count: douyin.length, file: COOKIE_FILE, acl }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
}
