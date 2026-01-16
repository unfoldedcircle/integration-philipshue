/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

export interface HubDeviceResult {
  errors: string[];
  data: DeviceResult[];
}

interface DeviceResult {
  id: string;
  product_data: ProductData;
  metadata: Metadata;
  identify: Record<string, any>;
  services: Service[];
  type: string;
  id_v1?: string;
}

interface ProductData {
  model_id: string;
  manufacturer_name: string;
  product_name: string;
  product_archetype: string;
  certified: boolean;
  software_version: string;
  hardware_platform_type?: string;
}

interface Metadata {
  name: string;
  archetype: string;
}

interface Service {
  rid: string;
  rtype: string;
}

export interface LightResourceResult {
  errors: any[];
  data: LightResource[];
}

export interface LightResource {
  id: string;
  id_v1?: string;
  owner: {
    rid: string;
    rtype: string;
  };
  metadata: {
    name: string;
    archetype: string;
    function: string;
  };
  product_data: {
    function: string;
  };
  identify: any;
  service_id: number;
  on: {
    on: boolean;
  };
  dimming: {
    brightness: number;
    min_dim_level?: number;
  };
  dimming_delta: any;
  color_temperature?: {
    mirek: number;
    mirek_valid: boolean;
    mirek_schema: {
      mirek_minimum: number;
      mirek_maximum: number;
    };
  };
  color_temperature_delta: any;
  color?: {
    xy: {
      x: number;
      y: number;
    };
    gamut: {
      red: { x: number; y: number };
      green: { x: number; y: number };
      blue: { x: number; y: number };
    };
    gamut_type: string;
  };
  dynamics: {
    status: string;
    status_values: string[];
    speed: number;
    speed_valid: boolean;
  };
  alert: {
    action_values: string[];
  };
  signaling: {
    signal_values: string[];
  };
  mode: string;
  effects: {
    status_values: string[];
    status: string;
    effect_values: string[];
  };
  timed_effects: {
    status_values: string[];
    status: string;
    effect_values: string[];
  };
  powerup: {
    preset: string;
    configured: boolean;
    on: {
      mode: string;
      on: {
        on: boolean;
      };
    };
    dimming: {
      mode: string;
      dimming: {
        brightness: number;
      };
    };
    color: {
      mode: string;
      color_temperature: {
        mirek: number;
      };
    };
  };
  type: string;
}

export interface LightResourceParams {
  on: { on: boolean };
  dimming: {
    brightness: number;
  };
  color: {
    xy: {
      x: number;
      y: number;
    };
  };
  color_temperature: {
    mirek: number;
  };
}

export interface HubConfig {
  name: string;
  datastoreversion: string;
  swversion: string;
  apiversion: string;
  mac: string;
  bridgeid: string;
  factorynew: boolean;
  replacesbridgeid: string | null;
  modelid: string;
  starterkitid: string;
}

export interface AuthenticateResult {
  error?: { type: number; address: string; description: string };
  success?: AuthenticateSuccess;
}

export interface AuthenticateSuccess {
  username: string;
  clientkey: string;
}

export type LightEffect =
  | "prism"
  | "opal"
  | "glisten"
  | "sparkle"
  | "fire"
  | "candle"
  | "underwater"
  | "cosmos"
  | "sunbeam"
  | "enchant"
  | "no_effect";

export interface LightResourceResponse {
  errors: { description: string }[];
  data: { rid: string }[];
}

export interface HueEvent {
  id: string;
  type: "update" | "add" | "delete" | "error";
  data: {
    id: string;
    type: string;
    [key: string]: any;
  }[];
  creationtime: string;
}
