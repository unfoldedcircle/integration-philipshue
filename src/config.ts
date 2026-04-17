/**
 * This module implements the Philips Hue local configuration of the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { LightFeatures } from "@unfoldedcircle/integration-api";
import EventEmitter from "node:events";
import fs from "fs";
import path from "path";
import log from "./log.js";
import { GamutTriangle, GamutType, GroupType } from "./lib/hue-api/types.js";
import { isDeepEqual } from "./util.js";

const CFG_VERSION = 3;
const V1_CFG_FILENAME = "config.json";
const CFG_FILENAME = "philips_hue_config.json";

export interface LightConfig {
  id_v1?: string;
  name: string;
  features: LightFeatures[];
  gamut_type?: GamutType;
  /** Runtime gamut triangle from the Hue API; preferred over the canonical gamut_type lookup. */
  gamut?: GamutTriangle;
  mirek_schema?: { mirek_minimum: number; mirek_maximum: number };
}
export interface GroupConfig extends Omit<LightConfig, "id_v1"> {
  groupType: GroupType;
  groupedLightIds: string[];
  childLightIds: string[];
}
export type LightOrGroupConfig = LightConfig | GroupConfig;

interface PhilipsHueConfig {
  cfg_version?: number;
  hub?: { name: string; ip: string; username: string; bridgeId: string };
  lights: { [key: string]: LightOrGroupConfig };
}

export type ConfigEvent =
  | { type: "light-added"; data: LightOrGroupConfig & { id: string } }
  | { type: "light-updated"; data: LightOrGroupConfig & { id: string } };

class Config extends EventEmitter {
  private config: PhilipsHueConfig = { lights: {} };
  private readonly configDir: string;
  private readonly cb?: (event: ConfigEvent) => void;

  constructor(configDir: string, cb?: (event: ConfigEvent) => void) {
    super();
    this.configDir = configDir;
    this.loadFromFile();
    this.cb = cb;
  }

  public getHubConfig() {
    return this.config.hub;
  }

  public updateHubConfig(hub: Partial<NonNullable<PhilipsHueConfig["hub"]>>) {
    if (!this.config.hub && hub.name && hub.ip && hub.username && hub.bridgeId) {
      this.config.hub = {
        name: hub.name,
        ip: hub.ip,
        username: hub.username,
        bridgeId: hub.bridgeId
      };
    } else if (this.config.hub) {
      this.config.hub = {
        name: hub.name ?? this.config.hub.name,
        ip: hub.ip ?? this.config.hub.ip,
        username: hub.username ?? this.config.hub.username,
        bridgeId: hub.bridgeId ?? this.config.hub.bridgeId
      };
    }
    this.saveToFile();
    if (this.config.hub) {
      this.emit("change", this.config.hub.bridgeId);
    }
  }

  /**
   * Returns true if the configuration version is not the latest version.
   */
  public needsMigration(): boolean {
    return this.config.cfg_version != CFG_VERSION;
  }

  /**
   * Set the configuration version to the latest version and save the configuration file.
   */
  public markMigrated() {
    this.config.cfg_version = CFG_VERSION;
    this.saveToFile();
  }

  public addLight(id: string, light: LightOrGroupConfig) {
    this.config.lights[id] = light;
    this.saveToFile();
    if (this.cb) {
      this.cb({ type: "light-added", data: { id, ...light } });
    }
  }

  public getLights(): (LightOrGroupConfig & { id: string })[] {
    return Object.entries(this.config.lights).map(([id, light]) => ({ id, ...light }));
  }

  public updateLight(id: string, light: LightOrGroupConfig) {
    if (this.config.lights[id] && isDeepEqual(this.config.lights[id], light)) {
      return;
    }
    this.config.lights[id] = light;
    this.saveToFile();
  }

  public removeLight(id: string) {
    delete this.config.lights[id];
    this.saveToFile();
  }

  public removeLights() {
    this.config.lights = {};
    this.saveToFile();
  }

  public getLight(id: string): LightOrGroupConfig | undefined {
    return this.config.lights[id];
  }

  /**
   * Remove the Hue hub. Since only one hub is supported, the configuration is cleared.
   */
  public removeHub() {
    const bridgeId = this.config.hub?.bridgeId;
    this.config = { cfg_version: CFG_VERSION, lights: {} };
    this.saveToFile();
    if (bridgeId) {
      this.emit("remove", bridgeId);
    }
  }

  /**
   * Clear the hub and light configuration.
   */
  public clear() {
    this.config = { cfg_version: CFG_VERSION, lights: {} };
    this.saveToFile();
    this.emit("remove", null);
  }

  private loadFromFile() {
    const configPath = path.join(this.configDir, CFG_FILENAME);

    try {
      if (fs.existsSync(configPath)) {
        log.debug(`Loading configuration from ${CFG_FILENAME}`);
        const data = fs.readFileSync(configPath, "utf-8");
        this.config = JSON.parse(data);
        if (this.config.cfg_version === undefined) {
          // older v2 development cfg: patch configuration
          this.config.cfg_version = CFG_VERSION;
          this.saveToFile();
        }
        return;
      }

      // migrate old configuration file if it exists
      if (this.migrateV1ConfigurationFiles()) {
        return;
      }

      log.warn("No configuration file found, creating new empty configuration");
      this.saveToFile();
    } catch (e) {
      log.error(`Error loading configuration from ${configPath}: ${e}`);
      // keep default config or what was already loaded
    }
  }

  private saveToFile() {
    const configPath = path.join(this.configDir, CFG_FILENAME);
    try {
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(configPath, data, "utf-8");
    } catch (e) {
      log.error(`Error saving configuration to ${configPath}: ${e}`);
    }
  }

  private migrateV1ConfigurationFiles(): boolean {
    const configPath = path.join(this.configDir, V1_CFG_FILENAME);

    if (!fs.existsSync(configPath)) {
      log.debug("No old configuration file found, skipping migration");
      return false;
    }

    log.warn("Old configuration file found, migrating to new format");
    const data = fs.readFileSync(configPath, "utf-8");
    const old = JSON.parse(data);
    if (old.hueBridgeAddress && old.hueBridgeIp && old.hueBridgeUser) {
      this.config.hub = {
        name: old.hueBridgeAddress.replace(".local", ""),
        ip: old.hueBridgeIp,
        username: old.hueBridgeUser,
        bridgeId: old.hueBridgeAddress
      };
      this.config.cfg_version = 1;
      const entityCfgPath = path.join(this.configDir, "configured_entities.json");
      this.saveToFile();
      fs.rmSync(configPath);
      if (fs.existsSync(entityCfgPath)) {
        log.debug(`Removing old entity configuration file: ${entityCfgPath}`);
        fs.rmSync(entityCfgPath);
      }
      return true;
    } else {
      log.error("Old configuration file is missing required hub fields: cannot migrate old configuration!");
      fs.rmSync(configPath);
      return false;
    }
  }
}

export default Config;
