/**
 * lib/chrome.mjs —— 插件里**唯一**的浏览器入口
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，9 个脚本各自写一份 `C:\Program Files\Google\Chrome\...` +
 *   各自的 `ensureChrome()` + 各自的 `new WebSocket(CDP)`。
 *   换台设备（Chrome 装在别的盘 / 只有 Edge）就全部静默失效。
 *
 * 这里统一做四件事：
 *   ① 找浏览器：DOUYIN_BROWSER → Chrome → Edge → Chromium（Windows / macOS / Linux 全试）
 *   ② 找端口：runtime.json 里记着就用它，否则从 9334 往上找空闲的（被占就换，别让用户改代码）
 *   ③ 起无头 Chrome（`--headless=new`，屏幕上无窗口），已起就复用
 *   ④ 连 CDP，给一个带 send/ev/close 的小客户端
 *
 * ⚠️ 规矩：`tools/` 下**任何**脚本都不许自己 `new WebSocket` 或写死 chrome.exe。
 * ============================================================================
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { homeDir, profileDir, readRuntime, writeRuntime } from './paths.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────── ⓪ 浏览器模式（无头 / 有头）───────────────────── */
// 为什么要有：抖音的滑块验证只有"人手动划"能过。所以提供一个开关：
//   有头 = 屏幕上出现真窗口，人去过验证；无头 = 平时跑的样子。
// 模式落在 $HOME/browser-mode.json，`ensureChrome` 每次起浏览器都读它 ——
// 这样就算浏览器崩了被自动拉起，也还是你选的那个模式。
export const BROWSER_MODE_FILE = () => join(homeDir(), 'browser-mode.json')

export function readBrowserMode() {
  try {
    const j = JSON.parse(readFileSync(BROWSER_MODE_FILE(), 'utf8'))
    return j && j.mode === 'headed' ? 'headed' : 'headless'
  } catch { return 'headless' }
}

export function writeBrowserMode(mode) {
  const m = mode === 'headed' ? 'headed' : 'headless'
  try {
    writeFileSync(BROWSER_MODE_FILE(), JSON.stringify({ mode: m, at: new Date().toISOString() }, null, 1))
    return m
  } catch { return readBrowserMode() }
}

/* ───────────────────────── ① 找浏览器 ───────────────────────── */

const CANDIDATES = () => {
  const out = []
  const env = String(process.env.DOUYIN_BROWSER || '').trim()
  if (env) out.push(env)                                  // ① 用户显式指定，最高优先
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files', 'D:\\Program Files (x86)']
    for (const r of roots.filter(Boolean)) {
      out.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      out.push(join(r, 'Chromium', 'Application', 'chrome.exe'))
    }
    // 免安装版常见位置
    for (const r of roots.filter(Boolean)) out.push(join(r, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return out
}

/** 找得到就返回绝对路径，找不到返回 ''（不抛，让 doctor 去报） */
export function findBrowser() {
  for (const p of CANDIDATES()) {
    try { if (p && existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return ''
}

/* ───────────────────────── ② 找端口 ───────────────────────── */

const portFree = (port) => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(port, '127.0.0.1')
})

const cdpAlive = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
}

/** 上一次挑端口是怎么决定的（doctor / 排查用；不含任何隐私） */
export let lastPortDecision = {}

/**
 * 决定用哪个端口：
 *   ⓪ 环境变量 IM_CDP_PORT 优先（**临时/测试场景必须用它**，见下面 ③ 的坑）
 *   ① runtime.json 里记着的端口，活着 **且 profile 对得上** ⇒ 复用
 *   ② 扫 9334–9373：活着 **且 profile 对得上** ⇒ 复用
 *   ③ 都不行才找空闲端口起新的
 *
 * ⚠️ 2026-11-15 真踩过的坑（务必别再退化）：
 *   老版本 ② 只判断"这个端口上有 CDP 活着"就复用，**不看 profile**。
 *   于是用临时家目录跑验证时，复用了主实例的 9334 —— 把主人正在用的浏览器关了，
 *   还拿临时 profile 在同一个端口起了一个新实例（登录态看着像"没了"）。
 *   现在复用**必须**先问出对方浏览器的 --user-data-dir，跟本次要用的 profile 比；
 *   不一致 / 问不出来（且没有 pid 兜底）一律不复用，改用下一个空闲端口。
 *   `IM_CDP_PORT` 仍然保留，脚本/测试想完全确定地用一个自己的端口就用它。
 */
export async function pickPort() {
  // 把「为什么没复用某个端口」也记下来 —— doctor 和排查时要能看到依据，别只给一个结果
  const decision = { skipped: [] }
  const done = (o) => { lastPortDecision = { ...decision, ...o }; return o.port }

  const forced = Number(process.env.IM_CDP_PORT || 0)
  if (forced) return done({ forced: true, port: forced, reused: 'forced' })

  const mine = profileDir()
  const rt = readRuntime()

  const remembered = Number(rt.cdpPort || 0)
  if (remembered && await cdpAlive(remembered)) {
    const dir = await profileOfPort(remembered)
    if (sameProfile(dir, mine)) return done({ port: remembered, reused: 'remembered' })
    // profile 问不出来，但我们上次亲手起的那个浏览器进程还活着 ⇒ 只能是它（否则同 profile 也起不了第二个）
    if (!dir && Number(rt.browserPid) > 0 && pidAlive(rt.browserPid)) {
      return done({ port: remembered, reused: 'remembered+pid', profileUnverified: true })
    }
    decision.skipped.push({ port: remembered, why: dir ? 'foreign-profile' : 'unknown-profile' })
  }

  // ② 扫一遍：**只复用 profile 对得上的**；别的实例哪怕占着范围里的端口，也一个都不碰
  for (let p = 9334; p < 9334 + 40; p++) {
    if (p === remembered) continue
    if (!(await cdpAlive(p))) continue
    const dir = await profileOfPort(p)
    if (!sameProfile(dir, mine)) { decision.skipped.push({ port: p, why: dir ? 'foreign-profile' : 'unknown-profile' }); continue }
    writeRuntime({ cdpPort: p })
    return done({ port: p, reused: 'scanned' })
  }

  // ③ 没有活的，找一个空闲端口起新的
  for (let p = 9334; p < 9334 + 40; p++) {
    if (await portFree(p)) return done({ port: p, reused: 'fresh' })
  }
  throw new Error('9334–9373 全被占用了，找不到空闲的调试端口')
}

/* ─────────────── ②′ 问「这个端口上的浏览器用的哪个 profile」 ─────────────── */

/** 进程是不是还活着（只用于「profile 问不出来时」的兜底判断） */
const pidAlive = (pid) => {
  const n = Number(pid) || 0
  if (!n) return false
  try { process.kill(n, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

/**
 * 两个 profile 路径是不是同一个。
 * 归一化：去引号、分隔符统一成 \、去结尾斜杠、转小写（Windows 路径大小写不敏感）。
 */
export function sameProfile(a, b) {
  const norm = (v) => String(v || '').trim()
    .replace(/^"+|"+$/g, '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
  const x = norm(a)
  const y = norm(b)
  return !!x && x === y
}

/** 从一整条命令行里取某个参数的值：`--name=v` / `--name="v"` */
export function cmdArg(cmd, name) {
  const m = new RegExp('--' + name + '=(?:"([^"]*)"|(\\S+))').exec(String(cmd || ''))
  return m ? String(m[1] || m[2] || '') : ''
}

// 进程列表缓存 3 秒：一次 pickPort 会连着问好几个端口，别每个端口都去拉一遍（Windows 上约 1 秒一次）
let procCache = { at: 0, rows: [] }

/** 列出「带 remote-debugging-port 的浏览器进程」：{ pid, cmd }。查不到返回空数组，不抛。 */
async function browserProcesses() {
  if (Date.now() - procCache.at < 3000) return procCache.rows
  let rows = []
  try {
    if (process.platform === 'win32') {
      // 用 -EncodedCommand 传脚本，免得跟 cmd/pwsh 的引号规则打架（踩过一次：$_ 被外层吃掉）
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$rows = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='chromium.exe'\"",
        "foreach ($r in $rows) { if ($r.CommandLine -and $r.CommandLine -match 'remote-debugging-port=') { $r.ProcessId.ToString() + '|' + $r.CommandLine } }",
      ].join('; ')
      const b64 = Buffer.from(script, 'utf16le').toString('base64')
      const stdout = await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
          { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          (err, out) => resolve(String(out || '')))
      })
      rows = stdout.split(/\r?\n/).map((line) => {
        const i = line.indexOf('|')
        if (i < 4) return null
        return { pid: Number(line.slice(0, i)) || 0, cmd: line.slice(i + 1) }
      }).filter(Boolean)
    } else if (process.platform === 'linux') {
      const pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
      for (const pid of pids) {
        try {
          const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          if (!raw.includes('remote-debugging-port=')) continue
          rows.push({ pid: Number(pid), cmd: raw.replace(/\0/g, ' ') })
        } catch { /* 进程刚退出 */ }
      }
    } else {
      const stdout = await new Promise((resolve) => {
        execFile('ps', ['-Ao', 'pid=,args='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
          (err, out) => resolve(String(out || '')))
      })
      rows = stdout.split(/\r?\n/).filter((l) => l.includes('remote-debugging-port=')).map((line) => {
        const t = line.trim()
        const sp = t.indexOf(' ')
        return { pid: Number(t.slice(0, sp)) || 0, cmd: sp > 0 ? t.slice(sp + 1) : '' }
      }).filter((r) => r.cmd)
    }
  } catch { rows = [] }
  procCache = { at: Date.now(), rows }
  return rows
}

/**
 * 这个端口上的浏览器的 --user-data-dir。
 * 返回 '' = 问不出来（端口上没浏览器 / 系统查不到进程）。
 */
export async function profileOfPort(port) {
  const want = Number(port) || 0
  if (!want) return ''
  const rows = await browserProcesses()
  for (const r of rows) {
    if (Number(cmdArg(r.cmd, 'remote-debugging-port')) !== want) continue
    const dir = cmdArg(r.cmd, 'user-data-dir')
    if (dir) return dir
  }
  return ''
}

/* ───────────────────────── ③ 起无头 Chrome ───────────────────────── */

/**
 * 保证有一个可用的无头 Chrome。
 * @returns {{port:number, status:'reused'|'launched', browser:string}}
 */
export async function ensureChrome({ url = 'https://www.douyin.com/' } = {}) {
  const port = await pickPort()
  if (await cdpAlive(port)) {
    writeRuntime({ cdpPort: port })
    return { port, status: 'reused', browser: readRuntime().browser || '' }
  }

  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      '找不到可用的浏览器。装一个 Chrome / Edge / Chromium 就行；'
      + '装在特殊位置的话，把完整路径写进环境变量 DOUYIN_BROWSER。',
    )
  }

  const profile = profileDir()
  mkdirSync(profile, { recursive: true })

  const mode = readBrowserMode()
  const headless = mode !== 'headed'

  const p = spawn(browser, [
    // 有头模式下**不能**带 --headless，否则窗口不可见、人没法划滑块
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', '--lang=zh-CN',
    '--disable-blink-features=AutomationControlled',
    // 2026-11-15：Chrome 会对它不认识的启动参数在窗口顶部画一条黄条
    //   （「您使用的是不受支持的命令行标记：--disable-blink-features=…」）。
    //   --test-type 是 Chrome 自带的开关，专门关掉这条提示，自动化工具都这么用。
    '--test-type',
    '--disable-features=IsolateOrigins,site-per-process',
    url,
  ], { detached: true, stdio: 'ignore' })
  p.unref()

  for (let i = 0; i < 60; i++) {
    if (await cdpAlive(port)) {
      // browserPid：只用于「profile 问不出来」时兜底（见 pickPort 里的说明）
      writeRuntime({ cdpPort: port, browser, browserPid: p.pid || 0 })
      return { port, status: 'launched', browser, mode }
    }
    await sleep(500)
  }
  throw new Error(`${headless ? '无头' : '有头'} Chrome 起来了但 ${port} 上连不上 CDP（60 秒超时）`)
}

/* ───────────────────────── ④ CDP 客户端 ───────────────────────── */

/**
 * 连上页面，返回 { send, ev, close, port }。
 * `ev(expr)` 在页面里求值并返回值 —— 大部分脚本只用得到这个。
 */
export async function connectPage(port) {
  const usePort = Number(port) || (await pickPort())
  const list = await (await fetch(`http://127.0.0.1:${usePort}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('douyin'))
    || list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有可用的 page target（Chrome 起来了吗？）')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  const subs = new Map()          // 事件订阅：method -> Set(handler)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('连不上 CDP WebSocket')), { once: true })
  })
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    // 事件推送（如 Network.requestWillBeSent）：转给订阅者
    if (m.method && subs.size) {
      const set = subs.get(m.method)
      if (set) for (const fn of set) { try { fn(m.params) } catch { /* 订阅方自己的错，别拖垮连接 */ } }
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pend.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')

  // 2026-11-13：把「HeadlessChrome」这一层也盖住。
  //   以前只在 comment-api 的写接口前临时设过 UA，**文档加载本身**还是 HeadlessChrome ——
  //   抖音据此在页面里挂一个 verifycenter 滑块层（内容照显示，但评论/私信接口被它挡）。
  //   这里在 attach 之后、任何导航之前设好，后面 openPage({url}) 的导航就用普通 Chrome UA。
  //   ⚠️ 只覆盖**当前 target**（Network.setUserAgentOverride 是 target 级），
  //      不改进程级启动参数、不需要重启浏览器；删掉这段即回滚。
  try {
    const uaRes = await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
    const rawUa = String((uaRes && uaRes.result && uaRes.result.value) || '')
    if (/HeadlessChrome/i.test(rawUa)) {
      const realUA = rawUa.replace(/HeadlessChrome/g, 'Chrome').replace(/\sHeadless/g, '')
      await send('Network.enable')
      await send('Network.setUserAgentOverride', {
        userAgent: realUA,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Win32',
      })
    }
  } catch { /* 盖不上就照旧，别让连接失败 */ }

  // 反自动化检测（stealth）：让无头 Chrome 的指纹更接近真实浏览器，
  // 避免抖音弹「验证码中间页」滑块（只该弹二次验证短信，那才是正常的）。
  try {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
        const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
        if (originalQuery) {
          window.navigator.permissions.query = (p) => (
            p && p.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : originalQuery(p)
          );
        }
      `,
    })
  } catch { /* 反检测脚本注入失败不致命 */ }

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 240))
    return r.result?.value
  }

  /**
   * 订阅 CDP 事件（只读用途，比如截 Network.requestWillBeSent 里的媒体直链）。
   * 返回取消订阅的函数。用完记得 off，别让订阅跟着连接活到下一轮。
   */
  const on = (method, fn) => {
    if (!subs.has(method)) subs.set(method, new Set())
    subs.get(method).add(fn)
    return () => { const s = subs.get(method); if (s) s.delete(fn) }
  }

  return {
    send, ev, on, port: usePort,
    close: () => { try { subs.clear(); ws.close() } catch { /* 已经关了 */ } },
  }
}

/** 一步到位：确保 Chrome + 连上页面。脚本里最常用这个。 */
export async function openPage(opts = {}) {
  const { port, status, browser } = await ensureChrome(opts)
  const page = await connectPage(port)
  return { ...page, status, browser }
}

/* ───────────────────────── 体检（给 doctor 用） ───────────────────────── */

export async function chromeDoctor() {
  const browser = findBrowser()
  const remembered = Number(readRuntime().cdpPort || 0)
  const alive = remembered ? await cdpAlive(remembered) : false
  const port = alive ? remembered : await pickPort().catch(() => 0)
  return {
    browser: browser || '',
    browser_found: Boolean(browser),
    cdp_port: port,
    cdp_alive: alive,
    profile: profileDir(),
    env_override: String(process.env.DOUYIN_BROWSER || ''),
  }
}

export { homedir }
