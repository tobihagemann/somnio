# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/tobihagemann/somnio/compare/player-0.1.2...HEAD
[0.1.2]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.2
[0.1.1]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.1
[0.1.0]: https://github.com/tobihagemann/somnio/releases/tag/player-0.1.0
