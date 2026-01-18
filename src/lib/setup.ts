/**
 * Setup flow of the Philips Hue integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import {
  DriverSetupRequest,
  RequestUserConfirmation,
  RequestUserInput,
  SetupAction,
  SetupComplete,
  SetupDriver,
  SetupError,
  UserConfirmationResponse,
  UserDataResponse
} from "@unfoldedcircle/integration-api";
import { Bonjour } from "bonjour-service";
import Config from "../config.js";
import log from "../log.js";
import { convertImageToBase64, delay, getHubUrl, getLightFeatures } from "../util.js";
import HueApi from "./hue-api/api.js";
import { LightResource } from "./hue-api/types.js";
import os from "os";

interface HueHub {
  id: string;
  ip: string;
  name: string;
}

class PhilipsHueSetup {
  private bonjour: Bonjour;
  private hubs: HueHub[] = [];
  private hueApi: HueApi;
  private config: Config;
  private selectedHub: HueHub | null = null;

  constructor(config: Config) {
    this.bonjour = new Bonjour();
    this.hueApi = new HueApi("");
    this.config = config;
  }

  async handleSetup(msg: SetupDriver): Promise<SetupAction> {
    if (msg instanceof DriverSetupRequest) {
      return await this.handleSetupRequest(msg);
    }
    if (msg instanceof UserConfirmationResponse) {
      return await this.handleUserConfirmationResponse(msg);
    }
    if (msg instanceof UserDataResponse) {
      return await this.handleUserDataResponse(msg);
    }
    return new SetupComplete();
  }

  private async handleSetupRequest(msg: DriverSetupRequest): Promise<SetupAction> {
    if (msg.reconfigure) {
      // TODO redesign setup flow: do we really want to delete the configration at this point?
      //      This should be done as late as possible: the user should not loose the old cfg if setup fails!
      this.selectedHub = null;
      this.hubs = [];
    }
    return await this.handleHubDiscovery();
  }

  private async handleUserConfirmationResponse(msg: UserConfirmationResponse): Promise<SetupAction> {
    if (msg.confirm && this.selectedHub) {
      try {
        this.hueApi.setBaseUrl(getHubUrl(this.selectedHub.ip));
        const authKey = await this.hueApi.generateAuthKey("unfoldedcircle#" + os.hostname());
        this.hueApi.setAuthKey(authKey.username);
        this.config.updateHubConfig({
          ip: this.selectedHub.ip,
          username: authKey.username
        });
        const { data, errors } = await this.hueApi.lightResource.getLights();
        if (errors && errors.length > 0) {
          return new SetupError(`Failed to get lights: ${JSON.stringify(errors[0])}`);
        }
        this.addAvailableLights(data);
        return new SetupComplete();
      } catch (error) {
        log.error("Failed to get hub config", error);
        return new SetupError("Failed to get hub config");
      }
    }
    return new SetupError("User did not confirm");
  }

  private async handleUserDataResponse(msg: UserDataResponse): Promise<SetupAction> {
    if (!msg.inputValues.hubId) {
      return new SetupError("No hub selected");
    }
    const selectedHub = this.hubs.find((hub) => hub.id === msg.inputValues.hubId);
    if (!selectedHub) {
      return new SetupError("Hub not found");
    }
    this.selectedHub = selectedHub;
    const img = convertImageToBase64("./assets/setupimg.png");
    if (!img) {
      log.error("Failed to convert image to base64");
      return new SetupError("Failed to process image during setup");
    }
    return new RequestUserConfirmation(
      "Philips Hue setup",
      "User action needed",
      img,
      "Please press the button on the Philips Hue Bridge and click next."
    );
  }

  private addAvailableLights(lights: LightResource[]) {
    lights.forEach((light) => {
      const features = getLightFeatures(light);
      this.config.addLight(light.id, { name: light.metadata.name, features });
    });
  }

  private async handleHubDiscovery(): Promise<SetupAction> {
    this.hubs = [];
    this.bonjour.find({ type: "hue" }, (service) => {
      if (!service.referer?.address) {
        log.warn("Hue bridge discovery: no address found", service.host);
        return;
      }
      const hub: HueHub = {
        id: service.host,
        ip: service.referer?.address,
        name: service.name
      };
      this.hubs.push(hub);
    });

    await delay(4000);

    if (this.hubs.length > 0) {
      log.info("Hue bridge discovery: found hubs", this.hubs);
      const hubItems = this.hubs.map((hub) => ({
        id: hub.id,
        label: { en: hub.name },
        description: { en: `IP: ${hub.ip}` }
      }));
      return new RequestUserInput("Select a Philips Hue hub", [
        {
          id: "hubId",
          label: { en: "Discovered hubs" },
          field: {
            dropdown: {
              value: hubItems[0].id,
              items: hubItems
            }
          }
        }
      ]);
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        log.warn("Hue bridge discovery timed out");
        resolve(new SetupError("Hue bridge discovery timed out"));
      }, 10000);
    });
  }
}

export default PhilipsHueSetup;
