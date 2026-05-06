/**
 * AWS Bedrock EventStream Decoder
 *
 * Decodes the binary `application/vnd.amazon.eventstream` framing used by
 * Bedrock's ConverseStream API. Self-contained, no AWS SDK dependency.
 *
 * Frame layout:
 *   [Total Length :4][Headers Length :4][Prelude CRC :4][Headers ...][Payload ...][Message CRC :4]
 *
 * Headers are a packed sequence of:
 *   {1-byte name length}{name bytes}{1-byte value type}{value bytes...}
 *
 * Bedrock only emits string headers (type 7) for the keys we care about
 * (`:event-type`, `:content-type`, `:message-type`). We decode those and
 * skip header value types we don't need to read for the Converse API.
 *
 * The payload is always UTF-8 JSON.
 */

const HEADER_VALUE_TYPE = {
  TRUE: 0,
  FALSE: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  BYTES: 6,
  STRING: 7,
  TIMESTAMP: 8,
  UUID: 9
};

const PRELUDE_LENGTH = 12;
const MIN_FRAME_LENGTH = 16;

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
}

function decodeHeaders(bytes, start, end) {
  const headers = {};
  const decoder = new TextDecoder('utf-8');
  let offset = start;
  while (offset < end) {
    const nameLen = bytes[offset++];
    if (offset + nameLen > end) break;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const valueType = bytes[offset++];

    switch (valueType) {
      case HEADER_VALUE_TYPE.TRUE:
        headers[name] = true;
        break;
      case HEADER_VALUE_TYPE.FALSE:
        headers[name] = false;
        break;
      case HEADER_VALUE_TYPE.BYTE:
        headers[name] = bytes[offset];
        offset += 1;
        break;
      case HEADER_VALUE_TYPE.SHORT: {
        const v = readUint16BE(bytes, offset);
        headers[name] = v > 0x7fff ? v - 0x10000 : v;
        offset += 2;
        break;
      }
      case HEADER_VALUE_TYPE.INT: {
        const v = readUint32BE(bytes, offset);
        headers[name] = v > 0x7fffffff ? v - 0x100000000 : v;
        offset += 4;
        break;
      }
      case HEADER_VALUE_TYPE.LONG: {
        offset += 8;
        break;
      }
      case HEADER_VALUE_TYPE.BYTES:
      case HEADER_VALUE_TYPE.STRING: {
        const len = readUint16BE(bytes, offset);
        offset += 2;
        const value = decoder.decode(bytes.subarray(offset, offset + len));
        headers[name] = value;
        offset += len;
        break;
      }
      case HEADER_VALUE_TYPE.TIMESTAMP:
        offset += 8;
        break;
      case HEADER_VALUE_TYPE.UUID:
        offset += 16;
        break;
      default:
        return headers;
    }
  }
  return headers;
}

export class BedrockEventStreamDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.textDecoder = new TextDecoder('utf-8');
  }

  feed(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }

    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const merged = new Uint8Array(this.buffer.length + incoming.length);
    merged.set(this.buffer, 0);
    merged.set(incoming, this.buffer.length);
    this.buffer = merged;

    const frames = [];
    while (this.buffer.length >= MIN_FRAME_LENGTH) {
      const totalLength = readUint32BE(this.buffer, 0);
      if (totalLength < MIN_FRAME_LENGTH || totalLength > 16 * 1024 * 1024) {
        // Unrecoverable framing error — drop buffer to resync.
        this.buffer = new Uint8Array(0);
        break;
      }
      if (this.buffer.length < totalLength) break;

      const headersLength = readUint32BE(this.buffer, 4);
      const preludeCrc = readUint32BE(this.buffer, 8);
      const computedPreludeCrc = crc32(this.buffer, 0, 8);
      const frameEnd = totalLength;

      if (computedPreludeCrc !== preludeCrc) {
        // Resync by skipping one byte and retrying.
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const headersStart = PRELUDE_LENGTH;
      const headersEnd = headersStart + headersLength;
      const payloadStart = headersEnd;
      const payloadEnd = frameEnd - 4;

      const headers = decodeHeaders(this.buffer, headersStart, headersEnd);
      let payload = null;
      if (payloadEnd > payloadStart) {
        const payloadBytes = this.buffer.subarray(payloadStart, payloadEnd);
        const payloadText = this.textDecoder.decode(payloadBytes);
        if (payloadText.length > 0) {
          try {
            payload = JSON.parse(payloadText);
          } catch {
            payload = { _raw: payloadText };
          }
        } else {
          payload = {};
        }
      } else {
        payload = {};
      }

      frames.push({
        headers,
        payload,
        eventType: headers[':event-type'] || '',
        messageType: headers[':message-type'] || ''
      });

      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }
}

export default BedrockEventStreamDecoder;
