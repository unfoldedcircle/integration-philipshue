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
  LightFeatures,
  LightStates,
  StatusCodes
} from "@unfoldedcircle/integration-api";
import Config, { ConfigEvent, GroupConfig, LightOrGroupConfig } from "../config.js";
import log from "../log.js";
import {
  addAvailableGroups,
  addAvailableLights,
  brightnessToPercent,
  colorTempToMirek,
  convertHSVtoXY,
  convertXYtoHSV,
  delay,
  getGroupFeatures,
  getHubUrl,
  getLightFeatures,
  getMinMaxMirek,
  getMostCommonGamut,
  mirekToColorTemp,
  percentToBrightness
} from "../util.js";
import HueApi, { HueError } from "./hue-api/api.js";
import HueEventStream from "./hue-api/event-stream.js";
import { CombinedGroupResource, HueEvent, LightResource, LightResourceParams } from "./hue-api/types.js";
import PhilipsHueSetup from "./setup.js";

const MIGRATION_MAX_RETRIES = 6;
const MIGRATION_INITIAL_RETRY_DELAY_MS = 1000;

class PhilipsHue {
  private uc: IntegrationAPI;
  private readonly config: Config;
  private readonly setup: PhilipsHueSetup;
  private hueApi: HueApi;
  private eventStream: HueEventStream;
  private groupedLightIdToGroupId: Map<string, string> = new Map();
  private lightIdToGroupIds: Map<string, string[]> = new Map();
  private entityIdToConfig: Map<string, LightOrGroupConfig> = new Map();
  // v1|v2 -> v2 light identifiers to map Remote entity IDs to the v2 light identifier.
  private publicToV2LightIds: Map<string, string> = new Map();
  // all available lights with a v1 identifier. Used to detect legacy entity subscriptions from the Remote.
  private v1LightIds: Set<string> = new Set();
  // migration guard flag
  private migrating = false;

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
    const hubConfig = this.config.getHubConfig();
    if (hubConfig && hubConfig.ip) {
      this.hueApi.setBaseUrl(getHubUrl(hubConfig.ip));
      this.hueApi.setAuthKey(hubConfig.username);

      if (this.config.needsMigration()) {
        await this.migrateConfig();
      }
    }

    this.uc.init("driver.json", this.setup.handleSetup.bind(this.setup));
    this.updateEntityIndexes();
    await this.readEntitiesFromConfig();
    this.setupDriverEvents();
    this.setupEventStreamEvents();
    log.info("Philips Hue driver initialized");
  }

  /**
   * Migrate an old v1 configuration to v2 by fetching all light, room, and zone resources from the hub.
   *
   * The configuration is marked as `migrated` after successful migration. In case of Hub authentication errors,
   * the configuration is cleared and the user has to run setup again.
   *
   * @param max_retries - Maximum number of retries for API calls during migration (default: MIGRATION_MAX_RETRIES)
   */
  private async migrateConfig(max_retries: number = MIGRATION_MAX_RETRIES) {
    if (this.migrating || !this.config.needsMigration()) {
      return;
    }
    this.migrating = true;
    log.info("Migrating v1 config to new format. This requires a connection to the Hub.");

    try {
      let retries = 0;
      while (true) {
        try {
          const v2Lights = await this.hueApi.lightResource.getLights();
          this.config.removeLights();
          addAvailableLights(v2Lights, this.config);

          const roomData = await this.hueApi.groupResource.getGroupResources("room");
          if (roomData.length > 0) {
            addAvailableGroups(roomData, "room", this.config);
          }

          const zoneData = await this.hueApi.groupResource.getGroupResources("zone");
          if (zoneData.length > 0) {
            addAvailableGroups(zoneData, "zone", this.config);
          }

          this.updateEntityIndexes();
          this.config.markMigrated();
          this.migrating = false;
          log.info("Migration successful");
          return;
        } catch (error) {
          retries++;
          // Abort in case of authentication error! New Hub authorization required
          if (error instanceof HueError && error.statusCode == StatusCodes.Unauthorized) {
            log.error("Migration failed: invalid credentials, setup is required. Error: %s", error.message);
            this.config.clear();
            this.hueApi.setBaseUrl(undefined);
            this.hueApi.setAuthKey("");
            this.eventStream.disconnect();
            return;
          }

          if (retries > max_retries) {
            log.error(
              "Migration failed after %d retries. Hub might be unavailable. The application will continue, but some entities might be missing. Error: %s",
              max_retries,
              error instanceof HueError ? error.message : error
            );
            return;
          }

          const waitMs = MIGRATION_INITIAL_RETRY_DELAY_MS * Math.pow(2, Math.min(5, retries - 1));
          log.warn(
            "Migration failed (attempt %d/%d), retrying in %d ms: %s",
            retries,
            max_retries,
            waitMs,
            error instanceof HueError ? error.message : error
          );
          await delay(waitMs);
        }
      }
    } finally {
      this.migrating = false;
    }
  }

  private async readEntitiesFromConfig() {
    const lights = this.config.getLights();
    for (const light of lights) {
      const lightEntity = new Light(light.id, light.name, {
        icon: this.getEntityIcon(light),
        description: this.getEntityDescription(light),
        features: light.features
      });
      this.addAvailableLight(lightEntity);
    }
  }

  private updateEntityIndexes() {
    this.groupedLightIdToGroupId.clear();
    this.lightIdToGroupIds.clear();
    this.entityIdToConfig.clear();
    this.publicToV2LightIds.clear();
    this.v1LightIds.clear();
    const entities = this.config.getLights();
    for (const entity of entities) {
      this.entityIdToConfig.set(entity.id, entity);

      // Groups were not supported in the old v1 integration
      if (this.isGroupConfig(entity)) {
        entity.groupedLightIds.forEach((groupedLightId) => {
          this.entityIdToConfig.set(groupedLightId, entity);
          this.groupedLightIdToGroupId.set(groupedLightId, entity.id);
        });
        entity.childLightIds.forEach((lightId) => {
          this.lightIdToGroupIds.set(lightId, [...(this.lightIdToGroupIds.get(lightId) ?? []), entity.id]);
        });
      } else {
        if (entity.id_v1) {
          this.entityIdToConfig.set(entity.id_v1, entity);
          this.publicToV2LightIds.set(entity.id_v1, entity.id);
          this.v1LightIds.add(entity.id_v1);
        }
        this.publicToV2LightIds.set(entity.id, entity.id);
      }
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
    this.eventStream.on("add", this.handleEventStreamAdd.bind(this));
    this.eventStream.on("delete", this.handleEventStreamDelete.bind(this));
    this.eventStream.on("connected", async () => {
      log.info("Event stream connected, updating lights");
      this.updateLights().catch((error) => log.error("Updating lights after event stream connection failed:", error));
    });
    this.eventStream.on("disconnected", async () => {
      log.debug("Event stream disconnected, trying to reconnect");
      // most likely the Hub is no longer available: set all configured lights to state UNKNOWN
      this.updateEntityStates(LightStates.Unknown);
      await delay(2000);
      if (hubConfig && hubConfig.ip) {
        this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
      }
    });
  }

  private onCfgChange(_bridgeId: string) {
    this.eventStream.disconnect();

    const hubCfg = this.config.getHubConfig();
    if (hubCfg) {
      // set new credentials
      this.hueApi.setBaseUrl(getHubUrl(hubCfg.ip));
      this.hueApi.setAuthKey(hubCfg.username);
      this.eventStream.connect(getHubUrl(hubCfg.ip), hubCfg.username);
    }
    this.updateEntityIndexes();
  }

  private onCfgRemove(_bridgeId?: string) {
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
      const light = new Light(event.data.id, event.data.name, {
        icon: this.getEntityIcon(event.data),
        description: this.getEntityDescription(event.data),
        features: event.data.features
      });
      this.addAvailableLight(light);
    }
    this.updateEntityIndexes();
  }

  /**
   * Return a custom icon for a light or group based on its type.
   */
  private getEntityIcon(light: LightOrGroupConfig): string | undefined {
    if ("groupType" in light) {
      return light.groupType === "room" ? "uc:vector-square" : "uc:rectangles-mixed";
    }

    return undefined;
  }

  /**
   * Return a custom description for a light or group based on its type.
   */
  private getEntityDescription(light: LightOrGroupConfig): string | undefined {
    if ("groupType" in light) {
      return `${light.groupType === "room" ? "Room group" : "Zone group"} with ${light.childLightIds.length} light(s)`;
    }

    // make it easier to distinguish between API v1 and v2 entities having the same name after a migration
    return "API v2 ID";
  }

  private addAvailableLight(light: Light) {
    light.setCmdHandler(this.onEntityCommand.bind(this));
    this.uc.addAvailableEntity(light);
  }

  private async onEntityCommand(
    entity: Entity,
    command: string,
    params?: { [key: string]: string | number | boolean }
  ): Promise<StatusCodes> {
    const latestConfig = this.entityIdToConfig.get(this.getV2EntityId(entity.id));
    if (!latestConfig) {
      log.error("No config found for entity: %s", entity.id);
      return StatusCodes.NotFound;
    }
    return this.handleLightCmd(entity, latestConfig, command, params);
  }

  private isGroupConfig(entityConfig: LightOrGroupConfig): entityConfig is GroupConfig {
    return "groupType" in entityConfig;
  }

  private async handleLightCmd(
    entity: Entity,
    entityConfig: LightOrGroupConfig,
    command: string,
    params?: { [key: string]: string | number | boolean }
  ): Promise<StatusCodes> {
    const isGroup = this.isGroupConfig(entityConfig);
    const entityIds = isGroup ? entityConfig.groupedLightIds : [entity.id];
    if (!entityIds || entityIds.length === 0) {
      log.error("handleLightCmd, missing groupedLightIds for group entity: %s", entity.id);
      return StatusCodes.NotFound;
    }

    const results = new Set(
      await Promise.all(
        entityIds.map(async (entityId) => {
          return await this.handleSingleLightCmd(entity, entityId, entityConfig, command, isGroup, params);
        })
      )
    );

    if (results.has(StatusCodes.ServerError)) {
      return StatusCodes.ServerError;
    }
    if (results.has(StatusCodes.BadRequest)) {
      return StatusCodes.BadRequest;
    }
    return StatusCodes.Ok;
  }

  private async handleSingleLightCmd(
    entity: Entity,
    entityId: string,
    entityConfig: LightOrGroupConfig,
    command: string,
    isGroup: boolean,
    params?: { [key: string]: string | number | boolean }
  ): Promise<StatusCodes> {
    const v2EntityId = this.getV2EntityId(entityId);
    try {
      switch (command) {
        case LightCommands.Toggle: {
          const currentState = entity.attributes?.[LightAttributes.State] as LightStates;
          await this.hueApi.lightResource.setOn(v2EntityId, currentState !== LightStates.On, !isGroup);
          break;
        }
        case LightCommands.On: {
          if (
            params?.brightness === undefined &&
            params?.color_temperature === undefined &&
            params?.hue === undefined
          ) {
            // if no parameters are provided, simply turn on the light
            await this.hueApi.lightResource.setOn(v2EntityId, true, !isGroup);
            break;
          }

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
            const config = this.config.getLight(entityId);
            const mirek = this.getMirek(entityId, config);
            const minMirek = mirek?.minMirek;
            const maxMirek = mirek?.maxMirek;
            if (minMirek && maxMirek) {
              req.color_temperature = {
                mirek: colorTempToMirek(Number(params.color_temperature), minMirek, maxMirek)
              };
            }
          }
          if (params?.hue !== undefined && params?.saturation !== undefined) {
            const currentB = Number(entity.attributes?.[LightAttributes.Brightness]);
            const v = Number.isFinite(currentB) ? Math.max(0, Math.min(currentB, 255)) / 255 : 1;
            req.color = {
              xy: convertHSVtoXY(Number(params.hue), Number(params.saturation), v, entityConfig.gamut)
            };
          }
          await this.hueApi.lightResource.updateLightState(v2EntityId, req, !isGroup);
          break;
        }
        case LightCommands.Off:
          await this.hueApi.lightResource.setOn(v2EntityId, false, !isGroup);
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

  private getMirek(entityId: string, config?: LightOrGroupConfig) {
    const minMirek = config?.mirek_schema?.mirek_minimum;
    const maxMirek = config?.mirek_schema?.mirek_maximum;
    if (minMirek && maxMirek) {
      return { minMirek, maxMirek };
    }

    const groupId = this.groupedLightIdToGroupId.get(entityId);
    if (groupId) {
      const groupLight = this.config.getLight(groupId!);
      return {
        minMirek: groupLight?.mirek_schema?.mirek_minimum,
        maxMirek: groupLight?.mirek_schema?.mirek_maximum
      };
    }
  }

  private async handleConnect() {
    log.debug("Got connect event");
    // make sure the integration state is set
    await this.uc.setDeviceState(DeviceStates.Connected);
    this.updateLights().catch((error) => log.error("Updating lights failed:", error));
  }

  private async handleEventStreamUpdate(event: HueEvent) {
    for (const data of event.data) {
      if (["light", "grouped_light"].includes(data.type)) {
        let entityId: string;
        if (data.type === "grouped_light") {
          const mappedId = this.groupedLightIdToGroupId.get(data.id);
          if (!mappedId) {
            log.debug("Skipping grouped_light event with unmapped id '%s'; no matching configured entity.", data.id);
            continue;
          }
          entityId = mappedId;
        } else {
          entityId = data.id;
        }
        log.debug("event stream light update: %s", JSON.stringify(data));
        // Stream updates for grouped lights have the same contract as single lights
        this.syncLightState(entityId, data).catch((error) =>
          log.error("Syncing lights failed for event stream update:", error)
        );

        // grouped_light can't be updated, they are a compound of multiple devices and belong to a room/zone
        if (data.type === "light") {
          const groupIds = this.lightIdToGroupIds.get(data.id);
          if (groupIds) {
            for (const groupId of groupIds) {
              // intentionally update the group with light data to update the color and gamut which is not sent for groups
              this.syncLightState(groupId, { ...data, on: undefined, dimming: undefined }).catch((error) =>
                log.error("Syncing group lights failed for event stream update:", error)
              );
            }
          }

          // a light can only be updated with its name
          if (data.metadata && typeof data.metadata === "object" && "name" in data.metadata) {
            const lightConfig = this.config.getLight(data.id);
            if (!lightConfig) {
              log.debug("No config found for light %s, skipping config update", data.id);
              continue;
            }
            this.config.updateLight(data.id, {
              id_v1: data.id_v1,
              name: data.metadata.name as string,
              features: lightConfig.features,
              gamut_type: lightConfig.gamut_type,
              mirek_schema: lightConfig.mirek_schema
            });
          }
        }
      } else if (["room", "zone"].includes(data.type)) {
        const group = this.config.getLight(data.id) as GroupConfig;
        if (group) {
          // update the whole group resource if something has changed in it since it is made up of multiple resources
          const updateGroupData = await this.hueApi.groupResource.getGroupResource(data.id, group.groupType);
          this.config.updateLight(data.id, {
            name: updateGroupData.metadata.name,
            features: getGroupFeatures(updateGroupData),
            groupType: updateGroupData.type === "zone" ? "zone" : "room",
            groupedLightIds: updateGroupData.grouped_lights.map((gl) => gl.id),
            childLightIds: updateGroupData.lights.map((light) => light.id),
            gamut_type: getMostCommonGamut(updateGroupData),
            mirek_schema: getMinMaxMirek(updateGroupData)
          });
          this.syncGroupState(data.id, updateGroupData).catch((error) =>
            log.error("Syncing group state failed for event stream update:", error)
          );
        }
      }
    }
  }

  private async handleEventStreamAdd(event: HueEvent) {
    for (const data of event.data) {
      switch (data.type) {
        case "light": {
          const light = await this.hueApi.lightResource.getLight(data.id);
          addAvailableLights([light], this.config);
          break;
        }
        case "room":
        case "zone":
          {
            const group = await this.hueApi.groupResource.getGroupResource(data.id, data.type);
            addAvailableGroups([group], data.type, this.config);
          }
          break;
      }
    }
  }

  private handleEventStreamDelete(event: HueEvent) {
    const configured = this.uc.getConfiguredEntities();
    for (const data of event.data) {
      const publicIds = this.getPublicEntityIds(data.id);
      for (const publicEntityId of publicIds) {
        configured.updateEntityAttributes(publicEntityId, {
          [LightAttributes.State]: LightStates.Unavailable
        });
      }
      this.config.removeLight(data.id);
    }
    this.updateEntityIndexes();
  }

  private async handleSubscribeEntities(ids: string[]) {
    const configured = this.uc.getConfiguredEntities();

    for (const id of ids) {
      // Support legacy entity configurations in the Remote using the old v1 light identifier
      if (this.v1LightIds.has(id) && !configured.contains(id)) {
        const entity = this.uc.getAvailableEntities().getEntity(this.getV2EntityId(id));
        if (entity) {
          // clone v2 entity using the v1 identifier
          const v1Entity = new Light(id, entity.name, {
            features: entity.features as LightFeatures[],
            attributes: entity.attributes,
            options: entity.options
          });
          v1Entity.setCmdHandler(this.onEntityCommand.bind(this));

          configured.addAvailableEntity(v1Entity);
        }
      }
    }
    const hubConfig = this.config.getHubConfig();

    if (hubConfig && hubConfig.ip) {
      // manually fetch the current light states and send entity updates
      for (const id of ids) {
        await this.updateLight(id);
      }
      this.updateEntityIndexes();
      // make sure the event stream is connected
      this.eventStream.connect(getHubUrl(hubConfig.ip), hubConfig.username);
    } else {
      this.updateEntityStates(LightStates.Unavailable);
    }
  }

  private async handleUnsubscribeEntities(_ids: string[]) {
    // Note: the node library needs more methods to check avail / configured entities
    if (this.uc.getConfiguredEntities().getEntities().length === 0) {
      this.eventStream.disconnect();
    }
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

  /**
   * Updates the state of all configured lights.
   *
   * Called whenever the event stream is connected or after a `connect` request of the Remote.
   *
   * This method iterates over all configured light entities, updating their
   * states individually, and then refreshes the entity indexes.
   */
  private async updateLights() {
    if (this.config.needsMigration()) {
      await this.migrateConfig(5);
    }
    // TODO get all lights at once instead of one call per light? Probably have to split by group type
    for (const entity of this.uc.getConfiguredEntities().getEntities()) {
      const entityId = entity.entity_id as string;
      await this.updateLight(entityId);
    }
    this.updateEntityIndexes();
    // TODO if an error occurred while updating lights: perform a manual connectivity test and set entity states
  }

  /**
   * Updates the state and configuration of a light or group of lights based on the provided entity ID.
   *
   * Determines if the entity is a single light or a group, fetches the corresponding resource,
   * updates the configuration, and synchronizes the state. Entity change events are emitted for changed attributes.
   *
   * @param {string} entityId - The unique v1 or v2 identifier of the light or group to update.
   * @return {Promise<boolean>} A promise that resolves to `true` if the update succeeds, or `false` if an error occurs.
   */
  private async updateLight(entityId: string): Promise<boolean> {
    const v2EntityId = this.getV2EntityId(entityId);
    try {
      const config = this.entityIdToConfig.get(v2EntityId);
      if (!config) {
        log.warn("No config found for entity %s; skipping update", v2EntityId);
        return false;
      }
      const isGroup = this.isGroupConfig(config);
      if (isGroup) {
        const groupResource = await this.hueApi.groupResource.getGroupResource(v2EntityId, config.groupType);
        if (!["room", "zone"].includes(groupResource.type)) {
          log.warn("Unsupported group type '%s' for entity %s; skipping update", groupResource.type, v2EntityId);
          return false;
        }
        const groupFeatures = getGroupFeatures(groupResource);
        this.config.updateLight(v2EntityId, {
          name: groupResource.metadata.name,
          features: groupFeatures,
          groupedLightIds: groupResource.grouped_lights.map((gl) => gl.id),
          groupType: groupResource.type === "zone" ? "zone" : "room",
          childLightIds: groupResource.lights.map((light) => light.id),
          gamut_type: getMostCommonGamut(groupResource),
          mirek_schema: getMinMaxMirek(groupResource)
        });
        await this.syncGroupState(v2EntityId, groupResource);
      } else {
        const light = await this.hueApi.lightResource.getLight(v2EntityId);
        const lightFeatures = getLightFeatures(light);
        this.config.updateLight(v2EntityId, {
          id_v1: light.id_v1,
          name: light.metadata.name,
          features: lightFeatures,
          gamut_type: light.color?.gamut_type,
          mirek_schema: light.color_temperature?.mirek_schema
        });
        await this.syncLightState(v2EntityId, light);
      }

      return true;
    } catch (error: unknown) {
      let statusCode = 0;
      if (error instanceof HueError) {
        statusCode = error.statusCode;
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
      // Only set entity to Unavailable for missing or invalid authentication key errors.
      const state = statusCode === 401 || statusCode === 403 ? LightStates.Unavailable : LightStates.Unknown;
      const publicIds = this.getPublicEntityIds(entityId);
      for (const publicEntityId of publicIds) {
        this.uc.getConfiguredEntities().updateEntityAttributes(publicEntityId, {
          [LightAttributes.State]: state
        });
      }

      return false;
    }
  }

  /**
   * Synchronizes the state of a light entity with the current state of the provided light resource.
   *
   * An entity change event is triggered if any entity attribute changes.
   *
   * @param v2Id - The unique v2 identifier of the entity to be synced.
   * @param light - A partial representation of the light resource containing the updated state.
   * @return A promise that resolves once the synchronization process is complete.
   */
  private async syncLightState(v2Id: string, light: Partial<LightResource>) {
    const publicIds = this.getPublicEntityIds(v2Id);
    if (publicIds.length === 0) {
      log.debug("entity %s is not configured, skipping sync", v2Id);
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
      const config = this.config.getLight(v2Id);
      const mirek = this.getMirek(v2Id, config);
      const minMirek = mirek?.minMirek;
      const maxMirek = mirek?.maxMirek;
      if (minMirek && maxMirek) {
        lightState[LightAttributes.ColorTemperature] = mirekToColorTemp(
          light.color_temperature.mirek,
          minMirek,
          maxMirek
        );
      }
    }

    if (light.color && light.color.xy) {
      const config = this.config.getLight(v2Id);
      const { hue, sat } = convertXYtoHSV(
        light.color.xy.x,
        light.color.xy.y,
        light.dimming?.brightness,
        light.color.gamut ?? config?.gamut
      );
      lightState[LightAttributes.Hue] = hue;
      lightState[LightAttributes.Saturation] = sat;
    }

    // update changed attributes and send WS entity change event
    if (Object.keys(lightState).length === 0) {
      return;
    }
    for (const publicEntityId of publicIds) {
      this.uc.getConfiguredEntities().updateEntityAttributes(publicEntityId, lightState);
    }
  }

  private async syncGroupState(entityId: string, group: CombinedGroupResource) {
    const entity = this.uc.getConfiguredEntities().getEntity(entityId);
    if (!entity) {
      log.debug("entity is not configured, skipping sync", entityId);
      return;
    }
    const groupState: Record<string, string | number> = {};
    const groupedLights = group.grouped_lights;
    const anyOn = groupedLights.some((groupLight) => groupLight.on?.on);
    const anyOff = groupedLights.some((groupLight) => groupLight.on && !groupLight.on.on);
    if (anyOn) {
      groupState[LightAttributes.State] = LightStates.On;
    } else if (anyOff) {
      groupState[LightAttributes.State] = LightStates.Off;
    }

    const dimming = groupedLights?.find((groupLight) => groupLight.dimming);
    if (dimming) {
      groupState[LightAttributes.Brightness] = percentToBrightness(dimming.dimming.brightness);
    }

    const colorTemp =
      groupedLights?.find((groupLight) => groupLight.color_temperature?.mirek_valid) ??
      group.lights?.find((light) => light.color_temperature?.mirek_valid);
    if (colorTemp?.color_temperature) {
      const config = this.config.getLight(entityId);
      const mirek = this.getMirek(entityId, config);
      const minMirek = mirek?.minMirek;
      const maxMirek = mirek?.maxMirek;
      if (minMirek && maxMirek) {
        groupState[LightAttributes.ColorTemperature] = mirekToColorTemp(
          colorTemp.color_temperature.mirek,
          minMirek,
          maxMirek
        );
      }
    }

    const color =
      groupedLights?.find((groupLight) => groupLight.color?.xy) ?? group.lights?.find((light) => light.color?.xy);
    if (color?.color && color.color.xy) {
      const config = this.config.getLight(entityId);
      const { hue, sat } = convertXYtoHSV(
        color.color.xy.x,
        color.color.xy.y,
        color.dimming?.brightness,
        color.color.gamut ?? config?.gamut
      );
      groupState[LightAttributes.Hue] = hue;
      groupState[LightAttributes.Saturation] = sat;
    }
    this.uc.getConfiguredEntities().updateEntityAttributes(entityId, groupState);
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

  /**
   * Get all configured entity identifiers of the given v2 ID.
   * If the Remote has legacy v1 entities configured, the light might be available as two entities with v1 and v2 ID.
   *
   * @param v2Id v2 light identifier
   */
  private getPublicEntityIds(v2Id: string): string[] {
    const ids = [];

    if (this.uc.getConfiguredEntities().contains(v2Id)) {
      ids.push(v2Id);
    }

    const light = this.config.getLight(v2Id);
    if (light && "id_v1" in light && light.id_v1) {
      if (this.uc.getConfiguredEntities().contains(light.id_v1)) {
        ids.push(light.id_v1);
      }
    }

    return ids;
  }

  /**
   * Resolve the v2 light identifier from a legacy v1 identifier.
   * Returns the same identifier if it's not a v1 ID.
   */
  private getV2EntityId(entityId: string): string {
    return this.publicToV2LightIds.get(entityId) ?? entityId;
  }
}

export default PhilipsHue;
