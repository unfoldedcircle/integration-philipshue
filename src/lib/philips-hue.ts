import {
  DeviceStates,
  Entity,
  Events,
  IntegrationAPI,
  Light,
  LightAttributes,
  LightCommands,
  LightStates,
  StatusCodes
} from "@unfoldedcircle/integration-api";
import Config, { ConfigEvent } from "../config.js";
import log from "../log.js";
import {
  brightnessToPercent,
  colorTempToMirek,
  convertHSVtoXY,
  convertXYtoHSV,
  getHubUrl,
  getLightFeatures,
  mirekToColorTemp,
  percentToBrightness
} from "../util.js";
import HueApi from "./hue-api/api.js";
import HueEventStream from "./hue-api/event-stream.js";
import { HueEvent, LightResource, LightResourceParams } from "./hue-api/types.js";
import PhilipsHueSetup from "./setup.js";

class PhilipsHue {
  private uc: IntegrationAPI;
  private config: Config;
  private setup: PhilipsHueSetup;
  private hueApi: HueApi;
  private eventStream: HueEventStream;

  constructor() {
    this.uc = new IntegrationAPI();
    this.config = new Config(this.uc.getConfigDirPath(), this.handleConfigEvent.bind(this));
    this.setup = new PhilipsHueSetup(this.config);
    this.hueApi = new HueApi("");
    this.eventStream = new HueEventStream();
  }

  async init() {
    this.uc.init("driver.json", this.setup.handleSetup.bind(this.setup));
    const hubConfig = this.config.getHubConfig();
    this.hueApi.setBaseUrl(getHubUrl(hubConfig.ip));
    this.hueApi.setAuthKey(hubConfig.username);
    this.readEntitiesFromConfig();
    this.setupDriverEvents();
    this.setupEventStreamEvents();
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

  private setupEventStreamEvents() {
    const hubConfig = this.config.getHubConfig();
    this.eventStream.on("update", this.handleEventStreamUpdate.bind(this));
    this.eventStream.on("disconnected", () => {
      log.warn("Event stream disconnected, trying to reconnect");
      setTimeout(() => {
        this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
      }, 2000);
    });
  }

  // terri: check if you can simplify since
  // light-added and light-updated are the same
  private handleConfigEvent(event: ConfigEvent) {
    if (event.type === "light-added") {
      const light = new Light(event.data.id, event.data.name, { features: event.data.features });
      this.addAvailableLight(light);
    }
  }

  private addAvailableLight(light: Light) {
    light.setCmdHandler(this.handleLightCmd.bind(this));
    this.uc.addAvailableEntity(light);
  }

  private async handleLightCmd(entity: Entity, command: string, params?: { [key: string]: string | number | boolean }) {
    switch (command) {
      case LightCommands.Toggle: {
        const currentState = entity.attributes?.[LightAttributes.State] as LightStates;
        this.hueApi.lightResource.setOn(entity.id, currentState === LightStates.On ? false : true);
        break;
      }
      case LightCommands.On:
        const req: Partial<LightResourceParams> = {};
        // ("brightness" (0-255), "color_temperature" (0-100), "hue", "saturation".)
        if (params?.brightness !== undefined) {
          if (params.brightness === 0) {
            req.on = { on: false };
          } else {
            req.dimming = { brightness: brightnessToPercent(Number(params.brightness)) };
            req.on = { on: true };
          }
        }
        if (params?.color_temperature !== undefined) {
          req.color_temperature = { mirek: colorTempToMirek(Number(params.color_temperature)) };
        }
        if (params?.hue !== undefined && params?.saturation !== undefined) {
          req.color = { xy: convertHSVtoXY(Number(params.hue), Number(params.saturation), 1) };
        }
        await this.hueApi.lightResource.updateLightState(entity.id, req);
        break;
      case LightCommands.Off:
        await this.hueApi.lightResource.setOn(entity.id, false);
        break;
      default:
        log.error(`handleLightCmd, Unsupported command: ${command}`);
        return StatusCodes.BadRequest;
    }
    return StatusCodes.Ok;
  }

  private async handleConnect() {
    this.updateLights();
  }

  private handleEventStreamUpdate(event: HueEvent) {
    for (const data of event.data) {
      if (["light", "grouped_light"].includes(data.type)) {
        log.debug("event stream light update", data)
        this.syncLightState(data.id, data);
      }
    }
  }

  private async handleSubscribeEntities() {
    const hubConfig = this.config.getHubConfig();
    this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
  }

  private async handleUnsubscribeEntities() {
    this.eventStream.disconnect();
  }

  private async handleDisconnect() {
    this.eventStream.disconnect();
    this.uc.setDeviceState(DeviceStates.Disconnected);
  }

  private async handleEnterStandby() {
    this.eventStream.disconnect();
  }

  private async handleExitStandby() {
    const hubConfig = this.config.getHubConfig();
    this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
  }

  private async updateLights() {
    for (const entity of this.uc.getConfiguredEntities().getEntities()) {
      const entityId = entity.entity_id as string;
      const lightResource = await this.hueApi.lightResource.getLight(entityId);
      if (lightResource.errors.length > 0) {
        log.error(`Error fetching light ${entityId}: ${lightResource.errors[0]}`);
        this.uc.getConfiguredEntities().updateEntityAttributes(entityId, {
          [LightAttributes.State]: LightStates.Unavailable
        });
        return;
      }
      const light = lightResource.data[0];
      const lightFeatures = getLightFeatures(light);
      this.config.updateLight(entityId, { name: light.metadata.name, features: lightFeatures });
      this.syncLightState(entityId, light);
    }
  }

  private async syncLightState(entityId: string, light: Partial<LightResource>) {
    const entity = this.uc.getConfiguredEntities().getEntity(entityId);
    if (!entity) {
      log.warn("entity is not configured, skipping sync", entityId);
      return;
    }
    const lightState: Record<string, any> = {};
    if (light.on) {
      lightState[LightAttributes.State] = light.on.on ? LightStates.On : LightStates.Off;
    }
    if (light.dimming) {
      lightState[LightAttributes.Brightness] = percentToBrightness(light.dimming.brightness);
    }

    if (light.color_temperature && light.color_temperature.mirek_valid) {
      const entityColorTemp = mirekToColorTemp(light.color_temperature.mirek);
      lightState[LightAttributes.ColorTemperature] = entityColorTemp;
    }

    if (light.color && light.color.xy) {
      const { hue, sat } = convertXYtoHSV(light.color.xy.x, light.color.xy.y, light.dimming?.brightness);
      lightState[LightAttributes.Hue] = hue;
      lightState[LightAttributes.Saturation] = sat;
    }
    this.uc.getConfiguredEntities().updateEntityAttributes(entityId, lightState);
  }
}

export default PhilipsHue;
