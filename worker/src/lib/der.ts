/** Just enough ASN.1 DER to turn an RSASSA-PSS SubjectPublicKeyInfo (what Privacy Pass issuers publish, RFC 9578
 *  §6.5) into a plain rsaEncryption SPKI that WebCrypto's importKey("spki", …, RSA-PSS) accepts. */

function readTL(buf: Uint8Array, p: number): { tag: number; len: number; start: number } {
  const tag = buf[p++];
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3) throw new Error("DER: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  if (p + len > buf.length) throw new Error("DER: truncated");
  return { tag, len, start: p };
}
function encLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
const tlv = (tag: number, body: Uint8Array | number[]) => new Uint8Array([tag, ...encLen(body.length), ...body]);

/** Returns the RSAPublicKey bytes inside an SPKI (any algorithm identifier). */
export function spkiPublicKey(spki: Uint8Array): Uint8Array {
  const outer = readTL(spki, 0);
  if (outer.tag !== 0x30) throw new Error("DER: SPKI is not a sequence");
  const alg = readTL(spki, outer.start);
  if (alg.tag !== 0x30) throw new Error("DER: bad algorithm identifier");
  const bits = readTL(spki, alg.start + alg.len);
  if (bits.tag !== 0x03 || spki[bits.start] !== 0) throw new Error("DER: bad public key bit string");
  return spki.slice(bits.start + 1, bits.start + bits.len);
}

const RSA_ENCRYPTION = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
export function toRsaEncryptionSpki(spki: Uint8Array): Uint8Array {
  const key = spkiPublicKey(spki);
  const algId = tlv(0x30, RSA_ENCRYPTION);
  const bitString = tlv(0x03, [0, ...key]);
  return tlv(0x30, [...algId, ...bitString]);
}
