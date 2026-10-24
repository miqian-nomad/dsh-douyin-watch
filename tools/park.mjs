#!/usr/bin/env node
/**
 * tools/park.mjs —— 把 9334 Chrome 的页面导航走（默认 about:blank）。
 * 关掉哨兵时用：页面停在 /chat 的会话上时，抖音前端会自己回执「已读」；导航走它就不再回执。
 * 工具脚本各自带「不在该在的页面就自己导航过去」的逻辑，所以下次调用会自愈（只多几秒）。
 * 用法: node tools/park.mjs [url]
 * 输出: { ok, url }
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const url = process.argv[2] || 'about:blank'

try {
  const c = await openPage()
  await c.send('Page.navigate', { url })
  c.close()
  await sleep(200)
  console.log(JSON.stringify({ ok: true, url }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
}
