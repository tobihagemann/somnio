# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-09

### Added

- Play in fullscreen: the game launches into fullscreen, remembers when you quit windowed instead, and windowed play resizes freely down to 1024×640 at a remembered frame
- Zoom the world with the scroll wheel between half and double the standard view, while every window size keeps showing the same slice of the world
- Open an in-game menu with Esc — Resume, Options, Leave Game, and About; Esc also backs out of any dialog and unfocuses the chat, and never drops the game out of fullscreen
- Collapse the chat, online-players, and inventory panels behind small toggle buttons to keep the view clear

### Changed

- Show every dialog in the game's own fantasy style: login, registration, options, about, and update prompts appear as bordered in-game panels over the world instead of macOS windows, with the game options moving from the system Settings menu into the new Options overlay and the About dialog crediting the KayKit, Quaternius, ambientCG, and Kenney asset packs
- Let the world fill the whole window: the HUD bars, chat, and player/inventory lists float over the view instead of sitting in a fixed side layout
- Show the world in full 3D: characters, monsters, and furniture render as real 3D models under sun, shadow, and day/night lighting, with dedicated floor materials, replacing the 2D sprite view; name plaques under players and NPCs and comic-style speech bubbles carry over into the 3D world
- Author maps in the same 3D view the game renders: the editor's canvas shows the real models and floor materials with click-to-select and click-to-place, a selection highlight, an optional grid, scroll panning, and Cmd-scroll zoom, opening at the game's own zoom level
- Pick objects and floors by name when editing maps: the object dialog offers the available models and the new-map dialog the available floor materials, replacing the sprite-sheet coordinate fields
- Store maps with named model and floor-material references instead of sprite-sheet coordinates; sector files saved by older versions no longer open
- Face exactly where your cursor points: your character rotates to the precise cursor angle instead of snapping to four directions, other players' facing shows at the same precision, and chasing monsters turn toward their exact target
- Walk smoothly in any direction without side-to-side jitter, and see animations that match your travel direction relative to your cursor — sneak, walk, and run when moving forward (Option or Shift), plus distinct backpedal and strafe animations when moving backward or sideways — with backpedaling and strafing slower than walking forward
- Cast without a weapon in hand: characters no longer carry a permanently attached weapon model

### Security

- Prevent a malicious game server from freezing the game with a single oversized sector
- Prevent a hostile map file or server frame from freezing the editor or game with huge record lists, an oversized file, or a sector crafted to overload the renderer's placement scan

## [0.1.2] - 2026-06-21

### Added

- Show a clear update message when your game version no longer matches the server's, telling you whether to update your client or wait for the server, instead of silently disconnecting

### Changed

- List yourself alongside other players in the online-players roster and keep the roster sorted alphabetically

### Fixed

- Fix "remember password" not working, so your login is restored when you reopen the game instead of the saved password being silently lost
- Stop your character from drifting when a movement key is still held as you click into the chat input

### Security

- Prevent registering a name that impersonates another by using look-alike letters from a different alphabet (such as a Cyrillic letter that looks Latin) or by mixing alphabets

## [0.1.1] - 2026-06-18

### Fixed

- Fix a stray translucent window appearing beside the player window at startup
- Show other players' walking animation as they move
- Stop showing a "left the game" message when another player moves to a different sector instead of leaving
- Allow equipping the cudgel from the inventory by double-clicking it
- Show your purse's coin balance in chat when you double-click the purse

## [0.1.0] - 2026-06-18

Initial release.

[Unreleased]: https://github.com/tobihagemann/somnio/compare/player-0.2.0...HEAD
[0.2.0]: https://github.com/tobihagemann/somnio/releases/tag/player-0.2.0
[0.1.2]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.2
[0.1.1]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.1
[0.1.0]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.0
