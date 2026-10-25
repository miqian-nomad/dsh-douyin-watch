#!/usr/bin/env node
/**
 * tools/analyze-video.mjs —— 一条命令跑完「视频 → 文案 + 画面联系表」
 * ============================================================================
 * 为什么要有这个：`douyin-video` 技能自己的三条取流路（router_data / yt-dlp / 它自带无登录浏览器）
 * 在这台机器上全被风控拒（2026-10-25 实测）。但我们手上有**已登录的 9334 浏览器**，
 * 视频页自己会去拉 douyinvod 的流 —— 截下来喂给技能就行（`--url` 显式入口）。
 *
 * 链路：media-urls.mjs 截直链 → python douyin_downloader.py --url … --json → 落盘
 *   产出：<out>/transcript.md、<out>/contact_sheet.jpg
 *
 * 用法:
 *   node tools/analyze-video.mjs --aweme <id>
 *   node tools/analyze-video.mjs --link "https://www.douyin.com/video/<id>"
 *
 * 输出一行 JSON：{ ok, aweme_id, title, duration_s, language, text_chars,
 *                  transcript, contact_sheet, out_dir, preview, steps, error? }
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { homeDir } from '../lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const LINK = String(argOf('--link', '')).trim()
const AID = String(argOf('--aweme', '')).trim()
const TIMEOUT = Math.max(8, Number(argOf('--timeout', '25')) || 25)
const awemeOf = (s) => { const m = /\/video\/(\d{15,25})/.exec(String(s || '')); return m ? m[1] : '' }
const AWEME = AID || awemeOf(LINK)
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme 或 --link（要含 /video/<id>）' }); process.exit(1) }

const run = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})

/** 技能目录：环境变量 > 常见位置；找不到就明确报错，别猜着跑 */
function skillDir() {
  const cands = [
    String(process.env.DOUYIN_VIDEO_SKILL || '').trim(),
    join(homedir(), '.agents', 'skills', 'douyin-video'),
    join(homedir(), '.dsh', 'skills', 'douyin-video'),
    'D:\\dsh-plugins\\_deps\\skills\\douyin-video',
  ].filter(Boolean)
  for (const d of cands) if (existsSync(join(d, 'scripts', 'douyin_downloader.py'))) return d
  return ''
}

/** Python：优先 _deps 里那个 3.11（技能自举也指向它），否则退回 PATH 上的 python */
function pythonBin() {
  const cands = [
    String(process.env.DOUYIN_PYTHON || '').trim(),
    'D:\\dsh-plugins\\_deps\\python311\\cpython-3.11-windows-x86_64-none\\python.exe',
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ].filter(Boolean)
  for (const p of cands) if (existsSync(p)) return p
  return 'python'
}

/**
 * 从混合输出里挖出 JSON：技能是 **pretty-print**（多行）输出，前面还夹着日志，
 * 所以按"顶格的 `{` 开始、一直到结尾"逐段试解析（2026-10-25 踩过：按行解析直接失败）。
 */
const pickJSON = (s) => {
  const lines = String(s || '').split(/\r?\n/)
  const starts = []
  lines.forEach((l, i) => { if (l === '{') starts.push(i) })
  for (const i of starts) {
    try { return JSON.parse(lines.slice(i).join('\n')) } catch { /* 试下一段 */ }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (l.startsWith('{')) { try { return JSON.parse(l) } catch { /* 继续 */ } }
  }
  return null
}

try {
  const steps = {}

  // ① 截媒体直链
  const nodeBin = process.execPath
  const mu = await run(nodeBin, [join(HERE, 'media-urls.mjs'), '--aweme', AWEME, '--timeout', String(TIMEOUT)], 90000)
  const media = pickJSON(mu.stdout)
  steps.media_urls = media ? { ok: !!media.ok, br: media.video_br, dur: media.dur_text } : { ok: false }
  if (!media || !media.ok || !media.video) {
    out({
      ok: false, aweme_id: AWEME, steps,
      error: (media && media.error) || mu.stderr.slice(-200) || '没截到媒体直链',
      hint: '视频页可能没自动播放 / 被验证码拦住；先在有头窗口里把那条视频点开播放一下再重跑',
    })
    process.exit(1)
  }

  // ② 跑技能的下载+ASR+抽帧
  const sd = skillDir()
  if (!sd) {
    out({ ok: false, aweme_id: AWEME, steps, error: '找不到 douyin-video 技能目录（可设 DOUYIN_VIDEO_SKILL 指过去）' })
    process.exit(1)
  }
  const py = pythonBin()
  const outDir = join(homeDir(), 'douyin_out', AWEME)
  const pageUrl = `https://www.douyin.com/video/${AWEME}`
  const pargs = [
    join(sd, 'scripts', 'douyin_downloader.py'),
    '--link', pageUrl,
    '--url', media.video,
    ...(media.audio ? ['--audio-url', media.audio] : []),
    '--out-dir', outDir,
    '--json',
  ]
  const pr = await run(py, pargs, 8 * 60 * 1000)
  const res = pickJSON(pr.stdout)
  steps.asr = res ? { ok: true, language: res.language, chars: String(res.text || '').length, frames: res.frame_count } : { ok: false }
  if (!res || !res.text) {
    out({
      ok: false, aweme_id: AWEME, steps,
      error: (res && (res.error || res.hint)) || pr.stderr.slice(-260) || 'ASR 没出结果',
      exit: pr.err ? pr.err.code : undefined,
    })
    process.exit(1)
  }

  const text = String(res.text || '')
  const transcript = res.transcript || join(outDir, 'transcript.md')
  const sheet = res.contact_sheet || join(outDir, 'contact_sheet.jpg')
  // 走 --url 显式入口时技能拿不到作品标题，会写成 direct_url/local_url；
  // 这时用详情接口给的 title 顶上（唤醒消息里那条卡片的文案也是同一句）
  const rawTitle = String(res.title || '')
  const title = /^(direct_url|local_url)$/i.test(rawTitle) ? String(media.title || rawTitle) : rawTitle
  out({
    ok: true,
    aweme_id: AWEME,
    title,
    author: media.author || '',
    duration_s: res.duration_s,
    language: res.language,
    text_chars: text.length,
    frames: res.frame_count,
    asr_device: res.asr_device,
    source: media.source,
    transcript,
    contact_sheet: sheet,
    out_dir: res.out_dir || outDir,
    // 只回前 160 字，正文让调用方读 transcript.md（省 token）
    preview: text.replace(/\s+/g, ' ').slice(0, 160),
    steps,
  })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
}