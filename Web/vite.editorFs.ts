import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { SOMNIO_CONSTANTS } from './src/core/constants'
import { SECTOR_API_PREFIX, isValidSectorName } from './src/editor/sectorName'

/**
 * The editor's localhost file API: list, read, and write `.somnio-sector` files under the
 * directory `SOMNIO_EDITOR_SECTORS_DIR` names. Dev-only by construction — a `configureServer`
 * hook only, never `configurePreviewServer`, so the API cannot exist outside `vite dev`; and
 * inert unless the environment variable is set, so an ordinary `npm run dev` never mounts a
 * filesystem write API at all (the `editor` npm script is what sets it).
 *
 * The default directory is the repo-root `sectors/` — deliberately the same staging directory
 * `docker-compose.example.yml` mounts and the `/somnio-web` skill seeds, because authoring the
 * sectors the local server serves is the point. A running server may therefore be reading these
 * files while the editor writes them; writes are atomic (temp file + rename) so a reader can
 * never observe a truncated sector.
 *
 * There is deliberately no DELETE route: the editor has no in-app delete, and rename uses
 * Save As semantics (write the new name, leave the original), so a destructive filesystem verb
 * would carry risk with no requirement behind it.
 */

const ROUTE_PREFIX = SECTOR_API_PREFIX
const EXTENSION = '.somnio-sector'
/** The codec enforces the same cap client-side; both read it from `SOMNIO_CONSTANTS`. */
const MAX_BODY_BYTES = SOMNIO_CONSTANTS.maxSectorFileBytes

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

type NextFunction = (error?: unknown) => void

export function editorSectorFs(): Plugin {
  return {
    name: 'somnio-editor-sector-fs',
    configureServer(server) {
      const root = process.env.SOMNIO_EDITOR_SECTORS_DIR
      if (root === undefined || root === '') return
      server.middlewares.use(createEditorSectorFsHandler(root))
    },
  }
}

/**
 * Exported separately from the plugin so the test suite can drive the handler directly
 * against a temp directory, fake sockets included.
 */
export function createEditorSectorFsHandler(
  root: string
): (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void {
  mkdirSync(root, { recursive: true })
  // Realpath the ROOT once, not each candidate: a New Map / Save As target does not exist yet,
  // so `realpath` on the candidate would ENOENT and make the two file-creating flows impossible.
  const realRoot = realpathSync(root)

  return (req, res, next) => {
    const url = req.url ?? ''
    if (url !== ROUTE_PREFIX && !url.startsWith(`${ROUTE_PREFIX}/`)) {
      next()
      return
    }
    // Structural loopback enforcement: Vite binds localhost by default, but `--host` opts out
    // of that default, and this middleware writes files.
    const address = req.socket.remoteAddress
    if (address === undefined || !LOOPBACK_ADDRESSES.has(address)) {
      respond(res, 403, 'forbidden: loopback only')
      return
    }
    // A loopback peer address is not an origin: Vite's default CORS admits every localhost-family
    // origin, and a Host-rewriting tunnel makes every client look loopback, so without this a page
    // on another origin could drive the file API. Gate on the origin the browser reports.
    if (!isSameOrigin(req)) {
      respond(res, 403, 'forbidden: cross-origin request')
      return
    }

    if (url === ROUTE_PREFIX || url === `${ROUTE_PREFIX}/`) {
      if (req.method !== 'GET') {
        respond(res, 405, 'method not allowed')
        return
      }
      const stems = readdirSync(realRoot)
        .filter((entry) => entry.endsWith(EXTENSION))
        .map((entry) => entry.slice(0, -EXTENSION.length))
        .sort()
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(stems))
      return
    }

    const encoded = url.slice(ROUTE_PREFIX.length + 1)
    let name: string
    try {
      name = decodeURIComponent(encoded)
    } catch {
      respond(res, 400, 'malformed sector name encoding')
      return
    }
    if (!isValidSectorName(name)) {
      respond(res, 400, 'invalid sector name')
      return
    }
    const filePath = containedSectorPath(realRoot, name)
    if (filePath === undefined) {
      respond(res, 400, 'sector name escapes the sectors directory')
      return
    }

    if (req.method === 'GET') {
      if (!existsSync(filePath)) {
        respond(res, 404, 'sector not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(readFileSync(filePath))
      return
    }
    if (req.method === 'PUT') {
      readBody(req, res, (body) => {
        // Atomic: a crashed write must never truncate an authored sector a running server
        // may be about to load. The temp name is unpredictable and opened `wx` (O_CREAT|O_EXCL),
        // so a pre-planted symlink at the temp path cannot redirect the write outside the root.
        const temporary = `${filePath}.tmp-${randomBytes(8).toString('hex')}`
        try {
          writeFileSync(temporary, body, { flag: 'wx' })
          renameSync(temporary, filePath)
        } catch {
          // The write runs in a stream callback, outside connect's error wrapper: an uncaught
          // throw here (ENOSPC, EROFS, EISDIR, a name the fs rejects) would exit the dev server.
          try {
            unlinkSync(temporary)
          } catch {
            // No temp file to clean up.
          }
          respond(res, 500, 'failed to write sector')
          return
        }
        res.statusCode = 204
        res.end()
      })
      return
    }
    respond(res, 405, 'method not allowed')
  }
}

/**
 * Resolves `<name>.somnio-sector` against the realpath'd root and verifies containment — and,
 * only when the candidate already exists, realpaths the candidate too and re-checks, so an
 * existing symlink inside the directory cannot escape it.
 */
function containedSectorPath(realRoot: string, name: string): string | undefined {
  const candidate = resolve(realRoot, `${name}${EXTENSION}`)
  if (dirname(candidate) !== realRoot) return undefined
  if (!existsSync(candidate)) return candidate
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return undefined
  }
  return dirname(real) === realRoot ? real : undefined
}

/**
 * Same-origin gate: `Sec-Fetch-Site` is authoritative when the browser sends it (`same-origin`
 * for the editor's own fetches, `none` for a user typing the URL); otherwise fall back to
 * matching `Origin`'s host against `Host`. A non-browser client (curl) carries no ambient
 * authority, so an absent origin is allowed.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const headers = req.headers ?? {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === headers.host
  } catch {
    return false
  }
}

function readBody(req: IncomingMessage, res: ServerResponse, onComplete: (body: Buffer) => void): void {
  const chunks: Buffer[] = []
  let byteCount = 0
  let rejected = false
  req.on('data', (chunk: Buffer) => {
    if (rejected) return
    byteCount += chunk.length
    if (byteCount > MAX_BODY_BYTES) {
      rejected = true
      respond(res, 413, 'sector file too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('error', () => {
    if (rejected) return
    rejected = true
    respond(res, 400, 'request stream error')
  })
  req.on('end', () => {
    if (!rejected) onComplete(Buffer.concat(chunks))
  })
}

function respond(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(message)
}
