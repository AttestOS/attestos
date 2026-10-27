import { b64url } from "./crypto";
import { decodeCbor, type CborValue } from "./cbor";

/** COSE public keys (RFC 9052/9053) as stored by WebAuthn → WebCrypto verification.
 *  Supported: ES256 (-7, EC2 P-256), RS256 (-257, RSA PKCS#1 v1.5 SHA-256), EdDSA (-8, OKP Ed25519). */
export const ALGS = [-7, -257, -8];

const get = (m: Map<CborValue, CborValue>, k: number) => m.get(k);
const bytes = (v: CborValue): Uint8Array => { if (!(v instanceof Uint8Array)) throw new Error("COSE: expected bytes"); return v; };

export function parseCoseKey(raw: Uint8Array): { alg: number; jwk: JsonWebKey } {
  const { value } = decodeCbor(raw);
  if (!(value instanceof Map)) throw new Error("COSE: not a map");
  const kty = get(value, 1), alg = Number(get(value, 3));
  if (kty === 2 && alg === -7) {
    if (get(value, -1) !== 1) throw new Error("COSE: only P-256 is supported for ES256");
    const x = bytes(get(value, -2)), y = bytes(get(value, -3));
    if (x.length !== 32 || y.length !== 32) throw new Error("COSE: bad P-256 point");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), ext: true } };
  }
  if (kty === 3 && alg === -257) {
    const n = bytes(get(value, -1)), e = bytes(get(value, -2));
    if (n.length < 256) throw new Error("COSE: RSA keys under 2048 bits are refused");
    return { alg, jwk: { kty: "RSA", alg: "RS256", n: b64url(n), e: b64url(e), ext: true } };
  }
  if (kty === 1 && alg === -8) {
    if (get(value, -1) !== 6) throw new Error("COSE: only Ed25519 is supported for EdDSA");
    const x = bytes(get(value, -2));
    if (x.length !== 32) throw new Error("COSE: bad Ed25519 key");
    return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: b64url(x), ext: true } };
  }
  throw new Error(`COSE: unsupported key (kty ${String(kty)}, alg ${alg})`);
}

/** ECDSA signatures from authenticators are ASN.1 DER; WebCrypto wants raw r||s (32 bytes each for P-256). */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let p = 0;
  if (der[p++] !== 0x30) throw new Error("DER: not a sequence");
  let len = der[p++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[p++]; }
  const int = () => {
    if (der[p++] !== 0x02) throw new Error("DER: expected integer");
    const l = der[p++];
    let v = der.subarray(p, p + l);
    p += l;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("DER: integer too long");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = int(), s = int();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0); raw.set(s, size);
  return raw;
}

export async function verifyCose(jwk: JsonWebKey, alg: number, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (alg === -7) {
      const k = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, derToRaw(signature), data);
    }
    if (alg === -257) {
      const k = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, signature, data);
    }
    if (alg === -8) {
      const k = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, k, signature, data);
    }
  } catch { return false; }
  return false;
}
