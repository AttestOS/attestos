// @ts-nocheck
import { describe, expect, it } from "vitest";
import { lanes, PROVIDERS } from "../src/mail/lanes";

describe("gmail lane preset (app-password route, no Google Cloud)", () => {
  const env = (cfg, extra = {}) => ({ MAILBOXES: JSON.stringify(cfg), MAILBOX_GM1_USER: "Shop.Owner@Gmail.com", MAILBOX_GM1_PASS: "abcd efgh ijkl mnop", ...extra });

  it("fills Gmail hosts, ports and spam folder from the provider name", () => {
    const [l] = lanes(env([{ id: "gm1", provider: "gmail", cold: 5 }]));
    expect(l).toMatchObject({ provider: "gmail", host: "smtp.gmail.com", imapHost: "imap.gmail.com", smtpPort: 465, imapPort: 993, spamFolder: "[Gmail]/Spam", user: "shop.owner@gmail.com" });
  });
  it("defaults to gmail when no host is given", () => {
    expect(lanes(env([{ id: "gm1" }]))[0].host).toBe("smtp.gmail.com");
  });
  it("strips the display spaces Google shows in app passwords", () => {
    expect(lanes(env([{ id: "gm1", provider: "gmail" }]))[0].pass).toBe("abcdefghijklmnop");
  });
  it("clamps hourly so no rolling 24 h can pass Google's ~500 limit", () => {
    const [l] = lanes(env([{ id: "gm1", provider: "gmail", hourly: 60 }]));
    expect(l.hourly).toBe(PROVIDERS.gmail.hourlyMax);
    expect(l.hourly * 24).toBeLessThan(500);
  });
  it("stays off until both secrets exist", () => {
    expect(lanes({ MAILBOXES: '[{"id":"gm1","provider":"gmail"}]', MAILBOX_GM1_USER: "a@gmail.com" })).toHaveLength(0);
  });
  it("a custom host still works and reads IMAP from the same host", () => {
    const [l] = lanes(env([{ id: "gm1", host: "mail.example.org" }]));
    expect(l).toMatchObject({ provider: "custom", host: "mail.example.org", imapHost: "mail.example.org", hourly: 4 });
  });
});
