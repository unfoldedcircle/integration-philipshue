/**
 * Philips Hue integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

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
  delay,
  getHubUrl,
  getLightFeatures,
  mirekToColorTemp,
  percentToBrightness
} from "../util.js";
import HueApi, { HueError } from "./hue-api/api.js";
import HueEventStream from "./hue-api/event-stream.js";
import { HueEvent, LightResource, LightResourceParams } from "./hue-api/types.js";
import PhilipsHueSetup from "./setup.js";

class PhilipsHue {
  private uc: IntegrationAPI;
  private readonly config: Config;
  private readonly setup: PhilipsHueSetup;
  private hueApi: HueApi;
  private eventStream: HueEventStream;

  constructor() {
    this.uc = new IntegrationAPI();
    this.config = new Config(this.uc.getConfigDirPath(), this.handleConfigEvent.bind(this));
    this.setup = new PhilipsHueSetup(this.config);
    this.hueApi = new HueApi();
    this.eventStream = new HueEventStream();
    this.config.on("change", this.onCfgChange.bind(this));
    this.config.on("remove", this.onCfgRemove.bind(this));
  }

  async init() {
    this.uc.init("driver.json", this.setup.handleSetup.bind(this.setup));
    const hubConfig = this.config.getHubConfig();
    if (hubConfig && hubConfig.ip) {
      this.hueApi.setBaseUrl(getHubUrl(hubConfig.ip));
      this.hueApi.setAuthKey(hubConfig.username);
    }
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
    this.eventStream.on("connected", async () => {
      log.info("Event stream connected, updating lights");
      this.updateLights().catch((error) => log.error("Updating lights after event stream connection failed:", error));
    });
    this.eventStream.on("disconnected", async () => {
      log.info("Event stream disconnected, trying to reconnect");
      // most likely the Hub is no longer available: set all configured lights to state UNKNOWN
      this.updateEntityStates(LightStates.Unknown);
      await delay(2000);
      if (hubConfig && hubConfig.ip) {
        this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
      }
    });
  }

  private async onCfgChange(_bridgeId: string) {
    this.eventStream.disconnect();

    const hubCfg = this.config.getHubConfig();
    if (hubCfg) {
      // set new credentials
      this.hueApi.setBaseUrl(getHubUrl(hubCfg.ip));
      this.hueApi.setAuthKey(hubCfg.username);
      this.eventStream.connect(getHubUrl(hubCfg.ip), hubCfg.username);
    }
  }

  private async onCfgRemove(_bridgeId?: string) {
    this.eventStream.disconnect();
    this.updateEntityStates(LightStates.Unavailable);
    // removing entities with a single bridge is easy
    this.uc.clearConfiguredEntities();
    this.uc.clearAvailableEntities();
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
    try {
      switch (command) {
        case LightCommands.Toggle: {
          const currentState = entity.attributes?.[LightAttributes.State] as LightStates;
          await this.hueApi.lightResource.setOn(entity.id, currentState !== LightStates.On);
          break;
        }
        case LightCommands.On: {
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
        }
        case LightCommands.Off:
          await this.hueApi.lightResource.setOn(entity.id, false);
          break;
        default:
          log.error("handleLightCmd, unsupported command: %s", command);
          return StatusCodes.BadRequest;
      }
      return StatusCodes.Ok;
    } catch (error) {
      if (error instanceof HueError) {
        // TODO check for connection error and set entity to state UNKNOWN or even UNAVAILABLE?
        //      --> consider this logic after there's a status polling feature.
        //      The event stream requires further testing and is rather slow detecting a network disconnection!
        return error.statusCode;
      }
      log.error("handleLightCmd error", error);
      return StatusCodes.ServerError;
    }
  }

  private async handleConnect() {
    log.debug("Got connect event");
    // make sure the integration state is set
    await this.uc.setDeviceState(DeviceStates.Connected);
    this.updateLights().catch((error) => log.error("Updating lights failed:", error));
  }

  private handleEventStreamUpdate(event: HueEvent) {
    for (const data of event.data) {
      if (["light", "grouped_light"].includes(data.type)) {
        log.debug("event stream light update: %s", JSON.stringify(data));
        this.syncLightState(data.id, data).catch((error) =>
          log.error("Syncing lights failed for event stream update:", error)
        );
      }
    }
  }

  private async handleSubscribeEntities() {
    // TODO verify command: entity IDs parameter seems missing!
    const hubConfig = this.config.getHubConfig();
    if (hubConfig && hubConfig.ip) {
      this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
    }
  }

  private async handleUnsubscribeEntities() {
    // TODO verify command: entity IDs parameter seems missing!
    this.eventStream.disconnect();
  }

  private async handleDisconnect() {
    log.debug("Got disconnect event");
    this.eventStream.disconnect();
    await this.uc.setDeviceState(DeviceStates.Disconnected);
  }

  private async handleEnterStandby() {
    log.info("Entering standby mode");
    this.eventStream.disconnect();
  }

  private async handleExitStandby() {
    log.info("Exiting standby mode");
    const hubConfig = this.config.getHubConfig();
    if (hubConfig && hubConfig.ip) {
      this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
    }
  }

  private async updateLights() {
    for (const entity of this.uc.getConfiguredEntities().getEntities()) {
      const entityId = entity.entity_id as string;
      try {
        const light = await this.hueApi.lightResource.getLight(entityId);

        const lightFeatures = getLightFeatures(light);
        this.config.updateLight(entityId, { name: light.metadata.name, features: lightFeatures });
        await this.syncLightState(entityId, light);
      } catch (error: unknown) {
        if (error instanceof HueError) {
          log.error(
            "Failed to update light %s: %s %s (%s)",
            entityId,
            error.statusCode,
            error.message,
            // @ts-expect-error best effort logging
            error.cause?.message ? error.cause?.message : ""
          );
        } else {
          log.error("Failed to update light %s: %s", entityId, error);
        }

        // TODO probably best to define a max error limit: e.g. abort after 3-5 failed requests

        // Note: a polling feature might be required to check the Hub's connection state.
        //       States are updated once the event stream is re-connected.
        //       But this might be rather slow, especially if the stream is still connected if an error occurs here!
        // TODO is UNAVAILABLE the correct state? The light cannot be controlled anymore until it sends an update!
        //      Maybe check status code? Only set to Unavailable for 401 (invalid auth key)
        this.uc.getConfiguredEntities().updateEntityAttributes(entityId, {
          [LightAttributes.State]: LightStates.Unavailable
        });
      }
    }
    // TODO if an error occurred while updating lights: perform a manual connectivity test and set entity states
  }

  private async syncLightState(entityId: string, light: Partial<LightResource>) {
    // only `light` types are supported at the moment: ignore everything else
    if (light.type !== "light") {
      return;
    }

    const entity = this.uc.getConfiguredEntities().getEntity(entityId);
    if (!entity) {
      log.debug("entity is not configured, skipping sync", entityId);
      return;
    }
    const lightState: Record<string, string | number> = {};
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

  private updateEntityStates(state: LightStates) {
    const configured = this.uc.getConfiguredEntities();
    for (const configuredEntity of configured.getEntities()) {
      const entityId = configuredEntity.entity_id as string;
      const entity = configured.getEntity(entityId);
      if (!entity) {
        continue;
      }
      // prevent repeating entity updates for every reconnection attempt
      if (entity.attributes?.[LightAttributes.State] !== state) {
        configured.updateEntityAttributes(entityId, {
          [LightAttributes.State]: state
        });
      }
    }
  }
}

export default PhilipsHue;
