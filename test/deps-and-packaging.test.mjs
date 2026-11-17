/**
 * 回归测试：依赖目录解析 + 打包白名单
 * ============================================================================
 * 2026-11-17 两件事一起钉住：
 *   ① 包里不许再出现写死的本机绝对路径（`D:\某盘\plugins\_deps\...`）。
 *      现在统一由 lib/deps-root.mjs 解析：环境变量 → 插件旁边的 _deps → ~/.dsh/deps。
 *   ② package.json 的 files 不能用整目录（`"tools"` 这种）。
 *      实测：files 用整目录时 **.npmignore 完全不生效**——跑过一次 python 就会把
 *      `tools/py/__pycache__/*.pyc`、随手留下的 `.bak` 一起打进包里。
 *      用显式后缀白名单才挡得住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { depsRoot, signerDir, signerScript, depsPyDir, depsPython } from '../lib/deps-root.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('依赖目录：环境变量优先，默认落到某个 _deps', () => {
  const saved = process.env.DOUYIN_DEPS_ROOT
  try {
    process.env.DOUYIN_DEPS_ROOT = join(homedir(), 'somewhere', '_deps')
    assert.equal(depsRoot(), join(homedir(), 'somewhere', '_deps'), '设了环境变量就该用它')
    delete process.env.DOUYIN_DEPS_ROOT
    // 默认值可以是「插件旁边的 _deps」，也可以回落到 ~/.dsh/deps —— 只要求是算出来的 _deps 目录，
    // 「有没有写死路径」由下面那条源码扫描守（这里不能断言具体值，否则在依赖和插件放一起的机器上会误报）。
    assert.match(depsRoot(), /_deps$/, '默认值应该是某个 _deps 目录')
  } finally {
    if (saved === undefined) delete process.env.DOUYIN_DEPS_ROOT
    else process.env.DOUYIN_DEPS_ROOT = saved
  }
})

test('签名脚本 / 依赖 python 都从依赖目录推出来（跟着根目录走）', () => {
  const root = depsRoot()
  assert.equal(signerDir(), join(root, 'scripts', 'douyin-signer'))
  assert.equal(signerScript('signed_get.py'), join(root, 'scripts', 'douyin-signer', 'signed_get.py'))
  assert.equal(signerScript('probe_get.py'), join(root, 'scripts', 'douyin-signer', 'probe_get.py'))
  assert.equal(depsPyDir(), join(root, 'python'))
  const py = depsPython('DOUYIN_SIGN_PY')
  assert.ok(py === 'python' || py.includes('python'), '要么是解释器路径，要么退回 PATH 上的 python：' + py)
})

test('源码里不许再有写死的本机依赖路径（index.js 的护栏正则除外）', () => {
  const files = [
    'index.js', 'tools/analyze-video.mjs', 'tools/comment-api.mjs', 'tools/comment-probe.mjs',
    'tools/comment-thread.mjs', 'tools/signed-search.mjs', 'tools/video-thread.mjs',
    'tools/py/fetch_media_urls.mjs', 'tools/py/douyin_downloader.py', 'lib/deps-root.mjs',
  ]
  const bad = []
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (!/dsh-plugins/i.test(line)) return
      // index.js 的「本机目录名」护栏正则是故意列出这类目录名的，属于拦截规则，不是路径
      if (f === 'index.js' && /本机目录名/.test(line)) return
      bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`)
    })
  }
  assert.deepEqual(bad, [], '源码里还有写死的本机路径：\n' + bad.join('\n'))
})

test('打包白名单必须是后缀，不能用整目录（否则 .npmignore 失效、__pycache__ 会进包）', () => {
  const files = PKG.files || []
  const bareDirs = files.filter((p) => !/[*.]/.test(p) && ['lib', 'tools', 'test', 'src'].includes(p))
  assert.deepEqual(bareDirs, [], '这些是整目录白名单，会被 __pycache__/.bak 钻进来：' + bareDirs.join(', '))
  // 这版必须覆盖到的几类文件
  for (const need of ['tools/*.mjs', 'tools/*.py', 'tools/py/*.py', 'tools/py/*.mjs', 'lib/*.mjs']) {
    assert.ok(files.includes(need), 'files 里缺 ' + need)
  }
  assert.ok(files.includes('CHANGELOG.md'), '更新日志要在包里（npm 页面能看）')
})
