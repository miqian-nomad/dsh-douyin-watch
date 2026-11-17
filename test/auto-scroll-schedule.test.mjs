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

test('时刻表：按时间段摊开，每段随机一个时刻', () => {
  assert.match(SRC, /function buildSlotTimes/, '缺时刻表生成')
  assert.match(SRC, /const seg = span \/ n/, '要按条数平分时间段')
  assert.match(SRC, /Math\.random\(\) \* seg/, '每段里随机挑一个时刻')
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

test('第 7 步能选"怎么摊开"', () => {
  assert.match(UI, /label: '怎么摊开'/, '引导页第 7 步要有这一项')
  assert.match(UI, /t: '摊开刷' \}, \{ v: 'burst', t: '一次刷完'/, '两个选项都要在')
  assert.match(UI, /autoScrollSpread: scrollSpread === 'burst' \? 'burst' : 'spread'/, '完成时要写进去')
})
