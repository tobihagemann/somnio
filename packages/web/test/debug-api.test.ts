import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell, element } from '@/ui'
import { installDebugAPI, makeDebugAPI } from '@/debugApi'

/**
 * The `window.somnio` introspection surface.
 *
 * It exists because a WebGL canvas is opaque to a DOM-driving agent: the panels and the chat input
 * are snapshot-able, but the character's position, the loaded sector, and whether a model resolved
 * are not. These assertions pin the shape agent recipes depend on, and the gating that keeps it off
 * a production page nobody asked to debug.
 */

describe('the debug API', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
    delete (window as unknown as Record<string, unknown>).somnio
  })

  function shell(): AppShell {
    return new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
    })
  }

  it('reports a disconnected session without throwing', () => {
    const api = makeDebugAPI(shell())

    expect(api.connectionState()).toBe('disconnected')
    expect(api.player()).toBeUndefined()
    expect(api.sectorName()).toBeUndefined()
    expect(api.entities()).toEqual([])
    expect(api.chatHistory()).toEqual([])
  })

  it('reports the local player once the entity stream has placed it', () => {
    const app = shell()
    app.controller.selfEntityIndex = 1
    app.controller.entities.set(1, {
      id: 1,
      kind: 'player',
      figure: 1,
      gender: 0,
      position: { x: 640, y: 480 },
      facing: 90,
      tempo: 2,
      maskSize: { width: 32, height: 48 },
      name: 'Tester',
    })

    expect(makeDebugAPI(app).player()).toEqual({
      x: 640,
      y: 480,
      facing: 90,
      tempo: 2,
      name: 'Tester',
    })
  })

  it('returns chat lines already localized, matching what the panel shows', () => {
    const app = shell()
    app.controller.appendChat({ kind: 'joined', playerName: 'Peer' })

    // An agent asserting on a chat line has to see the same text a player would, not a tag name.
    expect(makeDebugAPI(app).chatHistory()).toEqual(['Peer entered the game.'])
  })

  it('installs unconditionally in a dev build', () => {
    expect(installDebugAPI(shell(), { isDevelopment: true, search: '' })).toBe(true)
    expect((window as unknown as Record<string, unknown>).somnio).toBeDefined()
  })

  it('stays off a production page that did not ask for it', () => {
    // `entities()` reports every peer's name and position in the sector, which is more than the
    // rendered view gives away — so it is opt-in rather than always present.
    expect(installDebugAPI(shell(), { isDevelopment: false, search: '' })).toBe(false)
    expect((window as unknown as Record<string, unknown>).somnio).toBeUndefined()
  })

  it('installs in production when explicitly requested', () => {
    expect(installDebugAPI(shell(), { isDevelopment: false, search: '?debug=1' })).toBe(true)
  })
})
