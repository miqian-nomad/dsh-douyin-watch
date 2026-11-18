/**
 * lib/outbound.mjs —— 「发给谁」的解析 + 两个发送壳子（2026-11-18）
 *
 * 为什么单独放一份：真 bug —— 认领只写 owner.json，从来没同步到 cfg.owner，
 *   于是换个人装、走完引导认领成功，所有发出去的路径都拿空串当收件人。
 *   这里把「收件人怎么定」抽成一个纯函数，把 exec 变成可注入的，测试才能真正断言
 *   「传给 im-send 的 --to 不是空串」，而不是对着源码数行。
 *
 * 语义（别合并）：peer = 要盯的那条会话名；owner = 能命令它的人。
 *   这两个不是一个东西，这里只修「owner 没同步」，不动字段划分。
 */
import { execFile } from 'node:child_process'

/** 没认领主人时给用户看的话（一句人话，别让人去猜） */
export const NO_OWNER_MSG = '还没认领主人，先走引导第 4 步（点开你和它的私信会话，再点「读取当前会话」）'

/**
 * 收件人：cfg.owner 优先，其次 owner.json 里的 nick。
 * 两个都空 → 返回 ''（调用方必须报 NO_OWNER_MSG，别拿空串去开浏览器）。
 */
export function resolveOwnerName(owner, claimNick) {
  return String(owner || '').trim() || String(claimNick || '').trim()
}

/** 解析脚本输出的多行 JSON（im-send / card-share 都是整段 JSON，最后一行是 }） */
function parseOut(stdout) {
  const out = String(stdout || '')
  let parsed = null
  try { parsed = JSON.parse(out.trim()) } catch { try { parsed = JSON.parse(out.trim().split('\n').pop()) } catch { /* ignore */ } }
  return parsed
}

/**
 * 发一条文字私信（走 im-send.mjs）。行为与原来那句内联实现逐字一致：
 *   ok = 输入框清空 && 真回读；readback 单独带出去（唯一的送达证据）。
 * @param {object} o
 * @param {(name:string)=>{ [k:string]:any }} o.env   每次调用现取环境（DOUYIN_HOME 可能是改过的）
 * @param {() => string} o.peerName                   现取收件人（cfg 可能被设置页改过）
 * @param {Function} [o.exec]                         注入点（测试用；默认 child_process.execFile）
 */
export function makeSendChatText({ node, script, env, peerName, exec = execFile }) {
  return (text) => new Promise((resolve) => {
    const peer = String(peerName() || '').trim()
    if (!peer) return resolve({ ok: false, readback: false, to: '', error: NO_OWNER_MSG })
    exec(node, [script, '--to', peer, '--text', String(text)], {
      env: env(), timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      const parsed = parseOut(stdout)
      resolve({
        ok: !!(parsed && parsed.ok && parsed.sent),
        readback: !!(parsed && parsed.readback),
        to: String((parsed && parsed.to) || peer || ''),
        error: String((parsed && parsed.error) || (error && error.message) || ''),
      })
    })
  })
}

/**
 * 用抖音的「分享给朋友」把视频以卡片发给好友（card-share.mjs）。
 * card-share 的 ok 只是弱证据（点了按钮 / 看到成功信号），真到没到要靠 readbackCard 核对。
 */
export function makeShareCardTo({ node, script, env, peerName, exec = execFile }) {
  return (awemeId, peerOverride) => new Promise((resolve) => {
    const peer = String(peerOverride || '').trim() || String(peerName() || '').trim()
    if (!peer) return resolve({ ok: false, evidence: '', error: NO_OWNER_MSG })
    exec(node, [script, String(awemeId), peer], {
      env: env(), timeout: 90000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      const parsed = parseOut(stdout)
      resolve({
        ok: !!(parsed && parsed.ok),
        evidence: String((parsed && parsed.evidence) || ''),
        error: String((parsed && parsed.error) || (error && error.message) || ''),
      })
    })
  })
}
