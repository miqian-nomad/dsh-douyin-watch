/**
 * 回归测试：收到视频分享卡片时的行为（shareCardMode 开关）
 *
 * 背景：2026-11-05 把「收到分享卡片就自动分析」改成了「默认只当话题聊」，
 * 但当时是写死的、设置页里没有开关。2026-11-17 做成可调，默认行为保持不变。
 * 这几条钉住三件事：
 *   ① 默认值不许变（老用户升级后行为不能悄悄改）
 *   ② 两种模式在唤醒消息里给的是不同的指令
 *   ③ 设置页真的有这个选项、且写进白名单
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const UI = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('默认值是 chat（老用户升级后仍然是「只当话题聊」）', () => {
  assert.match(SRC, /shareCardMode:\s*'chat'/, '默认值被改了')
})

test('shareCardMode 在可写白名单里（不然设置页保存不进去）', () => {
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'shareCardMode'/, '漏了 TOGGLE_KEYS')
})

test('两种模式给出不同指令', () => {
  assert.match(SRC, /const wantAnalyze = String\(cfg\.shareCardMode \|\| 'chat'\) === 'analyze'/, '没有读开关')
  assert.match(SRC, /按设置自动分析：先调 douyin_analyze/, 'analyze 模式没给分析指令')
  assert.match(SRC, /先当话题接，他明说要分析才调 douyin_analyze/, 'chat 模式的指令被改掉了')
})

test('设置页有这一项，两个选项都在', () => {
  assert.match(UI, /label:\s*'收到视频分享卡片'/, '设置页没有这一项')
  assert.match(UI, /只当话题聊（默认）/, '缺「只当话题聊」选项')
  assert.match(UI, /自动分析再看/, '缺「自动分析」选项')
  assert.match(UI, /save\(\{\s*shareCardMode:/, '下拉框没接保存')
})
