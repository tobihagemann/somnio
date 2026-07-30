import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { element } from '@/ui/dom'

/**
 * The entry module's two document-level side effects.
 *
 * Only one of them is testable, and it is the one that matters: `document.documentElement.lang`.
 * Removing that assignment, or moving it above the locale resolution, leaves a German page
 * advertising `lang="en"` — every panel and chat line comes from the German table while a screen
 * reader pronounces them with English phonetics, and nothing else in the suite touches
 * `documentElement`. The build stamp needs no test here: only the `Web/Dockerfile` grep can observe
 * it, and that grep is the guard.
 *
 * `main.ts` is importable under `happy-dom` on two conditions, both arranged below: `#somnio-root`
 * has to exist (it throws otherwise, by design — a missing root is an unrecoverable page), and
 * `AppShell` has to take its `showWebGLUnavailable(); return` early exit, which it does because
 * happy-dom's `getContext('webgl2')` returns null. `SOMNIO_BUILD_STAMP` reaches the module through
 * `vitest.config.ts`'s `define`, the same way the app bundle gets it.
 *
 * A file of its own because an ES module is evaluated once per worker: `await import('@/main')` in a
 * suite that had already imported it would assert against a locale resolved before the stub below.
 */
describe('main', () => {
  const originalLanguages = navigator.languages

  beforeAll(() => {
    // German-first, so the assertion distinguishes "read from the resolved locale" from a hardcoded
    // `'en'` or from happy-dom's own default.
    Object.defineProperty(navigator, 'languages', { value: ['de-AT', 'en'], configurable: true })
    document.body.append(element('div', { attributes: { id: 'somnio-root' } }))
  })

  afterAll(() => {
    Object.defineProperty(navigator, 'languages', { value: originalLanguages, configurable: true })
  })

  it('advertises the resolved locale on the document element', async () => {
    expect(document.documentElement.lang).not.toBe('de')

    await import('@/main')

    expect(document.documentElement.lang).toBe('de')
  })
})
