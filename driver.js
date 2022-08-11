"use strict";

// get the UC module
const uc = require("uc-integration-api");
uc.init("driver.json");

// handle commands coming from the core
uc.on(
	uc.EVENTS.ENTITY_COMMAND,
	async (id, entity_id, entity_type, cmd_id, params) => {
		console.log(
			`ENTITY COMMAND: ${id} ${entity_id} ${entity_type} ${cmd_id} ${JSON.stringify(
				params
			)}`
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
							uc.acknowledgeCommand(id, true);
						})
						.catch((error) => {
							uc.acknowledgeCommand(id, false);
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
							uc.acknowledgeCommand(id, true);
						})
						.catch((error) => {
							uc.acknowledgeCommand(id, false);
						});
				}
				break;

			case uc.Entities.Light.COMMANDS.ON:
				let hueParams = { on: true };

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
						uc.acknowledgeCommand(id, true);
					})
					.catch((error) => {
						uc.acknowledgeCommand(id, false);
					});
				break;

			case uc.Entities.Light.COMMANDS.OFF:
				authenticatedApi.lights
					.setLightState(hueId, {
						on: false,
					})
					.then((result) => {
						uc.acknowledgeCommand(id, true);
					})
					.catch((error) => {
						uc.acknowledgeCommand(id, false);
					});
				break;
		}
	}
);

uc.on(uc.EVENTS.CONNECT, async () => {
	subscribeToEvents();
	uc.setDeviceState(uc.DEVICE_STATES.CONNECTED);
});

uc.on(uc.EVENTS.DISCONNECT, async () => {
	uc.setDeviceState(uc.DEVICE_STATES.DISCONNECTED);
});

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */
const v3 = require("node-hue-api").v3;
const hueApi = v3.api;
let authenticatedApi = null;

const appName = "uc-integration";
const deviceName = "UC Remote Two";

let hueBridgeIp = null;
let hueBridgeUser = null;
let hueBridgeKey = null;
/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */
const fs = require("fs");
const mDnsSd = require("node-dns-sd");
const axios = require("axios");
const https = require("https");

async function discoverBridge() {
	return mDnsSd
		.discover({
			name: "_hue._tcp.local",
		})
		.then((device_list) => {
			console.log(JSON.stringify(device_list[0]));
			return device_list[0].address;
		})
		.catch((error) => {
			console.error(error);
			return null;
		});
}

async function pairWithBridge(ipAddress) {
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
	} catch (err) {
		if (err.getHueErrorType() === 101) {
			console.error(
				"The Link button on the bridge was not pressed. Please press the Link button and try again."
			);
		} else {
			console.error(`Unexpected Error: ${err.message}`);
		}
	}
}

async function connectToBridge() {
	try {
		authenticatedApi = await hueApi
			.createLocal(hueBridgeIp)
			.connect(hueBridgeUser);

		const bridgeConfig =
			await authenticatedApi.configuration.getConfiguration();
		console.log(
			`Connected to Hue Bridge: ${bridgeConfig.name} :: ${bridgeConfig.ipaddress}`
		);

		await addAvailableLights();
	} catch (e) {
		console.log("Error connected to the Hue Bridge");
		uc.setDeviceState(uc.DEVICE_STATES.ERROR);
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

		let values = {
			[uc.Entities.Light.ATTRIBUTES.STATE]: light.data.state.on
				? uc.Entities.Light.STATES.ON
				: uc.Entities.Light.STATES.OFF,
		};

		switch (light.data.type) {
			case "Dimmable light":
				features.push(uc.Entities.Light.FEATURES.DIM);
				values[uc.Entities.Light.ATTRIBUTES.BRIGHTNESS] =
					light.data.state.bri;
				break;

			case "Color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR
				);
				values[uc.Entities.Light.ATTRIBUTES.BRIGHTNESS] =
					light.data.state.bri;
				values[uc.Entities.Light.ATTRIBUTES.HUE] = light.data.state.hue;
				values[uc.Entities.Light.ATTRIBUTES.SATURATION] =
					light.data.state.sat;
				break;

			case "Color temperature light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values[uc.Entities.Light.ATTRIBUTES.BRIGHTNESS] =
					light.data.state.bri;
				values[uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE] =
					light.data.state.ct;
				break;

			case "Extended color light":
				features.push(
					uc.Entities.Light.FEATURES.DIM,
					uc.Entities.Light.FEATURES.COLOR,
					uc.Entities.Light.FEATURES.COLOR_TEMPERATURE
				);
				values[uc.Entities.Light.ATTRIBUTES.BRIGHTNESS] =
					light.data.state.bri;
				values[uc.Entities.Light.ATTRIBUTES.HUE] = light.data.state.hue;
				values[uc.Entities.Light.ATTRIBUTES.SATURATION] =
					light.data.state.sat;
				values[uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE] =
					light.data.state.ct;
				break;
		}

		const entity = new uc.Entities.Light(
			String("hue_" + light.data.id),
			light.data.name,
			uc.getDriverVersion().id,
			features,
			values
		);

		uc.availableEntities.addEntity(entity);

		// todo remove configured entities from here
		uc.configuredEntities.addEntity(entity);
	});
}

async function subscribeToEvents() {
	axios
		.get(`https://${hueBridgeIp}/eventstream/clip/v2`, {
			responseType: "stream",
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
							item.data.forEach((dataItem) => {
								// we care only about lights for now
								const lightId =
									dataItem.id_v1.split("/lights/")[1];

								if (lightId) {
									console.log(JSON.stringify(dataItem));

									let keys = [];
									let values = [];

									console.log(dataItem);

									// state
									if (dataItem.on) {
										keys.push(
											uc.Entities.Light.ATTRIBUTES.STATE
										);
										values.push(
											dataItem.on.on
												? uc.Entities.Light.STATES.ON
												: uc.Entities.Light.STATES.OFF
										);
									}

									// brightness
									if (dataItem.dimming) {
										keys.push(
											uc.Entities.Light.ATTRIBUTES
												.BRIGHTNESS
										);
										values.push(
											parseInt(
												(dataItem.dimming.brightness /
													100) *
													255
											)
										);
									}

									if (dataItem.color_temperature) {
										// color temeprature
										if (
											dataItem.color_temperature
												.mirek_valid == true
										) {
											keys.push(
												uc.Entities.Light.ATTRIBUTES
													.COLOR_TEMPERATURE
											);
											values.push(
												convertColorTempFromHue(
													dataItem.color_temperature
														.mirek
												)
											);
										}
										// colors
										else {
											const rgb = xyBriToRgb(
												dataItem.color.xy.x,
												dataItem.color.xy.y,
												100
											);

											const res = rgbToHsv(
												rgb[0],
												rgb[1],
												rgb[2]
											);

											keys.push(
												uc.Entities.Light.ATTRIBUTES.HUE
											);
											keys.push(
												uc.Entities.Light.ATTRIBUTES
													.SATURATION
											);
											values.push(parseInt(res.h));
											values.push(parseInt(res.s));
										}
									}

									console.log(keys);
									console.log(values);

									if (keys.length > 0) {
										uc.configuredEntities.updateEntityAttributes(
											"hue_" + String(lightId),
											keys,
											values
										);
									}
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
				subscribeToEvents();
			});
		})
		.catch((error) => {
			// handle error
			console.log(error);
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

function xyBriToRgb(x, y, bri) {
	let z = 1.0 - x - y;

	let Y = bri / 255.0; // Brightness of lamp
	let X = (Y / y) * x;
	let Z = (Y / y) * z;
	let r = X * 1.612 - Y * 0.203 - Z * 0.302;
	let g = -X * 0.509 + Y * 1.412 + Z * 0.066;
	let b = X * 0.026 - Y * 0.072 + Z * 0.962;

	r =
		r <= 0.0031308
			? 12.92 * r
			: (1.0 + 0.055) * Math.pow(r, 1.0 / 2.4) - 0.055;
	g =
		g <= 0.0031308
			? 12.92 * g
			: (1.0 + 0.055) * Math.pow(g, 1.0 / 2.4) - 0.055;
	b =
		b <= 0.0031308
			? 12.92 * b
			: (1.0 + 0.055) * Math.pow(b, 1.0 / 2.4) - 0.055;

	let maxValue = Math.max(r, g, b);

	r /= maxValue;
	g /= maxValue;
	b /= maxValue;

	r = r * 255;
	if (r < 0) {
		r = 255;
	}

	g = g * 255;
	if (g < 0) {
		g = 255;
	}

	b = b * 255;
	if (b < 0) {
		b = 255;
	}

	return [r, g, b];
}

function rgbToHsv(r, g, b) {
	let rabs, gabs, babs, rr, gg, bb, h, s, v, diff, diffc, percentRoundFn;
	rabs = r / 255;
	gabs = g / 255;
	babs = b / 255;
	(v = Math.max(rabs, gabs, babs)), (diff = v - Math.min(rabs, gabs, babs));
	diffc = (c) => (v - c) / 6 / diff + 1 / 2;
	percentRoundFn = (num) => Math.round(num * 100) / 100;
	if (diff == 0) {
		h = s = 0;
	} else {
		s = diff / v;
		rr = diffc(rabs);
		gg = diffc(gabs);
		bb = diffc(babs);

		if (rabs === v) {
			h = bb - gg;
		} else if (gabs === v) {
			h = 1 / 3 + rr - bb;
		} else if (babs === v) {
			h = 2 / 3 + gg - rr;
		}
		if (h < 0) {
			h += 1;
		} else if (h > 1) {
			h -= 1;
		}
	}
	return {
		h: Math.round(h * 360),
		s: percentRoundFn(s * 255),
		v: percentRoundFn(v * 255),
	};
}

async function loadConfig() {
	try {
		const raw = fs.readFileSync("config.json");

		try {
			const json = JSON.parse(raw);
			hueBridgeIp = json.hueBridgeIp;
			hueBridgeUser = json.hueBridgeUser;
			hueBridgeKey = json.hueBridgeKey;
			console.log("Config loaded");
		} catch (e) {
			hueBridgeIp = await discoverBridge();
			console.log(
				"Error parsing config info. Starting with empty config and Hue Bridge discovery"
			);
		}
	} catch (e) {
		console.log(
			"No config file found. Starting with empty config and Hue Bridge discovery"
		);
		hueBridgeIp = await discoverBridge();
	}
}

function saveConfig() {
	try {
		fs.writeFileSync(
			"config.json",
			JSON.stringify({
				hueBridgeIp: hueBridgeIp,
				hueBridgeUser: hueBridgeUser,
				hueBridgeKey: hueBridgeKey,
			})
		);
		console.log("Config saved to file.");
	} catch (e) {
		console.log("Error writing config.");
	}
}

async function init() {
	// check if there's config and load
	await loadConfig();

	if (hueBridgeKey != null) {
		// connect to hue bridge
		await connectToBridge();
	} else {
		// todo for testing we pair
		await pairWithBridge(hueBridgeIp);
	}

	//otherwise wait for driver setup
}

init();
