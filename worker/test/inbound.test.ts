import { describe, expect, it } from "vitest";
import { classifyInbound } from "../src/mail/inbound";
import fixtures from "./inbound.fixtures.json";

// Owner 2026-11-04: wrong inbox, full inbox, unavailable, unmonitored are delivery problems, never "no" replies.
describe("inbound classifier (shared fixtures)", () => {
  for (const f of fixtures as { name: string; from: string; subject: string; text: string; headers?: Record<string, string>; kind: string }[]) {
    it(f.name, () => expect(classifyInbound(f).kind).toBe(f.kind));
  }
});
