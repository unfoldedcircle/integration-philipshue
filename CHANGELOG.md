# Philips Hue Integration for Remote Two/3 Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

_Changes in the next release_

### Added

- Manual Hue hub setup option ([#39](https://github.com/unfoldedcircle/integration-philipshue/pull/39)).

### Changed

- **BREAKING CHANGE** Using Philips Hue v2 API. V1 Hue hubs are no longer supported ([#19](https://github.com/unfoldedcircle/integration-philipshue/pull/19)).
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

---

## v0.2.16 - 2023-11-15

### Fixed

- Driver version.

## v0.2.15 - 2023-11-13

### Fixed

- Runtime crash in setup if choice parameter missing ([#14](https://github.com/unfoldedcircle/integration-philipshue/pull/14)).
- Runtime crash in poller: configredEntity is not defined ([#15](https://github.com/unfoldedcircle/integration-philipshue/pull/15)).
- AuthenticatedApi.lights runtime crash ([#16](https://github.com/unfoldedcircle/integration-philipshue/pull/16)).
- Brightness zero handling ([#17](https://github.com/unfoldedcircle/integration-philipshue/pull/17)).
