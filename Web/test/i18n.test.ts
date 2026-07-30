import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_LOCALES,
  RENDERED_KEYS,
  browserCatalog,
  catalogCollisions,
  catalogTables,
  formatTemplate,
  mergeCatalogs,
  readXcstrings,
  renderChatLine,
  resolveLocale,
  translate,
} from '@/i18n'
import type { ChatLine } from '@/client'

/**
 * Port of the Swift targets' `LocalizableCatalogTests` discipline, with one addition.
 *
 * The Swift suites check an `expectedKeys` allowlist for en/de presence, placeholder parity, and the
 * no-Unicode-ellipsis rule — but nothing forces a newly rendered string *into* that allowlist, so a
 * key the author forgets to add ships unguarded. The source scan at the bottom closes that hole for
 * the browser client: it reads the UI sources and fails on any rendered key missing from
 * `RENDERED_KEYS`.
 */

// Resolved from the Vitest root (`Web/`) rather than from `import.meta.url`, which under the
// `happy-dom` environment is an http URL that `fileURLToPath` refuses.
const sourceDirectory = resolve(process.cwd(), 'src')

/** Placeholders in a template, normalized so `%@` and `%1$@` compare as the same requirement. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/%(\d+)\$@|%@/g)].map((match) =>
    match[1] === undefined ? '@' : `${match[1]}$@`
  )
}

describe('catalog coverage', () => {
  it.each(RENDERED_KEYS)('resolves %j in both locales', (key) => {
    for (const locale of CATALOG_LOCALES) {
      const value = catalogTables[locale][key]
      expect(value, `${key} is missing a ${locale} value`).toBeDefined()
      expect(value?.length ?? 0).toBeGreaterThan(0)
    }
  })

  /**
   * The two keys whose English value is *not* their own key, pinned by value.
   *
   * `readXcstrings` fills `tables.en[key] ??= key`, so the presence check above cannot tell a real
   * English string from that fallback: dropping the `en` unit for either of these ships the literal
   * key to every English player with the suite green. Every other rendered key is its own English
   * text, where the fallback is harmless.
   */
  it.each([
    ['Copyright', '© Copyright 2026 Tobias Hagemann'],
    ['Thanks paragraph', undefined],
  ] as const)('carries a real English value for %j', (key, expected) => {
    const value = catalogTables.en[key]
    expect(value).toBeDefined()
    expect(value).not.toBe(key)
    if (expected !== undefined) expect(value).toBe(expected)
  })

  it.each(RENDERED_KEYS)('keeps placeholders in parity for %j', (key) => {
    const english = catalogTables.en[key] ?? key
    const german = catalogTables.de[key] ?? key
    // A German string that drops a placeholder renders the argument nowhere; one that adds a
    // placeholder renders a literal `%@` to the player.
    expect(placeholders(german).sort()).toEqual(placeholders(english).sort())
  })

  it.each(RENDERED_KEYS)('uses ASCII ellipsis in %j', (key) => {
    for (const locale of CATALOG_LOCALES) {
      expect(catalogTables[locale][key] ?? '').not.toContain('\u2026')
    }
  })

  it('has no key defined by more than one catalog', () => {
    // Merge order is Core, UI, App, browser with later winning. A collision means two catalogs
    // disagree about the same English key and the winner is decided by import order — which is
    // exactly the silent outcome this assertion exists to prevent.
    expect(catalogCollisions).toEqual([])
  })

  it('reads the shipped Swift catalogs rather than a copy', () => {
    // Pinned against the real German in `Sources/SomnioUI/Resources/Localizable.xcstrings`. If the
    // build alias silently stopped resolving, every lookup would fall back to its English key and
    // this is the assertion that notices.
    expect(translate('de', 'The connection was lost.')).not.toBe('The connection was lost.')
    expect(translate('de', 'Leave Game')).toBe('Spiel verlassen')
  })

  it('falls back to the English key for an unknown lookup', () => {
    // Safe only because catalog keys *are* the English source strings.
    expect(translate('de', 'Not A Catalog Key')).toBe('Not A Catalog Key')
  })
})

describe('the browser-owned catalog', () => {
  it('translates every one of its own keys into German', () => {
    for (const key of Object.keys(browserCatalog.en)) {
      expect(browserCatalog.de[key], `${key} has no German`).toBeDefined()
    }
  })

  it('covers the six browser-only surfaces the Swift catalogs cannot', () => {
    const keys = Object.keys(browserCatalog.en)
    expect(keys).toContain('This browser cannot render 3D graphics.')
    expect(keys).toContain('Somnio needs a desktop computer.')
    expect(keys).toContain('Loading the world...')
    expect(keys).toContain('Fullscreen')
    expect(keys).toContain('Your session expired. Please log in again.')
    expect(keys).toContain('Reconnecting...')
  })
})

describe('readXcstrings', () => {
  it('records the key as its own English value when the catalog has no en unit', () => {
    const tables = readXcstrings({
      strings: { 'Bare Key': { localizations: { de: { stringUnit: { value: 'Nackter Key' } } } } },
    })

    expect(tables.en['Bare Key']).toBe('Bare Key')
    expect(tables.de['Bare Key']).toBe('Nackter Key')
  })

  it('omits a locale with no stringUnit rather than mapping it to the empty string', () => {
    const tables = readXcstrings({ strings: { Orphan: { localizations: {} } } })

    // A blank label is far harder to notice than an untranslated one, so the lookup has to fall
    // through to English instead of finding an empty value.
    expect(tables.de.Orphan).toBeUndefined()
  })
})

describe('mergeCatalogs', () => {
  it('lets the later catalog win and reports the collision', () => {
    const first = { en: { Shared: 'Shared' }, de: { Shared: 'Erst' } }
    const second = { en: { Shared: 'Shared' }, de: { Shared: 'Zweit' } }

    const merged = mergeCatalogs([first, second])

    expect(merged.tables.de.Shared).toBe('Zweit')
    expect(merged.collisions).toEqual(['Shared'])
  })
})

describe('formatTemplate', () => {
  it('substitutes bare placeholders in order', () => {
    expect(formatTemplate('%@ and %@', ['a', 'b'])).toBe('a and b')
  })

  it('honours positional placeholders', () => {
    expect(formatTemplate('%2$@ before %1$@', ['second', 'first'])).toBe('first before second')
  })

  it('does not re-scan a substituted argument as a placeholder', () => {
    // A player-supplied name containing `%@` would otherwise consume the next argument — a
    // format-string injection reachable from any chat message.
    expect(formatTemplate('%1$@ says, "%2$@"', ['%@', 'hi'])).toBe('%@ says, "hi"')
  })

  it('leaves a placeholder with no argument alone rather than rendering undefined', () => {
    expect(formatTemplate('%@ and %@', ['only'])).toBe('only and %@')
  })

  it('unescapes a literal percent', () => {
    expect(formatTemplate('100%% done', [])).toBe('100% done')
  })
})

describe('resolveLocale', () => {
  it.each([
    [['de'], 'de'],
    [['de-AT'], 'de'],
    [['DE-CH'], 'de'],
    [['en-GB', 'de'], 'en'],
    [['fr'], 'en'],
    [[], 'en'],
    // Three-letter codes that merely *begin* with a bundled one. `den` is Slavey and `eng` is a
    // valid ISO 639-2 alpha-3 for English that this app does not advertise; a prefix match would
    // claim both. The primary subtag is compared whole.
    [['den'], 'en'],
    [['enm'], 'en'],
    [['den', 'de'], 'de'],
  ])('maps %j to %s', (tags, expected) => {
    expect(resolveLocale(tags)).toBe(expected)
  })
})

describe('renderChatLine', () => {
  const lines: ChatLine[] = [
    { kind: 'spokenByOwn', senderName: 'Ich', message: 'Hallo' },
    { kind: 'spokenByPeer', senderName: 'Peer', message: 'Was?' },
    { kind: 'spokenByNPC', senderName: 'Wirt', message: 'Halt!' },
    { kind: 'adminBroadcast', message: 'Wartung' },
    { kind: 'connectionLost' },
    { kind: 'serverUnreachable' },
    { kind: 'badCredentials' },
    { kind: 'alreadyLoggedIn' },
    { kind: 'errorCode', code: 'client_only_tag' },
    { kind: 'joined', playerName: 'Peer' },
    { kind: 'left', playerName: 'Peer' },
    { kind: 'startupGreeting' },
    { kind: 'purseBalance', coins: 42 },
    { kind: 'credentialSaveFailed' },
    { kind: 'sessionExpired' },
    { kind: 'reconnecting' },
  ]

  it.each(lines)('renders %j in both locales without leaking a placeholder', (line) => {
    for (const locale of CATALOG_LOCALES) {
      const rendered = renderChatLine(line, catalogTables, locale)
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered).not.toContain('%@')
      expect(rendered).not.toContain('$@')
    }
  })

  it('selects the verb from the trailing punctuation', () => {
    const asks = renderChatLine(
      { kind: 'spokenByPeer', senderName: 'Peer', message: 'Wo?' },
      catalogTables,
      'de'
    )
    const says = renderChatLine(
      { kind: 'spokenByPeer', senderName: 'Peer', message: 'Da.' },
      catalogTables,
      'de'
    )

    expect(asks).not.toBe(says)
  })

  it('substitutes the sender and message in the right order', () => {
    const rendered = renderChatLine(
      { kind: 'spokenByPeer', senderName: 'Alice', message: 'Bob' },
      catalogTables,
      'en'
    )

    // Both arguments are single words, so a swapped positional order would still read plausibly —
    // asserting on the exact string is the only way to catch it.
    expect(rendered).toBe('Alice says, "Bob"')
  })
})

describe('the rendered-key allowlist', () => {
  /**
   * Every `.ts` file under `src`, walked recursively.
   *
   * The whole tree rather than `src/ui` plus the chat renderer, because the complementary assertion
   * below — no allowlisted key that nothing renders — makes the narrow scan actively hazardous: a
   * string rendered from `src/client` or `src/scene` is invisible to the scan, so adding it to the
   * allowlist *fails* while leaving it out ships it unguarded, with no en/de, placeholder-parity, or
   * ellipsis check. The unguarded shape was the one that passed.
   */
  function sourceFiles(directory = sourceDirectory): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith('.ts') ? [path] : []
    })
  }

  /**
   * Comments are stripped first. Without that, a doc comment mentioning `t('...')` — which the
   * helpers here do, to explain why they take localized text rather than keys — is scanned as a
   * rendered key and the check fails on its own prose.
   */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  }

  /** Every first-argument string literal passed to `t(...)` or the chat renderer's `lookup(...)`. */
  function renderedKeysInSources(): Map<string, string[]> {
    const found = new Map<string, string[]>()
    for (const path of sourceFiles()) {
      const source = withoutComments(readFileSync(path, 'utf8'))
      for (const match of source.matchAll(/\b(?:t|lookup)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const key = (match[2] ?? '').replace(/\\(['"\\])/g, '$1')
        found.set(key, [...(found.get(key) ?? []), path])
      }
    }
    return found
  }

  it('finds keys to check, so a broken scan cannot pass vacuously', () => {
    expect(renderedKeysInSources().size).toBeGreaterThan(20)
  })

  it('lists every key the UI sources render', () => {
    const allowed = new Set(RENDERED_KEYS)
    const missing = [...renderedKeysInSources().keys()].filter((key) => !allowed.has(key)).sort()

    // This is the assertion the Swift allowlists cannot make: a new user-facing string that never
    // reached the allowlist would otherwise ship with no en/de or placeholder guard at all.
    expect(missing, 'add these to RENDERED_KEYS in src/i18n/index.ts').toEqual([])
  })

  it('has no allowlisted key that nothing renders', () => {
    // Chat lines are rendered through the switch in `chatLineText.ts`, class and gender labels
    // through the registration form's tables, so every entry has a real call site. A leftover key
    // means the allowlist is guarding something the player can no longer see.
    //
    // One filter suffices: `renderedKeysInSources` covers `chatLineText.ts` along with the rest of
    // `src`, and its regex matches `lookup(...)` as well as `t(...)`, so a separate chat-key pass
    // would be a subset of this one.
    const rendered = new Set(renderedKeysInSources().keys())
    const stale = RENDERED_KEYS.filter((key) => !rendered.has(key))

    expect(stale).toEqual([])
  })
})
