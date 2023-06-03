"use strict";

// get the UC module
const uc = require("uc-integration-api");
uc.init("driver.json");

// handle commands coming from the core
uc.on(
	uc.EVENTS.ENTITY_COMMAND,
	async (wsHandle, entity_id, entity_type, cmd_id, params) => {
		console.log(
			`ENTITY COMMAND: ${wsHandle} ${entity_id} ${entity_type} ${cmd_id}`
		);

		const hueId = entity_id.split("_")[1];

		const entity = await uc.configuredEntities.getEntity(entity_id);

		switch (cmd_id) {
			case uc.Entities.Light.COMMANDS.TOGGLE:
				if (entity.attributes.state == uc.Entities.Light.STATES.ON) {
					// turn off
					authenticatedApi.lights
						.setLightState(hueId, {
							on: false,
						})
						.then((result) => {
							console.log("Result:", result);
							uc.acknowledgeCommand(wsHandle);
						})
						.catch((error) => {
							uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVER_ERROR);
						});
				} else if (
					entity.attributes.state == uc.Entities.Light.STATES.OFF
				) {
					// turn on
					authenticatedApi.lights
						.setLightState(hueId, {
							on: true,
						})
						.then((result) => {
							console.log("Result:", result);
							uc.acknowledgeCommand(wsHandle);
						})
						.catch((error) => {
							uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVER_ERROR);
						});
				}
				break;

			case uc.Entities.Light.COMMANDS.ON:
				let hueParams = { on: true };

				if (params.brightness == 0) {
					hueParams["on"] = false;
				}

				if (params.brightness) {
					hueParams["bri"] = params.brightness - 1; // hue works with 0-254
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

				authenticatedApi.lights
					.setLightState(hueId, hueParams)
					.then((result) => {
						console.log("Result:", result);
						uc.acknowledgeCommand(wsHandle);
					})
					.catch((error) => {
						uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVER_ERROR);
					});
				break;

			case uc.Entities.Light.COMMANDS.OFF:
				authenticatedApi.lights
					.setLightState(hueId, {
						on: false,
					})
					.then((result) => {
						console.log("Result:", result);
						uc.acknowledgeCommand(wsHandle, true);
					})
					.catch((error) => {
						uc.acknowledgeCommand(wsHandle, uc.STATUS_CODES.SERVER_ERROR);
					});
				break;
		}
	}
);

uc.on(uc.EVENTS.CONNECT, async () => {
	if (hueBridgeKey != null) {
		// connect to hue bridge
		const res = await connectToBridge();
		if (!res) {
			uc.setDeviceState(uc.DEVICE_STATES.ERROR);
			return;
		}

		subscribeToEvents();
		uc.setDeviceState(uc.DEVICE_STATES.CONNECTED);
		ucConnected = true;
	}
});

uc.on(uc.EVENTS.DISCONNECT, async () => {
	uc.setDeviceState(uc.DEVICE_STATES.DISCONNECTED);
	ucConnected = false;
	if (signalController != null) {
		signalController.abort();
	}
});

uc.on(uc.EVENTS.ENTER_STANDBY, async () => {
	ucConnected = false;
	signalController.abort();
});

uc.on(uc.EVENTS.EXIT_STANDBY, async () => {
	ucConnected = true;
	subscribeToEvents();
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

	// start Hue bridge discovery
	discoverBridge();
	console.log('Hue bridge discovery started.');

	// start polling bridge address
	hueDiscoveryCheck = setInterval(async () => {
		if (hueBridgeAddress != null) {
			console.log('Hue birdge found:', hueBridgeAddress);

			clearInterval(hueDiscoveryCheck);
			clearTimeout(hueDiscoveryTimeout);
			
			console.log('Requesting user confirmation...');
			const img = convertImageToBase64('./assets/setupimg.png');
			await uc.requestDriverSetupUserConfirmation(wsHandle, 'User action needed', 'Please press the button on the Philips Hue Bridge and click next.', img);
		}
	}, 2000);

	hueDiscoveryTimeout = setTimeout(async () => {
		clearInterval(hueDiscoveryCheck);
		console.log('Discovery timeout');

		await uc.driverSetupError(wsHandle, 'No Philips Hue Bridges were discovered.');

	}, 20000);
});

uc.on(uc.EVENTS.SETUP_DRIVER_USER_CONFIRMATION, async (wsHandle) => {
	console.log('Received user confirmation for driver setup: sending OK');
	await uc.acknowledgeCommand(wsHandle);

	// Update setup progress
	await uc.driverSetupProgress(wsHandle);
	console.log('Sending setup progress that we are still busy...');

	// pair with the bridge
	const ipAddress = await resolveHostToIp(hueBridgeAddress);
	if (ipAddress == null) {
		await uc.driverSetupError(wsHandle, 'There was an error while connecting to the bridge');
		return;
	}

	const res = await pairWithBridge(ipAddress);

	if (res) {
		// connect to Hue bridge
		const resp = await connectToBridge();

		if (resp) {
			console.log('Driver setup completed!');
			await uc.driverSetupComplete(wsHandle);
		} else {
			await uc.driverSetupError(wsHandle, 'There was an error while connecting to the bridge');
		}
	} else {
		await uc.driverSetupError(wsHandle, 'There was an error while pairing with the bridge. The button was not pressed.');
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
let hueBridgeAddress = null;
let hueBridgeUser = null;
let hueBridgeKey = null;
let hueDiscoveryCheck;
let hueDiscoveryTimeout;

let signalController = null;
/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */
const util = require('util');
const fs = require("fs");
const path = require('path');
const { Bonjour } = require('bonjour-service');
const browser = new Bonjour();
const axios = require("axios");
const https = require("https");
const dns = require('dns');
const lookup = util.promisify(dns.lookup);

async function resolveHostToIp(host) {
	let res = null;

	try {
		const resp = await lookup(host, { family: 4 });
		res = resp.address;
	} catch (error) {
		console.error(error);
	}

	return res;	
}

async function discoverBridge() {
	browser.find({ type: 'hue' }, async (service) => {
		hueBridgeAddress = service.host;
		console.log('Found a Hue hub:', hueBridgeAddress);
	})
}

async function pairWithBridge(ipAddress) {
	let res = false;

	const unauthenticatedApi = await hueApi.createLocal(ipAddress).connect();

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

async function connectToBridge() {
	const ipAddress = await resolveHostToIp(hueBridgeAddress);
	if (ipAddress == null) {
		return false;
	}

	authenticatedApi = await hueApi
		.createLocal(ipAddress)
		.connect(hueBridgeUser);

	const bridgeConfig = await authenticatedApi.configuration.getConfiguration();

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
		// console.log(light);

		let features = [
			uc.Entities.Light.FEATURES.ON_OFF,
			uc.Entities.Light.FEATURES.TOGGLE,
		];

		let values = new Map([
			[uc.Entities.Light.ATTRIBUTES.STATE, light.data.state.on
				? uc.Entities.Light.STATES.ON
				: uc.Entities.Light.STATES.OFF]
		]);

		switch (light.data.type) {
			case "Dimmable light":
				features.push(uc.Entities.Light.FEATURES.DIM);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.data.state.bri);
				break;

			case "Color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.data.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.HUE], light.data.state.hue);
				values.set([uc.Entities.Light.ATTRIBUTES.SATURATION],
					light.data.state.sat);
				break;

			case "Color temperature light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.data.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE],
					light.data.state.ct);
				break;

			case "Extended color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS],
					light.data.state.bri);
				values.set([uc.Entities.Light.ATTRIBUTES.HUE], light.data.state.hue);
				values.set([uc.Entities.Light.ATTRIBUTES.SATURATION],
					light.data.state.sat);
				values.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE],
					light.data.state.ct);
				break;
		}

		const entity = new uc.Entities.Light(
			String("hue_" + light.data.id),
			new Map([[
				'en', light.data.name
			]]),
			features,
			values
		);

		uc.availableEntities.addEntity(entity);
	});
}

async function subscribeToEvents() {
	const ipAddress = await resolveHostToIp(hueBridgeAddress);

	if (ipAddress == null) {
		return;
	}

	signalController = new AbortController();

	axios
		.get(`https://${ipAddress}/eventstream/clip/v2`, {
			responseType: "stream",
			signal: signalController.signal,
			headers: {
				"hue-application-key": hueBridgeUser,
			},
			httpsAgent: new https.Agent({ rejectUnauthorized: false }),
		})
		.then((response) => {
			const stream = response.data;

			stream.on("data", (data) => {
				data = data.toString();
				const answers = data.split("\r\n\r\n");

				answers.forEach((answer) => {
					try {
						answer = JSON.parse(answer);

						answer.forEach((item) => {
							item.data.forEach(async (dataItem) => {
								// we care only about lights for now
								const lightId =
									dataItem.id_v1.split("/lights/")[1];

								if (lightId) {
									const entityId = "hue_" + String(lightId);
									
									if (!uc.configuredEntities.contains(entityId)) {
										return;
									}

									console.log(JSON.stringify(dataItem));
									
									let response = new Map([]);

									// state
									if (dataItem.on) {
										response.set([uc.Entities.Light.ATTRIBUTES.STATE], dataItem.on.on ? uc.Entities.Light.STATES.ON : uc.Entities.Light.STATES.OFF);
										const lightState = await authenticatedApi.lights.getLightState(lightId);
										
										response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], lightState.bri + 1);

										response.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE], convertColorTempFromHue(
											lightState.ct
										));
										
										const res = convertXYtoHSV(lightState.xy[0], lightState.xy[1]);
										response.set([uc.Entities.Light.ATTRIBUTES.HUE], res.hue);
										response.set([uc.Entities.Light.ATTRIBUTES.SATURATION], res.sat);
									}

									// brightness
									if (dataItem.dimming) {
										response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], parseInt(
												(dataItem.dimming.brightness /
													100) *
													255
											));
									}

									if (dataItem.color_temperature) {
										// color temeprature
										if (
											dataItem.color_temperature
												.mirek_valid == true
										) {
											response.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE], convertColorTempFromHue(
												dataItem.color_temperature
													.mirek
											));
										}
										// colors
										else {
											const res = convertXYtoHSV(dataItem.color.xy.x, dataItem.color.xy.y);
											response.set([uc.Entities.Light.ATTRIBUTES.HUE], res.hue);
											response.set([uc.Entities.Light.ATTRIBUTES.SATURATION], res.sat);
										}
									}

									console.log(response);
									uc.configuredEntities.updateEntityAttributes(entityId, response);
								}
							});
						});
					} catch (e) {
						console.log(e);
					}
				});
			});

			stream.on("end", () => {
				console.log("Stream disconnected");
				if (ucConnected) {
					subscribeToEvents();
				}
			});
		})
		.catch((error) => {
			// handle error
			console.log(error);
			if (ucConnected) {
				subscribeToEvents();
			}
		});
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
		console.log(e);
	}

	return data;
}

async function loadConfig() {
	try {
		const raw = fs.readFileSync(path.join(uc.configDirPath, "config.json"));

		try {
			const json = JSON.parse(raw);
			hueBridgeAddress = json.hueBridgeAddress;
			hueBridgeUser = json.hueBridgeUser;
			hueBridgeKey = json.hueBridgeKey;
			console.log(`Config loaded >> Address: ${hueBridgeAddress} User: ${hueBridgeUser}`);
		} catch (e) {
			console.log(
				"Error parsing config info. Starting with empty config."
			);
		}
	} catch (e) {
		console.log(
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
				hueBridgeUser: hueBridgeUser,
				hueBridgeKey: hueBridgeKey,
			})
		);
		console.log("Config saved to file.");
	} catch (e) {
		console.log("Error writing config.");
	}
}

function removeConfig() {
	try {
		fs.unlinkSync(path.join(uc.configDirPath, "config.json"))
		console.log("Config file removed.");
	} catch(e) {
		console.error(e)
	}
}

async function init() {
	await loadConfig();
}

init();
