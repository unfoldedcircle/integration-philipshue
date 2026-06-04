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
  Select,
  SelectAttributes,
  SelectCommands,
  SelectStates,
  StatusCodes
} from "@unfoldedcircle/integration-api";
import Config, { ConfigEvent, GroupConfig, LightOrGroupConfig, SceneConfig } from "../config.js";
import log from "../log.js";
import {
  addAvailableGroups,
  addAvailableLights,
  addAvailableScenes,
  brightnessToPercent,
  buildSceneOptionsForGroup,
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
  percentToBrightness,
  SCENE_NONE_OPTION,
  SCENE_OFF_OPTION
} from "../util.js";
import HueApi, { HueError } from "./hue-api/api.js";
import HueEventStream from "./hue-api/event-stream.js";
import { CombinedGroupResource, HueEvent, LightResource, LightResourceParams } from "./hue-api/types.js";
import PhilipsHueSetup from "./setup.js";

const SCENE_SELECT_PREFIX = "hue_scenes_";

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
  // Per-group scene Select state. Each group with scenes gets one Select entity named
  // "<Group> scenes"; these maps translate between the option label shown to the user
  // and the underlying Hue scene id. Forward map is keyed by groupId so we can wholesale
  // rebuild a group's Select on scene add/remove/rename; reverse map is keyed by sceneId
  // so SSE handlers (status.active transitions) can find the option in O(1).
  private sceneOptionToId: Map<string, Map<string, string>> = new Map();
  private sceneIdToOption: Map<string, { groupId: string; option: string }> = new Map();
  // Tracks the last-known on/off state of each group that has a scene Select, keyed by
  // groupId. Drives the `Off` current_option / placeholder distinction without depending on
  // whether the group's Light entity is configured. Populated from grouped_light SSE events
  // and syncGroupState; absent entry => assume on (show the `—` placeholder).
  private groupPowerOn: Map<string, boolean> = new Map();

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
    log.info("Migrating config to latest format. This requires a connection to the Hub.");

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

          const scenes = await this.hueApi.sceneResource.getScenes();
          this.config.removeScenes();
          if (scenes.length > 0) {
            addAvailableScenes(scenes, this.config);
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
    this.rebuildAllSceneSelects();
  }

  /**
   * (Re)build a Select entity for every group that has at least one configured scene.
   *
   * Groups without scenes get no entity (and any pre-existing Select is removed).
   */
  private rebuildAllSceneSelects() {
    const scenesByGroup = new Map<string, (SceneConfig & { id: string })[]>();
    for (const scene of this.config.getScenes()) {
      const bucket = scenesByGroup.get(scene.groupId);
      if (bucket) {
        bucket.push(scene);
      } else {
        scenesByGroup.set(scene.groupId, [scene]);
      }
    }
    // Remove Select entities for groups that no longer have scenes
    for (const groupId of this.sceneOptionToId.keys()) {
      if (!scenesByGroup.has(groupId)) {
        this.removeSceneSelectForGroup(groupId);
      }
    }
    for (const [groupId, scenes] of scenesByGroup) {
      this.rebuildSceneSelectForGroup(groupId, scenes);
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
    this.sceneOptionToId.clear();
    this.sceneIdToOption.clear();
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
    } else if (event.type === "scene-added") {
      this.rebuildSceneSelectForGroup(event.data.groupId);
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
            // CLIP v2 treats chromaticity (color.xy) and luminance (dimming.brightness)
            // as orthogonal. Coupling the bulb's current brightness into HSV→xy would
            // shift the computed xy non-linearly via the sRGB gamma step — we rely on
            // a separate dimming command instead.
            req.color = {
              xy: convertHSVtoXY(Number(params.hue), Number(params.saturation), entityConfig.gamut)
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

  private getSceneSelectEntityId(groupId: string): string {
    return `${SCENE_SELECT_PREFIX}${groupId}`;
  }

  private groupIdFromSelectEntityId(entityId: string): string | undefined {
    if (!entityId.startsWith(SCENE_SELECT_PREFIX)) {
      return undefined;
    }
    return entityId.slice(SCENE_SELECT_PREFIX.length);
  }

  /**
   * Rebuild (create or update) the scene Select entity for the given group.
   *
   * If `scenes` is omitted, queries the config for scenes belonging to `groupId`. Removes
   * the Select if the group ends up with zero scenes — a Select with only the placeholder
   * option carries no information and would clutter the entity list.
   */
  private rebuildSceneSelectForGroup(groupId: string, scenes?: (SceneConfig & { id: string })[]) {
    const groupScenes = scenes ?? this.config.getScenes().filter((s) => s.groupId === groupId);
    if (groupScenes.length === 0) {
      this.removeSceneSelectForGroup(groupId);
      return;
    }

    const { optionToId, idToOption } = buildSceneOptionsForGroup(groupScenes);
    this.sceneOptionToId.set(groupId, optionToId);
    // Refresh the reverse-direction map: drop stale entries for this group, then re-add.
    for (const [sceneId, mapping] of this.sceneIdToOption) {
      if (mapping.groupId === groupId) {
        this.sceneIdToOption.delete(sceneId);
      }
    }
    for (const [sceneId, option] of idToOption) {
      this.sceneIdToOption.set(sceneId, { groupId, option });
    }

    const currentOption = this.deriveCurrentOptionForGroup(groupId) ?? SCENE_NONE_OPTION;
    const options = this.computeOptionsForGroup(groupId, currentOption);

    const groupName = groupScenes[0].groupName;
    const entityId = this.getSceneSelectEntityId(groupId);
    const name = groupName ? `${groupName} scenes` : "Hue scenes";
    const available = this.uc.getAvailableEntities();

    if (available.contains(entityId)) {
      const configured = this.uc.getConfiguredEntities();
      const updates: Record<string, string | string[] | SelectStates> = {
        [SelectAttributes.Options]: options,
        [SelectAttributes.CurrentOption]: currentOption
      };
      configured.updateEntityAttributes(entityId, updates);
      available.updateEntityAttributes(entityId, updates);
    } else {
      const select = new Select(entityId, name, {
        description: groupName ? `Hue scenes in ${groupName}` : "Hue scenes",
        area: groupName,
        attributes: {
          [SelectAttributes.State]: SelectStates.On,
          [SelectAttributes.Options]: options,
          [SelectAttributes.CurrentOption]: currentOption
        }
      });
      select.setCmdHandler(this.onSceneSelectCommand.bind(this));
      available.addAvailableEntity(select);
    }
  }

  /**
   * Build the options array for a group's Select given its resolved `current_option`.
   *
   * `Off` is always present and selectable (turning it on turns the whole group off). The `—`
   * placeholder is included only when it is the current option (group on, no scene active), so
   * it disappears from the dropdown the moment a scene becomes active or the group turns off.
   */
  private computeOptionsForGroup(groupId: string, currentOption: string): string[] {
    const optionToId = this.sceneOptionToId.get(groupId);
    const sceneOptions = optionToId ? [...optionToId.keys()] : [];
    const placeholder = currentOption === SCENE_NONE_OPTION ? [SCENE_NONE_OPTION] : [];
    return [...placeholder, SCENE_OFF_OPTION, ...sceneOptions];
  }

  private removeSceneSelectForGroup(groupId: string) {
    this.sceneOptionToId.delete(groupId);
    for (const [sceneId, mapping] of this.sceneIdToOption) {
      if (mapping.groupId === groupId) {
        this.sceneIdToOption.delete(sceneId);
      }
    }
    const entityId = this.getSceneSelectEntityId(groupId);
    this.uc.getConfiguredEntities().removeEntity(entityId);
    this.uc.getAvailableEntities().removeEntity(entityId);
  }

  /**
   * Find the option string that should currently be shown for a group's Select.
   *
   * Returns the active scene's option label if one is set on the group's existing Select,
   * mapped through the (possibly just-rebuilt) options. Returns undefined if there's no
   * Select yet for this group (caller decides what to seed).
   */
  private deriveCurrentOptionForGroup(groupId: string): string | undefined {
    const entityId = this.getSceneSelectEntityId(groupId);
    const existing = this.uc.getAvailableEntities().getEntity(entityId);
    if (!existing) {
      return undefined;
    }
    // The non-scene sentinel reflects current group power: `Off` when off, `—` when on.
    const noScene = this.groupPowerOn.get(groupId) === false ? SCENE_OFF_OPTION : SCENE_NONE_OPTION;
    const prevOption = (existing.attributes?.[SelectAttributes.CurrentOption] as string | undefined) ?? undefined;
    if (!prevOption || prevOption === SCENE_NONE_OPTION || prevOption === SCENE_OFF_OPTION) {
      return noScene;
    }
    // If the previously-active scene still exists in this group, remap its label (it may
    // have been renamed). Otherwise, fall back to the power-based sentinel.
    const optionToId = this.sceneOptionToId.get(groupId);
    const sceneId = optionToId?.get(prevOption);
    if (sceneId) {
      const mapping = this.sceneIdToOption.get(sceneId);
      return mapping?.option ?? noScene;
    }
    return noScene;
  }

  /**
   * Set the Select's state for a group, given either the scene id whose activation we just
   * observed or undefined to revert to "no scene active".
   *
   * Broadcasts both `current_option` and `options` in the same entity_change so the Remote
   * sees a consistent snapshot. With no active scene, the current option reflects the group's
   * power: `Off` when off, the `—` placeholder when on (the placeholder then appears in
   * `options`; `Off` is always present and selectable).
   */
  private setSelectCurrentOption(groupId: string, sceneId: string | undefined) {
    const entityId = this.getSceneSelectEntityId(groupId);
    if (!this.uc.getAvailableEntities().contains(entityId)) {
      return;
    }
    let option: string;
    if (sceneId) {
      // An active scene implies the group is on; show the scene regardless of power state.
      option = this.sceneIdToOption.get(sceneId)?.option ?? SCENE_NONE_OPTION;
    } else {
      // No active scene: reflect the group's power — `Off` when off, `—` placeholder when on.
      option = this.groupPowerOn.get(groupId) === false ? SCENE_OFF_OPTION : SCENE_NONE_OPTION;
    }
    const updates = {
      [SelectAttributes.CurrentOption]: option,
      [SelectAttributes.Options]: this.computeOptionsForGroup(groupId, option)
    };
    this.uc.getConfiguredEntities().updateEntityAttributes(entityId, updates);
    this.uc.getAvailableEntities().updateEntityAttributes(entityId, updates);
  }

  /**
   * Record a group's on/off state and reconcile its scene Select's `Off`/`—` sentinel.
   *
   * Fed from grouped_light SSE events and {@link syncGroupState}. Only groups that have a
   * scene Select are reconciled. On a power change we move the sentinel — but when the group
   * turns on we only act if the Select currently shows `Off`, so a concurrently-activated
   * scene (whose SSE event may arrive before or after the power event) is never clobbered.
   */
  private recordGroupPowerForScenes(groupId: string, on: boolean) {
    const prev = this.groupPowerOn.get(groupId);
    this.groupPowerOn.set(groupId, on);
    if (prev === on || !this.sceneOptionToId.has(groupId)) {
      return;
    }
    const entityId = this.getSceneSelectEntityId(groupId);
    const current = this.uc.getAvailableEntities().getEntity(entityId)?.attributes?.[SelectAttributes.CurrentOption] as
      | string
      | undefined;
    if (!on) {
      // Group turned off: show `Off`, clearing any active scene or placeholder.
      if (current !== SCENE_OFF_OPTION) {
        this.setSelectCurrentOption(groupId, undefined);
      }
    } else if (current === SCENE_OFF_OPTION) {
      // Group turned on with no scene yet: move `Off` back to the `—` placeholder.
      this.setSelectCurrentOption(groupId, undefined);
    }
  }

  private async onSceneSelectCommand(
    entity: Entity,
    command: string,
    params?: { [key: string]: string | number | boolean }
  ): Promise<StatusCodes> {
    const groupId = this.groupIdFromSelectEntityId(entity.id);
    if (!groupId) {
      log.error("onSceneSelectCommand: entity id %s is not a scene Select", entity.id);
      return StatusCodes.BadRequest;
    }
    const optionToId = this.sceneOptionToId.get(groupId);
    if (!optionToId) {
      log.warn("onSceneSelectCommand: no options registered for group %s", groupId);
      return StatusCodes.BadRequest;
    }

    let targetOption: string | undefined;
    switch (command) {
      case SelectCommands.SelectOption:
        targetOption = typeof params?.option === "string" ? params.option : undefined;
        break;
      case SelectCommands.SelectFirst:
      case SelectCommands.SelectLast:
      case SelectCommands.SelectNext:
      case SelectCommands.SelectPrevious: {
        // Navigation uses whatever options the Remote currently sees — the entity's live
        // `options` attribute, not a freshly-built list. With the dynamic placeholder, the
        // visible options vary based on whether a scene is active.
        const currentEntity = this.uc.getAvailableEntities().getEntity(entity.id);
        const options = (currentEntity?.attributes?.[SelectAttributes.Options] as string[] | undefined) ?? [];
        if (options.length <= 1) {
          // Empty, or only the `—` placeholder — nothing to navigate.
          return StatusCodes.Ok;
        }
        const currentOption =
          (currentEntity?.attributes?.[SelectAttributes.CurrentOption] as string | undefined) ?? SCENE_NONE_OPTION;
        const currentIdx = Math.max(0, options.indexOf(currentOption));
        const cycle = params?.cycle !== false;
        let nextIdx: number;
        if (command === SelectCommands.SelectFirst) {
          nextIdx = 0;
        } else if (command === SelectCommands.SelectLast) {
          nextIdx = options.length - 1;
        } else if (command === SelectCommands.SelectNext) {
          nextIdx = currentIdx + 1 >= options.length ? (cycle ? 0 : currentIdx) : currentIdx + 1;
        } else {
          nextIdx = currentIdx - 1 < 0 ? (cycle ? options.length - 1 : currentIdx) : currentIdx - 1;
        }
        targetOption = options[nextIdx];
        break;
      }
      default:
        log.error("onSceneSelectCommand: unsupported command: %s", command);
        return StatusCodes.BadRequest;
    }

    if (targetOption === undefined) {
      log.warn("onSceneSelectCommand: missing `option` parameter for select_option");
      return StatusCodes.BadRequest;
    }

    if (targetOption === SCENE_OFF_OPTION) {
      const groupConfig = this.config.getLight(groupId);
      if (!groupConfig || !this.isGroupConfig(groupConfig)) {
        log.warn("onSceneSelectCommand: no group config for %s; cannot turn off", groupId);
        return StatusCodes.BadRequest;
      }
      // Optimistic UI: paint `Off` immediately, then turn the whole group off. Same call the
      // group's Light entity makes (PUT /grouped_light/<id> {on:{on:false}}), fanned out over
      // the group's grouped_light ids. SSE reaffirms on success; we revert on failure.
      this.groupPowerOn.set(groupId, false);
      this.setSelectCurrentOption(groupId, undefined); // resolves to `Off`
      Promise.all(
        groupConfig.groupedLightIds.map((groupedLightId) =>
          this.hueApi.lightResource.setOn(groupedLightId, false, false)
        )
      ).catch((error) => {
        log.error("Turning group %s off from scene Select failed, reverting:", groupId, error);
        this.groupPowerOn.set(groupId, true);
        this.setSelectCurrentOption(groupId, undefined);
      });
      return StatusCodes.Ok;
    }

    if (targetOption === SCENE_NONE_OPTION) {
      // Selecting the placeholder is a no-op — the Hue API has no "deactivate scene" verb.
      // The Select stays where it is (the bridge will resolve current_option via SSE if anything
      // actually changed).
      return StatusCodes.Ok;
    }

    const sceneId = optionToId.get(targetOption);
    if (!sceneId) {
      log.warn("onSceneSelectCommand: option %s not recognized for group %s", targetOption, groupId);
      return StatusCodes.BadRequest;
    }

    // Optimistic UI: paint the new option immediately so the remote doesn't sit in a "pending"
    // state while the bridge processes. Recall is fire-and-forget; SSE will reaffirm on success
    // and we revert on failure. The bridge's PUT /scene response can take >1.5s; awaiting it
    // would block this handler (and the remote's UI) for the full RTT plus any retries.
    this.setSelectCurrentOption(groupId, sceneId);
    this.hueApi.sceneResource.recall(sceneId).catch((error) => {
      log.error("Scene recall failed for %s, reverting Select to placeholder:", sceneId, error);
      // We don't actually know which scene (if any) the bridge is currently in; safest is to
      // revert to the placeholder. SSE will correct if some other scene was already active.
      this.setSelectCurrentOption(groupId, undefined);
    });
    return StatusCodes.Ok;
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

        // Track group power for the scene Select's `Off`/`—` sentinel. Done here (not inside
        // syncLightState, which bails when the group's Light entity isn't configured) so the
        // Select stays correct even if only the scene Select is configured.
        if (data.type === "grouped_light" && data.on && typeof data.on === "object" && "on" in data.on) {
          this.recordGroupPowerForScenes(entityId, !!data.on.on);
        }

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
              gamut: lightConfig.gamut,
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
          // a group rename cascades to the displayed names of any scenes pointing at it
          this.propagateGroupRenameToScenes(data.id, updateGroupData.metadata.name);
        }
      } else if (data.type === "scene") {
        log.debug("event stream scene update: %s", JSON.stringify(data));
        const sceneCfg = this.config.getScene(data.id);
        if (!sceneCfg) {
          log.debug("No config for scene %s, skipping update", data.id);
          continue;
        }
        let labelsChanged = false;
        if (data.metadata && typeof data.metadata === "object" && "name" in data.metadata) {
          const newName = data.metadata.name as string;
          if (newName !== sceneCfg.name) {
            this.config.updateScene(data.id, { ...sceneCfg, name: newName });
            labelsChanged = true;
          }
        }
        // Whichever scene the bridge reports as active is reflected in its group's Select.
        // The bridge uses several active-state strings ("static", "dynamic_palette", …) for
        // "scene is playing"; we only care about the binary "playing vs not".
        if (data.status && typeof data.status === "object" && "active" in data.status) {
          if (data.status.active !== "inactive") {
            this.setSelectCurrentOption(sceneCfg.groupId, data.id);
          } else {
            // Only clear if this scene is the one currently shown — another scene becoming
            // active will already have moved the Select away from this one.
            const mapping = this.sceneIdToOption.get(data.id);
            if (mapping) {
              const entityId = this.getSceneSelectEntityId(mapping.groupId);
              const existing = this.uc.getAvailableEntities().getEntity(entityId);
              const currentOption = existing?.attributes?.[SelectAttributes.CurrentOption] as string | undefined;
              if (currentOption === mapping.option) {
                this.setSelectCurrentOption(mapping.groupId, undefined);
              }
            }
          }
        }
        if (labelsChanged) {
          // Option label for this scene changed — rebuild the group's Select so options
          // (and the maps) stay in lockstep with the scene name shown to the user.
          this.rebuildSceneSelectForGroup(sceneCfg.groupId);
        }
      }
    }
  }

  private propagateGroupRenameToScenes(groupId: string, newGroupName: string) {
    let renamed = false;
    for (const scene of this.config.getScenes()) {
      if (scene.groupId === groupId && scene.groupName !== newGroupName) {
        const { id, ...rest } = scene;
        this.config.updateScene(id, { ...rest, groupName: newGroupName });
        renamed = true;
      }
    }
    if (!renamed) {
      return;
    }
    // The Select entity name embeds the group name ("<Group> scenes") and uses it as the area;
    // both need to be updated. The integration-api entity-list API doesn't support a name edit,
    // so we drop and re-add the entity instead. Any subscribers see one entity-removed +
    // entity-added pair, which is acceptable for the rare group-rename case.
    this.removeSceneSelectForGroup(groupId);
    this.rebuildSceneSelectForGroup(groupId);
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
        case "scene": {
          const scene = await this.hueApi.sceneResource.getScene(data.id);
          addAvailableScenes([scene], this.config);
          this.rebuildSceneSelectForGroup(scene.group.rid);
          // If the scene is recalled right after creation, the bridge will emit a separate
          // status.active update — handled in handleEventStreamUpdate. Nothing to seed here.
          break;
        }
      }
    }
  }

  private handleEventStreamDelete(event: HueEvent) {
    const configured = this.uc.getConfiguredEntities();
    for (const data of event.data) {
      if (data.type === "scene") {
        const sceneCfg = this.config.getScene(data.id);
        this.config.removeScene(data.id);
        if (sceneCfg) {
          this.rebuildSceneSelectForGroup(sceneCfg.groupId);
        }
        continue;
      }
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
        if (id.startsWith(SCENE_SELECT_PREFIX)) {
          // Scene Select entities are not lights/groups, so no per-entity bridge fetch is
          // needed. But: any attribute mutations that happened on availableEntities before
          // this subscribe (e.g. during setup, when scenes were added one at a time and the
          // Select's `options` list grew) were never broadcast — `updateEntityAttributes`
          // only broadcasts when the entity is already in configuredEntities. The framework
          // adds the entity to configured BEFORE emitting SubscribeEntities, so re-sending
          // the current attributes here lets the Remote learn the full options array,
          // current_option, and state in one entity_change event.
          const entity = this.uc.getAvailableEntities().getEntity(id);
          if (entity?.attributes) {
            this.uc.getConfiguredEntities().updateEntityAttributes(id, { ...entity.attributes });
          }
          continue;
        }
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
      // Scene Select entities don't have a light/group config; their state is refreshed by
      // refreshSceneSelectStates() below from the scene resource itself.
      if (entityId.startsWith(SCENE_SELECT_PREFIX)) {
        continue;
      }
      await this.updateLight(entityId);
    }
    this.updateEntityIndexes();
    await this.refreshSceneSelectStates();
    // TODO if an error occurred while updating lights: perform a manual connectivity test and set entity states
  }

  /**
   * Apply the bridge's current per-group active scene to each Select's `current_option`.
   * Called on event-stream connect so the UI is correct without waiting for the next SSE
   * transition.
   */
  private async refreshSceneSelectStates() {
    if (this.sceneOptionToId.size === 0) {
      return;
    }
    try {
      const activeScenes = await this.hueApi.sceneResource.getActiveScenes();
      const activeByGroup = new Map<string, string>();
      for (const scene of activeScenes) {
        activeByGroup.set(scene.groupId, scene.id);
      }
      for (const groupId of this.sceneOptionToId.keys()) {
        this.setSelectCurrentOption(groupId, activeByGroup.get(groupId));
      }
    } catch (error) {
      log.error("Refreshing scene Select states failed:", error);
    }
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
      const { hue, sat } = convertXYtoHSV(light.color.xy.x, light.color.xy.y, light.color.gamut ?? config?.gamut);
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
    // Keep the group's scene Select `Off`/`—` sentinel in sync (covers initial load and
    // room/zone events). Only when the grouped lights actually reported a power state.
    if (anyOn || anyOff) {
      this.recordGroupPowerForScenes(entityId, anyOn);
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
      const { hue, sat } = convertXYtoHSV(color.color.xy.x, color.color.xy.y, color.color.gamut ?? config?.gamut);
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
