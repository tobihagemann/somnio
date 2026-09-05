import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'

/**
 * The pinned trust anchors for every `wss://` dial: the long-lived Let's Encrypt ISRG roots,
 * read at runtime from the committed PEM so there is one source and nothing to drift.
 */
export const TRUST_ROOTS_PATH = new URL('../trust-roots.pem', import.meta.url)

export type TrustRootsResolution = { kind: 'pinned'; ca: string[] } | { kind: 'refused'; reason: string }

/** Certificate blocks only; the file carries a `#` documentation header. */
function certificateBlocks(pem: string): string[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map(
    (match) => match[0]
  )
}

/**
 * `pinned` when the PEM reads and holds at least one block, every block parsing as a certificate;
 * `refused` otherwise, so
 * the caller fails closed instead of downgrading to the system trust store.
 */
export function resolveTrustRoots(path: URL | string = TRUST_ROOTS_PATH): TrustRootsResolution {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { kind: 'refused', reason: `trust roots unreadable: ${String(error)}` }
  }
  const blocks = certificateBlocks(text)
  if (blocks.length === 0) return { kind: 'refused', reason: 'trust roots carry no certificate' }
  try {
    for (const block of blocks) new X509Certificate(block)
  } catch (error) {
    return { kind: 'refused', reason: `trust roots failed to parse: ${String(error)}` }
  }
  return { kind: 'pinned', ca: blocks }
}
