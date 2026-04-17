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
  identify: Record<string, unknown>;
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
  errors: { description: string }[];
  data: LightResource[];
}

export interface GroupLightResult {
  errors: { description: string }[];
  data: GroupedLightResource[];
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
  identify: unknown;
  service_id: number;
  on: {
    on: boolean;
  };
  dimming: {
    brightness: number;
    min_dim_level?: number;
  };
  dimming_delta: unknown;
  color_temperature?: {
    mirek: number;
    mirek_valid: boolean;
    mirek_schema: {
      mirek_minimum: number;
      mirek_maximum: number;
    };
  };
  color_temperature_delta: unknown;
  color?: {
    xy: {
      x: number;
      y: number;
    };
    gamut: GamutTriangle;
    gamut_type: GamutType;
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

export interface GroupedLightResource {
  id: string;
  id_v1?: string;
  owner: {
    rid: string;
    rtype: string;
  };
  on: {
    on: boolean;
  };
  dimming: {
    brightness: number;
    min_dim_level?: number;
  };
  dimming_delta: unknown;
  color_temperature?: {
    mirek: number;
    mirek_valid: boolean;
    mirek_schema: {
      mirek_minimum: number;
      mirek_maximum: number;
    };
  };
  color_temperature_delta: unknown;
  color?: {
    xy: {
      x: number;
      y: number;
    };
    gamut: GamutTriangle;
    gamut_type: GamutType;
  };
  alert: {
    action_values: string[];
  };
  signaling: {
    signal_values: string[];
  };
  dynamics: {
    status: string;
    status_values: string[];
    speed: number;
    speed_valid: boolean;
  };
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
    id_v1?: string;
    type: string;
    [key: string]: unknown;
  }[];
  creationtime: string;
}

export interface GroupResource {
  id: string;
  id_v1?: string;
  children: ResourceIdentifier[];
  services: ResourceIdentifier[];
  type: ResourceType;
  metadata: {
    name: string;
    archetype: Archetype;
  };
}

export interface ResourceIdentifier {
  rid: string;
  rtype: ResourceType;
}

export type GroupType = "zone" | "room";

export type ResourceType = KnownResourceType | (string & {});
export type KnownResourceType =
  | "device"
  | "bridge_home"
  | "room"
  | "zone"
  | "service_group"
  | "light"
  | "button"
  | "bell_button"
  | "relative_rotary"
  | "temperature"
  | "light_level"
  | "motion"
  | "camera_motion"
  | "entertainment"
  | "contact"
  | "tamper"
  | "convenience_area_motion"
  | "security_area_motion"
  | "speaker"
  | "grouped_light"
  | "grouped_motion"
  | "grouped_light_level"
  | "device_power"
  | "device_software_update"
  | "zigbee_connectivity"
  | "zgp_connectivity"
  | "bridge"
  | "motion_area_candidate"
  | "wifi_connectivity"
  | "zigbee_device_discovery"
  | "homekit"
  | "matter"
  | "matter_fabric"
  | "scene"
  | "entertainment_configuration"
  | "public_image"
  | "auth_v1"
  | "behavior_script"
  | "behavior_instance"
  | "geofence_client"
  | "geolocation"
  | "smart_scene"
  | "motion_area_configuration"
  | "clip";

export type Archetype = KnownArchetype | (string & {});
export type KnownArchetype =
  | "living_room"
  | "kitchen"
  | "dining"
  | "bedroom"
  | "kids_bedroom"
  | "bathroom"
  | "nursery"
  | "recreation"
  | "office"
  | "gym"
  | "hallway"
  | "toilet"
  | "front_door"
  | "garage"
  | "terrace"
  | "garden"
  | "driveway"
  | "carport"
  | "home"
  | "downstairs"
  | "upstairs"
  | "top_floor"
  | "attic"
  | "guest_room"
  | "staircase"
  | "lounge"
  | "man_cave"
  | "computer"
  | "studio"
  | "music"
  | "tv"
  | "reading"
  | "closet"
  | "storage"
  | "laundry_room"
  | "balcony"
  | "porch"
  | "barbecue"
  | "pool"
  | "other";

export interface GroupResourceResponse {
  errors: { description: string }[];
  data: GroupResource[];
}

export interface CombinedGroupResource {
  id: string;
  lights: LightResource[];
  grouped_lights: GroupedLightResource[];
  type: ResourceType;
  metadata: {
    name: string;
  };
}

export type GamutType = "A" | "B" | "C";

/** CIE xy chromaticity coordinates for each primary of a light's color gamut triangle. */
export interface GamutTriangle {
  red: { x: number; y: number };
  green: { x: number; y: number };
  blue: { x: number; y: number };
}
