/**
 * 回归测试：收到视频分享卡片时的行为（shareCardMode 开关）
 *
 * 背景：2026-11-05 我把「收到分享卡片就自动分析」改成了「默认只当话题聊」，
 * 但那条理由是**我自己**写的（怕像交作业），不是主人的要求。2026-11-17 主人推翻：
 * 「我分享给他视频为什么不看」——默认改成 analyze。
 * 这几条钉住四件事：
 *   ① 默认值必须是 analyze（不许悄悄退回 chat）
 *   ② 两种模式在唤醒消息里给的是不同的指令
 *   ③ 设置页真的有这个选项、且写进白名单
 *   ④ 私信里的图片/表情包也有开关（imageMode），skip 时连下载都不做
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const UI = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('默认值是 analyze（2026-11-17 主人拍板：分享的视频就该看）', () => {
  assert.match(SRC, /shareCardMode:\s*'analyze'/, '默认值应该是"主动看"')
  // 反过来：不许再退回 'chat' 当默认（那是我 11-05 自己定的理由，不是主人的要求）
  assert.equal(/shareCardMode:\s*'chat'/.test(SRC), false, '默认值又被改回只聊天了')
})

test('shareCardMode 在可写白名单里（不然设置页保存不进去）', () => {
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'shareCardMode'/, '漏了 TOGGLE_KEYS')
})

test('两种模式给出不同指令', () => {
  assert.match(SRC, /const wantAnalyze = String\(cfg\.shareCardMode \|\| 'analyze'\) !== 'chat'/, '没有读开关')
  assert.match(SRC, /按设置自动分析：先调 douyin_analyze/, 'analyze 模式没给分析指令')
  assert.match(SRC, /先当话题接，他明说要分析才调 douyin_analyze/, 'chat 模式的指令被改掉了')
})

test('设置页有这一项，两个选项都在', () => {
  assert.match(UI, /label:\s*'收到视频分享卡片'/, '设置页没有这一项')
  assert.match(UI, /主动看（默认）/, '缺「主动看（默认）」选项')
  assert.match(UI, /只当话题聊/, '缺「只当话题聊」选项')
  assert.match(UI, /save\(\{\s*shareCardMode:/, '下拉框没接保存')
})

// ── 2026-11-17 新增：私信里的图片 / 表情包要不要读 ─────────────────────
test('图片开关：默认读，选"当没看见"时不下载也不提图片内容', () => {
  assert.match(SRC, /imageMode:\s*'read'/, '默认应该读图')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'imageMode'/, '漏了 TOGGLE_KEYS')
  assert.match(SRC, /const imageMode = String\(cfg\.imageMode \|\| 'read'\) === 'skip' \? 'skip' : 'read'/, '没有读开关')
  // skip 时连下载都不做
  const i = SRC.indexOf("const imageMode = String(cfg.imageMode")
  const block = SRC.slice(i, i + 900)
  assert.match(block, /if \(imageMode === 'read'\)/, '读图要包在开关里')
  assert.match(block, /没读这张图/, 'skip 时要给一句人话，别让模型以为对方没发东西')
  assert.match(UI, /私信里发来的图片、表情包/, '设置页要能改这一项')
})
