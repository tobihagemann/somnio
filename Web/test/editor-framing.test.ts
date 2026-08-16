import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ORTHO_RIG, PLAYER_ZOOM, legacyPoint, worldPosition } from '@/scene/cameraRig'
import {
  EditorCamera,
  applyFramingToCamera,
  editorFramingFitting,
  editorFramingFittingPixelBounds,
  fitPixelBounds,
  playerZoomScale,
  scrollIntent,
} from '@/editor/framing'
import type { EditorFraming } from '@/editor/framing'
import { gridPoint } from '@/editor/canvasController'
import { floorPixelAtScreen, screenAtFloorPixel } from '@/editor/picking'
import type { ViewportSize } from '@/editor/picking'
import { quantize } from '@/editor/preferences'
import { readSectorFile } from '@/core/sectorFile'
import type { Sector } from '@/core/sector'
import { readSectorFixture } from './helpers/sectorFixture'

/**
 * The camera math: the project→unproject round trip, the whole-sector fit, the fit's
 * independence from the gameplay zoom clamp, the player-zoom opening framing, pan/zoom,
 * custom-camera persistence, and the scroll-intent cases. The unprojection here is the live Raycaster
 * against the camera the framing was applied to, so these also pin that the Three.js
 * projection agrees with the ported analytic fit math.
 */

const VIEWPORT: ViewportSize = { width: 640, height: 480 }

function cameraFor(framing: EditorFraming, viewport: ViewportSize = VIEWPORT): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera()
  applyFramingToCamera(camera, framing, viewport)
  return camera
}

function testSector(overrides: Partial<Sector> = {}): Sector {
  return {
    name: 'Test',
    version: 1,
    dimensions: { width: 12, height: 12 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
    ...overrides,
  }
}

describe('gridPoint', () => {
  const framing = editorFramingFittingPixelBounds({ x: 0, y: 0 }, { x: 512, y: 512 }, VIEWPORT)
  const camera = cameraFor(framing)

  it('resolves a tap at a pixel projected viewport point to that grid cell', () => {
    // Mid-pixel targets, as real taps are: the unprojection floors to the containing pixel.
    const tap = screenAtFloorPixel(camera, VIEWPORT, { x: 128.5, y: 96.5 })
    expect(gridPoint(camera, VIEWPORT, tap)).toEqual({ x: 128, y: 96 })
  })

  it('resolves a tap inside an overflow footprint to negative coordinates', () => {
    const overflowFraming = editorFramingFittingPixelBounds({ x: 0, y: -48 }, { x: 512, y: 512 }, VIEWPORT)
    const overflowCamera = cameraFor(overflowFraming)
    const tap = screenAtFloorPixel(overflowCamera, VIEWPORT, { x: 32.5, y: -40.5 })
    expect(gridPoint(overflowCamera, VIEWPORT, tap)).toEqual({ x: 32, y: -41 })
  })

  it('floors fractional pixels downward', () => {
    const tap = screenAtFloorPixel(camera, VIEWPORT, { x: 200.9, y: 300.4 })
    expect(gridPoint(camera, VIEWPORT, tap)).toEqual({ x: 200, y: 300 })
  })

  it('resolves a tap outside the sector bounds without throwing', () => {
    const grid = gridPoint(camera, VIEWPORT, { x: 0, y: 0 })
    const insideSector = grid.x >= 0 && grid.x < 512 && grid.y >= 0 && grid.y < 512
    expect(insideSector).toBe(false)
  })

  it('quantizes the unprojected pixel with the unchanged grid snap', () => {
    const tap = screenAtFloorPixel(camera, VIEWPORT, { x: 140.5, y: 70.5 })
    const grid = gridPoint(camera, VIEWPORT, tap)
    expect(quantize(grid.x, 32)).toBe(128)
    expect(quantize(grid.y, 32)).toBe(64)
  })
})

describe('project then unproject', () => {
  const framing = editorFramingFittingPixelBounds({ x: 0, y: 0 }, { x: 512, y: 512 }, VIEWPORT)
  const camera = cameraFor(framing)

  it.each([
    [0, 0],
    [128.5, 96.5],
    [511, 511],
    [-64, -48],
    [200.9, 300.4],
  ])('returns the same legacy pixel for (%s, %s)', (x, y) => {
    const screen = screenAtFloorPixel(camera, VIEWPORT, { x, y })
    const restored = floorPixelAtScreen(camera, VIEWPORT, screen)
    expect(Math.hypot(restored.x - x, restored.y - y)).toBeLessThan(0.1)
  })

  it('unprojects the viewport center to the framed bounds center', () => {
    const center = floorPixelAtScreen(camera, VIEWPORT, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 })
    expect(Math.hypot(center.x - 256, center.y - 256)).toBeLessThan(0.1)
  })

  it('lands on the floor plane the renderer places on', () => {
    const pixel = { x: 300.5, y: 200.5 }
    const screen = screenAtFloorPixel(camera, VIEWPORT, pixel)
    const restored = floorPixelAtScreen(camera, VIEWPORT, screen)
    const world = worldPosition(restored.x, restored.y)
    const expected = worldPosition(pixel.x, pixel.y)
    expect(Math.hypot(world.x - expected.x, world.z - expected.z)).toBeLessThan(0.01)
    expect(world.y).toBe(0)
  })
})

describe('whole-sector fit', () => {
  const fixtureNames = [
    'EdariaArena',
    'EdariaBibliothek',
    'EdariaInn',
    'EdariaMitte',
    'EdariaShop',
    'Nordwald',
    'Nordwiese',
  ]
  /** Extreme aspects alongside the play-field default. */
  const viewports: ViewportSize[] = [
    { width: 640, height: 480 },
    { width: 1600, height: 400 },
    { width: 400, height: 1200 },
  ]

  it.each(fixtureNames.flatMap((name) => viewports.map((viewport) => [name, viewport] as const)))(
    "%s's floor and footprints project inside a %o viewport",
    (name, viewport) => {
      const sector = readSectorFile(readSectorFixture(name), name)
      const framing = editorFramingFitting(sector, viewport)
      const camera = cameraFor(framing, viewport)
      const extremes = [
        { x: 0, y: 0 },
        { x: sector.dimensions.width * 128, y: 0 },
        { x: 0, y: sector.dimensions.height * 128 },
        { x: sector.dimensions.width * 128, y: sector.dimensions.height * 128 },
        ...sector.objects.flatMap((object) => [
          { x: object.x, y: object.y },
          { x: object.x + object.sourceWidth, y: object.y + object.sourceHeight },
          { x: object.x, y: object.y + object.sourceHeight },
          { x: object.x + object.sourceWidth, y: object.y },
        ]),
      ]
      const tolerance = 0.01
      for (const pixel of extremes) {
        const projected = screenAtFloorPixel(camera, viewport, pixel)
        expect(projected.x).toBeGreaterThanOrEqual(-tolerance)
        expect(projected.x).toBeLessThanOrEqual(viewport.width + tolerance)
        expect(projected.y).toBeGreaterThanOrEqual(-tolerance)
        expect(projected.y).toBeLessThanOrEqual(viewport.height + tolerance)
      }
      // Containment alone is one-sided (any too-zoomed-out fit passes): a fit-bounds corner
      // must land ON a viewport edge.
      const bounds = fitPixelBounds(sector)
      const corners = [
        bounds.min,
        { x: bounds.max.x, y: bounds.min.y },
        { x: bounds.min.x, y: bounds.max.y },
        bounds.max,
      ]
      const touches = corners.some((pixel) => {
        const projected = screenAtFloorPixel(camera, viewport, pixel)
        return (
          Math.abs(projected.x) <= tolerance ||
          Math.abs(projected.x - viewport.width) <= tolerance ||
          Math.abs(projected.y) <= tolerance ||
          Math.abs(projected.y - viewport.height) <= tolerance
        )
      })
      expect(touches).toBe(true)
    }
  )

  it('is not clamped to the gameplay zoom bounds', () => {
    const sector = testSector({ dimensions: { width: 24, height: 24 } })
    const framing = editorFramingFitting(sector, VIEWPORT)
    expect(framing.scale).toBeGreaterThan(ORTHO_RIG.maxScale)
  })

  it('widens for object footprints past the sector edge', () => {
    const bare = editorFramingFittingPixelBounds({ x: 0, y: 0 }, { x: 512, y: 512 }, VIEWPORT)
    const widened = editorFramingFittingPixelBounds({ x: 0, y: -48 }, { x: 512, y: 512 }, VIEWPORT)
    expect(widened.scale).toBeGreaterThan(bare.scale)
    const camera = cameraFor(widened)
    const shelfCorner = screenAtFloorPixel(camera, VIEWPORT, { x: 0, y: -48 })
    expect(shelfCorner.x).toBeGreaterThanOrEqual(0)
    expect(shelfCorner.y).toBeGreaterThanOrEqual(0)
  })

  it('falls back to the default scale for a degenerate viewport', () => {
    const framing = editorFramingFittingPixelBounds(
      { x: 0, y: 0 },
      { x: 512, y: 512 },
      { width: 0, height: 0 }
    )
    expect(framing.scale).toBe(ORTHO_RIG.defaultScale)
  })
})

describe('playerZoomScale', () => {
  it('tracks viewport height and guards a degenerate one', () => {
    expect(playerZoomScale(480)).toBe(ORTHO_RIG.defaultScale)
    expect(playerZoomScale(960)).toBe(ORTHO_RIG.defaultScale * 2)
    expect(playerZoomScale(0)).toBe(ORTHO_RIG.defaultScale)
  })
})

describe('scrollIntent', () => {
  it('routes command scroll to zoom with raw deltas', () => {
    expect(
      scrollIntent({ deltaX: 0, deltaY: 3, hasPreciseDeltas: false, commandHeld: true, shiftHeld: false })
    ).toEqual({ kind: 'zoom', deltaY: 3 })
    expect(
      scrollIntent({ deltaX: 0, deltaY: 3, hasPreciseDeltas: true, commandHeld: true, shiftHeld: false })
    ).toEqual({ kind: 'zoom', deltaY: 3 })
  })

  it('routes plain scroll to a two-axis pan', () => {
    expect(
      scrollIntent({ deltaX: 4, deltaY: -2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: false })
    ).toEqual({ kind: 'pan', delta: { width: 4, height: -2 } })
  })

  it('turns a mouse wheel vertical tick horizontal with shift', () => {
    expect(
      scrollIntent({ deltaX: 0, deltaY: 2, hasPreciseDeltas: false, commandHeld: false, shiftHeld: true })
    ).toEqual({ kind: 'pan', delta: { width: 20, height: 0 } })
    // A trackpad already pans both axes; Shift must not clobber a real horizontal delta.
    expect(
      scrollIntent({ deltaX: 3, deltaY: 2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: true })
    ).toEqual({ kind: 'pan', delta: { width: 3, height: 2 } })
  })
})

describe('EditorCamera', () => {
  function makeCamera(sector: Sector): EditorCamera {
    const camera = new EditorCamera(new THREE.OrthographicCamera())
    camera.refreshFraming(sector)
    return camera
  }

  it('opens sector-centered at the player zoom', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    expect(camera.framing.scale).toBe(ORTHO_RIG.defaultScale)
    const fit = editorFramingFitting(sector, camera.viewportSize)
    expect(camera.framing.focus).toEqual(fit.focus)
  })

  it('zooming out stops at the player minimum magnification and keeps the pan', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    camera.pan({ width: 200, height: 200 }, sector)
    const panned = camera.framing.focus
    camera.zoom(-500, sector)
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.minFactor, 5)
    expect(camera.framing.focus).toEqual(panned)
  })

  it('zooming back in stops at the player maximum close-up', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    camera.zoom(-500, sector)
    camera.zoom(2000, sector)
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.maxFactor, 5)
  })

  it('pans the focus to where the shifted center lands and clamps to the fit extent', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    const opening = structuredClone(camera.framing)
    camera.pan({ width: 0, height: 120 }, sector)
    expect(camera.framing.focus).not.toEqual(opening.focus)
    // A huge pan pins the focus to the fit-extent edge instead of leaving the sector.
    camera.pan({ width: 100_000, height: 100_000 }, sector)
    const bounds = fitPixelBounds(sector)
    const focusPixel = legacyPoint(camera.framing.focus)
    expect(focusPixel.x).toBeGreaterThanOrEqual(bounds.min.x - 0.01)
    expect(focusPixel.x).toBeLessThanOrEqual(bounds.max.x + 0.01)
    expect(focusPixel.y).toBeGreaterThanOrEqual(bounds.min.y - 0.01)
    expect(focusPixel.y).toBeLessThanOrEqual(bounds.max.y + 0.01)
  })

  it('keeps the player magnification through a viewport resize', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    camera.updateViewportSize({ width: 1280, height: 960 }, sector)
    expect(camera.framing.scale).toBe(playerZoomScale(960))
    const fit = editorFramingFitting(sector, camera.viewportSize)
    expect(camera.framing.focus).toEqual(fit.focus)
  })

  it('preserves the user pan and zoom through a viewport resize', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    camera.zoom(-50, sector)
    camera.pan({ width: 40, height: 40 }, sector)
    const custom = structuredClone(camera.framing)
    camera.updateViewportSize({ width: 1280, height: 480 }, sector)
    // The zoom factor survives, so the scale re-derives from the same factor over the new
    // height; the focus is untouched (the viewport height did not change here).
    expect(camera.framing.focus).toEqual(custom.focus)
    expect(camera.framing.scale).toBe(custom.scale)
  })

  it('ignores a degenerate or unchanged viewport size', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    const before = structuredClone(camera.framing)
    camera.updateViewportSize({ width: 0, height: 0 }, sector)
    camera.updateViewportSize(camera.viewportSize, sector)
    expect(camera.framing).toEqual(before)
  })

  it('preserves the user pan and zoom through a reconcile', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    camera.zoom(-100, sector)
    camera.pan({ width: 40, height: 40 }, sector)
    const custom = structuredClone(camera.framing)
    camera.refreshFraming(sector)
    expect(camera.framing).toEqual(custom)
  })

  it('keeps the opening framing through a reconcile without user navigation', () => {
    const sector = testSector()
    const camera = makeCamera(sector)
    const opening = structuredClone(camera.framing)
    camera.refreshFraming(sector)
    expect(camera.framing).toEqual(opening)
  })

  it('opens a sector smaller than the player view at the player zoom', () => {
    const tiny = testSector({ dimensions: { width: 1, height: 1 } })
    const camera = makeCamera(tiny)
    const fit = editorFramingFitting(tiny, camera.viewportSize)
    expect(fit.scale).toBeLessThan(ORTHO_RIG.defaultScale)
    expect(camera.framing.scale).toBe(ORTHO_RIG.defaultScale)
    expect(camera.framing.focus).toEqual(fit.focus)
    camera.zoom(2000, tiny)
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.maxFactor, 5)
  })
})
