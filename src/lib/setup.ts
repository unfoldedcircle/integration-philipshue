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
import { convertImageToBase64, delay, getHubUrl, getLightFeatures, i18all } from "../util.js";
import HueApi from "./hue-api/api.js";
import { LightResource } from "./hue-api/types.js";
import os from "os";
import * as uc from "@unfoldedcircle/integration-api";

/**
 * Enumeration of setup steps to keep track of user data responses.
 */
enum SetupSteps {
  INIT = 0,
  CONFIGURATION_MODE,
  DISCOVER,
  DEVICE_CHOICE,
  PRESS_THE_BUTTON,
  COMPLETED
}

interface HueHub {
  id: string;
  ip: string;
  name: string;
}

class PhilipsHueSetup {
  private setupStep = SetupSteps.INIT;
  private cfgAddDevice = false;
  private manualAddress = false;
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

  /**
   * Dispatch driver setup requests to corresponding handlers.
   *
   * Either start the setup process or handle the provided user input data.
   * @param msg the setup driver request object, either DriverSetupRequest,
   *            UserDataResponse or UserConfirmationResponse
   * @return the setup action on how to continue
   */
  async handleSetup(msg: SetupDriver): Promise<SetupAction> {
    if (this.setupStep === SetupSteps.COMPLETED) {
      this.setupStep = SetupSteps.INIT;
      return new SetupComplete();
    }

    if (msg instanceof DriverSetupRequest) {
      this.setupStep = SetupSteps.INIT;
      this.cfgAddDevice = false;
      return await this.handleDriverSetup(msg);
    } else if (msg instanceof UserConfirmationResponse) {
      if (this.setupStep === SetupSteps.DISCOVER) {
        log.debug("Received user confirmation for starting discovery again");
        return await this.handleHubDiscovery(msg);
      } else if (this.setupStep === SetupSteps.PRESS_THE_BUTTON) {
        return await this.handleUserConfirmationResponse(msg);
      }
      log.error("No or invalid user confirmation response was received in step %d: %s", this.setupStep, msg);
    } else if (msg instanceof UserDataResponse) {
      if (this.setupStep === SetupSteps.CONFIGURATION_MODE && "action" in msg.inputValues) {
        return await this.handleConfigurationMode(msg);
      }
      if (this.setupStep === SetupSteps.DISCOVER) {
        return await this.handleHubDiscovery(msg);
      }
      if (this.setupStep === SetupSteps.DEVICE_CHOICE) {
        return await this.handleUserDataResponse(msg);
      }
      log.error("No or invalid user response was received in step %d: %s", this.setupStep, msg);
    } else if (msg instanceof uc.AbortDriverSetup) {
      log.info("Setup was aborted with code: %s", msg.error);
      this.hubs = [];
      this.setupStep = SetupSteps.INIT;
    }

    return new SetupComplete();
  }

  /**
   * Start driver setup.
   *
   * Initiated by the UC Remote to set up the driver.
   * @param msg value(s) of input fields in the first setup screen.
   * @return the setup action on how to continue
   */
  private async handleDriverSetup(msg: DriverSetupRequest): Promise<SetupAction> {
    log.debug("Setting up driver. Setup data:", msg);

    if (msg.reconfigure) {
      this.setupStep = SetupSteps.CONFIGURATION_MODE;

      // get all configured devices for the user to choose from. Only a single hub is supported at the moment.
      const dropdownDevices: { id: string; label: { en: string } }[] = [];
      const hubCfg = this.config.getHubConfig();
      if (hubCfg && hubCfg.ip && hubCfg.username && hubCfg.bridgeId) {
        dropdownDevices.push({ id: hubCfg.bridgeId, label: { en: `${hubCfg.name} (${hubCfg.ip})` } });
      }

      // build user actions, based on available devices
      const dropdownActions = [];

      if (dropdownDevices.length == 0) {
        // only a single hub is supported at the moment
        dropdownActions.push({
          id: "add",
          label: i18all("setup.configuration.add")
        });
        // dummy entry if no devices are available
        dropdownDevices.push({ id: "", label: { en: "---" } });
      } else {
        // add info, remove & reset actions if there's at least one configured device
        dropdownActions.push({
          id: "info",
          label: i18all("setup.configuration.info")
        });
        dropdownActions.push({
          id: "remove",
          label: i18all("setup.configuration.remove")
        });
        dropdownActions.push({
          id: "reset",
          label: i18all("setup.configuration.reset")
        });
      }

      return new uc.RequestUserInput(i18all("setup.configuration.title"), [
        {
          field: { dropdown: { value: dropdownDevices[0].id, items: dropdownDevices } },
          id: "choice",
          label: i18all("setup.configuration.configured_devices")
        },
        {
          field: { dropdown: { value: dropdownActions[0].id, items: dropdownActions } },
          id: "action",
          label: i18all("setup.configuration.action")
        }
      ]);
    } else {
      // Initial setup, make sure we have a clean configuration
      this.config.clear();
    }

    this.setupStep = SetupSteps.DISCOVER;
    return await this.handleHubDiscovery(msg);
  }

  /**
   * Process user data response from the configuration mode screen.
   *
   * User input data:
   * - `choice` contains identifier of selected device
   * - `action` contains the selected action identifier
   *
   * @param msg user input data from the configuration mode screen.
   * @return the setup action on how to continue
   */
  private async handleConfigurationMode(msg: uc.UserDataResponse): Promise<uc.SetupAction> {
    const action = msg.inputValues.action;

    // workaround for web-configurator not picking up first response
    await new Promise((resolve) => setTimeout(resolve, 500));

    switch (action) {
      case "add":
        this.cfgAddDevice = true;
        break;
      case "info": {
        let hubInfos;
        let lightInfos;
        const hubCfg = this.config.getHubConfig();
        if (hubCfg && hubCfg.ip && hubCfg.username) {
          try {
            this.hueApi.setBaseUrl(getHubUrl(hubCfg.ip));
            const hubConfig = await this.hueApi.getHubConfig();

            /// text field has Markdown support
            hubInfos = { en: "```\n" + JSON.stringify(hubConfig, null, "  ") + "\n```" };
          } catch (e) {
            hubInfos = { en: `Error: ${e instanceof Error ? e.message : e}` };
          }

          // perform a connection test with API key
          try {
            this.hueApi.setAuthKey(hubCfg.username);
            const data = await this.hueApi.lightResource.getLights();
            lightInfos = { en: "```\n" + JSON.stringify(data, null, "  ") + "\n```" };
          } catch (e) {
            lightInfos = { en: `**Error: ${e instanceof Error ? e.message : e}**` };
          }
          this.hueApi.setAuthKey("");
        } else {
          hubInfos = i18all("setup.info.not_configured");
          lightInfos = i18all("setup.info.not_configured");
        }

        this.setupStep = SetupSteps.COMPLETED;
        return new uc.RequestUserInput("Philips Hue", [
          {
            id: "info",
            label: i18all("setup.info.title"),
            field: { label: { value: hubInfos } }
          },
          {
            id: "lights",
            label: i18all("setup.info.lights"),
            field: { label: { value: lightInfos } }
          }
        ]);
      }
      case "remove": {
        // only one hub supported at the moment
        this.config.removeHub();
        return new uc.SetupComplete();
      }
      case "reset":
        this.config.clear();
        break;
      default:
        log.error("Invalid configuration action: %s", action);
        return new uc.SetupError(uc.IntegrationSetupError.Other);
    }

    this.setupStep = SetupSteps.DISCOVER;

    return new uc.RequestUserInput(i18all("setup.discovery.title"), [
      {
        id: "info",
        label: i18all("setup.discovery.info"),
        field: {
          label: {
            value: i18all("setup.discovery.description")
          }
        }
      },
      {
        field: { text: { value: "" } },
        id: "address",
        label: i18all("setup.discovery.address")
      }
    ]);
  }

  private async handleUserConfirmationResponse(msg: UserConfirmationResponse): Promise<SetupAction> {
    if (msg.confirm && this.selectedHub) {
      try {
        this.hueApi.setBaseUrl(getHubUrl(this.selectedHub.ip));
        const authKey = await this.hueApi.generateAuthKey("unfoldedcircle#" + os.hostname());
        this.hueApi.setAuthKey(authKey.username);
        this.config.updateHubConfig({
          name: this.selectedHub.name,
          ip: this.selectedHub.ip,
          username: authKey.username,
          bridgeId: this.selectedHub.id
        });
        const data = await this.hueApi.lightResource.getLights();
        this.addAvailableLights(data);
        return new SetupComplete();
      } catch (error) {
        log.error("Failed to get hub config", error);
        return new SetupError("Failed to get hub configuration");
      }
    }
    return new SetupError("User did not confirm");
  }

  private async handleUserDataResponse(msg: UserDataResponse): Promise<SetupAction> {
    log.debug("Received user input for driver setup.", JSON.stringify(msg));

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

    this.setupStep = SetupSteps.PRESS_THE_BUTTON;
    return new RequestUserConfirmation(
      i18all("setup.confirmation.title"),
      i18all("setup.confirmation.header"),
      img,
      i18all("setup.confirmation.footer")
    );
  }

  private addAvailableLights(lights: LightResource[]) {
    lights.forEach((light) => {
      const features = getLightFeatures(light);
      this.config.addLight(light.id, { name: light.metadata.name, features });
    });
  }

  private async handleHubDiscovery(
    msg: uc.DriverSetupRequest | uc.UserConfirmationResponse | uc.UserDataResponse
  ): Promise<SetupAction> {
    this.manualAddress = false;
    this.hubs = [];
    let hubItems: { id: string }[] = [];

    if (msg instanceof uc.UserDataResponse && msg.inputValues.address) {
      if (msg.inputValues.address.length > 0) {
        log.debug("Starting manual hub setup for: %s", msg.inputValues.address);
        this.manualAddress = true;
        try {
          this.hueApi.setBaseUrl(getHubUrl(msg.inputValues.address));
          const hubConfig = await this.hueApi.getHubConfig();

          if (this.cfgAddDevice && this.config.getHubConfig()?.bridgeId === hubConfig.bridgeid) {
            // Prepared for multiple hubs: should not happen since only one Hub is supported at the moment.
            log.info("Hub already configured, skipping manuel device %s", hubConfig.bridgeid);
          } else {
            const hub: HueHub = {
              id: hubConfig.bridgeid,
              ip: msg.inputValues.address,
              name: hubConfig.name
            };
            this.hubs.push(hub);
          }
        } catch (e) {
          log.warn("Failed to connect to hub", e);
          return new uc.SetupError(uc.IntegrationSetupError.ConnectionRefused); // no better error at the moment :-(
        }
      }
    }

    if (!this.manualAddress) {
      log.info("Starting mDNS discovery of Hue hubs on the network");

      this.bonjour.find({ type: "hue" }, (service) => {
        // TODO verify if this is the correct address
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
    }

    if (this.hubs.length === 0) {
      log.info("Could not discover any new hubs");
      // Show try again / abort
      return new uc.RequestUserConfirmation(
        i18all("setup.discovery_failed.title"),
        i18all("setup.discovery_failed.header")
      );
    } else {
      // verify each discovered hub: only v2 hubs are supported
      const filteredHubs = this.hubs.filter(async (hub) => {
        try {
          log.debug("Found hub %s: checking if it is a v2 bridge", hub.ip);
          this.hueApi.setBaseUrl(getHubUrl(hub.ip));
          await this.hueApi.is_hue_bridge();
          if (!(await this.hueApi.is_v2_bridge())) {
            log.warn("Hub %s is not a v2 bridge, skipping", hub.ip);
            return false;
          }
        } catch (e) {
          log.warn("Hub %s is either not a Hue bridge, or connection failed: %s", hub.ip, e);
          return false;
        }
        return true;
      });

      log.info("Hue bridge discovery: found v2 hubs", filteredHubs);

      hubItems = filteredHubs.map((hub) => ({
        id: hub.id,
        label: { en: hub.name },
        description: { en: `IP: ${hub.ip}` }
      }));
    }

    this.setupStep = SetupSteps.DEVICE_CHOICE;
    return new RequestUserInput(i18all("setup.discovery.discovered_title"), [
      {
        id: "hubId",
        label: i18all("setup.discovery.discovered_hubs"),
        field: {
          dropdown: {
            value: hubItems[0].id,
            items: hubItems
          }
        }
      }
    ]);
  }
}

export default PhilipsHueSetup;
