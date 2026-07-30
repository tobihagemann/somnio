import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Reads a Swift enum's `case name = raw` table straight out of the source file.
 *
 * The enum body must be matched with `[\s\S]*?\n\}`, which reaches the closing brace at column zero.
 * A lazy `[^}]*` stops at the *first* inner `}`, so an enum carrying a computed property — which
 * `CharacterClass` and `Gender` both do — yields a truncated body and a pin that silently checks a
 * subset.
 *
 * Reading the file is the point: a copied table would drift in exactly the way these pins exist to
 * catch, and the drift is invisible because both sides of the wire encode with their own constant.
 */
export function swiftEnumCases(relativePath: string, enumName: string): Record<string, number> {
  const source = readFileSync(resolve(process.cwd(), '..', relativePath), 'utf8')
  const body = new RegExp(`enum ${enumName}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1]
  if (body === undefined) throw new Error(`no enum ${enumName} in ${relativePath}`)
  // Backticks are optional in the name: Swift escapes a case that collides with a keyword, and
  // `Tempo.default` is exactly that. Without the `` `? `` a pin over that enum silently compares a
  // subset and passes.
  const cases = [...body.matchAll(/case\s+`?(\w+)`?\s*=\s*(-?\d+)/g)].map(
    ([, name, raw]) => [name, Number(raw)] as const
  )
  if (cases.length === 0) throw new Error(`enum ${enumName} in ${relativePath} has no raw values`)
  return Object.fromEntries(cases) as Record<string, number>
}
