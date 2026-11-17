/**
 * 回归测试：刷视频的"时刻表"（2026-11-17 主人要求）
 *
 * 背景：以前落在时间段里、每 60 秒看一次，凑够条数就一口气刷完 —— 5 条挤在同一刻，像脚本。
 * 现在：先圈一段时间，再把 N 条摊开（每段随机一个时刻），到点刷一条。
 * 钉住三件事：
 *   ① 有自动识别的默认值，且能写进去（TOGGLE_KEYS）
 *   ② 到点才刷：tick 里必须查时刻表，没到点直接返回
 *   ③ 摊开模式下每次只刷一条，不是一次性刷完
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const UI = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('默认摊开刷；能写进配置白名单', () => {
  assert.match(SRC, /autoScrollSpread:\s*'spread'/, '默认值应该是摊开')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'autoScrollSpread'/, '漏了 TOGGLE_KEYS')
})

test('时刻表：先定起点，再按 5~20 分钟随机排开', () => {
  assert.match(SRC, /function buildSlotTimes/, '缺时刻表生成')
  assert.match(SRC, /function nextWindowStart/, '配了时段时要从时段里/下个时段开始')
  assert.match(SRC, /function dueSlot/, '缺"到点没有"的判断')
  assert.match(SRC, /function markSlotDone/, '刷完要把这一格标掉')
})

test('没到点就不刷（tick 里先查时刻表）', () => {
  const i = SRC.indexOf('const due = dueSlot(perDay)')
  assert.ok(i > 0, 'tick 里没有查时刻表')
  const after = SRC.slice(i, i + 200)
  assert.match(after, /if \(!due\) return/, '没到点必须直接返回')
})

test('摊开模式每次只刷一条；一次刷完才允许整批', () => {
  assert.match(SRC, /const burstRun = String\(cfg\.autoScrollSpread \|\| 'spread'\) === 'burst'/, '没有读模式')
  assert.match(SRC, /const runLimit = burstRun \? Math\.max\(1, perDay - st\.count\) : 1/, '摊开模式应该每次 1 条')
})

test('第 7 步只问四个大方向（顺序是主人定的），档位留在设置页', () => {
  const i = UI.indexOf('if (step === 7) {')
  const j = UI.indexOf('if (step === 8) {', i)
  assert.ok(i > 0 && j > i, '找不到第 7 步')
  const seg = UI.slice(i, j)
  const labels = [...seg.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(labels, ['要不要刷', '什么时候刷', '刷完告诉你', '写日报'], '四项、顺序不能变')
  assert.equal(/'怎么摊开'/.test(seg), false, '「怎么摊开」不该留在引导里')
  assert.equal(/'每天几条'/.test(seg), false, '「每天几条」不该留在引导里')
  assert.match(seg, /t: '开机就刷' \}, \{ v: 'window', t: '按时间段'/, '第二问是「开机就刷 / 按时间段」')
})

test('「什么时候刷」两档：默认开机就刷，后端认 autoScrollWhen', () => {
  assert.match(SRC, /autoScrollWhen: 'uptime'/, '默认跟着开机走')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'autoScrollWhen'/, '漏了 TOGGLE_KEYS')
  assert.match(SRC, /if \(String\(cfg\.autoScrollWhen \|\| 'uptime'\) !== 'window'\) return true/, '选开机就刷时不该被时段挡住')
})

test('档位都在设置页改：什么时候刷、怎么摊开、每天几条', () => {
  assert.match(UI, /autoScrollWhen: e\.target\.value/, '设置页要能改「什么时候刷」')
  assert.match(UI, /autoScrollSpread: e\.target\.value/, '设置页要能改「怎么摊开」')
  assert.match(UI, /autoScrollPerDay: Number\(e\.target\.value\)/, '设置页要能填「每天几条」')
})

test('引导页不再自己编时间段（跟设置页只留一套）', () => {
  assert.equal(/中午晚上/.test(UI), false, '引导页不许再出现「中午晚上」这种自编预设')
  assert.equal(/全天都行/.test(UI), false, '引导页不许再出现「全天都行」这种自编预设')
  assert.match(SRC, /if \(!wins\.length\) return true/, '没配时段不该永远不跑')
})

test('间隔 5~20 分钟随机；条数多就自然摊更久（不压成 2 分钟一条）', () => {
  assert.match(SRC, /const MIN = 5 \* 60000/, '下限 5 分钟')
  assert.match(SRC, /const MAX = 20 \* 60000/, '上限 20 分钟')
  assert.match(SRC, /MIN \+ Math\.random\(\) \* \(MAX - MIN\)/, '中间每次重抽，不是固定值')
  assert.equal(/60 \/ n/.test(SRC), false, '不许再用"一小时除以条数"把间隔压死')
})

test('没配时段 = 跟着开机：先等 10~30 分钟', () => {
  assert.match(SRC, /Date\.now\(\) \+ \(10 \+ Math\.random\(\) \* 20\) \* 60000/, '开机后要随机等 10~30 分钟')
  assert.match(SRC, /错过的那一格不补/, '关机错过的不许补刷')
})
