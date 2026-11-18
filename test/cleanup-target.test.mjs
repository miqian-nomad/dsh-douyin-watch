/**
 * 回归测试：脚本自己产生的文件要有自动清理，而且得指对目录
 * 2026-11-18 实测发现：清理一直指向 analyses/，产物其实写在 douyin_out/ —— 等于清空目录，
 * 真正堆积的 193 个文件（49 MB）从 10-25 一直留到现在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'index.js'), 'utf8')
const ANALYZE = readFileSync(join(ROOT, 'tools', 'analyze-video.mjs'), 'utf8')

test('清理目录必须和产物目录一致', () => {
  // 产物写到 douyin_out/<id>/
  assert.match(ANALYZE, /join\(homeDir\(\), 'douyin_out'/, '产物目录是 douyin_out')
  // 清理也要指这里
  assert.match(SRC, /const analysesDir = join\(cfg\.home \|\| HOME, 'douyin_out'\)/, '清理还指向旧目录就会清空')
})

test('每天清一次，保留 14 天', () => {
  assert.match(SRC, /maybePurgeAnalyses\(\)/, '要有这个函数并且被调用')
  assert.match(SRC, /'--analyses-days', '14'/, '默认保留 14 天')
  assert.match(SRC, /now - Number\(j\.at \|\| 0\) < 86400000/, '24 小时内别重复清')
})
