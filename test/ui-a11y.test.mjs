/**
 * 回归测试：设置页的可用性/规范项（2026-11-18，MOSS 用 Web Interface Guidelines 审出 8 条）
 *
 * 背景：主人对界面极度挑剔，这批只许修可用性、不许动排版配色。所以这些断言盯的都是
 * 「有没有做到」和「有没有偷偷改坏」，不是像素。
 *   ① 键盘焦点：ctlBase 以前带 outline:'none'，全文件没有替代 → Tab 走一圈看不见焦点
 *   ② Row 标签：普通 div，和右侧控件没关联（37 处）
 *   ③ 「−」删时间段：纯图标、无名字、删了没法撤销
 *   ④ 原生 select：深色下弹层可能白底白字
 *   ⑤ 按钮没有 hover 反馈
 *   ⑥ 数字列没对齐
 *   ⑦ 没管 prefers-reduced-motion
 *   ⑧ ✓/✕/○ 是装饰字符，该 aria-hidden
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const U = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('① 焦点：ctlBase 不再吞掉 outline，焦点环只在键盘走时出现', () => {
  assert.equal(/outline:\s*'none'/.test(U), false, 'ctlBase 里又有 outline:none 了（内联会盖掉 CSS）')
  assert.match(U, /const A11Y_CSS = \[/, '缺可用性样式表')
  assert.match(U, /:focus-visible \{/, '没有 :focus-visible 焦点环')
  // 焦点环用页面里已有的固定品牌蓝（brand-primary 在浅色下是墨黑，画环会变黑框）
  assert.match(U, /outline: 2px solid #4d6bfe/, '焦点环颜色不对')
  assert.match(U, /:focus \{ outline: none; \}/, '鼠标点击时不该冒出焦点框')
  assert.match(U, /ensureA11yTheme\(\)/, '样式表要真的被注入')
})

test('② Row：标签是 label、点它能聚焦控件、右侧控件有可访问名称', () => {
  const i = U.indexOf('function Row({ label, hint, children })')
  assert.ok(i > 0, '找不到 Row')
  const block = U.slice(i, i + 2000)
  assert.match(block, /h\('label', \{/, '标签还是 div')
  assert.match(block, /onClick: focusFirst/, '点标签不聚焦')
  assert.match(block, /role: 'group', 'aria-labelledby': labelId/, '右侧容器没有可访问名称')
  assert.match(block, /display: 'block'/, 'label 要按块级渲染，别改排版')
  // 标签要有 id（被 aria-labelledby 引用），但**不许 htmlFor 指自己**
  assert.match(block, /id: labelId/, '标签没 id，aria-labelledby 就指向空了')
  assert.equal(/htmlFor:\s*labelId/.test(block), false, 'htmlFor 又指回 label 自己的 id 了（等于自己绑自己）')
})

test('③ 删时间段：有可访问名称，并且能撤销（连删两行也留得住）', () => {
  assert.match(U, /'aria-label': '删掉这一段/, '− 按钮还是没有名字')
  assert.match(U, /items: \(prev && Array\.isArray\(prev\.items\) \? prev\.items : \[\]\)\.concat\(\[\{ row: r, index: i \}\]\)/, '连删时没有累加撤销信息')
  assert.match(U, /\}, '撤销'\)/, '没有撤销按钮')
  assert.match(U, /setTimeout\(\(\) => setUndoWin\(null\), 10000\)/, '撤销窗口要自己过期')
  // 连删两行：撤销条要说「已删掉 2 段」
  assert.match(U, /已删掉 ' \+ undoWin\.items\.length \+ ' 段/, '连删两行时没说清删了几段')
  // 撤销要按「后删的先放回」还原，位置才不颠倒
  assert.match(U, /for \(let k = undoWin\.items\.length - 1; k >= 0; k--\)/, '撤销顺序不对（连删会颠倒）')
  assert.match(U, /next\.splice\(at, 0, it\.row\)/, '撤销没把行放回去')
})

test('④ select：显式给背景色/字色，面板根按主题设 colorScheme', () => {
  assert.match(U, /backgroundColor: 'transparent'/, 'select 没显式给 backgroundColor')
  const roots = U.match(/colorScheme: dark \? 'dark' : 'light'/g) || []
  assert.ok(roots.length >= 2, '常规页和向导页根节点都要设 colorScheme（Windows 深色弹层靠它）')
})

test('⑤ 按钮有 hover/active 反馈（用内阴影叠色，不改配色）', () => {
  assert.match(U, /button:not\(:disabled\):hover \{ box-shadow: inset/, '没有 hover 反馈')
  assert.match(U, /button:not\(:disabled\):active \{ box-shadow: inset/, '没有 active 反馈')
})

test('⑥ 数字列用等宽数字', () => {
  assert.match(U, /input\[type="number"\] \{ font-variant-numeric: tabular-nums; \}/, '数字没对齐')
})

test('⑦ 尊重「减少动态效果」', () => {
  assert.match(U, /@media \(prefers-reduced-motion: reduce\)/, '没管 prefers-reduced-motion')
  assert.match(U, /transition-duration: 0\.001ms !important/, '过渡没被压掉')
})

test('⑧ 状态图标 aria-hidden（状态已经写在文字里）', () => {
  assert.match(U, /'aria-hidden': 'true', style: \{ flex: '0 0 auto', fontWeight: 700 \}/, '✓/✕/○ 还会被读屏念')
})

test('这批只动可用性：没碰配色/字号/圆角这些外观值', () => {
  // 浅色语义色逐字不变（上一轮定的），别趁这次改
  assert.match(U, /danger: '#c0392b', dangerBg: '#fdecea'/, '浅色语义色被改了')
  assert.match(U, /card: 'var\(--dsw-alias-bg-layer-1, #ffffff\)'/, '卡片底色被改了')
  // 字号只有在新增的几处（撤销条/标签）用到，行高 20px 那套不许变
  assert.match(U, /fontSize: 13, color: C\.text, lineHeight: '20px'/, 'Row 标签的字体行高被改了')
})
