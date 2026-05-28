/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { HueError, ResourceApi } from "./api.js";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import {
  CombinedSceneResource,
  SceneRecallResponse,
  SceneResource as SceneResourceData,
  SceneResourceResult
} from "./types.js";

class SceneResource {
  private readonly api: ResourceApi;

  constructor(api: ResourceApi) {
    this.api = api;
  }

  public async getScenes(): Promise<CombinedSceneResource[]> {
    const res = await this.api.sendRequest<SceneResourceResult>("GET", "/clip/v2/resource/scene");
    if (!res.data || res.data.length === 0) {
      return [];
    }
    return res.data.map((scene) => this.toCombined(scene));
  }

  public async getScene(id: string): Promise<CombinedSceneResource> {
    const res = await this.api.sendRequest<SceneResourceResult>("GET", `/clip/v2/resource/scene/${id}`);
    if (!res.data || res.data.length === 0) {
      throw new HueError("Scene resource not found", StatusCodes.NotFound);
    }
    return this.toCombined(res.data[0]);
  }

  /**
   * Recall a scene on the bridge. Lets the bridge pick the playback mode based on the scene's
   * own configuration (e.g. `auto_dynamic`); we don't override it.
   */
  public async recall(id: string): Promise<SceneRecallResponse["data"]> {
    const res = await this.api.sendRequest<SceneRecallResponse>("PUT", `/clip/v2/resource/scene/${id}`, {
      recall: { action: "active" }
    });
    return res.data ?? [];
  }

  /**
   * Return the scenes the bridge currently reports as playing, one per group at most.
   *
   * Used to seed each per-group Select's `current_option` on event-stream connect.
   */
  public async getActiveScenes(): Promise<{ id: string; groupId: string }[]> {
    const res = await this.api.sendRequest<SceneResourceResult>("GET", "/clip/v2/resource/scene");
    if (!res.data || res.data.length === 0) {
      return [];
    }
    return res.data
      .filter((scene) => scene.status?.active && scene.status.active !== "inactive")
      .map((scene) => ({ id: scene.id, groupId: scene.group.rid }));
  }

  private toCombined(scene: SceneResourceData): CombinedSceneResource {
    const rtype: "room" | "zone" = scene.group.rtype === "zone" ? "zone" : "room";
    return {
      id: scene.id,
      name: scene.metadata.name,
      group: { rid: scene.group.rid, rtype }
    };
  }
}

export default SceneResource;
