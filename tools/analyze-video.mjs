#!/usr/bin/env node
/**
 * tools/analyze-video.mjs —— 一条命令跑完「视频 → 文案 + 画面联系表」
 * ============================================================================
 * 为什么要有这个：`douyin-video` 技能自己的三条取流路（router_data / yt-dlp / 它自带无登录浏览器）
 * 在这台机器上全被风控拒（2026-10-25 实测）。但我们手上有**已登录的 9334 浏览器**，
 * 视频页自己会去拉 douyinvod 的流 —— 截下来喂给技能就行（`--url` 显式入口）。
 *
 * 链路：media-urls.mjs 截直链 → python douyin_downloader.py --url … --json → 落盘
 *   产出：<out>/transcript.md、<out>/contact_sheet.jpg、<out>/subtitle_ocr.md
 *
 * 用法:
 *   node tools/analyze-video.mjs --aweme <id>
 *   node tools/analyze-video.mjs --link "https://www.douyin.com/video/<id>"
 *   node tools/analyze-video.mjs --video <本地文件>
 *   （默认不做硬字幕 OCR；需要逐句精确的字幕时加 --ocr，会多花几分钟 CPU）
 *
 * 输出一行 JSON：{ ok, aweme_id, title, duration_s, language, text_chars,
 *                  transcript, contact_sheet, subtitle_ocr, subtitle_count,
 *                  out_dir, preview, steps, error? }
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { homeDir } from '../lib/paths.mjs'
import { depsPython, depsRoot } from '../lib/deps-root.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const LINK = String(argOf('--link', '')).trim()
const AID = String(argOf('--aweme', '')).trim()
const TIMEOUT = Math.max(8, Number(argOf('--timeout', '25')) || 25)
const awemeOf = (s) => { const m = /\/video\/(\d{15,25})/.exec(String(s || '')); return m ? m[1] : '' }
const AWEME = AID || awemeOf(LINK)
const VIDEO_IN = String(argOf('--video', '')).trim()   // 本地文件入口（跳过取直链）
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME && !VIDEO_IN) { out({ ok: false, error: '缺 --aweme / --link（要含 /video/<id>）或 --video <本地文件>' }); process.exit(1) }

const run = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})


/** 转写脚本：① 插件自带，随 npm 包一起发（别人装上就有）
 *            ② 外面那套「抖音视频」技能（老用户兼容）
 *            ③ 环境变量指定
 * 找不到就明确报错，别猜着跑
 */
function scriptPath() {
  // ① 环境变量优先：明确指定了就用它（老用户换过自定义脚本的不能静默失效）
  const envSkill = String(process.env.DOUYIN_VIDEO_SKILL || '').trim()
  if (envSkill) {
    const p = join(envSkill, 'scripts', 'douyin_downloader.py')
    if (existsSync(p)) return p
    if (existsSync(join(envSkill, 'douyin_downloader.py'))) return join(envSkill, 'douyin_downloader.py')
  }
  // ② 插件自带（随 npm 包发布）
  const own = join(HERE, 'py', 'douyin_downloader.py')
  if (existsSync(own)) return own
  // ③ 外面那套「抖音视频」技能（老布局）
  const cands = [
    join(homedir(), '.agents', 'skills', 'douyin-video'),
    join(homedir(), '.dsh', 'skills', 'douyin-video'),
    join(depsRoot(), 'skills', 'douyin-video'),
  ].filter(Boolean)
  for (const d of cands) {
    const p = join(d, 'scripts', 'douyin_downloader.py')
    if (existsSync(p)) return p
  }
  return ''
}

/** Python：优先依赖目录里那个 3.11（脚本自举也指向它），否则退回 DSH 自带 / PATH 上的 python */
function pythonBin() {
  const cands = [
    String(process.env.DOUYIN_PYTHON || '').trim(),
    depsPython('DOUYIN_PYTHON'),
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

  // ① 截媒体直链（本地文件不用）
  let media = { ok: true, source: 'local_file' }
  if (!VIDEO_IN) {
    const nodeBin = process.execPath
    const mu = await run(nodeBin, [join(HERE, 'media-urls.mjs'), '--aweme', AWEME, '--timeout', String(TIMEOUT)], 90000)
    media = pickJSON(mu.stdout)
    steps.media_urls = media ? { ok: !!media.ok, br: media.video_br, dur: media.dur_text } : { ok: false }
    if (!media || !media.ok || !media.video) {
      out({
        ok: false, aweme_id: AWEME, steps,
        error: (media && media.error) || mu.stderr.slice(-200) || '没截到媒体直链',
        hint: '视频页可能没自动播放 / 被验证码拦住；先在有头窗口里把那条视频点开播放一下再重跑',
      })
      process.exit(1)
    }
  }

  // ② 跑转写脚本（下载 + ASR + 抽帧）
  const pyScript = scriptPath()
  if (!pyScript) {
    out({ ok: false, aweme_id: AWEME, steps, error: '找不到转写脚本：插件内 tools/py 缺失，可设 DOUYIN_VIDEO_SKILL 指向技能目录' })
    process.exit(1)
  }
  const py = pythonBin()
// 让 python 那边的「依赖根目录」和这里算的一致（它自己也会推，但别各算一遍）
process.env.DOUYIN_DEPS_ROOT = depsRoot()
  const outDir = join(homeDir(), 'douyin_out', VIDEO_IN ? 'local' : AWEME)
  const pageUrl = `https://www.douyin.com/video/${AWEME}`
  // 2026-11-05：硬字幕以前靠视觉模型看联系表来"读"，实测会编字
  //  （「诸葛亮也太啰嗦了」→「莽撞」）。OCR 能逐句准确、带时间轴地读出来，
  //  但代价是纯 CPU 逐帧识别，一条 2 分钟的视频要多花约 5 分钟满载。
  //  插件是给别人用的，别人机器不一定扛得住 → 默认关，需要精确字幕时加 --ocr 才跑。
  const ocrArgs = argv.includes('--ocr') ? ['--subtitle-ocr'] : []
  // 转写引擎：默认中文引擎（技能里那一套，纯 CPU、带标点）。--asr whisper 只在排障时用。
  const asrArgs = argv.includes('--asr-whisper') ? ['--asr', 'whisper'] : []
  const pargs = VIDEO_IN
    ? [pyScript, '--video', VIDEO_IN, '--out-dir', outDir, '--json', ...asrArgs, ...ocrArgs]
    : [
      pyScript,
      '--link', pageUrl,
      '--url', media.video,
      ...(media.audio ? ['--audio-url', media.audio] : []),
      '--out-dir', outDir,
      '--json',
      ...asrArgs,
      ...ocrArgs,
    ]
  const pr = await run(py, pargs, 8 * 60 * 1000)
  // 机器上压根没有 Python 时，spawn 会直接失败，别把 ENOENT 抛给用户看
  if (pr.err && /ENOENT|not found|不是内部或外部命令/i.test(String(pr.err.message || pr.err.code || ''))) {
    out({
      ok: false,
      aweme_id: AWEME,
      steps,
      error: '本机找不到 Python，视频分析要用它。装一个 Python 3.10 以上就行（装完重开 DSH），'
        + '或者设 DOUYIN_PYTHON 指向已有的 python.exe。',
    })
    process.exit(1)
  }
  const res = pickJSON(pr.stdout)
  // 2026-11-17：转写脚本崩了 / 被超时打断时，stdout 里没有 JSON → res 为空。
  //   以前这里没兜住，最后会在 Number(res.frame_count) 抛
  //   「Cannot read properties of null (reading 'frame_count')」——真正的错误
  //   （引擎没装好、pip 超时、Python 缺依赖）全在 stderr 里，被丢掉了。
  if (!res) {
    const tail = String(pr.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ')
    const timedOut = !!(pr.err && (pr.err.killed || pr.err.code === 'ETIMEDOUT'
      || /timeout|timed out|ETIMEDOUT/i.test(String(pr.err.message || ''))))
    out({
      ok: false,
      aweme_id: AWEME,
      steps,
      exit: pr.err ? pr.err.code : undefined,
      error: (timedOut
        ? '转写脚本跑超时被打断了（8 分钟）。第一次用要联网下载转写引擎和模型，网慢就会超；'
          + '过一会儿再试一次，装好之后就不用再下了。'
        : '转写脚本没跑出结果（多半是转写引擎还没装好）。')
        + (tail ? ' 细节：' + tail.slice(0, 300) : ' 这次没拿到细节输出。'),
    })
    process.exit(1)
  }
  steps.asr = {
    ok: true,
    engine: res.asr_engine || res.asr_device || '',
    language: res.language,
    chars: String(res.text || '').length,
    frames: res.frame_count,
  }
  if (res.subtitle_ocr) {
    steps.ocr = {
      ok: !!res.subtitle_ocr.ok,
      segments: res.subtitle_ocr.segment_count ?? 0,
      frames: res.subtitle_ocr.frames_ocr,
      elapsed: res.subtitle_ocr.elapsed,
      error: res.subtitle_ocr.error,
    }
  }

  // ⚠️ 2026-10-25 修：**「视频没人声」≠「ASR 出故障」**。
  //   抖音上很多视频只有 BGM / 只有表情包字幕，whisper 转出来就是空字符串。
  //   以前 `!res.text` 直接判失败 —— 结果① 语义错（把"没人说话"报成"ASR 没出结果"），
  //   ② 已经抽好的帧和联系表全白扔（调用方拿不到 contact_sheet 路径）。
  //   现在只要转写脚本正常返回，就算成功；正文为空只标 no_speech，画面路线照常可用。
  //   （res 为空的情况上面已经提前 exit 了，这里不用再判一次。）

  const text = String(res.text || '')
  const frames = Number(res.frame_count) || 0
  const noSpeech = text.trim().length === 0
  const transcript = res.transcript || join(outDir, 'transcript.md')
  const sheet = res.contact_sheet || join(outDir, 'contact_sheet.jpg')
  // 硬字幕 OCR 结果：ASR 是"听"到的，这份是"看"到的，两条线互为校验
  const subOcr = res.subtitle_ocr || null
  const subPath = res.subtitle_ocr_path || null
  const subCount = Number((subOcr && subOcr.segment_count) || 0)
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
    // 画面硬字幕（OCR）：需要准确字幕、或者 ASR 听岔时以这份为准
    subtitle_ocr: subPath || undefined,
    subtitle_count: subCount || undefined,
    // 没人声：别当成失败，但也别假装有文案 —— 明确标出来，让调用方改走画面路线
    no_speech: noSpeech || undefined,
    hint: noSpeech
      ? (subCount > 0
        ? `没检测到人声，但画面有 ${subCount} 句硬字幕：读 ${subPath}`
        : (frames > 0
          ? `没检测到人声（大概只有 BGM / 字幕表情），画面已抽成 ${frames} 帧：看 contact_sheet.jpg`
          : '没检测到人声，而且这次也没抽到帧'))
      : undefined,
    // 只回前 160 字，正文让调用方读 transcript.md（省 token）
    preview: text.replace(/\s+/g, ' ').slice(0, 160),
    steps,
  })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
}