/**
 * tools/comment-probe.mjs —— 评论区接口「签名自检」：打三次做对照，分清是哪一层坏了
 *
 *   ① 正常签名 ② 随便编一个 a_bogus ③ 完全不签名
 *   单看一次响应分不清（空 body 可能是没签名、没 cookie、或风控），三次交叉才能判。
 *
 * 用法：node tools/comment-probe.mjs [--aweme <视频id>] [--count 20]
 * 输出：{ ok, state, text, evidence, probes:{signed,badSign,unsigned}, cookie:{file,ttwid,session} }
 *
 * 只读：只 GET comment/list，不点不写不发。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { homeDir, cookieFile } from '../lib/paths.mjs'
import { classifyCommentProbe, probeText, PROBE } from '../lib/comment-probe.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

const AWEME = String(argOf('--aweme', '')).trim()
const COUNT = String(argOf('--count', '20'))
const PY = process.env.DOUYIN_SIGN_PY || 'D:\\dsh-plugins\\_deps\\python311\\cpython-3.11.16-windows-x86_64-none\\python.exe'
const SCRIPT = process.env.DOUYIN_PROBE_SCRIPT || 'D:\\dsh-plugins\\_deps\\scripts\\douyin-signer\\probe_get.py'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// 本地先看 cookie：文件在不在、有没有 ttwid / sessionid（只判存在，不打印任何值）
function inspectCookie() {
  const f = cookieFile()
  const info = { file: false, ttwid: false, session: false }
  try {
    if (!existsSync(f)) return info
    const raw = readFileSync(f, 'utf8').trim()
    if (!raw) return info
    info.file = true
    info.ttwid = /(^|;\s*)ttwid=/.test(raw)
    info.session = /(^|;\s*)sessionid(_ss)?=/.test(raw)
  } catch { /* 读不到就当真 */ }
  return info
}

function call(path, query, sign) {
  const args = [SCRIPT, '--path', path, '--query', query, '--sign', sign]
  const r = spawnSync(PY, args, { encoding: 'utf8', timeout: 40000 })
  const raw = String(r.stdout || '').trim()
  try { return JSON.parse(raw) || {} } catch { return { stage: 'parse', error: raw.slice(0, 160) || String(r.stderr || '').slice(0, 160) } }
}

// 一条固定视频：默认用 my-works.json 里第一个作品（本机自己在用，别人拿不到也不影响）
function pickAweme() {
  if (AWEME) return AWEME
  try {
    const j = JSON.parse(readFileSync(join(homeDir({ create: false }), 'my-works.json'), 'utf8'))
    const ids = Array.isArray(j.ids) ? j.ids.map(String).filter(Boolean) : []
    return ids[0] || ''
  } catch { return '' }
}

const aweme = pickAweme()
if (!aweme) {
  out({ ok: false, state: PROBE.UNKNOWN, text: '没有可用的视频 id：先用 --aweme 指定一条，或在设置页填「我的作品」', evidence: '拿不到固定视频', probes: null })
  process.exit(0)
}

const query = `device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500&version_name=19.5.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10&platform=PC&aweme_id=${aweme}&cursor=0&count=${COUNT}&item_type=0&app_name=aweme`

const signed = call('/aweme/v1/web/comment/list/', query, 'good')
const badSign = call('/aweme/v1/web/comment/list/', query, 'bad')
const unsigned = call('/aweme/v1/web/comment/list/', query, 'none')
const cookie = inspectCookie()

const verdict = classifyCommentProbe({ signed, badSign, unsigned, cookie })

out({
  ok: verdict.state === PROBE.OK,
  state: verdict.state,
  text: probeText(verdict.state),
  evidence: verdict.evidence,
  sign_checked: verdict.sign_checked,
  aweme,
  cookie: { file: cookie.file, ttwid: cookie.ttwid, session: cookie.session },
  probes: {
    signed: { http: signed.http, status_code: signed.status_code, n: signed.n, ok_json: signed.ok_json, empty: !String(signed.head || '').trim() },
    badSign: { http: badSign.http, status_code: badSign.status_code, n: badSign.n, ok_json: badSign.ok_json, empty: !String(badSign.head || '').trim() },
    unsigned: { http: unsigned.http, status_code: unsigned.status_code, n: unsigned.n, ok_json: unsigned.ok_json, empty: !String(unsigned.head || '').trim() },
  },
  // 诊断用：只有全空的时候才需要看原始响应开头（不含 cookie）
  heads: verdict.state === PROBE.EMPTY_SILENT ? { signed: String(signed.head || '').slice(0, 200) } : undefined,
})