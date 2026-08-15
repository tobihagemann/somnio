import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Reads a Swift `static let name = <number>` straight out of the source file. Sibling of
 * `swiftEnumCases`, for plain numeric constants.
 *
 * The digit group is `-?[\d.]+`, not `\d+`: the rig's constants include `0.05` and `0.02`, and an
 * integer-only pattern silently matches the leading `0` of a float rather than failing.
 */
export function swiftStaticLet(relativePath: string, name: string): number {
  const source = readFileSync(resolve(process.cwd(), '..', relativePath), 'utf8')
  const match = new RegExp(`static let ${name}\\s*(?::\\s*\\w+)?\\s*=\\s*(-?[\\d.]+)`).exec(source)
  if (match === null) throw new Error(`no static let ${name} in ${relativePath}`)
  return Number(match[1])
}
