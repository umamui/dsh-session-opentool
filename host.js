/**
 * dsh-session-opentool — Host half.
 *
 * The sidebar's session menu cannot open a local folder: the Client package has
 * no shell-open capability, so the click has to come back to the Host. This file
 * registers one route and answers with the folder it opened:
 *
 *   POST /dsh-session-opentool/open   { sessionId, target: 'cwd' | 'session' }
 *     cwd     — the Session header's working directory (`header.cwd`).
 *     session — the folder holding the stored log, `dirname(locate(header).path)`,
 *               i.e. `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/`.
 *
 * Both paths come from the persistence backend, never from the request body: the
 * Client only names a Session and which of the two folders it means. A path that
 * the backend no longer resolves, or that no longer exists on disk, is refused
 * with a message instead of handing the platform a broken target.
 *
 * Opening is a detached child process (`explorer.exe`, `open`, `xdg-open`) with
 * no stdio and no wait: the file manager outlives this request, and its exit
 * status is not a useful signal (`explorer.exe` routinely exits 1 on success).
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Services activation waits for; the persistence seam is looked up per request. */
export const inject = ['webServer']

const BASE = '/dsh-session-opentool'
const OPEN_PATH = `${BASE}/open`

/** Session ids are opaque strings, but never paths: keep them to safe segments. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

const TARGETS = new Set(['cwd', 'session'])

const MAX_BODY_BYTES = 4096

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** A refusal carrying an HTTP status and a stable code the Client reports. */
class OpenRefusal extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'OpenRefusal'
    this.status = status
    this.code = code
    this.details = details ?? {}
  }
}

function send(response, status, payload) {
  if (response.headersSent) return
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(payload))
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Temporary diagnostics: every request that reaches the Host appends one line.
 * An empty file after a click proves the request never left the page.
 */
const DEBUG_LOG = join(tmpdir(), 'dsh-session-opentool.log')

function debugLog(line) {
  if (DEBUG_LOG === '') return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Diagnostics must never break the request they describe.
  }
}

/** Read a JSON request body with a hard ceiling. */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new OpenRefusal(413, 'body-too-large', '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    throw new OpenRefusal(400, 'bad-json', '请求体不是合法 JSON')
  }
}

/**
 * The argv that hands one directory to this platform's file manager.
 *
 * `explorer.exe` is resolved through `%SystemRoot%` first: the Host process may
 * run with a scrubbed PATH, while the shell's real executable is always there.
 * @param {string} directory - absolute directory to show.
 * @returns {readonly [string, ...string[]]} the command and its arguments.
 */
export function openerArgv(directory) {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.windir ?? ''
    const command = root === '' ? 'explorer.exe' : join(root, 'explorer.exe')
    return [command, directory]
  }
  if (process.platform === 'darwin') return ['open', directory]
  return ['xdg-open', directory]
}

/**
 * Start the file manager and resolve once the process is actually spawned.
 *
 * Resolution is not attributed to the child lingering: the handle is unref'd, so
 * a Host shutdown is never held open by an explorer window.
 * @param {string} directory - absolute directory to show.
 * @returns {Promise<void>} resolution after `spawn`, rejection if it never started.
 */
export function openDirectory(directory) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = openerArgv(directory)
    let settled = false
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    try {
      // `windowsHide` must stay off. The Windows shell inherits that startup flag
      // and builds the folder window with WS_VISIBLE unset, so the window exists
      // but never shows — which reads as "clicking did nothing".
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

/** The persistence seam, or a refusal that says the profile lacks it. */
function requirePersistence(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw new OpenRefusal(503, 'persistence-unavailable', 'sessionPersistence 未挂载，读不到会话的工作目录。')
  }
  return persistence
}

/**
 * Resolve the directory one Session row should open.
 * @param {object} persistence - the mounted persistence service.
 * @param {object} header - the Session's stored header.
 * @param {'cwd' | 'session'} target - which folder the row means.
 * @returns {{ directory: string, target: 'cwd' | 'session' }} the resolved folder.
 */
export function resolveDirectory(persistence, header, target) {
  if (target === 'cwd') {
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new OpenRefusal(409, 'session-no-cwd', '这个会话没有记录工作目录，无法打开。')
    }
    return { directory: cwd, target }
  }

  // `locate()` is a capability of the JSONL backend rather than of the abstract
  // service, so an alternative backend answers by refusing, not by crashing.
  if (typeof persistence.locate !== 'function') {
    throw new OpenRefusal(501, 'no-locate', '当前持久化后端不提供会话文件路径，无法定位会话记录。')
  }
  const located = persistence.locate(header)
  const file = located?.path
  if (typeof file !== 'string' || file === '') {
    throw new OpenRefusal(501, 'no-artifact', '无法定位这个会话的记录文件。')
  }
  return { directory: dirname(file), target }
}

/**
 * Open one Session's folder on request.
 * @param {object} ctx - the Host context.
 * @param {unknown} body - the parsed request body.
 * @returns {Promise<{ ok: true, target: 'cwd' | 'session', path: string }>} the opened folder.
 */
export async function openSessionFolder(ctx, body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const target = typeof body?.target === 'string' ? body.target : 'cwd'
  if (!SESSION_ID.test(sessionId)) throw new OpenRefusal(400, 'bad-session-id', '会话 ID 不合法')
  if (!TARGETS.has(target)) throw new OpenRefusal(400, 'bad-target', `未知的打开目标：${target}`)

  const persistence = requirePersistence(ctx)
  const snapshot = await persistence.stat(sessionId)
  const header = snapshot?.header
  if (header === undefined) throw new OpenRefusal(404, 'session-not-found', '找不到这个会话的持久化记录。')

  const { directory } = resolveDirectory(persistence, header, /** @type {'cwd' | 'session'} */ (target))

  // The header can outlive the directory it names (renamed or deleted project),
  // so disk is the authority; a stale path is reported instead of opening a
  // file manager dialog over a folder that is not there.
  const info = await stat(directory).catch(() => undefined)
  if (info === undefined) {
    throw new OpenRefusal(404, 'missing-directory', `目录不存在：${directory}`, { path: directory })
  }
  if (!info.isDirectory()) {
    throw new OpenRefusal(409, 'not-directory', `目标不是目录：${directory}`, { path: directory })
  }

  try {
    await openDirectory(directory)
  } catch (error) {
    throw new OpenRefusal(500, 'open-failed', `无法调用文件管理器：${messageOf(error)}`, { path: directory })
  }

  return { ok: true, target: /** @type {'cwd' | 'session'} */ (target), path: directory }
}

/**
 * Register the route.
 * @param {object} ctx - the Host context.
 */
export function apply(ctx) {
  debugLog(`apply ${OPEN_PATH}`)
  const onOpen = (request, response) => {
    debugLog(`request ${request.method} ${request.url}`)
    void (async () => {
      const body = await readJson(request)
      const result = await openSessionFolder(ctx, body)
      debugLog(`ok ${result.target} ${result.path}`)
      send(response, 200, result)
    })().catch((error) => {
      debugLog(`fail ${error instanceof Error ? error.name : 'unknown'} ${messageOf(error)}`)
      ctx.logger?.warn?.(`[dsh-session-opentool] open failed: ${messageOf(error)}`)
      send(response, error instanceof OpenRefusal ? error.status : 500, {
        ok: false,
        code: error instanceof OpenRefusal ? error.code : 'internal',
        message: messageOf(error),
        ...(error instanceof OpenRefusal ? error.details : {}),
      })
    })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: OPEN_PATH, handler: onOpen }), 'dsh-session-opentool: open')
}
