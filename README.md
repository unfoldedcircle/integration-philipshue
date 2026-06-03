# Philips Hue integration for Remote Two/3

Unfolded Circle Remote integration driver for Philips Hue lights, supporting the Hue API v2.  
Supported bridges: Hue Bridge (Gen 2) and Hue Bridge Pro.

This integration is bundled with the Unfolded Circle Remote firmware and does not need to run as an external service for
normal usage. A standalone mode is available for development or custom integrations.

The integration implements the UC Remote [Integration API](https://github.com/unfoldedcircle/core-api), communicating
via JSON messages over WebSocket.

> [!IMPORTANT]
>
> - The Hue Bridge v1 is no longer supported with version v0.3.0.
> - The latest Hue Bridge Pro is supported via the v2 API starting with version v0.3.0.

## Hue v1 API migration

Integration versions < v0.3.0 used the Hue v1 API. Starting with v0.3.0, the integration uses the Hue v2 API.  
The v1-based integration was included in Remote Two/3 firmware up to version v2.9.0.

- Existing configurations are automatically migrated if a connection to the Hue Bridge can be established.
  - On startup, the driver attempts to connect to the Hue Bridge for up to one minute to start the migration.
  - If migration cannot start during startup, it will retry later when the Remote connects to the integration.
  - Re-authentication is not required unless authentication fails.
- Previously configured lights using v1 identifiers (short numeric IDs) will continue to work.
  - Newly discovered lights will use v2 identifiers (UUIDs).
  - It is recommended to migrate to v2 identifiers by removing and re-adding lights in the web configurator.  
    Note: this requires recreating associated UI widgets and button mappings.

## Standalone usage

### Setup

Requirements:

- Remote Two/3 firmware v1.9.3 or newer (with custom integration support)
- [nvm](https://github.com/nvm-sh/nvm) for managing Node.js versions (recommended)
- Node.js v22.22 or newer (older versions are untested)

Install dependencies:

```shell
npm install
```

### Run

Build JavaScript from TypeScript:

```shell
npm run build
```

Run as an external integration driver:

```shell
UC_CONFIG_HOME=. UC_INTEGRATION_HTTP_PORT=8097 npm run start
```

Configuration files are read from and written to the path specified by `UC_CONFIG_HOME`.

### Logging

Logging is handled via the [`debug`](https://www.npmjs.com/package/debug) module.

To configure custom logging, run the driver with the `DEBUG` environment variable set like:

```shell
DEBUG=uc_hue:* npm run start
```

If the `DEBUG` environment variable is not set, the driver will use default log settings.

Available log namespaces:

- `uc_hue:msg` – Philips Hue API messages
- `uc_hue:debug` – Debug-level logs
- `uc_hue:info` – Informational messages
- `uc_hue:warn` – Warnings
- `uc_hue:error` – Errors

To show only warnings and errors:

```shell
DEBUG=uc_hue:warn,uc_hue:error npm run start
```

The [Unfolded Circle Integration API library](https://github.com/unfoldedcircle/integration-node-library) also uses the
`debug` module:

- WebSocket message tracing: `ucapi:msg`

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the
[tags and releases on this repository](https://github.com/unfoldedcircle/integration-philipshue/releases).

## Changelog

The major changes found in each new release are listed in the [changelog](CHANGELOG.md)
and under the GitHub [releases](https://github.com/unfoldedcircle/integration-philipshue/releases).

## Contributions

Please read our [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## License

This project is licensed under the [**Mozilla Public License 2.0**](https://choosealicense.com/licenses/mpl-2.0/).
See the [LICENSE](LICENSE) file for details.
