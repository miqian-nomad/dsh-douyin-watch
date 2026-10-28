/**
 * lib/outbound-guard.mjs —— 公开评论发出去之前的三道闸（去重 / 频次 / 话术）
 * ============================================================================
 * 为什么要有：2026-10-25 对着 [narikujrd/douyin-comment-automation] 的
 * `reply-ledger.mjs` + `outbound-rules.mjs` 想到的三处缺口 ——
 *   ① 同一句评论对同一个视频/同一个人可以无感重复发（平台判定刷评）；
 *   ② 没有频次上限，agent 一口气能连发十几条；
 *   ③ 话术里可以夹带站外引导（网址/手机号/微信/二维码），公开评论区这是最容易被判营销的。
 *
 * 边界（写死）：
 *   · 只做**本地预检 + 记账**，不联网、不改页面；
 *   · 拦下来的每条都要给出**人能看懂的 reason**，别静默丢；
 *   · 记账只在**确认发出（拿到 cid）之后**写，避免"失败了也占额度"。
 * ============================================================================
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { homeDir } from './paths.mjs'

/** 公开评论区里不该出现的东西（正则 + 人话理由） */
export const OUTBOUND_PATTERNS = [
  { re: /https?:\/\//i, why: '带网址（http/https）' },
  { re: /\bwww\./i, why: '带网址（www.）' },
  { re: /\b[a-z0-9][a-z0-9-]{0,40}\.(com|cn|net|org|io|me|top|xyz|cc|tv|app)\b/i, why: '带域名' },
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/, why: '带手机号' },
  { re: /(微信|weixin|wechat|wx\s*[:：]|vx\s*[:：]|v信|加我|私聊|私我|扣扣|qq\s*[:：]|邮箱|e-?mail|二维码|扫码)/i, why: '引导站外联系方式' },
]

/**
 * 台账放哪个家目录。
 * ⚠️ 2026-10-25：这里原来只认 `homeDir()`（= 环境变量 DOUYIN_HOME，没设就回落 ~/.dsh/douyin-duty），
 *    而插件跑脚本时给子进程设的是 `DOUYIN_HOME = cfg.home`。两边不一致 →
 *    台账写到 ~/.dsh/douyin-duty、作品清单写到 D:\douyin-duty，**家目录分裂**。
 *    现在插件启动时调 setGuardHome(cfg.home) 显式对齐。
 */
let HOME_OVERRIDE = ''
export function setGuardHome(dir) { HOME_OVERRIDE = String(dir || '').trim() }
export const guardFile = () => join(HOME_OVERRIDE || homeDir(), 'comment-ledger.jsonl')

const normText = (s) => String(s || '')
  .replace(/[\u200b\s]+/g, '')
  .replace(/[，。！？、,.!?~～…—\-"'"'（）()【】\[\]]/g, '')
  .toLowerCase()

const ledgerKey = (aweme, target, text) => `${aweme || ''}|${normText(target)}|${normText(text)}`

function readLedger(limit = 4000) {
  const f = guardFile()
  if (!existsSync(f)) return []
  let raw = ''
  try { raw = readFileSync(f, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过，别让整本台账炸掉 */ }
  }
  return out.slice(-limit)
}

/**
 * 发公开评论前的预检。
 * @param {{text:string, aweme:string, target?:string, maxChars?:number,
 *          bannedWords?:string|string[], perHour?:number, perDay?:number,
 *          dedupeHours?:number}} o
 * @returns {{ok:boolean, code?:string, detail?:string}}
 */
export function checkPublicComment(o = {}) {
  const text = String(o.text || '').trim()
  const aweme = String(o.aweme || '').trim()
  const target = String(o.target || '').trim()

  if (!text) return { ok: false, code: 'empty', detail: '评论正文是空的' }

  // ① 长度
  const maxChars = Number(o.maxChars) > 0 ? Number(o.maxChars) : 60
  if (text.length > maxChars) {
    return { ok: false, code: 'length', detail: `太长（${text.length} 字 > 上限 ${maxChars}）：公开评论越短越安全` }
  }

  // ② 禁止词（设置页里填的，逗号/顿号分隔）
  const banned = (Array.isArray(o.bannedWords) ? o.bannedWords : String(o.bannedWords || '').split(/[,，、\s]+/))
    .map((w) => String(w || '').trim()).filter(Boolean)
  const hitWord = banned.find((w) => text.includes(w))
  if (hitWord) return { ok: false, code: 'banned', detail: `命中禁止词「${hitWord}」` }

  // ③ 站外引导
  for (const p of OUTBOUND_PATTERNS) {
    if (p.re.test(text)) return { ok: false, code: 'pattern', detail: `公开评论里不能${p.why}` }
  }

  // ④ 去重 + 频次（读本地台账）
  const now = Date.now()
  const rows = readLedger()
  const dedupeMs = (Number(o.dedupeHours) > 0 ? Number(o.dedupeHours) : 168) * 3600e3
  const key = ledgerKey(aweme, target, text)
  const dup = rows.find((r) => r && r.key === key && now - Number(r.at || 0) < dedupeMs)
  if (dup) {
    const when = new Date(Number(dup.at)).toLocaleString('zh-CN', { hour12: false })
    return { ok: false, code: 'duplicate', detail: `这条已经发过了（${when} 发过同一句${dup.target ? `给「${dup.target}」` : ''}），别重复刷` }
  }

  const perHour = Number(o.perHour) > 0 ? Number(o.perHour) : 6
  const perDay = Number(o.perDay) > 0 ? Number(o.perDay) : 30
  const inHour = rows.filter((r) => now - Number(r.at || 0) < 3600e3).length
  const inDay = rows.filter((r) => now - Number(r.at || 0) < 86400e3).length
  if (inHour >= perHour) return { ok: false, code: 'quota_hour', detail: `这一小时已经发了 ${inHour} 条（上限 ${perHour}），歇一会儿再发` }
  if (inDay >= perDay) return { ok: false, code: 'quota_day', detail: `今天已经发了 ${inDay} 条（上限 ${perDay}），明天再发` }

  return { ok: true }
}

/**
 * 确认发出后记账（拿到 cid 才调用），返回累计条数（1 小时 / 24 小时）。
 * source：'tool' = 本插件发的；'server' = 从子评论接口补录回来的（别人/别的会话发的）。
 */
export function recordPublicComment(o = {}) {
  const text = String(o.text || '').trim()
  const aweme = String(o.aweme || '').trim()
  const target = String(o.target || '').trim()
  const rec = {
    at: Number(o.at) || Date.now(),
    aweme,
    target,
    text: text.slice(0, 200),
    cid: String(o.cid || ''),
    source: String(o.source || 'tool'),
    // state: 'unverified' = 服务端回了 200 但没给评论 id（很可能已发出）。
    //   这种也记账，靠去重闸拦住"同一句再发一次"（2026-10-28 重复评论事故的补丁）。
    state: String(o.state || ''),
    key: ledgerKey(aweme, target, text),
  }
  try { appendFileSync(guardFile(), JSON.stringify(rec) + '\n') } catch { /* 记账失败不影响发送结果 */ }
  const rows = readLedger()
  const now = Date.now()
  return {
    hour: rows.filter((r) => now - Number(r.at || 0) < 3600e3).length,
    day: rows.filter((r) => now - Number(r.at || 0) < 86400e3).length,
  }
}

/** 给设置页/日志用：现在的额度用了多少 */
export function guardStats(o = {}) {
  const rows = readLedger()
  const now = Date.now()
  const hour = rows.filter((r) => now - Number(r.at || 0) < 3600e3).length
  const day = rows.filter((r) => now - Number(r.at || 0) < 86400e3).length
  return { hour, day, perHour: Number(o.perHour) || 6, perDay: Number(o.perDay) || 30, total: rows.length }
}

/**
 * 台账里出现过的「回复目标 cid」集合。
 * 用途：评论区自动回复要先问"这条是不是已经回过了"——
 *      内容是不是同一句不重要，**同一个线程回过就不再回**，不然会一直复读。
 * ⚠️ 这只是**缓存**：真判据在服务端（子评论接口里有没有我的回复），
 *    因为台账看不见别人手动回的那些（2026-10-25 用户指出）。
 */
export function repliedTargets() {
  const set = new Set()
  for (const r of readLedger()) {
    const t = String((r && r.target) || '').trim()
    if (/^\d{10,25}$/.test(t)) set.add(t)
  }
  return set
}

/** 台账里有没有这条线程的记账（补录前先查，别重复写） */
export function ledgerHasTarget(cid) {
  const t = String(cid || '').trim()
  if (!t) return false
  return readLedger().some((r) => String((r && r.target) || '').trim() === t)
}

/** 清空台账（设置页给个按钮用；只删自己的记账文件） */
export function resetGuard() {
  try { writeFileSync(guardFile(), ''); return true } catch { return false }
}