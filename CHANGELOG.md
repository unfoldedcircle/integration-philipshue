# Philips Hue Integration for Remote Two/3 Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Each Hue room/zone with scenes is exposed as a `Select` entity; `current_option` tracks the active scene via SSE ([#134](https://github.com/unfoldedcircle/integration-philipshue/pull/134)).

### Changed

- Configuration version bumped from 3 to 4; the migration now also fetches scenes ([#134](https://github.com/unfoldedcircle/integration-philipshue/pull/134)).

---

## v0.3.3 - 2026-04-27

### Fixed

- Color conversion (gamma decode + Wide RGB D65 matrix + gamut clipping) by @stakats and @henrikwidlund ([#127](https://github.com/unfoldedcircle/integration-philipshue/pull/127)).

### Changed

- Set default logging if the DEBUG environment variable is not set.
- Dependency updates.

## v0.3.2 - 2026-04-13

### Fixed

- Translation file loading ([#122](https://github.com/unfoldedcircle/integration-philipshue/pull/122)).

### Changed

- Update integration-api, dependencies, GitHub release action ([#118](https://github.com/unfoldedcircle/integration-philipshue/pull/118), [#121](https://github.com/unfoldedcircle/integration-philipshue/pull/121)).
- Add an "API v2 ID" comment to light-entities for easier identification when having old v1 lights.

## v0.3.0 - 2026-04-08

### Breaking Changes

- Using Philips Hue v2 API. V1 Hue Bridges are no longer supported ([#19](https://github.com/unfoldedcircle/integration-philipshue/pull/19)).
- Light-entity identifier changed to Hue v2 API format ([#79](https://github.com/unfoldedcircle/integration-philipshue/pull/79)).
  - Already configured lights using the old v1 identifiers are still working. It is recommended to reconfigure the lights to use the new format.
- New configuration file format to support lights, groups, rooms, and different gamut types ([#79](https://github.com/unfoldedcircle/integration-philipshue/pull/79)).
  - The old configuration file is automatically migrated if a connection to the Hue Bridge can be established.

### Added

- Manual Hue hub setup option ([#39](https://github.com/unfoldedcircle/integration-philipshue/pull/39)).
- Add support for rooms and zones by @henrikwidlund ([#49](https://github.com/unfoldedcircle/integration-philipshue/pull/49)).
- Use custom icons for room and zone groups ([#116](https://github.com/unfoldedcircle/integration-philipshue/pull/116)).
- Initial unit tests ([#69](https://github.com/unfoldedcircle/integration-philipshue/pull/69)).

### Changed

- Open Source release ([#20](https://github.com/unfoldedcircle/integration-philipshue/issues/20)).
- Node.js v22.13 and package updates ([#31](https://github.com/unfoldedcircle/integration-philipshue/pull/31)).
- Logging prefixes ([#40](https://github.com/unfoldedcircle/integration-philipshue/pull/40)).
- Add retry handling for rate limiting and service unavailable errors ([#43](https://github.com/unfoldedcircle/integration-philipshue/issues/43)).

### Fixed

- Event stream reconnection ([#34](https://github.com/unfoldedcircle/integration-philipshue/pull/34)).
- Command error propagation and improve entity state handling ([#36](https://github.com/unfoldedcircle/integration-philipshue/pull/36)).
- Emit hub configuration change events ([#41](https://github.com/unfoldedcircle/integration-philipshue/pull/41)).
- Only set entity state to unavailable for auth errors ([#42](https://github.com/unfoldedcircle/integration-philipshue/pull/42)).
- Properly handle entity subscribe and unsubscribe events ([#44](https://github.com/unfoldedcircle/integration-philipshue/pull/44)).
- Setup flow restart after cancelling ([#48](https://github.com/unfoldedcircle/integration-philipshue/pull/48)).
- Invalid color picker conversion by @henrikwidlund ([#53](https://github.com/unfoldedcircle/integration-philipshue/pull/53)).
- Potential errors in color conversions.

## v0.2.16 - 2023-11-15

### Fixed

- Driver version.

## v0.2.15 - 2023-11-13

### Fixed

- Runtime crash in setup if choice parameter missing ([#14](https://github.com/unfoldedcircle/integration-philipshue/pull/14)).
- Runtime crash in poller: configredEntity is not defined ([#15](https://github.com/unfoldedcircle/integration-philipshue/pull/15)).
- AuthenticatedApi.lights runtime crash ([#16](https://github.com/unfoldedcircle/integration-philipshue/pull/16)).
- Brightness zero handling ([#17](https://github.com/unfoldedcircle/integration-philipshue/pull/17)).
