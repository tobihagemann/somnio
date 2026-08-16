// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEditorSectorFsHandler, editorSectorFs } from '../vite.editorFs'

/**
 * The editor's file middleware against a real temp directory. A per-file node environment
 * (not a third vitest config): `npm test` — the set `lint.sh --web` and the `web` CI job run —
 * must execute these security-relevant assertions, and a separate config would leave them
 * permanently unexecuted while reporting green.
 */

type Handler = ReturnType<typeof createEditorSectorFsHandler>

const MINIMAL_SECTOR = `{\n  "version" : 1\n}`

let root: string
let handler: Handler
let server: Server
let baseURL: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'somnio-editor-fs-'))
  handler = createEditorSectorFsHandler(join(root, 'sectors'))
  server = createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404
      res.end('unhandled')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseURL = `http://127.0.0.1:${port}/__editor/sectors`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Drives the handler directly with a fake socket, for the cases a real local socket cannot produce. */
function invoke(options: {
  url: string
  method?: string
  remoteAddress?: string | undefined
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; body: string }> {
  return new Promise((settle) => {
    const request = Object.assign(new EventEmitter(), {
      url: options.url,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      socket: { remoteAddress: options.remoteAddress },
      destroy: () => {},
    }) as unknown as IncomingMessage
    const chunks: Buffer[] = []
    const response = {
      statusCode: 200,
      setHeader: () => {},
      end: (data?: string | Buffer) => {
        if (data !== undefined) chunks.push(Buffer.from(data))
        settle({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      },
    }
    handler(request, response as unknown as ServerResponse, () => settle({ status: -1, body: '' }))
    if ((options.method ?? 'GET') === 'PUT') {
      if (options.body !== undefined) request.emit('data', Buffer.from(options.body))
      request.emit('end')
    }
  })
}

describe('list, read, write', () => {
  it('creates a file that does not exist yet — the New Map / Save As path', async () => {
    const put = await fetch(`${baseURL}/${encodeURIComponent('Fresh')}`, {
      method: 'PUT',
      body: MINIMAL_SECTOR,
    })
    expect(put.status).toBe(204)
    expect(readFileSync(join(root, 'sectors', 'Fresh.somnio-sector'), 'utf8')).toBe(MINIMAL_SECTOR)
  })

  it('round-trips a name with a space and an umlaut through percent-encoding', async () => {
    const name = 'Nordwiese Süd'
    const put = await fetch(`${baseURL}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: MINIMAL_SECTOR,
    })
    expect(put.status).toBe(204)
    const list = (await (await fetch(baseURL)).json()) as string[]
    expect(list).toContain(name)
    const get = await fetch(`${baseURL}/${encodeURIComponent(name)}`)
    expect(get.status).toBe(200)
    expect(await get.text()).toBe(MINIMAL_SECTOR)
  })

  it('lists only .somnio-sector stems', async () => {
    writeFileSync(join(root, 'sectors', 'notes.txt'), 'not a sector')
    const list = (await (await fetch(baseURL)).json()) as string[]
    expect(list).not.toContain('notes')
    expect(list).not.toContain('notes.txt')
  })

  it('answers 404 for a sector that does not exist', async () => {
    const get = await fetch(`${baseURL}/${encodeURIComponent('Missing')}`)
    expect(get.status).toBe(404)
  })

  it('overwrites atomically, leaving no temp file behind', async () => {
    await fetch(`${baseURL}/${encodeURIComponent('Fresh')}`, { method: 'PUT', body: '{\n  "version" : 2\n}' })
    expect(readFileSync(join(root, 'sectors', 'Fresh.somnio-sector'), 'utf8')).toContain('"version" : 2')
    expect(readdirSync(join(root, 'sectors')).filter((entry) => entry.includes('.tmp-'))).toEqual([])
  })

  it('refuses methods other than GET and PUT', async () => {
    const del = await fetch(`${baseURL}/${encodeURIComponent('Fresh')}`, { method: 'DELETE' })
    expect(del.status).toBe(405)
    const post = await fetch(baseURL, { method: 'POST' })
    expect(post.status).toBe(405)
  })

  it('passes non-editor routes through to the next middleware', async () => {
    expect(await invoke({ url: '/index.html', remoteAddress: '127.0.0.1' })).toEqual({
      status: -1,
      body: '',
    })
  })
})

describe('loopback enforcement', () => {
  it.each(['203.0.113.9', '10.0.0.5', undefined])('rejects remote address %s', async (remoteAddress) => {
    const result = await invoke({ url: '/__editor/sectors', remoteAddress })
    expect(result.status).toBe(403)
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', async (remoteAddress) => {
    const result = await invoke({ url: '/__editor/sectors', remoteAddress })
    expect(result.status).toBe(200)
  })
})

describe('same-origin enforcement', () => {
  it('rejects a cross-site request even from loopback', async () => {
    const result = await invoke({
      url: '/__editor/sectors',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(result.status).toBe(403)
  })

  it('rejects a same-site (other-origin) request', async () => {
    const result = await invoke({
      url: '/__editor/sectors',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'same-site' },
    })
    expect(result.status).toBe(403)
  })

  it('rejects a request whose Origin host does not match Host', async () => {
    const result = await invoke({
      url: '/__editor/sectors',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://evil.example', host: 'localhost:17669' },
    })
    expect(result.status).toBe(403)
  })

  it('allows the editor own-origin fetch (Sec-Fetch-Site: same-origin)', async () => {
    const result = await invoke({
      url: '/__editor/sectors',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(result.status).toBe(200)
  })

  it('allows a user-typed navigation (Sec-Fetch-Site: none)', async () => {
    const result = await invoke({
      url: '/__editor/sectors',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'none' },
    })
    expect(result.status).toBe(200)
  })
})

describe('traversal rejection', () => {
  it.each([
    ['encoded traversal', '/__editor/sectors/..%2F..%2FPackage.swift'],
    ['raw traversal', '/__editor/sectors/../../Package.swift'],
    ['absolute path', '/__editor/sectors/%2Fetc%2Fpasswd'],
    ['backslash', '/__editor/sectors/..%5C..%5CPackage.swift'],
    ['dot-dot name', '/__editor/sectors/..'],
    ['leading dot', '/__editor/sectors/.hidden'],
    ['NUL byte', '/__editor/sectors/evil%00name'],
    ['malformed encoding', '/__editor/sectors/%E0%A4%A'],
  ])('%s is refused', async (_label, url) => {
    const result = await invoke({ url, remoteAddress: '127.0.0.1' })
    expect(result.status).toBe(400)
  })

  it('refuses a symlink escape on an existing path, for reads and writes', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'target.somnio-sector'), 'outside content')
    symlinkSync(join(outside, 'target.somnio-sector'), join(root, 'sectors', 'Evil.somnio-sector'))
    const get = await fetch(`${baseURL}/${encodeURIComponent('Evil')}`)
    expect(get.status).toBe(400)
    const put = await fetch(`${baseURL}/${encodeURIComponent('Evil')}`, { method: 'PUT', body: 'x' })
    expect(put.status).toBe(400)
    expect(readFileSync(join(outside, 'target.somnio-sector'), 'utf8')).toBe('outside content')
  })
})

describe('environment gating', () => {
  function mountedHandlerCount(environmentValue: string | undefined): number {
    const previous = process.env.SOMNIO_EDITOR_SECTORS_DIR
    if (environmentValue === undefined) delete process.env.SOMNIO_EDITOR_SECTORS_DIR
    else process.env.SOMNIO_EDITOR_SECTORS_DIR = environmentValue
    try {
      const mounted: unknown[] = []
      const fakeServer = { middlewares: { use: (mountedHandler: unknown) => mounted.push(mountedHandler) } }
      const configureServer = editorSectorFs().configureServer as (server: unknown) => void
      configureServer(fakeServer)
      return mounted.length
    } finally {
      if (previous === undefined) delete process.env.SOMNIO_EDITOR_SECTORS_DIR
      else process.env.SOMNIO_EDITOR_SECTORS_DIR = previous
    }
  }

  it('mounts nothing when SOMNIO_EDITOR_SECTORS_DIR is unset or empty', () => {
    expect(mountedHandlerCount(undefined)).toBe(0)
    expect(mountedHandlerCount('')).toBe(0)
  })

  it('mounts the handler when SOMNIO_EDITOR_SECTORS_DIR is set', () => {
    expect(mountedHandlerCount(join(root, 'gated-sectors'))).toBe(1)
  })
})
