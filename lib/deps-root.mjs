/**
 * lib/deps-root.mjs —— 「依赖根目录」的唯一来源
 * ============================================================================
 * 为什么要抽出来（2026-11-17）：
 *   以前 6 个文件各自写死「某个盘符下的 plugins\_deps\...」（签名脚本、python 解释器）。
 *   换台机器 / 换个盘符全是静默失效，而且这种本机绝对路径不该出现在公开的包里。
 *
 * 找法（跟 tools/py/douyin_downloader.py 的 _default_deps_root() 是同一套规则）：
 *   ① 环境变量 DOUYIN_DEPS_ROOT（想放哪都行）
 *   ② **插件旁边的 _deps**：插件装在 <plugins>/dsh-douyin-watch 时 = <plugins>/_deps
 *      —— 也就是"依赖和插件放一起"的机器布局，换盘符、换用户名都成立
 *   ③ ~/.dsh/deps（全新机器什么都没有时的落脚点）
 * ============================================================================
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))   // <插件>/lib

/** 依赖根目录（绝对路径；不保证存在） */
export function depsRoot() {
  const env = String(process.env.DOUYIN_DEPS_ROOT || '').trim()
  if (env) return env
  const sibling = join(HERE, '..', '..', '_deps')
  if (existsSync(sibling)) return sibling
  return join(homedir(), '.dsh', 'deps')
}

/** 签名脚本目录（curl_cffi + cryptography 那套 python 脚本） */
export const signerDir = () => join(depsRoot(), 'scripts', 'douyin-signer')

/** 签名脚本本身：signerScript('signed_get.py') / signerScript('probe_get.py') */
export const signerScript = (name = 'signed_get.py') => join(signerDir(), name)

/** 依赖目录里的 site-packages（给 PYTHONPATH 用，不是解释器） */
export const depsPyDir = () => join(depsRoot(), 'python')

/**
 * 依赖里的 Python 解释器。
 * 顺序：envName 指定的环境变量 → 依赖目录里的 3.11（先按老布局的构建名，再按任意构建）→ PATH 上的 python
 * @param {string} envName 该调用方惯用的环境变量名（DOUYIN_SIGN_PY / DOUYIN_DEPS_PYTHON / DOUYIN_PYTHON …）
 */
export function depsPython(envName = 'DOUYIN_SIGN_PY') {
  const fromEnv = String(process.env[envName] || '').trim()
  if (fromEnv) return fromEnv
  const base = join(depsRoot(), 'python311')
  // ① 老布局的构建名（保持和以前完全一样的选择，行为不变）
  const legacy = join(base, 'cpython-3.11-windows-x86_64-none', 'python.exe')
  if (existsSync(legacy)) return legacy
  // ② 依赖目录里的任意 3.11 构建（构建目录名随下载包变化，不写死）
  try {
    const builds = readdirSync(base)
      .filter((d) => existsSync(join(base, d, 'python.exe')))
      .sort((a, b) => {
        const pa = /cpython-\d+\.\d+\.\d+/.test(a) ? 0 : 1
        const pb = /cpython-\d+\.\d+\.\d+/.test(b) ? 0 : 1
        return pa - pb || a.localeCompare(b)
      })
    if (builds.length) return join(base, builds[0], 'python.exe')
  } catch { /* 没有就算了 */ }
  // 2026-11-18：以前最后直接返回 'python' —— macOS / Linux 常常只有 python3，没有 python，
  //   那样「签名直连」这条路在别的系统上会白失败一次。按平台给个更可能存在的名字（调用方仍可报错）。
  return process.platform === 'win32' ? 'python' : 'python3'
}
