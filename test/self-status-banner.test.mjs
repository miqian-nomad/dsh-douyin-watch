/**
 * 回归测试：「本号身份缺失」提示 + 顶部常驻「重新引导」入口
 * ============================================================================
 * 来由（2026-11-15，主人当面提的）：
 *   主人想重进向导，在常规页找不到入口，顺手点了「清除本机记录」→ 把真实的 self.json 删了。
 *   要求：① 顶部常驻可见的「重新引导」入口（常规页 + 向导页都要）；② onboarded=true 但
 *   self.json 缺 uid/nick/sec_uid 任一项 → 顶一条明确提示；③ 补完以后提示要能消失。
 *
 * 这里验两件事：
 *   A. 服务端判据（lib/self-identity.mjs 的 selfStatus）在三种状态下算得对不对；
 *   B. 界面结构：判据读的是 cfg.self.complete（每次渲染重算），入口和文案都在。
 *      —— 界面像素这里验不了（无 GUI），布局靠快照/人看一眼。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selfStatus } from '../lib/self-identity.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')

// 跟 index.js 的 readSelfStore() + view() 走同一条路：读文件 → 解析 → selfStatus
const readStatus = (home) => {
  try { return selfStatus(JSON.parse(readFileSync(join(home, 'self.json'), 'utf8'))) } catch { return selfStatus(null) }
}

test('状态① self.json 不存在 → 提示（三项都缺）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dy-self-'))
  try {
    const st = readStatus(home)
    assert.equal(st.stored, false)
    assert.equal(st.complete, false, 'complete 必须是 false，界面才会顶提示')
    assert.deepEqual(st.missing, ['本号 uid', '昵称', 'sec_uid'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('状态①b 老文件只有 uid+nick（本机升级前的样子）→ 仍然提示，且明确说缺 sec_uid', () => {
  const home = mkdtempSync(join(tmpdir(), 'dy-self-'))
  try {
    writeFileSync(join(home, 'self.json'), JSON.stringify({
      current: { uid: '7000000000000000001', nick: '示例本号', learned_at: '2026-11-11T05:00:00.000Z' },
      known: [],
    }))
    const st = readStatus(home)
    assert.equal(st.stored, true)
    assert.equal(st.complete, false)
    assert.deepEqual(st.missing, ['sec_uid'])
    assert.equal(st.uid, '700000…', 'uid 只回前 6 位给界面看')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('状态② 三项齐全 → 提示消失（complete: true、missing 为空）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dy-self-'))
  try {
    writeFileSync(join(home, 'self.json'), JSON.stringify({
      current: {
        uid: '7000000000000000001',
        nick: '示例本号',
        sec_uid: 'MS4wLjABAAAAiYfGiPwa0JPrD6YLWSBGEyf7vysMa9zNyebYcTicqlXpY2mYfKV-JF-djYpF5TBN',
        learned_at: '2026-11-15T05:00:00.000Z',
      },
      known: [],
    }))
    const st = readStatus(home)
    assert.equal(st.stored, true)
    assert.equal(st.complete, true, 'complete=true 界面就不该再显示提示')
    assert.deepEqual(st.missing, [])
    assert.equal(st.hasSec, true)
    assert.equal(st.nick, '示例本号')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('服务端：view() 用 selfStatus 算，并且带 onboarded（界面靠这两个字段判）', () => {
  assert.match(SERVER, /import \{[^}]*selfStatus[^}]*\} from '\.\/lib\/self-identity\.mjs'/, 'index.js 要从 lib 引 selfStatus')
  assert.match(SERVER, /o\.self = \(\(\) => \{[\s\S]{0,400}selfStatus\(readSelfStore\(\)\)/, 'self 状态要按 selfStatus 算')
  assert.match(SERVER, /o\.onboarded = cfg\.onboarded === true/, 'view() 要带 onboarded')
})

test('界面：提示判据是 onboarded && !self.complete，且在渲染期算（不是打开时算一次）', () => {
  assert.match(CLIENT, /const gap = cfg && cfg\.onboarded === true && !me\.complete/,
    '缺口判据必须读 cfg.self.complete —— 补完 load() 一刷就消失')
  // 不能写在 useEffect 里（那样只有打开设置页那一刻算一次）
  const eff = CLIENT.indexOf('useEffect')
  assert.ok(eff > 0)
  assert.equal(/useEffect\([^)]*\)\s*=>\s*\{[^}]*self\.complete/.test(CLIENT), false, '别把判据塞进 useEffect')
})

test('界面：提示文案 + 「去重新引导」按钮，常驻入口「重新引导」也在', () => {
  assert.match(CLIENT, /本号身份缺失/, '提示标题')
  assert.match(CLIENT, /认不出自己的号：判断不了哪条评论是它自己发的/, '要说清后果，别只报错误码')
  assert.match(CLIENT, /\}, '去重新引导'\)/, '提示里要带一个直达入口')
  assert.match(CLIENT, /\}, '重新引导'\)/, '状态正常时也要有常驻入口（不是藏角落）')
  // 入口在面板最顶部：wizardEntry() 是常规页容器的第一个子元素
  assert.match(CLIENT, /return h\('div', \{ 'data-dy-panel': '1', style: \{ padding: '4px 0 16px' \} \},\s*\n\s*wizardEntry\(\)/, '入口/提示必须放在整页最前面')
})

test('界面：向导页里也有「重新引导」入口（重新开始，只清界面状态）', () => {
  assert.match(CLIENT, /const restartWizard = \(\) => \{/, '向导页要有重新开始的入口函数')
  assert.match(CLIENT, /setStep\(1\); setWarn\(''\); setStatus\(\{\}\); setMsg\(\{\}\)/, '重新开始 = 回到第 1 步并清掉检测状态')
  assert.match(CLIENT, /\}, '重新开始'\)\)/, '向导页顶部要看得见这个按钮')
})

test('界面：走完引导回来会重新拉一次配置（补完立刻消失，不用重启）', () => {
  assert.match(CLIENT, /onDone: \(\) => \{ setWizOpen\(false\); load\(\); \}/, '向导结束要 load() 重拉 view()')
})
