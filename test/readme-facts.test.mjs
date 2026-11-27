/**
 * 守卫：README / 挂载模板里的「事实性描述」不许跟代码漂开（2026-11-28，W8 审计后加）
 *
 * 起因：README 长期写着「所有工具都走 9334 Chrome，永远无头」「家目录默认 ~/.dsh/douyin-duty」
 *   「9 个工具」这类话，而代码早就变了；更糟的是公开包模板里写 `home: '[PLACEHOLDER_...]'`，
 *   代码只判空 → 新用户装完家目录就是那个字面量。这些都不该靠人记，靠测试挡。
 *
 * 这里只钉「能从代码算出来的事实」：工具数量、默认值、文件名存在性、禁写的过时表述、
 *   不许出现本机绝对路径、模板里的路径不许是占位符。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUnsetPath, resolveConfiguredPath } from '../lib/paths.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const SERVER = readFileSync(join(ROOT, 'index.js'), 'utf8')
const PATCH = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/* ───────────── ① 工具数量 / 工具表，跟 index.js 注册的动态比 ───────────── */
const registered = [...SERVER.matchAll(/name: '(douyin_[a-z_]+)'/g)].map((m) => m[1])
const registeredSet = [...new Set(registered)].sort()

test('README 写着「N 个工具」，N 必须等于 index.js 实际注册数', () => {
  assert.ok(registeredSet.length >= 10, '工具数量像是解析错了：' + registeredSet.length)
  const m = /##\s*(\d+)\s*个工具/.exec(README)
  assert.ok(m, 'README 里找不到「## N 个工具」这个小标题')
  assert.equal(Number(m[1]), registeredSet.length,
    `README 写 ${m[1]} 个，index.js 实际注册 ${registeredSet.length} 个`)
})

test('工具表逐行都在 / 全都在表里（不许漏写，也不许写不存在的）', () => {
  const i = README.indexOf('个工具')
  const start = README.lastIndexOf('##', i)
  const end = README.indexOf('\n## ', i)
  const block = README.slice(start, end > 0 ? end : README.length)
  const listed = [...block.matchAll(/^\|\s*`(douyin_[a-z_]+)`\s*\|/gm)].map((m) => m[1]).sort()
  const missing = registeredSet.filter((t) => !listed.includes(t))
  const extra = listed.filter((t) => !registeredSet.includes(t))
  assert.deepEqual(missing, [], 'README 工具表漏了：' + missing.join(', '))
  assert.deepEqual(extra, [], 'README 工具表写了代码里没有的：' + extra.join(', '))
})

/* ───────────── ② 端口 / 模式：不许写死 ───────────── */
test('端口不许写死：9334 只允许出现在「从 9334 起扫」这种描述里', () => {
  const bad = README.split('\n')
    .map((line, n) => ({ line, n: n + 1 }))
    .filter((x) => x.line.includes('9334') && !x.line.includes('起扫'))
  assert.deepEqual(bad.map((x) => x.n), [],
    '这些行把端口写死了（端口应写成「见 runtime.json / 从 9334 起扫」）：' + bad.map((x) => x.n).join(', '))
})

test('不许再写「永远无头」和那两个已废的开关/文件', () => {
  for (const s of ['永远无头', 'dsh-browser-playwright.state.json', '--headless=off']) {
    assert.equal(README.includes(s), false, 'README 里还有过时表述：' + s)
  }
})

/* ───────────── ③ 配置默认值：README 表格 vs DEFAULTS ───────────── */
const defaultsBlock = (() => {
  const i = SERVER.indexOf('const DEFAULTS = {')
  assert.ok(i > 0, '找不到 DEFAULTS')
  const j = SERVER.indexOf('\n}', i)
  return SERVER.slice(i, j)
})()
const norm = (v) => String(v).replace(/[`*'"\s]/g, '').replace(/^,+|,+$/g, '')

function defaultOf(key) {
  const m = new RegExp('^\\s+' + key + ':\\s*([^,\\n]+)', 'm').exec(defaultsBlock)
  return m ? norm(m[1]) : null
}
function readmeRow(key) {
  const m = new RegExp('\\|\\s*`' + key + '`\\s*\\|\\s*([^|]+?)\\s*\\|', 'm').exec(README)
  return m ? norm(m[1]) : null
}

test('README 配置表里的默认值与 DEFAULTS 一致（7 个关键键）', () => {
  const keys = ['enabled', 'intervalSeconds', 'maxWakeText', 'ownerAutoReply', 'commentPerHour', 'commentPerDay', 'probeHours']
  for (const k of keys) {
    const code = defaultOf(k)
    const doc = readmeRow(k)
    assert.ok(code !== null, 'DEFAULTS 里找不到 ' + k)
    assert.ok(doc !== null, 'README 配置表里找不到 ' + k)
    assert.equal(doc, code, `\`${k}\` 默认值不一致：README 写 ${doc}，代码是 ${code}`)
  }
})

/* ───────────── ④ README 提到的 tools 文件必须真实存在 ───────────── */
test('README 里提到的每个 tools/ 文件都真的存在（改名/错字当场抓）', () => {
  const hits = [...README.matchAll(/tools\/[A-Za-z0-9_.\-/]+\.(?:mjs|py|json)/g)].map((m) => m[0])
  const uniq = [...new Set(hits)]
  assert.ok(uniq.length > 0, 'README 里一个 tools/ 文件都没提到？像是解析错了')
  const missing = uniq.filter((p) => !existsSync(join(ROOT, p)))
  assert.deepEqual(missing, [], 'README 提到但仓库里不存在的文件：' + missing.join(', '))
})

/* ───────────── ⑤ 发布卫生 + 模板占位符 ───────────── */
test('README / 挂载模板里不许出现本机绝对路径', () => {
  // 注意别把 URL 当盘符：`https://…` 里也有 `s:/`，所以 Windows 路径只认反斜杠形式
  const WIN = /(^|[^\w])[A-Za-z]:\\\S/
  const POSIX = /\/(Users|home)\/[A-Za-z0-9_.-]+\//
  for (const [name, text] of [['README.md', README], ['cordis.patch.yml', PATCH]]) {
    const bad = text.split('\n').map((line, n) => ({ line, n: n + 1 }))
      .filter((x) => WIN.test(x.line) || POSIX.test(x.line))
    assert.deepEqual(bad.map((x) => name + ':' + x.n + ' ' + x.line.trim().slice(0, 40)), [], '出现了本机绝对路径')
  }
})

test('挂载模板里 home / cfgFile / logFile 的值不许是占位符（留空 = 用默认目录）', () => {
  const rows = [...PATCH.matchAll(/^\s+(home|cfgFile|logFile):\s*(.*)$/gm)]
  assert.equal(rows.length, 3, '模板里应该正好有 home / cfgFile / logFile 三行')
  for (const [, key, rawValue] of rows) {
    const v = String(rawValue).replace(/#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    assert.equal(/PLACEHOLDER/i.test(v), false, `${key} 还是占位符：${v}`)
    assert.equal(v, '', `${key} 应该留空（留空 = 默认目录），现在是：${v}`)
  }
})

test('代码里真的接了「占位符 = 没给」的兜底（不是只改文档）', () => {
  assert.match(SERVER, /resolveConfiguredPath\(boot\.home/, 'home 没走统一解析')
  assert.match(SERVER, /resolveConfiguredPath\(boot\.cfgFile/, 'cfgFile 没走统一解析')
  assert.match(SERVER, /resolveConfiguredPath\(boot\.logFile/, 'logFile 没走统一解析')
  // 覆盖顺序：算好的真路径必须在展开 boot 之后覆盖，否则占位符又会盖回去
  assert.match(SERVER, /home: bootHome, cfgFile: cfgPath, logFile: logPath/, 'cfg 里没有回填解析后的路径')
  assert.match(SERVER, /家目录=\$\{cfg\.home\}/, '启动日志没写实际家目录')
})

test('占位符判定本身（纯函数，行为级）', () => {
  assert.equal(isUnsetPath(''), true)
  assert.equal(isUnsetPath('   '), true)
  assert.equal(isUnsetPath('[PLACEHOLDER_DOUYIN_HOME]'), true)
  assert.equal(isUnsetPath('[PLACEHOLDER_DOUYIN_HOME]/watch-config.json'), true)
  assert.equal(isUnsetPath('[ANYTHING]/x.log'), true, '以 [ 开头一律当占位符')
  assert.equal(isUnsetPath('undefined'), true)
  assert.equal(isUnsetPath('null'), true)
  assert.equal(isUnsetPath('/data/douyin-duty'), false)
  assert.equal(isUnsetPath('D:\\douyin-duty'), false)
  assert.equal(resolveConfiguredPath('[PLACEHOLDER_DOUYIN_HOME]', '/fallback'), '/fallback')
  assert.equal(resolveConfiguredPath(' D:\\douyin-duty ', '/fallback'), 'D:\\douyin-duty')
})
