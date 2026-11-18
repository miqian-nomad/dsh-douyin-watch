/**
 * 回归测试：陌生人 / 冷启动视角（2026-11-18 主人要求「按别人第一次用」重验）
 *   这里只钉那些"换台机器、从零开始"会踩到的东西：
 *   ① 没认领主人时，任何发消息的路都不许真的对外动作
 *   ② 路径不许写死本机盘符
 *   ③ 浏览器/进程查找、cookie 权限必须按平台分支（不能只认 Windows）
 *   界面观感、真实登录态在这里验不了（要实机），只钉代码口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const CHROME = readFileSync(join(ROOT, 'lib', 'chrome.mjs'), 'utf8')

// ① 红线：没认领主人（cfg.owner 为空）时，douyin_send 必须先拒绝，且不许走到 sendChatText
test('douyin_send：没认领主人时直接拒绝，不白开浏览器、不对外发', () => {
  const i = SERVER.indexOf("name: 'douyin_send'")
  assert.ok(i > 0, '找不到 douyin_send 工具定义')
  const block = SERVER.slice(i, i + 3000)
  const guard = block.indexOf("String(cfg.owner || '').trim()")
  assert.ok(guard > 0, 'douyin_send 里少了「cfg.owner 为空」的判断')
  assert.match(block.slice(guard, guard + 400), /还没认领主人/, '拒绝的理由要说人话：还没认领主人')
  const send = block.indexOf('await sendChatText(')
  assert.ok(send > guard, '守卫必须在调用 sendChatText 之前（return 掉，别再往下发）')
})

// ① 红线续：自动刷的结果投递，没 owner 时跳过并记日志，不许拿空昵称去分享/发私信
test('自动刷投递：没认领主人时跳过投递（不分享卡片、不发私信）', () => {
  const i = SERVER.indexOf('if (cfg.autoScrollDeliverDm) {')
  assert.ok(i > 0, '找不到自动刷投递分支')
  const block = SERVER.slice(i, SERVER.indexOf('if (cfg.autoScrollAgentRead)', i))
  const guard = block.indexOf("if (!String(cfg.owner || '').trim()) {")
  assert.ok(guard > 0, '投递前必须判 cfg.owner 为空')
  assert.match(block.slice(guard, guard + 400), /还没认领主人/, '跳过时要写清原因')
  const share = block.indexOf('await shareCardTo(')
  const text = block.indexOf('await sendChatText(')
  assert.ok(share > guard, 'shareCardTo 必须在守卫之后')
  assert.ok(text > guard, 'sendChatText 必须在守卫之后')
})

// ② 路径：插件自己拼路径不许出现本机盘符（'D:\\…' / 'C:\\…'）
//   ⚠️ lib/chrome.mjs 不算：它列的就是 Windows 候选安装路径，本来就该在 win32 分支里写死盘符。
test('插件代码里不写死本机盘符（换台机器/换盘符也要能跑）', () => {
  for (const [name, src] of [['index.js', SERVER], ['client.js', CLIENT]]) {
    const lines = src.split('\n')
    lines.forEach((line, n) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return          // 注释里提到 D:\ 是说明，不算
      assert.equal(/['"][A-Za-z]:\\\\/.test(line), false, name + ':' + (n + 1) + ' 写死了盘符：' + line.trim())
    })
  }
})

// ③ 浏览器与进程查找：三个平台都要有分支（Windows 专用调用必须有条件保护）
test('找浏览器：win32 / darwin / linux 三分支都在', () => {
  assert.match(CHROME, /process\.platform === 'win32'/, '缺 win32 分支')
  assert.match(CHROME, /process\.platform === 'darwin'/, '缺 macOS 分支')
  assert.ok(CHROME.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'macOS 要能找到 Chrome.app')
  assert.ok(CHROME.includes('/usr/bin/chromium'), 'Linux 要能找到 chromium')
})

test('列浏览器进程：PowerShell 只在 Windows 下调用，别的平台走 /proc 或 ps', () => {
  const i = CHROME.indexOf('async function browserProcesses()')
  assert.ok(i > 0, '找不到 browserProcesses')
  const block = CHROME.slice(i, i + 2200)
  const win = block.indexOf("process.platform === 'win32'")
  const ps = block.indexOf("execFile('powershell'")
  assert.ok(win > 0 && ps > win, 'powershell 必须在 win32 分支里面')
  assert.ok(block.includes("process.platform === 'linux'") && block.includes("'/proc'"), 'Linux 分支要看 /proc')
  assert.ok(block.includes("execFile('ps'"), '其余平台（macOS）要走 ps')
})

// ③ cookie 权限：Windows 用 icacls，其它平台用 chmod 600
test('cookie 文件权限：Windows icacls / 其它 chmod 600', () => {
  const SRC = readFileSync(join(ROOT, 'tools', 'cookie-save.mjs'), 'utf8')
  assert.match(SRC, /chmodSync\(file, 0o600\)/, '非 Windows 要 chmod 600')
  assert.match(SRC, /execFileSync\('icacls'/, 'Windows 要 icacls')
  assert.match(SRC, /process\.platform !== 'win32'/, '两条路必须按平台分（非 Windows 走 chmod）')
})
