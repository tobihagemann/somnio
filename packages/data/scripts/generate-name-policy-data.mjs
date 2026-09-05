#!/usr/bin/env node
// Dev-only generator for the pinned Unicode data behind the name policy.
//
// Run manually (NOT in CI) whenever the pinned Unicode version is bumped:
//
//     node packages/data/scripts/generate-name-policy-data.mjs [inputDir] [outputDir]
//
// With no arguments it downloads the seven source files from unicode.org at the pinned version
// into a temp dir and writes the JSON tables into packages/data/data/name-policy. Pass `inputDir`
// to read already-downloaded files from disk instead.
//
// Sources (all read at the SAME pinned version):
//   - confusables.txt          (security/<v>/)   TR39 confusable prototype map
//   - IdentifierStatus.txt     (security/<v>/)   Identifier_Status=Allowed set
//   - IdentifierType.txt       (security/<v>/)   downloaded for provenance, never parsed
//   - Scripts.txt              (<v>/ucd/)        primary Script per code point
//   - ScriptExtensions.txt     (<v>/ucd/)        Script_Extensions per code point
//   - PropertyValueAliases.txt (<v>/ucd/)        sc short<->long alias map (unifies the two spellings)
//   - UnicodeData.txt          (<v>/ucd/)        General_Category per code point (letters, marks, digits)
//
// A Unicode bump changes computed skeletons, so it is a migration that recomputes every stored
// `name_skeleton` row, and SKELETON_ALGORITHM_VERSION goes up with it.

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNICODE_VERSION = '15.1.0'
const SECURITY_FILES = ['confusables.txt', 'IdentifierStatus.txt', 'IdentifierType.txt']
const UCD_FILES = ['Scripts.txt', 'ScriptExtensions.txt', 'PropertyValueAliases.txt', 'UnicodeData.txt']
/** The general categories the name shape admits: letters, marks, and decimal digits. */
const NAME_CATEGORIES = new Set(['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd'])

const [, , explicitInputDir, explicitOutputDir] = process.argv
const outputDir =
  explicitOutputDir ?? resolve(fileURLToPath(new URL('../data/name-policy/', import.meta.url)))

async function loadSources() {
  const contents = {}
  if (explicitInputDir !== undefined) {
    for (const name of [...SECURITY_FILES, ...UCD_FILES]) {
      contents[name] = await readFile(join(explicitInputDir, name), 'utf8')
    }
    return contents
  }
  const directory = await mkdtemp(join(tmpdir(), 'somnio-unicode-'))
  const fetchInto = async (base, name) => {
    const response = await fetch(`${base}${name}`)
    if (!response.ok) throw new Error(`${base}${name}: HTTP ${response.status}`)
    const text = await response.text()
    await writeFile(join(directory, name), text)
    contents[name] = text
  }
  for (const name of SECURITY_FILES)
    await fetchInto(`https://www.unicode.org/Public/security/${UNICODE_VERSION}/`, name)
  for (const name of UCD_FILES)
    await fetchInto(`https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/`, name)
  return contents
}

/** Cuts the line at its first `#` and trims. Returns undefined for blank/comment lines. */
function dataFields(line) {
  const withoutComment = line.split('#', 1)[0].trim()
  if (withoutComment.length === 0) return undefined
  return withoutComment.split(';').map((field) => field.trim())
}

/** Parses `XXXX` or `XXXX..YYYY` into an inclusive `[start, end]` code-point pair. */
function parseRange(field) {
  const [start, end] = field.split('..')
  const from = parseInt(start, 16)
  if (Number.isNaN(from)) return undefined
  const to = end === undefined ? from : parseInt(end, 16)
  return Number.isNaN(to) ? undefined : [from, to]
}

const hex = (value) => value.toString(16).toUpperCase()
const lines = (text) => text.split('\n')

const sources = await loadSources()

// --- Script short<->long alias map (sc property) ---
const shortToLong = new Map()
const longNames = new Set()
for (const line of lines(sources['PropertyValueAliases.txt'])) {
  const fields = dataFields(line)
  if (fields === undefined || fields.length < 3 || fields[0] !== 'sc') continue
  shortToLong.set(fields[1], fields[2])
  longNames.add(fields[2])
}
const canonicalScript = (token) => (longNames.has(token) ? token : (shortToLong.get(token) ?? token))

// --- Confusables (drop identity mappings) ---
const confusableEntries = []
for (const line of lines(sources['confusables.txt'])) {
  const fields = dataFields(line)
  if (fields === undefined || fields.length < 2) continue
  const source = parseInt(fields[0], 16)
  if (Number.isNaN(source)) continue
  const targets = fields[1]
    .split(' ')
    .map((token) => parseInt(token, 16))
    .filter((value) => !Number.isNaN(value))
  if (targets.length === 0) continue
  if (targets.length === 1 && targets[0] === source) continue
  confusableEntries.push([source, targets])
}
confusableEntries.sort((a, b) => a[0] - b[0])

// --- Primary Script ranges ---
const scriptRanges = []
for (const line of lines(sources['Scripts.txt'])) {
  const fields = dataFields(line)
  if (fields === undefined || fields.length < 2) continue
  const range = parseRange(fields[0])
  if (range === undefined) continue
  const script = canonicalScript(fields[1])
  scriptRanges.push([range[0], range[1], script])
  longNames.add(script)
}
scriptRanges.sort((a, b) => a[0] - b[0])

// --- Script_Extensions ranges ---
const scriptExtensionRanges = []
for (const line of lines(sources['ScriptExtensions.txt'])) {
  const fields = dataFields(line)
  if (fields === undefined || fields.length < 2) continue
  const range = parseRange(fields[0])
  if (range === undefined) continue
  const scripts = fields[1].split(' ').map(canonicalScript)
  for (const script of scripts) longNames.add(script)
  scriptExtensionRanges.push([range[0], range[1], scripts])
}
scriptExtensionRanges.sort((a, b) => a[0] - b[0])

// --- Identifier_Status=Allowed ranges ---
const allowedRanges = []
for (const line of lines(sources['IdentifierStatus.txt'])) {
  const fields = dataFields(line)
  if (fields === undefined || fields.length < 2 || fields[1] !== 'Allowed') continue
  const range = parseRange(fields[0])
  if (range === undefined) continue
  allowedRanges.push(range)
}
allowedRanges.sort((a, b) => a[0] - b[0])

// --- General_Category ranges for the name-shape categories ---
// UnicodeData.txt lists one code point per line, except `<..., First>` / `<..., Last>` pairs that
// bracket a range. Adjacent code points with the same category are merged into one range.
const categoryRanges = []
let pendingFirst
let last
for (const line of lines(sources['UnicodeData.txt'])) {
  if (line.trim().length === 0) continue
  const fields = line.split(';')
  const code = parseInt(fields[0], 16)
  const name = fields[1]
  const category = fields[2]
  let start = code
  let end = code
  if (name.endsWith(', First>')) {
    pendingFirst = code
    continue
  }
  if (name.endsWith(', Last>')) {
    start = pendingFirst
    pendingFirst = undefined
  }
  if (!NAME_CATEGORIES.has(category)) continue
  if (last !== undefined && last.category === category && last.end + 1 === start) {
    last.end = end
    continue
  }
  last = { start, end, category }
  categoryRanges.push(last)
}

// --- Stable script id assignment ---
const sortedScriptNames = [...longNames].sort()
const scriptID = new Map(sortedScriptNames.map((name, index) => [name, index]))

const confusables = {
  mappingTable: confusableEntries
    .map(([source, targets]) => `${hex(source)}>${targets.map(hex).join(' ')}`)
    .join(';'),
}
const scripts = {
  scriptNames: sortedScriptNames.join(';'),
  scriptRanges: scriptRanges
    .map(([start, end, script]) => `${hex(start)} ${hex(end)} ${scriptID.get(script)}`)
    .join(';'),
  scriptExtensionRanges: scriptExtensionRanges
    .map(
      ([start, end, names]) =>
        `${hex(start)} ${hex(end)} ${names.map((name) => scriptID.get(name)).join(',')}`
    )
    .join(';'),
}
const identifierProfile = {
  allowedRanges: allowedRanges.map(([start, end]) => `${hex(start)} ${hex(end)}`).join(';'),
}
const generalCategories = {
  ranges: categoryRanges.map(({ start, end, category }) => `${hex(start)} ${hex(end)} ${category}`).join(';'),
}
const version = { unicode: UNICODE_VERSION }

await mkdir(outputDir, { recursive: true })
const write = async (name, value) => {
  const path = join(outputDir, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  console.log(`wrote ${path}`)
}
await write('confusables.json', confusables)
await write('scripts.json', scripts)
await write('identifier-profile.json', identifierProfile)
await write('general-categories.json', generalCategories)
await write('version.json', version)

console.log(`confusable entries: ${confusableEntries.length}`)
console.log(
  `script ranges: ${scriptRanges.length}, extension ranges: ${scriptExtensionRanges.length}, scripts: ${sortedScriptNames.length}`
)
console.log(`allowed ranges: ${allowedRanges.length}, category ranges: ${categoryRanges.length}`)
