# Philips Hue integration for Remote Two/3

Unfolded Circle Remote integration driver for Philips Hue lights.

This integration driver is included in the Unfolded Circle Remote firmware and does not need to be run as an external
integration to control Hue lights. A standalone driver can be used for development or custom functionality.

The integration implements the UC Remote [Integration-API](https://github.com/unfoldedcircle/core-api) which
communicates with JSON messages over WebSocket.

> [!IMPORTANT]
> Compatibility with the new Hue Bridge Pro has not yet been tested.

## Standalone usage

### Setup

Requirements:

- Remote Two firmware 1.9.3 or newer with support for custom integrations.
- Install [nvm](https://github.com/nvm-sh/nvm) (Node.js version manager) for local development.
- Node.js v20.16 or newer (older versions are not tested).
- Install required libraries:

`npm install`

### Run

Build JavaScript from TypeScript:

```shell
npm run build
```

Run as an external integration driver:

```shell
UC_CONFIG_HOME=. UC_INTEGRATION_HTTP_PORT=8097 npm run start
```

The configuration files are loaded & saved from the path specified in the environment variable `UC_CONFIG_HOME`.

### Configuration

Fill out the configuration options in `driver.json`, especially `port` and `driver_url`.

You need to manually register the driver and create an integration in the core:

---

The driver uses discovery for Philips Hue. These will be available for the core to setup.

To register the integration send via websockets:

```
{
    "kind": "req",
    "id": 3,
    "msg": "register_integration_driver",
    "msg_data": {
        "driver_id": "uc_node_philipshue_driver",
        "name": {
            "en": "Philips Hue Integration"
        },
        "driver_url": "ws://localhost:8097",
        "version": "0.0.1",
        "enabled": true,
        "description": {
            "en": "Control your Philips Hue lights with Remote Two."
        },
        "developer": {
		"name": "Unfolded Circle",
		"email": "support@unfoldedcircle.com",
		"url": "https://www.unfoldedcircle.com/support"
        },
        "home_page": "https://www.unfoldedcircle.com",
        "release_date": "2022-07-24",
        "device_discovery": false
    }
}
```

Create an integration:

```
{
    "kind": "req",
    "id": 4,
    "msg": "create_integration",
    "msg_data": {
        "driver_id": "uc_node_philipshue_driver",
        "name": {
            "en": "Philips Hue Integration"
        },
        "enabled": true
    }
}
```

Delete:

```
{
    "kind": "req",
    "id": 5,
    "msg": "delete_integration_driver",
    "msg_data": {
        "driver_id": "uc_node_philipshue_driver"
    }
}
```

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
