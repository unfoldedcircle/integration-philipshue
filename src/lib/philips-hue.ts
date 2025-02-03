import { DeviceStates, Entity, Events, IntegrationAPI, Light, StatusCodes } from "@unfoldedcircle/integration-api";
import log from "../log.js";
import PhilipsHueSetup from "./setup.js";
import HueApi from "./hue-api/api.js";
import Config, { ConfigEvent, LightConfig } from "../config.js";

class PhilipsHue {
  private uc: IntegrationAPI;
  private setup: PhilipsHueSetup;
  private hueApi: HueApi;
  private config: Config;
  constructor() {
    this.uc = new IntegrationAPI();
    this.config = new Config(this.uc.getConfigDirPath(), this.handleConfigEvent.bind(this));
    this.setup = new PhilipsHueSetup(this.uc, this.config);
    this.hueApi = new HueApi("");
  }

  async init() {
    this.uc.init("driver.json", this.setup.handleSetup.bind(this.setup));
    const hubConfig = this.config.getHubConfig();
    this.hueApi.setBaseUrl("https://" + hubConfig.ip);
    this.hueApi.setAuthKey(hubConfig.username);
    this.readEntitiesFromConfig();
    this.setupDriverEvents();
    log.info("Philips Hue driver initialized");
  }

  private readEntitiesFromConfig() {
    const lights = this.config.getLights();
    for (const light of lights) {
      const lightEntity = new Light(light.id, light.name, { features: light.features });
      this.addAvailableLight(lightEntity);
    }
  }

  private setupDriverEvents() {
    this.uc.on(Events.Connect, this.handleConnect.bind(this));
    this.uc.on(Events.SubscribeEntities, this.handleSubscribeEntities.bind(this));
    this.uc.on(Events.UnsubscribeEntities, this.handleUnsubscribeEntities.bind(this));
    this.uc.on(Events.Disconnect, this.handleDisconnect.bind(this));
    this.uc.on(Events.EnterStandby, this.handleEnterStandby.bind(this));
    this.uc.on(Events.ExitStandby, this.handleExitStandby.bind(this));
  }

  // what can i do so when i do if event == light_Added, the data is typed?
  private handleConfigEvent(event: ConfigEvent) {
    if (event.type === "light-added") {
      const light = new Light(event.data.id, event.data.name, { features: event.data.features });
      this.addAvailableLight(light);
      console.log("handleConfigEvent", event, event.data);
    }
  }

  private addAvailableLight(light: Light) {
    light.setCmdHandler(this.handleLightCmd.bind(this));
    this.uc.addAvailableEntity(light);
  }

  private async handleLightCmd(entity: Entity, command: string, params?: { [key: string]: string | number | boolean }) {
    console.log("handleLightCmd", entity, command, params);
    return StatusCodes.Ok;
  }

  private async handleConnect() {
    this.connect();
  }

  private async handleSubscribeEntities() {
    this.startPolling();
  }

  private async handleUnsubscribeEntities() {
    this.stopPolling();
  }

  private async handleDisconnect() {
    this.stopPolling();
    this.uc.setDeviceState(DeviceStates.Disconnected);
    // ucConnected = false;
    // ucConnectionAttempts = 0;
  }

  private async handleEnterStandby() {
    //   ucConnected = false;
    // ucConnectionAttempts = 0;
    // stopPolling();
  }

  private async handleExitStandby() {
    //   await connect();
    //   ucConnected = true;
  }

  private async stopPolling() {
    // clearInterval(pollWorker);
    // pollWorker = null;
    // console.debug("Polling stopped.");
  }

  private async startPolling() {
    // console.debug("Started polling.");
    // if (pollWorker != null) {
    //   console.debug("Polling has already started.");
    //   return;
    // }
    // pollWorker = setInterval(async () => {
    //   if (!ucConnected) {
    //     return;
    //   }
    //   const entities = uc.configuredEntities.getEntities();
    //   for (const entity of entities) {
    //     if (entity.entity_id) {
    //       let response = new Map([]);
    //       // Get full entity data, getEntities() only returns a subset without attributes!
    //       const configuredEntity = uc.configuredEntities.getEntity(entity.entity_id);
    //       if (configuredEntity == null) {
    //         response.set([uc.Entities.Light.ATTRIBUTES.STATE], uc.Entities.Light.STATES.UNAVAILABLE);
    //         uc.configuredEntities.updateEntityAttributes(entity.entity_id, response);
    //         continue;
    //       }
    //       try {
    //         const light = await authenticatedApi.lights.getLight(entity.entity_id);
    //         console.debug("Got hue light with id:", light.id, light.name);
    //         const state = light.state;
    //         if (state.bri) {
    //           if (configuredEntity.attributes.brightness !== state.bri && configuredEntity.attributes.state !== uc.Entities.Light.STATES.OFF) {
    //             response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], configuredEntity.attributes.state === uc.Entities.Light.STATES.ON ? state.bri : 0);
    //           }
    //         }
    //         if (light.state) {
    //           const entityState = state.on ? uc.Entities.Light.STATES.ON : uc.Entities.Light.STATES.OFF;
    //           if (configuredEntity.attributes.state !== entityState) {
    //             response.set([uc.Entities.Light.ATTRIBUTES.STATE], entityState);
    //             response.set([uc.Entities.Light.ATTRIBUTES.BRIGHTNESS], state.on ? state.bri : 0);
    //           }
    //         }
    //         if (state.ct) {
    //           try {
    //             const entityColorTemp = convertColorTempFromHue(state.ct);
    //             if (configuredEntity.attributes.color_temperature !== entityColorTemp) {
    //               response.set([uc.Entities.Light.ATTRIBUTES.COLOR_TEMPERATURE], entityColorTemp);
    //             }
    //           } catch (error) {
    //             console.error("Could not convert color temperature for", entity.entity_id);
    //           }
    //         }
    //         if (state.xy) {
    //           try {
    //             const res = convertXYtoHSV(state.xy[0], state.xy[1]);
    //             const entityHue = res.hue;
    //             const entitySat = res.sat;
    //             if (configuredEntity.attributes.hue !== entityHue) {
    //               response.set([uc.Entities.Light.ATTRIBUTES.HUE], entityHue);
    //             }
    //             if (configuredEntity.attributes.saturation !== entitySat) {
    //               response.set([uc.Entities.Light.ATTRIBUTES.SATURATION], entitySat);
    //             }
    //           } catch (error) {
    //             console.error("Could not convert color for", entity.entity_id);
    //           }
    //         }
    //       } catch (error) {
    //         console.error(`Error getting hue light ${entity.entity_id}: ${error}`);
    //         if (configuredEntity.attributes.state !== uc.Entities.Light.STATES.UNAVAILABLE) {
    //           response.set([uc.Entities.Light.ATTRIBUTES.STATE], uc.Entities.Light.STATES.UNAVAILABLE);
    //         }
    //       }
    //       if (response.size > 0) {
    //         uc.configuredEntities.updateEntityAttributes(entity.entity_id, response);
    //       }
    //     }
    //   }
    // }, 2000);
  }

  private async connect() {
    //   if (hueBridgeKey != null) {
    //     console.debug("Connecting to bridge...");
    //     // connect to hue bridge
    //     let res = false;
    //     while (!res) {
    //       res = await connectToBridge();
    //       if (!res) {
    //         uc.setDeviceState(uc.DEVICE_STATES.CONNECTING);
    //         console.error("Error connecting to the Hue bridge. Trying again.");
    //         ucConnectionAttempts += 1;
    //         if (ucConnectionAttempts === 10) {
    //           console.debug("Discovering the bridge again.");
    //           const discoveredRes = await discoverBridges();
    //           if (hueBridgeAddress in discoveredRes) {
    //             hueBridgeIp = discoveredHueBridges[hueBridgeAddress].ip;
    //             saveConfig();
    //           }
    //           await delay(1000);
    //           await connectToBridge();
    //         }
    //         console.debug("Trying again in:", backOff());
    //         await delay(backOff());
    //       }
    //     }
    //     uc.setDeviceState(uc.DEVICE_STATES.CONNECTED);
    //     ucConnected = true;
    //     ucConnectionAttempts = 0;
    //     startPolling();
    //   }
  }
}

export default PhilipsHue;
