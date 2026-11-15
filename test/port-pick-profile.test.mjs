/**
 * 回归测试：挑端口复用前必须比对 profile
 * ============================================================================
 * 2026-11-15 真踩的坑：`pickPort` 原来第 ③ 条是「扫 9334–9373，只要有 CDP 活着就复用」，
 *   不看那个实例用的是哪个 profile。于是用临时家目录跑验证时复用了主实例的 9334 ——
 *   把主人正在用的浏览器关了，还拿临时 profile 在同一个端口起了一个（登录态看着像没了）。
 *
 * 这里钉死两件事：
 *   ① profile 路径的比较规则（带引号 / 结尾斜杠 / 大小写都不算不同）——比较本身别写歪；
 *   ② 范围里存在「别人的 CDP」时，pickPort **不许**返回那个端口（哪怕 runtime.json 记着它）。
 *
 * ⚠️ 这个测试不会碰真实例：假 CDP 绑在范围内第一个空闲端口上，
 *    临时家目录用 DOUYIN_HOME 指到 temp，跑完就删。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickPort, profileOfPort, sameProfile, cmdArg, lastPortDecision } from '../lib/chrome.mjs'

test('profile 比较：引号 / 结尾斜杠 / 大小写 / 正反斜杠都算同一个', () => {
  assert.equal(sameProfile('D:\\douyin-duty\\chrome-profile', '"D:\\douyin-duty\\chrome-profile"'), true)
  assert.equal(sameProfile('D:\\douyin-duty\\chrome-profile', 'D:/douyin-duty/chrome-profile/'), true)
  assert.equal(sameProfile('D:\\DOUYIN-DUTY\\Chrome-Profile', 'd:\\douyin-duty\\chrome-profile'), true)
  assert.equal(sameProfile('D:\\douyin-duty\\chrome-profile', 'C:\\Users\\x\\chrome-profile'), false)
  assert.equal(sameProfile('', 'D:\\douyin-duty\\chrome-profile'), false, '问不出来就是不匹配')
  assert.equal(sameProfile('D:\\douyin-duty\\chrome-profile', ''), false)
})

test('命令行取参数：带引号和不带引号都要取对', () => {
  const a = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --remote-debugging-port=9334 --user-data-dir=D:\\douyin-duty\\chrome-profile https://www.douyin.com/'
  assert.equal(cmdArg(a, 'remote-debugging-port'), '9334')
  assert.equal(cmdArg(a, 'user-data-dir'), 'D:\\douyin-duty\\chrome-profile')
  const b = 'chrome.exe --user-data-dir="D:\\dy home\\chrome-profile" --remote-debugging-port=9361'
  assert.equal(cmdArg(b, 'user-data-dir'), 'D:\\dy home\\chrome-profile')
  assert.equal(cmdArg(b, 'user-data-dir').includes('"'), false, '引号要去掉')
  assert.equal(cmdArg(a, 'no-sandbox'), '')
})

test('范围里有「别人的 CDP」时，pickPort 不许复用那个端口', async () => {
  // 范围内第一个空闲端口拿来扮演"别人的实例"（本机真实例在 9334 时它会落到 9335）
  let fakePort = 0
  for (let p = 9334; p < 9374; p++) {
    const got = await tryListen(p)
    if (got) { fakePort = p; var closeFake = got; break }
  }
  assert.ok(fakePort, '9334–9373 都被占满了，没法构造这个场景')

  const home = mkdtempSync(join(tmpdir(), 'dy-port-'))
  const saved = { home: process.env.DOUYIN_HOME, port: process.env.IM_CDP_PORT }
  process.env.DOUYIN_HOME = home
  delete process.env.IM_CDP_PORT
  try {
    // 这个假实例上没有任何真实浏览器进程 → profile 问不出来 → 必须视为「别人的」
    assert.equal(await profileOfPort(fakePort), '', '假 CDP 不该被认出 profile')

    // 情形一：全新（runtime.json 空）
    const p1 = await pickPort()
    assert.notEqual(p1, fakePort, '不许复用别人的端口')

    // 情形二：runtime.json 里还「记着」那个端口（主实例崩过 / 换了人起），照样不许复用
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ cdpPort: fakePort }))
    const p2 = await pickPort()
    assert.notEqual(p2, fakePort, '记着的端口是别人的，也不许复用')
    assert.equal(lastPortDecision.port, p2, '应该给出「这次到底选了哪个端口」的依据')
    assert.ok((lastPortDecision.skipped || []).some((s) => s.port === fakePort),
      '应该记下「跳过了哪个端口、为什么」：' + JSON.stringify(lastPortDecision))
  } finally {
    if (saved.home === undefined) delete process.env.DOUYIN_HOME
    else process.env.DOUYIN_HOME = saved.home
    if (saved.port === undefined) delete process.env.IM_CDP_PORT
    else process.env.IM_CDP_PORT = saved.port
    try { closeFake() } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** 能在 port 上监听就返回 close 函数，占着就返回 null */
function tryListen(port) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (req.url && req.url.startsWith('/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Browser: 'FakeCDP/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    s.once('error', () => resolve(null))
    s.listen(port, '127.0.0.1', () => resolve(() => new Promise((r) => s.close(r))))
  })
}
