/**
 * 回归测试：提示条不许再用写死的浅色底（深色主题下会变刺眼白块）
 * ============================================================================
 * 来由（2026-11-15）：设置页里「被拦住」「评论区接口体检不正常」两条提示写死
 *   background: '#fdecea' / '#fef5e7' —— 浅色主题正常，深色下就是一块白板。
 *   同一天前面几轮修的是同一类问题（写死颜色 / 用错主题变量），所以这里钉死：
 *     ① 语义色只准从 TONE(深/浅) 取；
 *     ② 浅色分支必须逐字等于原来的写死值（外观一像素不变）；
 *     ③ 深色分支的提示底色必须是卡片层变量，不是浅色硬编码。
 * 界面像素这里验不了（无 GUI），但"用了哪种颜色"是纯字符串，可以钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** 把 TONE(dark) 里的两套值都抠出来：{ light: {...}, dark: {...} } */
function toneTable() {
  const m = /const TONE = \(dark\) => \(dark\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{([\s\S]*?)\}\)/.exec(CLIENT)
  assert.ok(m, 'client.js 里找不到 TONE(深/浅) 色表')
  const pick = (src) => {
    const out = {}
    for (const kv of src.matchAll(/(\w+):\s*'([^']*)'/g)) out[kv[1]] = kv[2]
    return out
  }
  return { dark: pick(m[1]), light: pick(m[2]) }
}

test('浅色分支逐字等于原来的写死值（浅色外观不变）', () => {
  const { light } = toneTable()
  // 右边这列全是改造前散落在各处、写死在代码里的原值
  assert.equal(light.danger, '#c0392b', '错误红')
  assert.equal(light.dangerBg, '#fdecea', '「被拦住」提示的原底色')
  assert.equal(light.warnBg, '#fef5e7', '「体检不正常」提示的原底色')
  assert.equal(light.warn, '#9c640c', '警告标题的原色')
  assert.equal(light.warnBorder, '#d68910', '警告边框的原色')
  assert.equal(light.ok, '#1f9d55', '通过绿')
  assert.equal(light.ok2, '#2e7d32', '运行中绿')
  assert.equal(light.note, '#b26a00', '提示橙')
  assert.equal(light.info, '#d4380d', '人设提示红橙')
})

test('深色分支：提示底色用卡片层变量，不是浅色硬编码', () => {
  const { dark } = toneTable()
  for (const k of ['dangerBg', 'warnBg']) {
    assert.match(dark[k], /^var\(--dsw-alias-bg-layer-1, #232324\)$/, k + ' 必须是卡片层变量（兜底 #232324）')
    assert.equal(/#fdecea|#fef5e7/i.test(dark[k]), false, k + ' 不许再出现浅色底')
  }
  // 深色下语义文字色要比浅色那套亮，否则衬在 #232324 上看不清
  assert.notEqual(dark.danger, '#c0392b', '深色下的错误红要更亮')
  assert.notEqual(dark.warn, '#9c640c', '深色下的警告色要更亮')
})

test('写死浅色底只准留在 TONE 的浅色分支里（各一处）', () => {
  for (const hex of ['#fdecea', '#fef5e7']) {
    const hits = CLIENT.split('\n').filter((l) => l.includes(hex) && !l.trim().startsWith('//'))
    assert.equal(hits.length, 1, hex + ' 只该出现 1 次（在 TONE 浅色分支），实际：' + hits.length + ' 次')
    assert.match(hits[0], /(dangerBg|warnBg):/, hex + ' 只该作为 TONE 的值出现')
  }
  // 不许再有「直接拿浅色十六进制当背景」
  const bgHard = CLIENT.split('\n').filter((l) => /background:\s*'#[0-9a-fA-F]{3,6}'/.test(l))
  const bad = bgHard.filter((l) => !/background:\s*'#fff'/.test(l))   // 开关拇指的 #fff 是允许的（白拇指配灰轨道）
  assert.deepEqual(bad, [], '不许写死背景色：' + bad.join(' | '))
})

test('三处提示都走 TONE：被拦住 / 体检不正常 / 本号身份缺失', () => {
  assert.match(CLIENT, /background: bad \? T\.dangerBg : T\.warnBg,/, '「被拦住」的底色要走 TONE')
  assert.match(CLIENT, /border: '1px solid ' \+ \(bad \? T\.danger : T\.warnBorder\)/, '「被拦住」的边框要走 TONE')
  assert.match(CLIENT, /style: \{ border: '1px solid ' \+ T\.warnBorder, background: T\.warnBg, borderRadius: 12/, '「体检不正常」要走 TONE')
  assert.match(CLIENT, /border: '1px solid ' \+ T\.warnBorder, background: C\.card,/, '「本号身份缺失」要用卡片层底（深浅都成立）')
})

test('深/浅判断读的是主题变量，不是猜 html class', () => {
  assert.match(CLIENT, /getPropertyValue\('--dsw-alias-bg-base'\)/, '按实际解析出来的页面底色判深浅')
  assert.equal(/classList\.contains\(['"]dark/.test(CLIENT), false, '别猜 class 名（之前猜 --dsw-alias-border-l 就猜错过）')
})

test('主题变了要重渲染（否则换主题后提示条颜色不会跟着变）', () => {
  assert.match(CLIENT, /function useThemeDark\(\)/, '要有跟主题的 hook')
  assert.match(CLIENT, /new MutationObserver/, 'html 上的主题属性变了要能感知')
  assert.match(CLIENT, /prefers-color-scheme: dark/, '系统偏好作为兜底')
  // 每个用到 TONE 的组件都得拿到 dark
  assert.match(CLIENT, /const dark = useThemeDark\(\);/, 'Panel 要取主题')
  assert.match(CLIENT, /sessionId: cfg\.sessionId, dark \}\)/, 'StatusCard 要拿到主题')
  assert.match(CLIENT, /function Wizard\(\{ cfg, setCfg, onDone, dark \}\)/, 'Wizard 要拿到主题')
  assert.match(CLIENT, /function WizStatus\(\{ state, text, dark \}\)/, 'WizStatus 要拿到主题')
})
