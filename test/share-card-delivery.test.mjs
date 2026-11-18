/**
 * 回归测试：自动刷视频的结果，用「视频分享卡片」发，不是一串长链接
 * （2026-11-18 主人拍板：卡片有封面、点开就能看；卡片发不出去才退回文字链接兜底）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const UI = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('默认发卡片，并且写进配置白名单', () => {
  assert.match(SRC, /autoScrollDeliverAs:\s*'card'/, '默认值应该是卡片')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'autoScrollDeliverAs'/, '漏了 TOGGLE_KEYS，设置页存不进去')
})

test('发卡片走 card-share，发文字才是 im-send', () => {
  assert.match(SRC, /function shareCardTo\(/, '要有发卡片的封装')
  assert.match(SRC, /cfg\.shareScript/, '卡片的脚本是 card-share.mjs')
  assert.match(SRC, /function readbackCard\(/, '卡片要能回读')
})

test('卡片回读看的是卡片的类型（aweType 800），不是只看有没有新消息', () => {
  assert.match(SRC, /Number\(m\.awe\) === 800/, '卡片消息的判据是 aweType 800')
  assert.match(SRC, /m\.from === 'me'/, '只认「我发的」那一边')
})

test('自动刷：先发卡片，失败的才退回文字链接', () => {
  const i = SRC.indexOf('const asCard = String(cfg.autoScrollDeliverAs')
  assert.ok(i > 0, '自动刷里没有按配置分流的判断')
  const block = SRC.slice(i, i + 1600)
  assert.match(block, /await shareCardTo\(aid, cfg\.owner\)/, '要用卡片发')
  assert.match(block, /const rb = shar\.ok \? await readbackCard/, '发完要回读')
  assert.match(block, /if \(!rb\.ok\) failed\.push\(it\)/, '回读不到就算失败')
  assert.match(block, /卡片没发出去，先发链接给你/, '失败要有文字兜底')
  assert.match(block, /await sendChatText\(target, head\)/, '兜底走 im-send 发文字')
})

test('设置页能选「结果怎么发」，且新项挂在自动刷视频那块', () => {
  assert.match(UI, /label: '结果怎么发'/, '设置页要有这一项')
  assert.match(UI, /autoScrollDeliverAs: e\.target\.value/, '保存要真的写进去')
  assert.match(UI, /视频卡片（默认）/, '默认档要写明')
})

test('哨兵暂停要盖住整个投递（发卡片会跟哨兵抢页面）', () => {
  assert.match(SRC, /哨兵要暂停到\*\*投递完\*\*/, '要有这条说明，免得以后又被改回只暂停采集')
  assert.match(SRC, /resumeWatcher\(\)\s+\/\/ 不管成败都要把哨兵放回去/, '外层 finally 必须放回哨兵')
})

test('刷完叫醒它自己看：走 followup，不碰自己发的卡片', () => {
  assert.match(SRC, /autoScrollAgentRead:\s*true/, '默认开着，主人这次就是要它自己看')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'autoScrollAgentRead'/, '漏了白名单，设置页存不进去')
  const i = SRC.indexOf('if (cfg.autoScrollAgentRead) {')
  assert.ok(i > 0, 'tick 里没有「叫醒它自己看」这一步')
  const block = SRC.slice(i, i + 1400)
  assert.match(block, /tgtAgent\.followup\(makeUserMessage\(prompt\)\)/, '要用 followup 主动投递')
  assert.match(block, /sessionRoute\(tgtAgent\)/, '投递前先确认能解析模型路由')
  assert.match(block, /douyin_analyze/, '要让它自己去读这条视频')
  assert.match(block, /douyin_send/, '要让它自己讲给主人')
})
