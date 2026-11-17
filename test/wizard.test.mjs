/**
 * 回归测试：首次引导（7 步）的结构守卫
 *   界面的视觉效果在这里验不了，但"步骤顺序 / 必填步 / 调用的接口 / 深浅色变量"可以钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')

test('7 步顺序：认领会话 → 登录 → 确认本号 → 认领主人 → 谁能命令 → 干什么活 → 体检', () => {
  const m = /const steps = \[(.*?)\]/.exec(CLIENT)
  assert.ok(m, 'client.js 里找不到 steps 数组')
  const steps = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(steps, ['认领会话', '登录抖音号', '确认本号', '认领主人', '谁能命令它', '让它干什么活', '体检'])
})

test('第 1/2/4 步不能跳过，其余可以稍后', () => {
  const m = /const mustDo = \{([^}]*)\}/.exec(CLIENT)
  assert.ok(m, '找不到 mustDo')
  const keys = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)
  assert.deepEqual(keys.sort(), ['1', '2', '4'], '必填步必须正好是 1、2、4')
})

test('每一步都调到对应的后端接口（前端不许自己猜状态）', () => {
  for (const p of ['session', 'login-check', 'identify', 'claim', 'finish']) {
    assert.match(CLIENT, new RegExp("post\\('" + p + "'"), 'client 没调 onboard/' + p)
    assert.match(SERVER, new RegExp("pathname === '/api/douyin-watch/onboard/" + p + "'"), 'index.js 没有 onboard/' + p + ' 路由')
  }
})

test('登录判据是「读到私信」，不是页面标题也不是评论区', () => {
  const i = SERVER.indexOf("pathname === '/api/douyin-watch/onboard/login-check'")
  const block = SERVER.slice(i, i + 900)
  assert.match(block, /messages/, '应该看 messages 有没有内容')
  assert.match(block, /msgs\.length > 0/, '判据应该是读到至少一条私信')
  assert.equal(/document\.title/.test(block), false, '不许用页面标题判断登录')
})

test('认领会话：传空 = 不钉死；传了就必须在会话列表里找得到', () => {
  const i = SERVER.indexOf("pathname === '/api/douyin-watch/onboard/session'")
  const block = SERVER.slice(i, i + 1400)
  assert.match(block, /sessionController/, '应该用 DSH 的会话列表校验')
  assert.match(block, /找不到这个对话/, '找不到要给一句人话')
  assert.match(block, /sessionId = want/, '应该写回 cfg.sessionId')
})

test('向导用的都是主题变量（深浅色都不会花）', () => {
  const i = CLIENT.indexOf('function Wizard(')
  const end = CLIENT.indexOf('// 「钉死会话」选择器', i)
  const block = CLIENT.slice(i, end > i ? end : CLIENT.length)
  assert.match(block, /background: C\.card/, '卡片底色要用主题变量')
  assert.match(block, /border: '1px solid ' \+ C\.line/, '边框要用主题变量')
  assert.equal(/background: '#fff'/.test(block), false, '别写死白底')
})

// 2026-11-15 回归：第 2 步原先开的是 /chat —— 没登录时那是空白骨架屏（左灰条 + 空图标），
//   没有任何登录入口，主人根本没法扫码。必须开首页，跳私信页的动作留到「检测」那一步。
test('第 2 步「打开浏览器去登录」开的是首页，不是 /chat', () => {
  const i = CLIENT.indexOf('const openBrowser = () =>')
  assert.ok(i > 0, 'client.js 里找不到 openBrowser')
  const block = CLIENT.slice(i, i + 1800)
  const m = /body: JSON\.stringify\(\{ mode: '([a-z]+)', goto: '([^']+)'/.exec(block)
  assert.ok(m, 'openBrowser 没带 goto')
  assert.equal(m[1], 'headed', '第 2 步要切有头')
  assert.equal(m[2], 'https://www.douyin.com/', '第 2 步必须开首页 —— /chat 未登录是空白骨架屏')
  assert.match(block, /clickLogin: true/, '要顺手试着把登录二维码点出来（失败不影响主流程）')
})

test('跳私信页只发生在「我登录好了，检测」那一步', () => {
  const i = SERVER.indexOf("pathname === '/api/douyin-watch/onboard/login-check'")
  assert.ok(i > 0, '找不到 login-check 路由')
  assert.match(SERVER.slice(i, i + 700), /--force-chat/, 'login-check 要靠 --force-chat 自己把页面导航到 /chat')
})

test('浏览器落地页三处一致：未引导→首页、向导第 2 步→首页、已引导→/chat', () => {
  const MODE = readFileSync(join(ROOT, 'tools', 'browser-mode.mjs'), 'utf8')
  assert.match(MODE, /readOnboarded\(\) \? 'https:\/\/www\.douyin\.com\/chat' : 'https:\/\/www\.douyin\.com\/'/, '落地页要按 onboarded 分岔')
  // 例子里的 goto 只出现在向导里，且必须是首页（登录入口在首页）
  const hardCoded = [...CLIENT.matchAll(/goto: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(hardCoded, ['https://www.douyin.com/'], "向导里不许再写死 /chat 当 goto")
})

test('「点不到登录」不许把整件事判失败（加分项要能安全降级）', () => {
  const MODE = readFileSync(join(ROOT, 'tools', 'browser-mode.mjs'), 'utf8')
  const i = MODE.indexOf('if (CLICK_LOGIN) {')
  assert.ok(i > 0, '找不到 --click-login 的处理')
  const block = MODE.slice(i, i + 2600)
  assert.match(block, /try \{/, '点登录必须包在 try 里')
  assert.match(block, /catch \(e\) \{\s*\n\s*loginPopup = \{ clicked: false/, '点不到就记一条原因，不抛错')
  // loginPopup 只作为「报告数据」出现在 out 里，而那个 out 是 ok: true
  const outs = [...MODE.matchAll(/out\(\{[\s\S]*?\n  \}\)/g)].map((m) => m[0])
  const withPopup = outs.filter((o) => /loginPopup/.test(o))
  assert.ok(withPopup.length > 0, 'loginPopup 应该出现在结果里')
  for (const o of withPopup) assert.match(o, /ok: true/, 'loginPopup 不许影响 ok')
})