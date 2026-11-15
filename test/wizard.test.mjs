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