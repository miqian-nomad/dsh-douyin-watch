/**
 * 回归测试：哨兵循环里的接线（静态守卫）
 *
 * 这几条不是纯函数，跑不起来（要真 Chrome + 真会话），但坏起来很典型：
 *   · 闸门到期没人清 → 界面永远显示「已暂停」
 *   · 体检 await 在私信轮询前面 → 签名器一慢，私信就晚读
 * 所以直接在源码上钉住接线形态，改回去就红。
 *
 * 背景：2026-11-13 Codex 审查 PR #3 的 P2 意见（我逐条核过代码）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')

test('闸门到期要真的摘掉：循环里调了 expireGate，且用的是 gateExpired', () => {
  assert.match(SRC, /import \{[^}]*gateExpired[^}]*\} from '\.\/lib\/gate-state\.mjs'/, 'gateExpired 没被引入')
  const call = SRC.indexOf('expireGate()')
  const scan = SRC.indexOf('await maybeScanComments(agent)')
  assert.ok(call > 0, '循环里没调 expireGate()')
  assert.ok(scan > call, 'expireGate() 要在扫描评论之前调')
})

test('体检不许挡私信轮询（不能 await）', () => {
  assert.equal(/await\s+maybeHealthCheck\s*\(/.test(SRC), false, '又把体检 await 回循环里了 → 私信会被拖慢')
  assert.match(SRC, /if \(!healthRunning\) \{/, '后台跑体检要有防重入闸，别叠起来')
  assert.match(SRC, /maybeHealthCheck\(\)\.catch\(\(\) => \{\}\)\.finally\(/, '后台调用要自己吞异常并复位闸')
})

test('认领主人的成功日志不能说「等他发消息验证」（0.4.14 起认领即生效）', () => {
  assert.equal(SRC.includes('等他发一条消息过来验证'), false, '日志还在说一句早就不存在的流程')
  assert.match(SRC, /已认领主人：[\s\S]{0,80}认领即生效/)
})