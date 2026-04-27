import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs/promises'
const PORT = Number(process.env.PORT) || 8787
const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'

/** @type {string | null} */
let projectRoot = null

const IGNORE = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.turbo',
  '.cache',
  'target',
  '.idea',
])

const MAX_READ_AGENT = 400_000
const MAX_READ_API = 2_000_000

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory relative to project root.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path; use "." for project root.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file relative to project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file. Creates parent folders if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full new file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tree',
      description: 'Get complete tree structure of a directory relative to project root. Shows all files and folders recursively.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path; use "." or empty string for project root.',
          },
        },
        required: ['path'],
      },
    },
  },
]

function normalizeRoot(p) {
  let s = String(p || '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '')
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1)
  }
  return path.resolve(s)
}

function mapFsError(e) {
  if (!e || typeof e !== 'object') return e instanceof Error ? e.message : String(e)
  const c = e.code
  if (c === 'ENOENT') {
    return 'Bu yolda klasör bulunamadı. Gezginde klasöre gidip adres çubuğundan yolu kopyalayın; tırnak eklemeyin.'
  }
  if (c === 'ENOTDIR') return 'Bu yol bir klasör değil (muhtemelen bir dosya). Üst klasörü seçin.'
  if (c === 'EACCES') return 'Klasöre erişim reddedildi (izin veya antivirüs).'
  if (c === 'EPERM') return 'İşletim sistemi bu klasörü okumayı engelledi.'
  return e.message || String(e)
}

function assertRoot() {
  if (!projectRoot) {
    const e = new Error('NO_PROJECT')
    e.code = 'NO_PROJECT'
    throw e
  }
}

function safeFullPath(rel) {
  assertRoot()
  const root = path.resolve(projectRoot)
  const full = path.resolve(root, rel)
  const relNorm = path.relative(root, full)
  if (relNorm.startsWith('..') || path.isAbsolute(relNorm)) {
    const e = new Error('PATH_ESCAPE')
    e.code = 'PATH_ESCAPE'
    throw e
  }
  return full
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function langFromPath(rel) {
  const ext = path.extname(rel).toLowerCase()
  const map = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.css': 'css',
    '.html': 'html',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.sql': 'sql',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  }
  return map[ext] || 'plaintext'
}

async function scanSummary(root) {
  let files = 0
  let skipped = 0
  async function walk(dir) {
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      if (IGNORE.has(ent.name)) {
        skipped++
        continue
      }
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else files++
    }
  }
  await walk(root)
  return { fileCount: files, ignoredEntries: skipped }
}

async function buildTree(absDir, relPath) {
  const baseName = path.basename(absDir)
  const name = relPath ? path.basename(relPath) : baseName
  let ents
  try {
    ents = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return {
      name,
      path: toPosix(relPath || ''),
      type: 'folder',
      children: [],
    }
  }
  ents.sort((a, b) => {
    if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name)
    return a.isDirectory() ? -1 : 1
  })
  /** @type {any[]} */
  const children = []
  for (const ent of ents) {
    if (IGNORE.has(ent.name)) continue
    const r = relPath ? path.join(relPath, ent.name) : ent.name
    if (ent.isDirectory()) {
      children.push(await buildTree(path.join(absDir, ent.name), r))
    } else {
      children.push({
        name: ent.name,
        path: toPosix(r),
        type: 'file',
      })
    }
  }
  return {
    name,
    path: toPosix(relPath || ''),
    type: 'folder',
    children,
  }
}

async function getTreeForAgent(relPath) {
  const full = safeFullPath(relPath || '.')
  const tree = await buildTree(full, relPath || '')
  
  function formatTree(node, indent = '') {
    let result = `${indent}${node.type === 'folder' ? '📁' : '📄'} ${node.name}\n`
    if (node.children && node.children.length > 0) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        const isLast = i === node.children.length - 1
        result += formatTree(child, indent + (isLast ? '  ' : '│ '))
      }
    }
    return result
  }
  
  return formatTree(tree)
}

function parseToolArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return {}
}

async function executeTool(name, args, toolLog) {
  try {
    if (name === 'create_file') name = 'write_file'
    const a = parseToolArgs(args)
    if (name === 'read_file') {
      const p = String(a.path || '')
      toolLog.push(`read_file → ${p}`)
      const full = safeFullPath(p)
      const buf = await fs.readFile(full)
      if (buf.length > MAX_READ_AGENT) return '[Dosya çok büyük; özet veya parça isteyin.]'
      return buf.toString('utf8')
    }
    if (name === 'write_file') {
      const p = String(a.path || '')
      const content = String(a.content ?? '')
      toolLog.push(`write_file → ${p} (${content.length} bayt)`)
      const full = safeFullPath(p)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content, 'utf8')
      return `Tamam: ${p} yazıldı.`
    }
    if (name === 'list_dir') {
      const p = String(a.path ?? '.')
      toolLog.push(`list_dir → ${p}`)
      const full = safeFullPath(p)
      const ents = await fs.readdir(full, { withFileTypes: true })
      return ents
        .filter((e) => !IGNORE.has(e.name))
        .map((e) => `${e.isDirectory() ? '[klasör]' : '[dosya]'} ${e.name}`)
        .join('\n')
    }
    if (name === 'get_tree') {
      const p = String(a.path ?? '.')
      toolLog.push(`get_tree → ${p}`)
      const result = await getTreeForAgent(p)
      return result
    }
    toolLog.push(`? ${name}`)
    return `Bilinmeyen araç: ${name}`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toolLog.push(`HATA ${name}: ${msg}`)
    return `Hata: ${msg}`
  }
}

const TOOL_NAMES = new Set(['list_dir', 'read_file', 'write_file', 'create_file', 'get_tree'])

function normalizeSmartQuotes(s) {
  return String(s).replace(/[\u201C\u201D\u2018\u2019]/g, '"')
}

/** Model bazen araçları metin içinde ```json ...``` ile yazar; Ollama tool_calls boş kalır. */
function stripToolJsonFences(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/```(?:json|JSON)?\s*[\s\S]*?```/gi, '').replace(/\s+/g, ' ').trim()
}

function tryParseToolObject(slice, out) {
  const s = slice.trim()
  if (!s.startsWith('{')) return
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) {
      for (const item of j) {
        if (item && item.name && TOOL_NAMES.has(String(item.name))) {
          out.push({
            name: String(item.name),
            arguments: item.arguments ?? item.args ?? {},
          })
        }
      }
      return
    }
    if (j && j.name && TOOL_NAMES.has(String(j.name))) {
      out.push({ name: String(j.name), arguments: j.arguments ?? j.args ?? {} })
    }
  } catch {
    /* atla */
  }
}

/** Kapanan veya kapanmayan ```json ... blokları */
function parseFencedToolJson(t, out) {
  const re = /```(?:json|JSON)?\s*/g
  let m
  while ((m = re.exec(t)) !== null) {
    const bodyStart = m.index + m[0].length
    const closeIdx = t.indexOf('```', bodyStart)
    let inner
    if (closeIdx >= 0) {
      inner = t.slice(bodyStart, closeIdx).trim()
    } else {
      const brace0 = t.indexOf('{', bodyStart)
      if (brace0 < 0) continue
      let depth = 0
      let k = brace0
      for (; k < t.length; k++) {
        const c = t[k]
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            k++
            break
          }
        }
      }
      inner = t.slice(brace0, k).trim()
    }
    if (inner) tryParseToolObject(inner, out)
  }
}

/** Metin içinde düz {"name":"list_dir",...} (fence olmadan veya kırık fence) */
function parseBareToolJson(t, out) {
  const nameRe = /"name"\s*:\s*"(list_dir|read_file|write_file|create_file|get_tree)"/g
  let nm
  while ((nm = nameRe.exec(t)) !== null) {
    let start = -1
    for (let p = nm.index; p >= Math.max(0, nm.index - 200); p--) {
      if (t[p] === '{') {
        start = p
        break
      }
    }
    if (start < 0) continue
    let depth = 0
    let k = start
    for (; k < t.length; k++) {
      if (t[k] === '{') depth++
      else if (t[k] === '}') {
        depth--
        if (depth === 0) {
          k++
          break
        }
      }
    }
    tryParseToolObject(t.slice(start, k), out)
  }
}

function parseToolCallsFromContent(text) {
  const out = []
  if (!text || typeof text !== 'string') return out
  const t = normalizeSmartQuotes(text)

  const reClosed = /```(?:json|JSON)?\s*([\s\S]*?)```/gi
  let m
  while ((m = reClosed.exec(t)) !== null) {
    const inner = m[1].trim()
    if (inner) tryParseToolObject(inner, out)
  }

  if (out.length === 0) parseFencedToolJson(t, out)
  if (out.length === 0) parseBareToolJson(t, out)

  const seen = new Set()
  return out.filter((x) => {
    const key = `${x.name}:${JSON.stringify(x.arguments)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeToolCalls(msg) {
  const raw = msg?.tool_calls
  if (!Array.isArray(raw)) return []
  return raw.map((tc) => {
    const fn = tc.function || tc
    const name = fn.name || fn.function?.name
    const arguments_ = fn.arguments ?? fn.function?.arguments ?? {}
    return { name, arguments: arguments_ }
  })
}

function collectErrorCodes(err) {
  const codes = []
  let cur = err
  while (cur) {
    if (cur.code) codes.push(String(cur.code))
    cur = cur.cause
  }
  return codes
}

/** Node/undici «fetch failed» → anlaşılır Türkçe (çoğunlukla Ollama kapalı) */
function humanizeOllamaError(err) {
  const codes = collectErrorCodes(err)
  if (codes.includes('ECONNREFUSED') || codes.includes('ENOTFOUND')) {
    return `Ollama çalışmıyor veya adrese ulaşılamıyor (${OLLAMA}). Ollama'yı kurup uygulamayı açın; terminalde: ollama pull ${MODEL} — sonra tekrar deneyin.`
  }
  const msg = err instanceof Error ? err.message : String(err)
  const low = msg.toLowerCase()
  if (
    low === 'fetch failed' ||
    low.includes('failed to fetch') ||
    low.includes('networkerror') ||
    low.includes('econnrefused')
  ) {
    return `Ollama'ya bağlanılamadı (${OLLAMA}). Ollama servisi açık mı kontrol edin; gerekirse güvenlik duvarında 11434 portuna izin verin. Model: ollama pull ${MODEL}`
  }
  return msg
}

async function ollamaChat(messages, tools) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    options: { temperature: 0.15, num_ctx: 8192 },
  }
  if (tools?.length) body.tools = tools

  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 120_000)
  let r
  try {
    r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } catch (e) {
    clearTimeout(t)
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`Ollama yanıt vermedi (120 sn). Model çok büyük veya takıldı; farklı model deneyin: OLLAMA_MODEL=...`)
    }
    throw new Error(humanizeOllamaError(e))
  }
  clearTimeout(t)

  if (!r.ok) {
    const txt = await r.text()
    let detail = txt.slice(0, 400)
    try {
      const j = JSON.parse(txt)
      if (j.error) detail = String(j.error)
    } catch {
      /* metin kalsın */
    }
    if (r.status === 404 || /not found|model/i.test(detail)) {
      throw new Error(
        `Model bulunamadı veya adı yanlış: «${MODEL}». Terminalde: ollama pull ${MODEL} — veya OLLAMA_MODEL ortam değişkenini «ollama list» çıktısındaki tam ada göre ayarlayın.`,
      )
    }
    throw new Error(`Ollama HTTP ${r.status}: ${detail}`)
  }
  return r.json()
}

async function runAgent(clientMessages, extraSystem) {
  assertRoot()
  const toolLog = []
  const baseSystem = `Sen yerel disk üzerinde çalışan özerk bir kod asistanısın.

Proje kök dizini (mutlak yol): ${projectRoot}

Kurallar:
- Tüm dosya yolları bu köke göre GÖRELİ olsun (örn: src/App.tsx, package.json).
- Düzeltme veya özellik istenince önce gerekirse get_tree, list_dir ve read_file ile projeyi incele, sonra write_file ile değişikliği uygula.
- Yeni dosya gerekiyorsa write_file ile oluştur (klasörler otomatik oluşur).
- Kullanıcıya Türkçe, kısa ve net özet ver.
- Araç çıktıları İngilizce kalabilir; nihai açıklama Türkçe olsun.
- Kullanıcıya markdown kod bloğunda sahte araç JSON'u yazma; araçlar sistem tarafından çalıştırılır.`

  const system =
    extraSystem && String(extraSystem).trim()
      ? `${baseSystem}\n\nEk kullanıcı talimatları:\n${String(extraSystem).trim()}`
      : baseSystem

  /** @type {any[]} */
  const messages = [{ role: 'system', content: system }]
  for (const m of clientMessages) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: String(m.content ?? '') })
    }
  }

  let finalContent = ''
  const maxSteps = 24
  for (let step = 0; step < maxSteps; step++) {
    const data = await ollamaChat(messages, TOOL_DEFS)
    const msg = data.message || {}
    const nativeCalls = normalizeToolCalls(msg)
    let calls = nativeCalls
    if (calls.length === 0) {
      calls = parseToolCallsFromContent(String(msg.content || ''))
    }

    if (calls.length > 0) {
      if (nativeCalls.length > 0) {
        messages.push(msg)
      } else {
        const stripped = stripToolJsonFences(String(msg.content || ''))
        messages.push({
          role: 'assistant',
          content: stripped.length > 0 ? stripped : 'Araçları çalıştırıyorum.',
        })
      }
      for (const tc of calls) {
        const toolName = tc.name === 'create_file' ? 'write_file' : tc.name
        const out = await executeTool(toolName, tc.arguments, toolLog)
        messages.push({
          role: 'tool',
          content: out,
          name: toolName,
        })
      }
      continue
    }

    finalContent = String(msg.content ?? '').trim() || '(Model boş yanıt döndü.)'
    break
  }

  return { content: finalContent, toolLog: toolLog.join('\n') }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    projectRoot,
    ollama: OLLAMA,
    model: MODEL,
  })
})

app.get('/api/ollama/ping', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { method: 'GET' })
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Ollama yanıtı: ${r.status}` })
    }
    const data = await r.json()
    const names = (data.models || []).map((m) => m.name)
    res.json({ ok: true, models: names, using: MODEL })
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/project/open', async (req, res) => {
  try {
    const raw = req.body?.path
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ error: 'path zorunlu' })
    }
    const p = normalizeRoot(raw)
    const st = await fs.stat(p)
    if (!st.isDirectory()) {
      return res.status(400).json({ error: 'Geçerli bir klasör yolu girin' })
    }
    projectRoot = p
    const summary = await scanSummary(p)
    res.json({ ok: true, root: projectRoot, ...summary })
  } catch (e) {
    const msg = mapFsError(e)
    res.status(400).json({ error: msg })
  }
})

app.post('/api/project/close', (_req, res) => {
  projectRoot = null
  res.json({ ok: true })
})

app.get('/api/project', (_req, res) => {
  res.json({ root: projectRoot })
})

app.get('/api/tree', async (_req, res) => {
  try {
    assertRoot()
    const tree = await buildTree(projectRoot, '')
    res.json(tree)
  } catch (e) {
    if (e.code === 'NO_PROJECT') {
      return res.status(400).json({ error: 'Önce bir proje klasörü açın' })
    }
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/api/file', async (req, res) => {
  try {
    const rel = req.query.path
    if (typeof rel !== 'string') {
      return res.status(400).json({ error: 'path sorgu parametresi gerekli' })
    }
    const full = safeFullPath(rel)
    const buf = await fs.readFile(full)
    if (buf.length > MAX_READ_API) {
      return res.status(413).json({ error: 'Dosya çok büyük' })
    }
    const content = buf.toString('utf8')
    res.json({
      path: toPosix(rel),
      content,
      language: langFromPath(rel),
    })
  } catch (e) {
    if (e.code === 'NO_PROJECT') {
      return res.status(400).json({ error: 'Proje açık değil' })
    }
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.put('/api/file', async (req, res) => {
  try {
    const rel = req.body?.path
    const content = req.body?.content
    if (typeof rel !== 'string' || typeof content !== 'string') {
      return res.status(400).json({ error: 'path ve content gerekli' })
    }
    const full = safeFullPath(rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
    res.json({ ok: true })
  } catch (e) {
    if (e.code === 'NO_PROJECT') {
      return res.status(400).json({ error: 'Proje açık değil' })
    }
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/api/agent', async (req, res) => {
  try {
    const msgs = req.body?.messages
    const extraSystem = req.body?.extraSystem
    if (!Array.isArray(msgs)) {
      return res.status(400).json({ error: 'messages dizi olmalı' })
    }
    const slim = msgs
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content ?? '') }))
    const result = await runAgent(slim, extraSystem)
    res.json(result)
  } catch (e) {
    if (e.code === 'NO_PROJECT') {
      return res.status(400).json({
        error: 'Ajan için önce yerel proje klasörünü açın',
        code: 'NO_PROJECT',
      })
    }
    const raw = e instanceof Error ? e.message : String(e)
    const error =
      raw.toLowerCase() === 'fetch failed' || raw.includes('fetch failed')
        ? humanizeOllamaError(e)
        : raw
    res.status(500).json({ error })
  }
})

const server = app.listen(PORT, () => {
  console.log(`Bidolu yerel sunucu http://127.0.0.1:${PORT}`)
  console.log(`Ollama: ${OLLAMA} model: ${MODEL}`)
})
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[Bidolu] Port ${PORT} dolu. Başka bir uygulamayı kapatın veya şunu deneyin: set PORT=8788 && node server/index.mjs`,
    )
  } else {
    console.error('[Bidolu] Sunucu hatası:', err)
  }
  process.exit(1)
})
