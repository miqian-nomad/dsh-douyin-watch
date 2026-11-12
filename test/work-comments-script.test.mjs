/**
 * 回归测试：work-comments.mjs 里那段「页面内脚本」必须能编译。
 *
 * 为什么单拎一条：那段代码是塞进模板字符串里、到浏览器里才执行的，
 *   `node --check` 只检查外层文件，模板里的语法错误要到真机上才炸（用户看到的就是
 *   "评论扫描失败"）。这条测试把它抠出来做一次编译，改坏了当场红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'tools', 'work-comments.mjs'), 'utf8')

const START = 'const JS = (ids, max, discover, maxWorkAgeDays) => `'
const at = SRC.indexOf(START)
assert.ok(at >= 0, 'work-comments.mjs 里找不到页面脚本模板（改名了？测试要跟着改）')

const bodyStart = at + START.length
const endMarker = '\n})()'
const endAt = SRC.indexOf(endMarker, bodyStart)
assert.ok(endAt > bodyStart, '找不到页面脚本的结尾（模板结构变了？）')

const BODY = SRC.slice(bodyStart, endAt + endMarker.length)   // 到 "})()" 为止，不含末尾反引号

test('页面内脚本能编译（语法层面）', () => {
  // 用模板的真实插值把这一段还原成字符串，再交给 Function 编译
  const render = new Function('COMMON', 'ids', 'max', 'discover', 'maxWorkAgeDays',
    'return `' + BODY + '`;')
  const code = render({ aid: '6383' }, ['1'], 20, true, 0)
  assert.ok(code.includes('async function'), '还原出来的不是一段可执行的脚本')
  assert.doesNotThrow(() => new Function(code), '页面脚本有语法错误，进浏览器就炸')
})

test('页面内脚本给每条评论带了 mine 字段（自己回自己的防线）', () => {
  const render = new Function('COMMON', 'ids', 'max', 'discover', 'maxWorkAgeDays',
    'return `' + BODY + '`;')
  const code = render({ aid: '6383' }, ['1'], 20, true, 0)
  // 2026-11-13（Codex 审查 P2）：必须是「authorUid 有值 **且** 这条评论自己带了 uid」才判 true/false，
  //   否则给 null（分不清）。老写法 `authorUid ? ... : null` 在评论缺 uid 时算出 false，
  //   classifyCommentSelf 会当成铁证"不是我"→ 账号自己的评论被排进待回。
  const hits = code.match(/mine:\s*\(authorUid && String\(u\.uid \|\| ''\)\) \?/g) || []
  assert.ok(hits.length >= 2, '顶层评论和子回复都要按 uid 标出"是不是我发的"（缺 uid 给 null），现在只有 ' + hits.length + ' 处')
  const old = code.match(/mine:\s*authorUid \?/g) || []
  assert.equal(old.length, 0, '还有旧写法（缺 uid 会算成 false）没改干净：' + old.length + ' 处')
})

test('详情接口只给昵称、不给 uid 时也要把 author 交出去', () => {
  // 这段不在页面脚本里，直接在源文件上做静态守卫：改回 `if (authorUid)` 当场红。
  assert.match(
    SRC,
    /if \(authorUid \|\| String\(a\.nickname \|\| ''\)\.trim\(\)\) res\.author =/,
    'author 只在有 uid 时才赋值 → 只给昵称的详情响应会让 self.json 兜底学不到东西',
  )
})

// ── 2026-11-13（Codex 审查 P2）：扫描时的 429 必须能进冷却 ──────────────────────
test('页面脚本保留 HTTP 429，并把它报成 rate 状态', () => {
  const render = new Function('COMMON', 'ids', 'max', 'discover', 'maxWorkAgeDays',
    'return `' + BODY + '`;')
  const code = render({ aid: '6383' }, ['1'], 20, true, 0)
  assert.match(code, /if \(r\.status === 429\) http429 = true/, '拿不到 HTTP 状态，429 就会和"普通读失败"长一样')
  assert.match(code, /res\.state = 'rate'/, '算了 429 却没报给调用方，闸门照样进不去冷却')
})