/**
 * 回归测试：视频分析的「静默失败」和「音轨分离」，以及 cookies 文件不泄内容
 *
 * 背景（2026-11-18 实测，凤凰网《旅途》7703929158044290319）：
 *   ① 这条作品 `play_addr` 只有**画面轨**，人声在 `video.bit_rate_audio[].audio_meta.url_list`；
 *      不给音轨时 py 抽音频 ffmpeg rc=-22，**但它回的是 {"ok":false,...}** ——
 *      analyze-video 以前不看 res.ok，把这次失败报成「没检测到人声，也没抽到帧」的 ok:true。
 *   ② `--cookies` 指过来的如果不是 Netscape 格式，yt-dlp 会把**整个文件内容**
 *      打到日志里（连 sessionid 一起）—— 等于把账号所有权泄了。
 *
 * 这几条钉住：
 *   1) 脚本自己说 ok:false 必须当失败
 *   2) 抽音频失败时，用详情接口给的独立音轨重试一次
 *   3) 一帧没抽、一个字没有 = 失败（不是"没人说话"）
 *   4) media-urls 必须把 audio_dash 单独带出来，别和 music 混
 *   5) cookies 先过格式闸，拒绝时不许回显内容
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ANALYZE = readFileSync(join(ROOT, 'tools', 'analyze-video.mjs'), 'utf8')
const MEDIA = readFileSync(join(ROOT, 'tools', 'media-urls.mjs'), 'utf8')
const PY = readFileSync(join(ROOT, 'tools', 'py', 'douyin_downloader.py'), 'utf8')

test('analyze-video：脚本回 ok:false 必须当失败（不许静默成功）', () => {
  assert.match(ANALYZE, /if \(res\.ok === false\) \{/, '没有判 res.ok === false')
  const i = ANALYZE.indexOf('if (res.ok === false)')
  const block = ANALYZE.slice(i, i + 600)
  assert.match(block, /ok: false/, '还要往外报 ok:false')
  assert.match(block, /process\.exit\(1\)/, '要真的失败退出')
  // 以前那句注释是把「没人声」当成功的理由，别又退回去
  assert.equal(/text_chars: text\.length/.test(ANALYZE), true, '成功分支还在（别把整段删了）')
})

test('analyze-video：抽音频失败时用独立音轨重试一次', () => {
  assert.match(ANALYZE, /audioExtractFailed/, '没有识别「提取音频失败」')
  assert.match(ANALYZE, /提取音频失败\|ffmpeg/, '判据里要认 ffmpeg 失败')
  assert.match(ANALYZE, /retry_with_dash_audio/, '没记「用了独立音轨重试」')
  assert.match(ANALYZE, /buildArgs\(dashAudio\)/, '没有拿 audio_dash 重跑')
  assert.match(ANALYZE, /if \(!VIDEO_IN && dashAudio/, '本地文件入口不该走这条重试')
})

test('analyze-video：0 帧 + 0 字 = 失败，不是「没人说话」', () => {
  assert.match(ANALYZE, /if \(frames === 0 && noSpeech\)/, '缺 0 帧守卫')
  const i = ANALYZE.indexOf('if (frames === 0 && noSpeech)')
  assert.match(ANALYZE.slice(i, i + 500), /ok: false/, '0 帧要报失败')
})

test('media-urls：独立音轨从 bit_rate_audio 里取，并且和 music 分开存', () => {
  assert.match(MEDIA, /bit_rate_audio/, '没有读 bit_rate_audio')
  assert.match(MEDIA, /audio_dash/, '没有 audio_dash 字段')
  assert.match(MEDIA, /audio: music\[0\] \|\| ''/, 'audio 还是 music（这条没变，别动）')
  // 两种 url_list 形态都要认：数组 / {backup_url, fallback_url}
  assert.match(MEDIA, /backup_url \|\| au\.fallback_url/, '没兼容 backup_url/fallback_url 形态')
})

test('cookies：先判格式，非 Netscape 的原始串会转成 Netscape', () => {
  assert.match(PY, /def _looks_netscape_cookie_file/, '缺格式判定')
  assert.match(PY, /def _looks_raw_cookie_header/, '缺原始 cookie 串判定')
  assert.match(PY, /def _cookies_to_netscape/, '缺转换函数')
  assert.match(PY, /Netscape HTTP Cookie File/, '转换后要写表头')
})

test('cookies：拒绝时不许回显文件内容', () => {
  const i = PY.indexOf('def _cookies_to_netscape')
  const block = PY.slice(i, i + 2200)
  // 错误消息里不许拼 text / 内容变量
  assert.equal(/ResolveError\([^)]*text/.test(block), false, '错误消息里拼了文件内容')
  assert.match(block, /没有把文件内容打印出来/, '要给一句「没回显」的说明')
})

test('cookies：main 里在 resolve 之前就过闸', () => {
  const iMain = PY.indexOf('def main(')
  const iCheck = PY.indexOf("if args.cookies:", iMain)
  const iResolve = PY.indexOf('p.resolve(args.link', iMain)
  assert.ok(iCheck > 0, 'main 里没有 cookies 闸')
  assert.ok(iResolve > 0, '找不到 resolve 调用')
  assert.ok(iCheck < iResolve, 'cookies 闸必须在 resolve 之前')
  // 临时文件用完要删
  assert.match(PY, /atexit\.register\(_cleanup_temp_cookies\)/, '临时 cookie 文件没安排清理')
})
