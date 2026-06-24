import test from "ava";
import PhilipsHueSetup, { createDeviceTypeName } from "../src/lib/setup.js";
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

// Tests for createDeviceTypeName function
test("createDeviceTypeName - short hostname without domain", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "myhost");
  t.is(result, "unfoldedcircle#myhost");
  t.true(result.length <= 33); // 14 + 1 + 18 max
});

test("createDeviceTypeName - hostname with .local suffix", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "myhost.local");
  // "myhost.local" is 12 chars, fits without shortening
  t.is(result, "unfoldedcircle#myhost.local");
});

test("createDeviceTypeName - hostname with multiple domain segments", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "host.subdomain.local");
  // "host.subdomain.local" is 20 chars, > 19
  // Remove from right: "host.subdomain.local" -> "host.subdomain" (14 chars, fits)
  t.is(result, "unfoldedcircle#host.subdomain");
});

test("createDeviceTypeName - hostname still too long after removing domain", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "verylonghostname.subdomain.local");
  // Remove from right to left:
  // "verylonghostname.subdomain.local" -> "verylonghostname.subdomain" (27 chars, still > 19)
  // "verylonghostname.subdomain" -> "verylonghostname" (18 chars, fits)
  t.is(result, "unfoldedcircle#verylonghostname");
});

test("createDeviceTypeName - hostname with RemoteTwo replacement", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "RemoteTwo.local");
  // "RemoteTwo.local" is 15 chars, fits without shortening
  t.is(result, "unfoldedcircle#RemoteTwo.local");
});

test("createDeviceTypeName - RemoteTwo in longer hostname", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "RemoteTwoABCDEF123456");
  // "RemoteTwoABCDEF123456" is 20 chars, > 19
  // Replace RemoteTwo with R2: "R2ABCDEF123456" = 14 chars, fits
  t.is(result, "unfoldedcircle#R2ABCDEF123456");
});

test("createDeviceTypeName - Remote3 in longer hostname", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "Remote3ABCDEF1234567890123456789");
  t.is(result, "unfoldedcircle#R3ABCDEF12345678901");
});

test("createDeviceTypeName - RemoteTwo with domain too long", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "RemoteTwoABCDEF123456.local");
  // "RemoteTwoABCDEF123456.local" is 26 chars, > 19
  // Remove ".local" -> "RemoteTwoABCDEF123456" (20 chars, still > 19)
  // Replace RemoteTwo with R2: "R2ABCDEF123456" = 14 chars, fits
  t.is(result, "unfoldedcircle#R2ABCDEF123456");
});

test("createDeviceTypeName - RemoteTwo replacement still too long", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "RemoteTwoABCDEF1234567890");
  // "RemoteTwoABCDEF1234567890" is 24 chars
  // Replace RemoteTwo with R2: "R2ABCDEF1234567890" = 18 chars, fits
  t.is(result, "unfoldedcircle#R2ABCDEF1234567890");
});

test("createDeviceTypeName - Remote3 replacement", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "Remote3.local");
  // "Remote3.local" is 13 chars, fits without shortening
  t.is(result, "unfoldedcircle#Remote3.local");
});

test("createDeviceTypeName - truncation when still too long", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "ABCDEFGHIJKLMNOPQRST");
  // 20 chars, no domain, no RemoteTwo to replace -> truncate to 19
  t.is(result, "unfoldedcircle#ABCDEFGHIJKLMNOPQRS");
  t.is(result.length, 34); // 14 + 1 + 19
});

test("createDeviceTypeName - exactly 19 characters", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "ABCDEFGHIJKLMNOPQRS");
  // Exactly 19 chars, should not be truncated
  t.is(result, "unfoldedcircle#ABCDEFGHIJKLMNOPQRS");
  t.is(result.length, 34); // 14 + 1 + 19
});

test("createDeviceTypeName - empty device name", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "");
  t.is(result, "unfoldedcircle#");
});

test("createDeviceTypeName - only domain suffix", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", ".local");
  // ".local" is 6 chars, fits without shortening
  t.is(result, "unfoldedcircle#.local");
});

test("createDeviceTypeName - complex real-world hostname", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "MyRemoteTwoHome.local");
  // "MyRemoteTwoHome.local" is 21 chars, > 19
  // Remove ".local" -> "MyRemoteTwoHome" (15 chars, fits)
  t.is(result, "unfoldedcircle#MyRemoteTwoHome");
});

test("createDeviceTypeName - very long hostname with multiple dots", (t) => {
  const result = createDeviceTypeName("unfoldedcircle", "verylonghostname.subdomain.example.local");
  // Remove from right to left:
  // "verylonghostname.subdomain.example.local" (41 chars)
  // -> "verylonghostname.subdomain.example" (36 chars)
  // -> "verylonghostname.subdomain" (26 chars)
  // -> "verylonghostname" (18 chars, fits)
  t.is(result, "unfoldedcircle#verylonghostname");
});
