import test from "ava";
import PhilipsHueSetup from "../src/lib/setup.js";
import Config from "../src/config.js";
import * as uc from "@unfoldedcircle/integration-api";
import { Bonjour, Service } from "bonjour-service";
import HueApi from "../src/lib/hue-api/api.js";
import { HubConfig } from "../src/lib/hue-api/types.js";

test("handleHubDiscovery should use normalized bridge ID for mDNS hubs", async (t) => {
  const config = {
    clear: () => {},
    getHubConfig: () => null
  } as unknown as Config;
  const setup = new PhilipsHueSetup(config);

  // Mock Bonjour
  const mockBonjour = {
    find: (_query: object, callback: (service: Service) => void) => {
      // Simulate discovery of a hub
      callback({
        host: "Philips-Hue.local",
        name: "Philips Hue Bridge",
        addresses: ["192.168.1.10"]
      } as unknown as Service);
    },
    destroy: () => {}
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setup as any).bonjourFactory = () => mockBonjour as unknown as Bonjour;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setup as any).discoveryDelay = 1;

  // Mock HueApi
  const mockHueApi = {
    setBaseUrl: () => {},
    is_hue_bridge: async () => "001122334455", // normalized ID
    is_v2_bridge: async () => true
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setup as any).hueApiFactory = () => mockHueApi as unknown as HueApi;

  const msg = new uc.DriverSetupRequest(false, {});
  // handleSetup with DriverSetupRequest(false) will call handleDriverSetup, which calls handleHubDiscovery
  const result = await setup.handleSetup(msg);

  t.true(result instanceof uc.RequestUserInput);
  const inputRequest = result as uc.RequestUserInput;
  t.is(inputRequest.settings[0].id as string, "hubId");

  // Check the hub ID in the dropdown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const field = inputRequest.settings[0].field as any;
  t.is(field.dropdown.items[0].id, "001122334455");
  t.is(field.dropdown.items[0].label?.en, "Philips Hue Bridge");
});

test("handleHubDiscovery should normalize bridge ID for manual setup", async (t) => {
  const config = {
    getHubConfig: () => null
  } as unknown as Config;
  const setup = new PhilipsHueSetup(config);

  // Mock HueApi
  const mockHueApi = {
    setBaseUrl: () => {},
    getHubConfig: async () =>
      ({
        bridgeid: "00:11:22:33:44:55", // unnormalized ID
        name: "Manual Bridge"
      }) as unknown as HubConfig,
    is_hue_bridge: async () => "001122334455",
    is_v2_bridge: async () => true
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setup as any).hueApiFactory = () => mockHueApi as unknown as HueApi;

  // Transition to DISCOVER step
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (setup as any).setupStep = 2; // SetupSteps.DISCOVER

  const msg = new uc.UserDataResponse({ address: "192.168.1.10" });
  const result = await setup.handleSetup(msg);

  t.true(result instanceof uc.RequestUserInput);
  const inputRequest = result as uc.RequestUserInput;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const field = inputRequest.settings[0].field as any;
  t.is(field.dropdown.items[0].id, "001122334455"); // should be normalized
});
