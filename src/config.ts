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
import { GamutType, GroupType } from "./lib/hue-api/types.js";

const CFG_FILENAME = "philips_hue_config.json";

export interface LightConfig {
  name: string;
  features: LightFeatures[];
  gamut_type?: GamutType;
  mirek_schema?: { mirek_minimum: number; mirek_maximum: number };
}
export interface GroupConfig extends LightConfig {
  groupType: GroupType;
  groupedLightIds: string[];
  childLightIds: string[];
}
export type LightOrGroupConfig = LightConfig | GroupConfig;

interface PhilipsHueConfig {
  hub?: { name: string; ip: string; username: string; bridgeId: string };
  lights: { [key: string]: LightOrGroupConfig };
}

export type ConfigEvent =
  | { type: "light-added"; data: LightOrGroupConfig & { id: string } }
  | { type: "light-updated"; data: LightOrGroupConfig & { id: string } };

class Config extends EventEmitter {
  private config: PhilipsHueConfig = { lights: {} };
  private readonly configPath: string;
  private readonly cb?: (event: ConfigEvent) => void;

  constructor(configDir: string, cb?: (event: ConfigEvent) => void) {
    super();
    this.configPath = path.join(configDir, CFG_FILENAME);
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
    this.config.lights[id] = light;
    this.saveToFile();
  }

  public removeLight(id: string) {
    delete this.config.lights[id];
    this.saveToFile();
  }

  public getLight(id: string): LightOrGroupConfig | undefined {
    return this.config.lights[id];
  }

  public removeHub() {
    const bridgeId = this.config.hub?.bridgeId;
    this.config = { lights: {} };
    this.saveToFile();
    if (bridgeId) {
      this.emit("remove", bridgeId);
    }
  }

  public clear() {
    this.config = { lights: {} };
    this.saveToFile();
    this.emit("remove", null);
  }

  private loadFromFile() {
    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, "utf-8");
        this.config = JSON.parse(data);
      } catch (e) {
        log.error(`Error loading configuration from ${this.configPath}: ${e}`);
        // keep default config or what was already loaded
      }
    } else {
      this.saveToFile();
    }
  }

  private saveToFile() {
    try {
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, data, "utf-8");
    } catch (e) {
      log.error(`Error saving configuration to ${this.configPath}: ${e}`);
    }
  }
}

export default Config;
