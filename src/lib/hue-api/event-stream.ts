import { EventSource } from "eventsource";
import EventEmitter from "node:events";
import { Agent, fetch } from "undici";
import { HueEvent } from "./types.js";
import { hueBridgeCA } from "./cert.js";

class HueEventStream extends EventEmitter {
  private es: EventSource | null = null;
  private reconnectInterval = 1000;
  private connected = false;

  constructor() {
    super();
  }

  connect(hubUrl: string, authKey: string, bridgeId: string) {
    if (this.connected) {
      return;
    }
    const dispatcher = new Agent({
      connect: {
        ca: [hueBridgeCA],
        rejectUnauthorized: true,
        checkServerIdentity: (_, cert) => {
          const certCN = cert.subject.CN;
          if (certCN.toLowerCase() !== bridgeId.toLowerCase()) {
            throw new Error("event-stream.ts: Invalid bridge certificate");
          }
          return undefined;
        }
      }
    });
    const headers = {
      Accept: "text/event-stream",
      "hue-application-key": authKey
    };

    this.es = new EventSource(hubUrl + "/eventstream/clip/v2", {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          dispatcher,
          headers: {
            ...init?.headers,
            ...headers
          }
        })
    });

    this.es.onopen = () => {
      this.connected = true;
      this.emit("connected");
    };

    this.es.onopen = () => {
      console.log("EVENTSTREAM CONNECTED");
      this.connected = true;
      this.emit("connected");
    };
    this.es.onmessage = (event) => {
      console.log("EVENTSTREAM MESSAGE", event.data);
      try {
        const messages = JSON.parse(event.data) as HueEvent[];
        for (const message of messages) {
          this.emit(message.type, message);
        }
      } catch (err) {
        this.emit("error", err);
      }
    };

    this.es.onerror = (err) => {
      console.log("EVENTSTREAM ERROR", err);
      this.connected = false;
      this.emit("disconnected");
    };
  }

  disconnect() {
    if (this.es) {
      this.es.close();
      this.connected = false;
      this.emit("disconnected");
    }
  }
}

export default HueEventStream;
