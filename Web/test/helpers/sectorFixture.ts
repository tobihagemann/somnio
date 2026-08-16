import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Reads a committed `.somnio-sector` fixture straight out of the Swift tree, decoded as UTF-8.
 * Sibling of `swiftConstant.ts`/`swiftEnum.ts` and resolved the same way — `readFileSync`
 * relative to the repo root, no Vite alias: a `?raw` import resolves through `vite/client`'s
 * ambient declaration and never consults `tsconfig` `paths`, so an alias would be dead weight
 * that looks load-bearing.
 */
export function readSectorFixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), '..', 'Tests/SomnioMapFixturesTestSupport/MapFixtures', `${name}.somnio-sector`),
    'utf8'
  )
}

/** The Swift-emitted synthetic golden covering the cases the seven fixtures never reach. */
export function readSectorEncodingGolden(): string {
  return readFileSync(
    resolve(process.cwd(), '..', 'Tests/SomnioCoreTests/Fixtures/sector-encoding-golden.somnio-sector'),
    'utf8'
  )
}
