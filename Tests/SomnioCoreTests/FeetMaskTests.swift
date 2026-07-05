import SomnioCore
import Testing

struct FeetMaskTests {
    @Test func `rect is a bottom-aligned full-width sub-rect of the sprite cell`() {
        // Player sprite 32x48: feetHeight = 48/4 + 4 = 16, feet origin y = y + 48 - 16 = y + 32.
        let feet = FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 200), spriteSize: GridSize(width: 32, height: 48))
        #expect(feet.x == 100)
        #expect(feet.y == 232)
        #expect(feet.width == 32)
        #expect(feet.height == 16)
    }

    @Test func `center is the feet box midpoint, well below the sprite top`() {
        let center = FeetMask.center(forSpriteAt: GridPoint(x: 100, y: 200), spriteSize: GridSize(width: 32, height: 48))
        #expect(center.x == 116)
        #expect(center.y == 240)
    }

    @Test func `a mask over the head row does not collide, a mask over the feet row does`() {
        // Sprite at (100, 200): head row y 200-248, feet box y 232-248. A mask high on the head
        // (y 200-216) misses the feet box; a mask in the feet row (y 232-248) overlaps it.
        let feet = FeetMask.rect(forSpriteAt: GridPoint(x: 100, y: 200), spriteSize: GridSize(width: 32, height: 48))
        let headMask = CollisionMask(x: 100, y: 200, width: 32, height: 16)
        let feetMask = CollisionMask(x: 100, y: 232, width: 32, height: 16)
        #expect(CollisionMaskOverlap.intersects(feet, [headMask]) == false)
        #expect(CollisionMaskOverlap.intersects(feet, [feetMask]) == true)
    }

    @Test func `overlaps treats right and bottom edges as exclusive`() {
        let a = PixelRect(x: 0, y: 0, width: 10, height: 10)
        // Flush along the right edge (b starts at a.maxX) — no overlap.
        #expect(CollisionMaskOverlap.overlaps(a, PixelRect(x: 10, y: 0, width: 5, height: 5)) == false)
        // One pixel of horizontal overlap.
        #expect(CollisionMaskOverlap.overlaps(a, PixelRect(x: 9, y: 0, width: 5, height: 5)) == true)
        // Flush along the bottom edge — no overlap.
        #expect(CollisionMaskOverlap.overlaps(a, PixelRect(x: 0, y: 10, width: 5, height: 5)) == false)
    }

    @Test func `clamped keeps the feet box inside the sector at every edge`() {
        // 4x4 tiles = 512x512 px; player 32x48 -> maxX = 512-32 = 480, maxY = 512-48 = 464,
        // minY = feetHeight(16) - 48 = -32 (feet flush against the top edge).
        let sector = Sector(
            body: SectorBody(
                version: 1,
                dimensions: GridSize(width: 4, height: 4),
                floorMaterialID: "grass-meadow",
                light: LightSetting(indoor: false, brightness: 100)
            ),
            name: "Test"
        )
        let sprite = GridSize(width: 32, height: 48)
        #expect(FeetMask.clamped(GridPoint(x: 600, y: 100), spriteSize: sprite, sector: sector).x == 480)
        #expect(FeetMask.clamped(GridPoint(x: -50, y: 100), spriteSize: sprite, sector: sector).x == 0)
        #expect(FeetMask.clamped(GridPoint(x: 100, y: 600), spriteSize: sprite, sector: sector).y == 464)
        #expect(FeetMask.clamped(GridPoint(x: 100, y: -100), spriteSize: sprite, sector: sector).y == -32)
        // An in-bounds point is unchanged.
        #expect(FeetMask.clamped(GridPoint(x: 100, y: 100), spriteSize: sprite, sector: sector) == GridPoint(x: 100, y: 100))
        // The far corner clamps to a feet box flush against the right/bottom edges.
        let corner = FeetMask.clamped(GridPoint(x: 999, y: 999), spriteSize: sprite, sector: sector)
        let feet = FeetMask.rect(forSpriteAt: corner, spriteSize: sprite)
        #expect(feet.maxX == sector.pixelWidth)
        #expect(feet.maxY == sector.pixelHeight)
    }
}
