
export const Hackpad = {
  port: null,
  reader: null,
  connected: false,

  onDown: null,
  onUp: null,
  onExpression: null,
  onAction: null,
  onStatus: null,

  async connect() {
    if (!("serial" in navigator)) {
      this._status("braucht chromium oder chrome");
      return;
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.connected = true;
      this._status("verbunden");
      this._readLoop();
    } catch (err) {
      this._status("verbindung fehlgeschlagen");
    }
  },

  async disconnect() {
    this.connected = false;
    if (this.reader) {
      await this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.port) {
      await this.port.close().catch(() => {});
      this.port = null;
    }
    this._status("getrennt");
  },

  async _readLoop() {
    const decoder = new TextDecoderStream();
    this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();

    let buffer = "";

    while (this.connected) {
      let result;
      try {
        result = await this.reader.read();
      } catch (err) {
        break;
      }
      if (result.done) break;

      buffer += result.value;

      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this._handle(line);
      }
    }

    this.connected = false;
    this._status("verbindung verloren");
  },

  _handle(line) {
    const split = line.indexOf(":");
    if (split < 0) return;

    const kind = line.slice(0, split);
    const value = line.slice(split + 1);

    if (kind === "DOWN" && this.onDown) this.onDown(value);
    else if (kind === "UP" && this.onUp) this.onUp(value);
    else if (kind === "EXPR" && this.onExpression) this.onExpression(value);
    else if (kind === "ACT" && this.onAction) this.onAction(value);
    else if (kind === "READY") this._status("hackpad bereit");
  },

  _status(text) {
    if (this.onStatus) this.onStatus(text);
    else console.log("[hackpad]", text);
  },
};

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", () => {
    Hackpad.connected = false;
    Hackpad._status("hackpad abgezogen");
  });
}