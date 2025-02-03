import {
  DriverSetupRequest,
  IntegrationAPI,
  Light,
  RequestUserConfirmation,
  RequestUserInput,
  SetupAction,
  SetupComplete,
  SetupDriver,
  SetupError,
  UserConfirmationResponse,
  UserDataResponse
} from "@unfoldedcircle/integration-api";
import { convertImageToBase64, delay, getLightFeatures } from "../util.js";
import log from "../log.js";
import { Bonjour } from "bonjour-service";
import HueApi from "./hue-api/api.js";
import { LightResource } from "./hue-api/types.js";
import Config from "../config.js";

interface HueHub {
  id: string;
  ip: string;
  name: string;
}

class PhilipsHueSetup {
  private uc: IntegrationAPI;
  private bonjour: Bonjour;
  private hubs: HueHub[] = [];
  private hueApi: HueApi;
  private config: Config;

  constructor(uc: IntegrationAPI, config: Config) {
    this.uc = uc;
    this.bonjour = new Bonjour();
    this.hueApi = new HueApi("");
    this.config = config;
  }

  async handleSetup(msg: SetupDriver): Promise<SetupAction> {
    // this.updateStep("setup");
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
    console.log("handleSetupRequest", msg);
    if (msg.reconfigure) {
      // TODO redesign setup flow: do we really want to delete the configration at this point?
      //      This should be done as late as possible: the user should not loose the old cfg if setup fails!
      // this.config.clear();
    }
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

  private async handleUserConfirmationResponse(msg: UserConfirmationResponse): Promise<SetupAction> {
    console.log("handleUserConfirmationResponse", msg);
    if (msg.confirm) {
      return await this.handleHubDiscovery();
    }
    return new SetupError("User did not confirm");
  }

  private async handleUserDataResponse(msg: UserDataResponse): Promise<SetupAction> {
    console.log("handleUserDataResponse", msg);
    if (!msg.inputValues.hubId) {
      return new SetupError("No hub selected");
    }
    const selectedHub = this.hubs.find((hub) => hub.id === msg.inputValues.hubId);
    if (!selectedHub) {
      return new SetupError("Hub not found");
    }

    try {
      this.hueApi.setBaseUrl("https://" + selectedHub.ip);
      const config = await this.hueApi.getConfig();
      console.log("received hue api config", config);
      const authKey = await this.hueApi.generateAuthKey("unfoldedcircle#philips_hue");
      console.log("received hue api auth key", authKey);
      this.hueApi.setAuthKey(authKey.username);
      this.config.updateHubConfig({ ip: selectedHub.ip, username: authKey.username });
      const { data, errors } = await this.hueApi.lightResource.getLights();

      if (errors.length > 0) {
        return new SetupError("Failed to get lights");
      }
      this.addAvailableLights(data);
      return new SetupComplete();
    } catch (error) {
      log.error("Failed to get hub config", error);
      return new SetupError("Failed to get hub config");
    }
  }

  private addAvailableLights(lights: LightResource[]) {
    lights.forEach((light) => {
      const features = getLightFeatures(light);
      this.config.addLight(light.id, { name: light.metadata.name, features });
    });
  }

  private async handleHubDiscovery(): Promise<SetupAction> {
    console.log("handleHubDiscovery");
    // Start discovery timeout

    // {
    //   "name": "Hue Bridge",
    //   "datastoreversion": "172",
    //   "swversion": "1968096020",
    //   "apiversion": "1.68.0",
    //   "mac": "ec:b5:fa:1f:c7:5a",
    //   "bridgeid": "ECB5FAFFFE1FC75A",
    //   "factorynew": false,
    //   "replacesbridgeid": null,
    //   "modelid": "BSB002",
    //   "starterkitid": ""
    // }
    this.hubs.push({
      id: "ECB5FAFFFE1FC75A",
      ip: "10.0.10.73",
      name: "Hue Bridge"
    });
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

    await delay(1000);

    if (this.hubs.length > 0) {
      console.log("Hue bridge discovery: found hubs", this.hubs);
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
