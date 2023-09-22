"use strict";

// get the UC module
const uc = require("uc-integration-api");
uc.init("driver.json");

const BACKOFF_MAX = 30;
const BACKOFF_SEC = 2;

// handle commands coming from the core
uc.on(
	uc.EVENTS.ENTITY_COMMAND,
	async (wsHandle, entity_id, entity_type, cmd_id, params) => {
		console.log(
			`ENTITY COMMAND: ${wsHandle} ${entity_id} ${entity_type} ${cmd_id}`
		);

		const entity = await uc.configuredEntities.getEntity(entity_id);
		if (entity == null) {
			console.error("Cannot find entity", entity_id);
			uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVICE_UNAVAILABLE);
			return;
		}

		switch (cmd_id) {
			case uc.Entities.Light.COMMANDS.ON:
				let hueParams = { on: true };

				if (params) {
					if (params.brightness) {
						if (params.brightness == 0) {
							hueParams["on"] = false;
						} else {
							hueParams["bri"] = params.brightness - 1; // hue works with 0-254
						}
					}

					// The hue value is a wrapping value between 0 and 65535
					if (params.hue) {
						const scale = ((params.hue - 0) / 360) * 65535;
						hueParams["hue"] = scale;
					}

					if (params.saturation) {
						hueParams["sat"] = params.saturation - 1; // hue works with 0-254
					}

					// 153 - 500
					if (params.color_temperature) {
						hueParams["ct"] = convertColorTempToHue(
							params.color_temperature
						);
					}
				}

				authenticatedApi.lights
					.setLightState(entity_id, hueParams)
					.then((result) => {
						console.log("Result:", result);
						uc.acknowledgeCommand(wsHandle);
					})
					.catch((error) => {
						console.error("Error setting light state", String(error));
						uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVICE_UNAVAILABLE);
					});
				break;

			case uc.Entities.Light.COMMANDS.OFF:
				authenticatedApi.lights
					.setLightState(entity_id, {
						on: false,
					})
					.then((result) => {
						console.log("Result:", result);
						uc.acknowledgeCommand(wsHandle, true);
					})
					.catch((error) => {
						console.error("Error setting light state", String(error));
						uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVICE_UNAVAILABLE);
					});
				break;

			default:
				uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.BAD_REQUEST);
				break;
		}
	}
);

uc.on(uc.EVENTS.CONNECT, async () => {
	await connect();
});

uc.on(uc.EVENTS.DISCONNECT, async () => {
	stopPolling();
	uc.setDeviceState(uc.DEVICE_STATES.DISCONNECTED);
	ucConnected = false;
	ucConnectionAttempts = 0;
});

uc.on(uc.EVENTS.SUBSCRIBE_ENTITIES, async (entityIds) => {
	startPolling();
});

uc.on(uc.EVENTS.UNSUBSCRIBE_ENTITIES, async (entityIds) => {
	stopPolling();
});

uc.on(uc.EVENTS.ENTER_STANDBY, async () => {
	ucConnected = false;
	ucConnectionAttempts = 0;
	stopPolling();
});

uc.on(uc.EVENTS.EXIT_STANDBY, async () => {
	await connect();
	ucConnected = true;
});

// DRIVER SETUP
uc.on(uc.EVENTS.SETUP_DRIVER, async (wsHandle, setupData) => {
	removeConfig();

	console.log(`Setting up driver. Setup data: ${setupData}`);

	await uc.acknowledgeCommand(wsHandle);
	console.log('Acknowledged driver setup');

	// Update setup progress
	await uc.driverSetupProgress(wsHandle);
	console.log('Sending setup progress that we are still busy...');

	hueDiscoveryTimeout = setTimeout(async () => {
		console.log('Discovery timeout');
		await uc.driverSetupError(wsHandle);
	}, 10000);

	// start Hue bridge discovery
	let result = await discoverBridges();

	if (result.length !== 0) {
		console.log('We have discovered Hue bridges:', result);

		clearTimeout(hueDiscoveryTimeout);

		let dropdownItems = [];

		result.forEach((item) => {
			dropdownItems.push({
				'id': item.address,
				'label': {
					'en': item.name
				}
			});
		});

		await uc.requestDriverSetupUserInput(wsHandle, 'Please select your Philips Hue hub', [{
			'field': {
				'dropdown': {
					'value': dropdownItems[0]['id'],
					'items': dropdownItems
				}
			},
			'id': 'choice',
			'label': { 'en': 'Discovered hubs' }
		}]);
	}
});

uc.on(uc.EVENTS.SETUP_DRIVER_USER_DATA, async (wsHandle, data) => {
	console.log('Received user input for driver setup: sending OK');
	await uc.acknowledgeCommand(wsHandle);
	await uc.driverSetupProgress(wsHandle);

	if (data == null || !('choice' in data)) {
		await uc.driverSetupError(wsHandle);
	}

	hueBridgeAddress = discoveredHueBridges[data.choice].address;
	hueBridgeIp = discoveredHueBridges[data.choice].ip;

	console.log('Requesting user confirmation...');
	const img = convertImageToBase64('/opt/uc/integrations/philipshue/assets/setupimg.png');
	await uc.requestDriverSetupUserConfirmation(wsHandle, 'User action needed', 'Please press the button on the Philips Hue Bridge and click next.', img);

});

uc.on(uc.EVENTS.SETUP_DRIVER_USER_CONFIRMATION, async (wsHandle) => {
	console.log('Received user confirmation for driver setup: sending OK');
	await uc.acknowledgeCommand(wsHandle);

	// Update setup progress
	await uc.driverSetupProgress(wsHandle);
	console.log('Sending setup progress that we are still busy...');

	// pair with the bridge
	const res = await pairWithBridge(hueBridgeIp);

	if (res) {
		// connect to Hue bridge
		const resp = await connectToBridge();

		if (resp) {
			console.log('Driver setup completed!');
			await uc.driverSetupComplete(wsHandle);
		} else {
			console.error("Error connecting to the Hue bridge.");
			await uc.driverSetupError(wsHandle);
		}
	} else {
		console.error("Error pairing with the Hue bridge.");
		await uc.driverSetupError(wsHandle);
	}
});
// END DRIVER SETUP

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */
const v3 = require("node-hue-api").v3;
const hueApi = v3.api;
let authenticatedApi = null;

const appName = "uc-integration";
const deviceName = "UC Remote Two";

let ucConnected = false;
let ucConnectionAttempts = 0;
let discoveredHueBridges = {};
let hueBridgeAddress = null;
let hueBridgeIp = null;
let hueBridgeUser = null;
let hueBridgeKey = null;
let hueDiscoveryTimeout;

let pollWorker = null;
/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */
const fs = require("fs");
const path = require('path');
const { Bonjour } = require('bonjour-service');
const browser = new Bonjour();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function discoverBridges(timeOut = 4000) {
	let results = [];

	browser.find({ type: 'hue' }, async (service) => {
		console.log('Found a Hue hub:', service);
		results.push({
			'address': service.host,
			'ip': service.referer.address,
			'name': service.name
		});

		discoveredHueBridges[service.host] = {
			'address': service.host,
			'ip': service.referer.address,
			'name': service.name
		};
	});

	await delay(timeOut);
	return results;
}

async function pairWithBridge(address) {
	let res = false;

	let unauthenticatedApi;

	try {
		unauthenticatedApi = await hueApi.createLocal(address).connect();
	} catch (err) {
		console.error(`Unexpected Error: ${err.message}`);
		return false;
	}

	let createdUser;
	try {
		createdUser = await unauthenticatedApi.users.createUser(
			appName,
			deviceName
		);

		hueBridgeUser = createdUser.username;
		hueBridgeKey = createdUser.clientkey;
		saveConfig();
		res = true;
	} catch (err) {
		if (err.getHueErrorType() === 101) {
			console.error(
				"The Link button on the bridge was not pressed. Please press the Link button and try again."
			);
		} else {
			console.error(`Unexpected Error: ${err.message}`);
		}
	}

	return res;
}

async function connect() {
	if (hueBridgeKey != null) {
		console.debug("Connecting to bridge...");
		// connect to hue bridge
		let res = false;
		while (!res) {
			res = await connectToBridge();

			if (!res) {
				uc.setDeviceState(uc.DEVICE_STATES.CONNECTING);
				console.error("Error connecting to the Hue bridge. Trying again.");
				ucConnectionAttempts += 1;

				if (ucConnectionAttempts == 10) {
					console.debug("Discovering the bridge again.");
					const discoveredRes = await discoverBridges();
					if (hueBridgeAddress in discoveredRes) {
						hueBridgeIp = discoveredHueBridges[hueBridgeAddress].ip;
						saveConfig();
					}
					await delay(1000);
					await connectToBridge();
				}

				console.debug("Trying again in:", backOff());
				await delay(backOff());
			}
		}

		uc.setDeviceState(uc.DEVICE_STATES.CONNECTED);
		ucConnected = true;
		ucConnectionAttempts = 0;
		startPolling();
	}
}

async function connectToBridge() {
	try {
		authenticatedApi = await hueApi
			.createLocal(hueBridgeIp)
			.connect(hueBridgeUser);
	} catch (err) {
		console.error(`Failed to connect: ${err.message}`);
		return false;
	}

	let bridgeConfig;
	try {
		bridgeConfig = await authenticatedApi.configuration.getConfiguration();
	} catch (err) {
		console.error(`Failed to get configuration: ${err.message}`);
		return false;
	}

	if (bridgeConfig.name) {
		console.log(`Connected to Hue Bridge: ${bridgeConfig.name} :: ${bridgeConfig.ipaddress}`);
		await addAvailableLights();
		return true;
	} else {
		return false;
	}
}

async function addAvailableLights() {
	const lights = await authenticatedApi.lights.getAll();

	lights.forEach((light) => {
		let features = [
			uc.Entities.Light.FEATURES.ON_OFF,
		];

		let values = new Map([
			[uc.Entities.Light.ATTRIBUTES.STATE, light.state.on
				? uc.Entities.Light.STATES.ON
				: uc.Entities.Light.STATES.OFF]
		]);

		switch (light.type) {
			case "Dimmable light":
				features.push(uc.Entities.Light.FEATURES.DIM);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.state.bri);
				break;

			case "Color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.HUE], light.state.hue);
				values.set([uc.Entities.Light.ATTRIBUTES.SATURATION],
					light.state.sat);
				break;

			case "Color temperature light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE],
					light.state.ct);
				break;

			case "Extended color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.HUE], light.state.hue);
				values.set([uc.Entities.Light.ATTRIBUTES.SATURATION],
					light.state.sat);
				values.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE],
					light.state.ct);
				break;
		}

		const entity = new uc.Entities.Light(
			String(light.id),
			new Map([[
				'en', light.name
			]]),
			features,
			values
		);

		uc.availableEntities.addEntity(entity);
	});
}

async function startPolling() {
	console.debug("Started polling.");
	if (pollWorker != null) {
		console.debug("Polling has already started.");
		return;
	}

	pollWorker = setInterval(async () => {
		if (!ucConnected) {
			return;
		}

		const entities = uc.configuredEntities.getEntities();
		// const lights = await authenticatedApi.lights.getAll();

		for (const entity of entities) {
			if (entity.entity_id) {
				let response = new Map([]);

				try {
					const light = await authenticatedApi.lights.getLight(entity.entity_id);
					const configredEntity = uc.configuredEntities.getEntity(entity.entity_id);

					console.debug("Got hue ligth with id:", light.id, light.name);

					if (configredEntity == null) {
						console.error("Cannot find configured entity with id", entity.entity_id);
						response.set([uc.Entities.Light.ATTRIBUTES.STATE], uc.Entities.Light.STATES.UNAVAILABLE);
						uc.configuredEntities.updateEntityAttributes(entity.entity_id, response);
						return;
					}

					const state = light.state;

					if (state.bri) {
						if (configredEntity.attributes.brightness != state.bri && configredEntity.attributes.state != uc.Entities.Light.STATES.OFF) {
							response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], configredEntity.attributes.state == uc.Entities.Light.STATES.ON ? state.bri : 0);
						}
					}

					if (light.state) {
						const entityState = state.on ? uc.Entities.Light.STATES.ON : uc.Entities.Light.STATES.OFF;
						if (configredEntity.attributes.state != entityState) {
							response.set([uc.Entities.Light.ATTRIBUTES.STATE], entityState);
							response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], state.on ? state.bri : 0);
						}
					}

					if (state.ct) {
						try {
							const entityColorTemp = convertColorTempFromHue(state.ct);
							if (configredEntity.attributes.color_temperature != entityColorTemp) {
								response.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE], entityColorTemp);
							}
						} catch (error) {
							console.error("Could not convert color temperature for", entity.entity_id);
						}
					}

					if (state.xy) {
						try {
							const res = convertXYtoHSV(state.xy[0], state.xy[1]);
							const entityHue = res.hue;
							const entitySat = res.sat;
							if (configredEntity.attributes.hue != entityHue) {
								response.set([uc.Entities.Light.ATTRIBUTES.HUE], entityHue);
							}
							if (configredEntity.attributes.saturation != entitySat) {
								response.set([uc.Entities.Light.ATTRIBUTES.SATURATION], entitySat);
							}
						} catch (error) {
							console.error("Could not convert color for", entity.entity_id);
						}
					}
				} catch (error) {
					console.error("Error getting hue light:", entity.entity_id);
					console.error("Poll error", String(error));
					if (configredEntity.attributes.state != uc.Entities.Light.STATES.UNAVAILABLE) {
						response.set([uc.Entities.Light.ATTRIBUTES.STATE], uc.Entities.Light.STATES.UNAVAILABLE);
					}
				}

				if (response.size > 0) {
					uc.configuredEntities.updateEntityAttributes(entity.entity_id, response);
				}
			}
		}
	}, 2000);
}

async function stopPolling() {
	clearInterval(pollWorker);
	pollWorker = null;
	console.debug("Polling stopped.");
}

function backOff() {
	if (ucConnectionAttempts * BACKOFF_SEC >= BACKOFF_MAX)
		return BACKOFF_MAX;

	return ucConnectionAttempts * BACKOFF_SEC;
}

function convertColorTempFromHue(colorTemp) {
	// color temperature range is (integer – minimum: 153 – maximum: 500)
	// 347
	colorTemp = colorTemp - 153;

	return (colorTemp / 347) * 100;
}

function convertColorTempToHue(colorTemp) {
	colorTemp = (colorTemp / 100) * 347;

	return colorTemp + 153;
}

function convertXYtoHSV(x, y, lightness = 1) {
	var Y = lightness;
	var X = (x / y) * Y;
	var Z = ((1 - x - y) / y) * Y;

	const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
	const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
	const B = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

	const V = Math.max(R, G, B);
	const minRGB = Math.min(R, G, B);
	const S = (V - minRGB) / V;

	let H;
	if (V == minRGB) {
		H = 0;
	} else if (V == R && G >= B) {
		H = 60 * ((G - B) / (V - minRGB));
	} else if (V == R && G < B) {
		H = 60 * ((G - B) / (V - minRGB)) + 360;
	} else if (V == G) {
		H = 60 * ((B - R) / (V - minRGB)) + 120;
	} else if (V == B) {
		H = 60 * ((R - G) / (V - minRGB)) + 240;
	}

	let ScaledS = Math.round(S * 255);

	const res = {
		hue: Math.round(H) % 360,
		sat: Math.max(0, Math.min(ScaledS, 255))
	}

	return res;
}

function convertImageToBase64(file) {
	let data;

	try {
		data = fs.readFileSync(file, 'base64');
	} catch (e) {
		console.error(e);
	}

	return data;
}

async function loadConfig() {
	try {
		const raw = fs.readFileSync(path.join(uc.configDirPath, "config.json"));

		try {
			const json = JSON.parse(raw);
			hueBridgeAddress = json.hueBridgeAddress;
			hueBridgeIp = json.hueBridgeIp;
			hueBridgeUser = json.hueBridgeUser;
			hueBridgeKey = json.hueBridgeKey;
			console.log(`Config loaded >> Address: ${hueBridgeAddress} User: ${hueBridgeUser}`);
		} catch (e) {
			console.error(
				"Error parsing config info. Starting with empty config."
			);
		}
	} catch (e) {
		console.error(
			"No config file found. Starting with empty config."
		);
	}
}

function saveConfig() {
	try {
		fs.writeFileSync(
			path.join(uc.configDirPath, "config.json"),
			JSON.stringify({
				hueBridgeAddress: hueBridgeAddress,
				hueBridgeIp: hueBridgeIp,
				hueBridgeUser: hueBridgeUser,
				hueBridgeKey: hueBridgeKey,
			})
		);
		console.log("Config saved to file.");
	} catch (e) {
		console.error("Error writing config.");
	}
}

function removeConfig() {
	const configPath = path.join(uc.configDirPath, "config.json");

	try {
		if (fs.existsSync(configPath)) {
			try {
				fs.unlinkSync(configPath)
				console.log("Config file removed.");
			} catch (e) {
				console.error(e)
			}
		}
	} catch (e) {
		console.error(e);
	}
}

async function init() {
	await loadConfig();
}

init();
