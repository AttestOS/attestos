#!/usr/bin/env node
// Prints an OWNER_PASSWORD_HASH for the owner console (same PBKDF2 format the Worker verifies).
// Usage: node scripts/owner-password.mjs            → generates a strong password and prints both
//        node scripts/owner-password.mjs 'my pass'  → hashes the given password
// Then:  cd worker && npx wrangler secret put OWNER_PASSWORD_HASH   (paste the hash)
import { webcrypto as crypto, randomBytes } from "node:crypto";

const given = process.argv[2];
const password = given || [...Array(5)].map(() => randomBytes(4).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, 5)).join("-");
if (password.length < 12) { console.error("Use at least 12 characters."); process.exit(1); }
const iterations = 100000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
const b64 = (u) => Buffer.from(u).toString("base64");
if (!given) console.log(`password: ${password}`);
console.log(`OWNER_PASSWORD_HASH: pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`);
