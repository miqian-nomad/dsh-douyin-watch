/**
 * 回归测试：设置页下拉弹层的主题修复（issue #4）
 *
 * 背景：原生 <select> 的弹层由浏览器画，深色主题下白底浅字。实测 Chromium 151 支持
 *   appearance: base-select / ::picker(select)，弹层变可样式化 DOM，吃掉主题变量。
 * 这里守住三件事：
 *   ① 必须是 @supports 渐进增强（老浏览器忽略，不比现在差）
 *   ② 必须只作用于本插件面板（[data-dy-panel]），不许污染 DSH 其它页面
 *   ③ ::picker 和 option 都要显式给背景色 —— 只给 color 不解决问题
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8')

const START = 'const SELECT_THEME_CSS = '
const at = SRC.indexOf(START)
assert.ok(at >= 0, 'client.js 里找不到 SELECT_THEME_CSS')
const end = SRC.indexOf(".join('\\n')", at)
assert.ok(end > at, '找不到 .join 结尾')
const expr = SRC.slice(at + START.length, end + ".join('\\n')".length)
const C = {
  line: 'var(--dsw-alias-border-l, rgba(0,0,0,0.10))',
  text3: 'var(--dsw-alias-label-tertiary, rgba(15,17,21,0.45))',
}
const CSS = new Function('C', 'return ' + expr)(C)

test('用 @supports 渐进增强，老浏览器不会被这条 CSS 影响', () => {
  assert.match(CSS, /@supports \(appearance: base-select\)/, '必须包在 @supports 里')
})

test('只作用于本插件面板，不碰 DSH 其它页面', () => {
  const selectors = CSS.split('\n').filter((l) => /\{/.test(l)).map((l) => l.trim())
  const global = selectors.filter((s) => s.startsWith('select') || s.startsWith('option') || s.startsWith('[data-dy-panel]') === false)
  // 允许以 @supports 开头；其余必须带 [data-dy-panel]
  const bad = global.filter((s) => !s.startsWith('@supports') && !s.includes('[data-dy-panel]'))
  assert.deepEqual(bad, [], '这些选择器没限定在面板内：' + bad.join(' | '))
})

test('弹层本体（::picker）和每个选项都显式给了背景色', () => {
  const pickerBlock = CSS.slice(CSS.indexOf('::picker(select)'), CSS.indexOf('option {'))
  assert.match(pickerBlock, /background:/, '::picker 必须给背景色，只给 color 不够')
  const optionBlock = CSS.slice(CSS.indexOf('[data-dy-panel] option {'))
  assert.match(optionBlock, /background:/, 'option 必须给背景色')
  assert.match(optionBlock, /color:/, 'option 必须给文字色')
})

test('选中态/悬停态另有底色，避免白底高亮条把字盖住', () => {
  assert.match(CSS, /option:checked/, '要处理选中态')
  assert.match(CSS, /option:hover/, '要处理悬停态')
})