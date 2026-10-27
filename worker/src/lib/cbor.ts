/** Minimal CBOR decoder (RFC 8949) for WebAuthn: attestation objects and COSE keys. Definite lengths only
 *  (WebAuthn requires CTAP2 canonical CBOR, which never uses indefinite lengths). Returns the value and the
 *  number of bytes consumed, because a COSE key in authenticator data can be followed by extensions. */
export type CborValue = number | bigint | string | Uint8Array | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

export function decodeCbor(buf: Uint8Array, offset = 0): { value: CborValue; end: number } {
  let p = offset;
  const need = (n: number) => { if (p + n > buf.length) throw new Error("CBOR: truncated"); };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[p++]; }
    if (info === 25) { need(2); const v = (buf[p] << 8) | buf[p + 1]; p += 2; return v; }
    if (info === 26) { need(4); const v = ((buf[p] << 24) >>> 0) + (buf[p + 1] << 16) + (buf[p + 2] << 8) + buf[p + 3]; p += 4; return v; }
    if (info === 27) {
      need(8);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) + BigInt(buf[p + i]);
      p += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR: length too large");
      return Number(v);
    }
    throw new Error("CBOR: indefinite length not supported");
  };
  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error("CBOR: too deep");
    need(1);
    const b = buf[p++];
    const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); need(n); const v = buf.slice(p, p + n); p += n; return v; }
      case 3: { const n = readLen(info); need(n); const v = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return v; }
      case 4: { const n = readLen(info); if (n > 1000) throw new Error("CBOR: array too long"); const a: CborValue[] = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); if (n > 1000) throw new Error("CBOR: map too long"); const m = new Map<CborValue, CborValue>(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 6: readLen(info); return item(depth + 1); // tag: ignore, return the tagged value
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25 || info === 26 || info === 27) { const n = info === 25 ? 2 : info === 26 ? 4 : 8; need(n); const dv = new DataView(buf.buffer, buf.byteOffset + p, n); p += n; return n === 2 ? 0 : n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }
        throw new Error("CBOR: unsupported simple value");
    }
    throw new Error("CBOR: bad major type");
  };
  const value = item(0);
  return { value, end: p };
}
