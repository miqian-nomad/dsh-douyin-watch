/**
 * 人设库：可编辑、可导入导出、按会话生效的那套机制。
 *
 * 设计抄自开源项目 dsh-persona-dafeiyu（MIT），但存储落在本插件自己的 home 里，
 * 跟 watch-config.json 放一起，不占用 DSH 的 storages 目录。
 *
 * 结构：
 *   { current: '<id>', items: { '<id>': { name, text, source: 'imported', enabled: true } } }
 *
 * 内置三套（大肥鱼 / 阿茶 / 听澜）写死在 personas.mjs 里，**只读**：
 * 不能删、不能改名、不能覆盖；想改就自己导入一份。
 *
 * 写入用「临时文件 + rename」，半个文件不会留在磁盘上。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PERSONA_PRESETS, personaById } from './personas.mjs'

const MAX_NAME = 60
const MAX_TEXT = 64000

export function storePath(home) {
  return join(home, 'personas.json')
}

function emptyStore() {
  return { current: '', items: {} }
}

function normalize(raw) {
  const store = emptyStore()
  if (!raw || typeof raw !== 'object') return store
  if (typeof raw.current === 'string') store.current = raw.current
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {}
  for (const [id, v] of Object.entries(items)) {
    if (!v || typeof v !== 'object') continue
    const name = String(v.name || '').trim()
    const text = String(v.text || '')
    if (!name || !text) continue
    if (personaById(id)) continue // 内置 id 不许被占用
    store.items[id] = {
      name: name.slice(0, MAX_NAME),
      text: text.slice(0, MAX_TEXT),
      source: 'imported',
      enabled: v.enabled !== false,
    }
  }
  return store
}

export function readStore(home) {
  const file = storePath(home)
  try {
    if (!existsSync(file)) return emptyStore()
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyStore() // 文件坏了就当空库，不让插件挂掉
  }
}

export function writeStore(home, store) {
  const file = storePath(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

/** 内置 + 导入，统一成界面上要用的形状（不含正文，正文单取）。 */
export function listPersonas(home) {
  const store = readStore(home)
  const list = PERSONA_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    source: 'builtin',
    builtin: true,
    enabled: true,
    chars: p.text.length,
  }))
  for (const [id, v] of Object.entries(store.items)) {
    list.push({
      id,
      name: v.name,
      source: 'imported',
      builtin: false,
      enabled: v.enabled !== false,
      chars: v.text.length,
    })
  }
  return { current: store.current, list }
}

/** 取一条人设的正文；停用的、不存在的都返回 null。 */
export function resolvePersona(home, id) {
  const key = String(id || '').trim()
  if (!key) return null
  const builtin = personaById(key)
  if (builtin) return { id: builtin.id, name: builtin.name, text: builtin.text, source: 'builtin' }
  const store = readStore(home)
  const v = store.items[key]
  if (!v || v.enabled === false) return null
  return { id: key, name: v.name, text: v.text, source: 'imported' }
}

/** 只取正文（界面的「查看全文」）。 */
export function personaText(home, id) {
  const p = resolvePersona(home, id)
  return p ? p.text : null
}

/**
 * 一个动作改一次库。返回 { ok, error?, ... }。
 * action: set-current | import | rename | remove | set-enabled
 */
export function mutate(home, action, payload = {}) {
  const store = readStore(home)

  if (action === 'set-current') {
    const id = String(payload.id || '').trim()
    if (!id) { store.current = ''; writeStore(home, store); return { ok: true, current: '' } }
    if (!resolvePersona(home, id)) return { ok: false, error: '没有这条人设，或者它被停用了' }
    store.current = id
    writeStore(home, store)
    return { ok: true, current: id }
  }

  if (action === 'import') {
    const name = String(payload.name || '').trim().slice(0, MAX_NAME)
    const text = String(payload.text || '').trim().slice(0, MAX_TEXT)
    if (!name) return { ok: false, error: '名字不能为空' }
    if (!text) return { ok: false, error: '正文不能为空' }
    if (PERSONA_PRESETS.some((p) => p.id === name || p.name === name)) return { ok: false, error: '这个名字跟内置人设重名了' }
    if (Object.values(store.items).some((v) => v.name === name)) return { ok: false, error: '已经有同名的人设了' }
    const id = 'p-' + randomUUID().slice(0, 8)
    store.items[id] = { name, text, source: 'imported', enabled: true }
    writeStore(home, store)
    return { ok: true, id, name }
  }

  if (action === 'rename') {
    const id = String(payload.id || '').trim()
    const name = String(payload.name || '').trim().slice(0, MAX_NAME)
    const v = store.items[id]
    if (!v) return { ok: false, error: '内置人设不能改名，或者这条不存在' }
    if (!name) return { ok: false, error: '名字不能为空' }
    if (Object.entries(store.items).some(([k, x]) => k !== id && x.name === name)) return { ok: false, error: '已经有同名的人设了' }
    v.name = name
    writeStore(home, store)
    return { ok: true }
  }

  if (action === 'remove') {
    const id = String(payload.id || '').trim()
    const v = store.items[id]
    if (!v) return { ok: false, error: '内置人设不能删，或者这条不存在' }
    delete store.items[id]
    if (store.current === id) store.current = ''
    writeStore(home, store)
    return { ok: true, current: store.current }
  }

  if (action === 'set-enabled') {
    const id = String(payload.id || '').trim()
    const v = store.items[id]
    if (!v) return { ok: false, error: '内置人设不能停用，或者这条不存在' }
    v.enabled = payload.enabled !== false
    // 停用的这套如果正被选中，就一起清掉——否则界面上写着"当前"、实际一条人设都没挂
    if (!v.enabled && store.current === id) store.current = ''
    writeStore(home, store)
    return { ok: true, current: store.current }
  }

  return { ok: false, error: '不认识的动作：' + action }
}
