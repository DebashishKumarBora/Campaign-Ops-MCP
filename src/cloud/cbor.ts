/**
 * A minimal CBOR decoder (RFC 8949), enough to read WebAuthn attestation
 * objects and COSE public keys: integers, byte and text strings, arrays,
 * maps, booleans and null. Indefinite lengths and floats are refused.
 */

export type CborValue = number | bigint | string | boolean | null | undefined | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

export interface Decoded {
  value: CborValue;
  /** How many bytes the value used. */
  length: number;
}

export function decodeCbor(bytes: Uint8Array, start = 0): Decoded {
  let at = start;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error('CBOR data ends early.');
  };
  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[at++];
    }
    if (info === 25) {
      need(2);
      const v = (bytes[at] << 8) | bytes[at + 1];
      at += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
      at += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[at + i]);
      at += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR length too large.');
      return Number(v);
    }
    throw new Error('Indefinite or reserved CBOR length.');
  };
  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error('CBOR nested too deeply.');
    need(1);
    const head = bytes[at++];
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        need(n);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        const n = readLength(info);
        need(n);
        const out = new TextDecoder().decode(bytes.subarray(at, at + n));
        at += n;
        return out;
      }
      case 4: {
        const n = readLength(info);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = readLength(info);
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          out.set(k, item(depth + 1));
        }
        return out;
      }
      case 6:
        readLength(info);
        return item(depth + 1); // tags are ignored
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error('CBOR floats and simple values are not supported.');
      default:
        throw new Error('Unknown CBOR type.');
    }
  };
  const value = item(0);
  return { value, length: at - start };
}
