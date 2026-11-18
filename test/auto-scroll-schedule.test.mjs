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

test('时刻表：两套算法分开（开机一套，按时间段一套）', () => {
  assert.match(SRC, /function buildSlotTimes/, '缺时刻表生成')
  assert.match(SRC, /function expandWindows/, '要能把时间段展开成区间（支持跨零点）')
  assert.match(SRC, /function dueSlot/, '缺"到点没有"的判断')
  assert.match(SRC, /function markSlotDone/, '刷完要把这一格标掉')
})

test('按时间段：段长 ÷ 条数 = 每格，每格随机取一个点（不套 5~20 分钟）', () => {
  assert.match(SRC, /const g = left \/ k/, '要按剩余段长均分')
  assert.match(SRC, /a \+ j \* g \+ Math\.random\(\) \* g/, '每格内随机取一点')
  assert.match(SRC, /const cap = Math\.max\(1, Math\.floor\(left \/ 60000\)\)/, '段装不下就今天少排，不硬塞')
  const i = SRC.indexOf('// ── ② 按时间段')
  assert.ok(i > 0, '找不到「按时间段」那一段')
  const winBlock = SRC.slice(i, SRC.indexOf('const schedSig', i))
  assert.equal(/5 \* 60000/.test(winBlock), false, '按时间段不许再套 5~20 分钟那条')
})

test('每个时间段自己填几条，外面的「每天最多」管所有段', () => {
  assert.match(SRC, /autoScrollWindowPer:/, '要有「每段几条」的配置')
  assert.match(SRC, /TOGGLE_KEYS\s*=\s*\[[^\]]*'autoScrollWindowPer'/, '漏了白名单，设置页存不进去')
  assert.match(SRC, /const spare = Math\.max\(0, n - asked\)/, '没填条数的段要用剩下的额度')
  assert.match(SRC, /Math\.min\(s\.per, n - acc\)/, '各段加起来超了总上限就按时间先后截断')
  assert.match(UI, /这段看/, '设置页每段后面要有「这段看几条」')
  assert.match(UI, /autoScrollWindowPer:/, '保存时要把每段条数一起写进去')
})

test('设置页写明「今天已经刷了几条」', () => {
  assert.match(SRC, /autoScrollTodayCount/, '接口要给出今天已刷数')
  assert.match(UI, /今天已经刷了/, '「每天最多刷几条」那条要把今天已刷数写出来')
})

test('改完时段/条数，今天的表跟着重排', () => {
  assert.match(SRC, /const schedSig = \(\) =>/, '要有配置签名')
  assert.match(SRC, /s\.sig !== schedSig\(\)/, '签名变了就必须重排，不然改完今天照旧跑')
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
})

test('按时间段却一段没填 = 今天不刷（2026-11-18 主人拍板，以前是「空 = 全天不限」）', () => {
  // 他在设置页选了「按时间段」、列表空着，结果全天都在刷，当天刷到 10 条才发现
  const i = SRC.indexOf('function inAutoWindow()')
  assert.ok(i > 0, '找不到 inAutoWindow')
  const fn = SRC.slice(i, SRC.indexOf('// ── 2026-11-17：刷视频的"时刻表"', i))
  assert.match(fn, /if \(!wins\.length\) return false/, '空列表必须当成「不刷」，不许回退成全天不限')
  assert.equal(/if \(!wins\.length\) return true/.test(fn), false, '「空 = 不限」的老写法又回来了')
  // 排时刻表这一层也要挡住：不许再回落到开机那套 5~20 分钟
  assert.match(SRC, /if \(byWindow && !segs\.length\) \{/, '按时段但排不出段时要单独拦一道')
  assert.match(SRC, /一个时段都没填'\) \+ '，今天不刷'/, '要在日志里说清为什么没排')
  // 设置页也要讲明白，不然页面上一片空、主人不知道今天为什么不刷
  // （2026-11-18 自审改了措辞：点「+」但没选完时间时列表已经有行、真正保存的段还是 0，
  //   所以文案从「一段都没填」改成「还没有一段填完整」，判据也改成看填完的段）
  assert.match(UI, /还没有一段填完整 = 今天不刷/, '设置页要写明后果')
})

test('规则改版要顶掉今天已经排好的旧表', () => {
  // 不改签名的话：今天 pick-sched.json 里那张表签名不变，会继续按老规则跑完
  assert.match(SRC, /const SCHED_RULE_VERSION = \d+/, '缺规则版本号')
  assert.match(SRC, /const schedSig = \(\) => \['v' \+ SCHED_RULE_VERSION/, '版本号要进签名')
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
