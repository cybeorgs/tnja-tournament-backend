import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { env } from "../config/env.js";
import { classifySmtpError, devRecipientAllowed, isProductionDeployment, routeFor, sendWithRetry, transportMode, type SmtpError } from "./emailTransport.js";

const smtpError = (props: Partial<SmtpError>) => Object.assign(new Error(props.message ?? "smtp error"), props) as SmtpError;

describe("SMTP failure classification", () => {
  it("never retries a recipient the server rejected (suppress instead)", () => {
    for (const code of [550, 551, 553]) assert.equal(classifySmtpError(smtpError({ code: "EENVELOPE", responseCode: code, command: "RCPT TO" })), "RECIPIENT_REJECTED");
  });
  it("retries when the server answered 4xx (nothing was accepted)", () => {
    assert.equal(classifySmtpError(smtpError({ responseCode: 421, command: "MAIL FROM" })), "RETRYABLE");
    assert.equal(classifySmtpError(smtpError({ responseCode: 451, command: "DATA" })), "RETRYABLE");
  });
  it("retries when the connection failed before the message was handed over", () => {
    assert.equal(classifySmtpError(smtpError({ code: "ECONNECTION", command: "CONN" })), "RETRYABLE");
    assert.equal(classifySmtpError(smtpError({ code: "ETIMEDOUT", command: "CONN" })), "RETRYABLE");
    assert.equal(classifySmtpError(smtpError({ code: "ETIMEDOUT", command: "EHLO" })), "RETRYABLE");
  });
  it("does NOT retry a timeout after the message was handed over (it may have been accepted)", () => {
    assert.equal(classifySmtpError(smtpError({ code: "ETIMEDOUT", command: "DATA" })), "UNCERTAIN");
    assert.equal(classifySmtpError(smtpError({ code: "ECONNRESET" })), "UNCERTAIN");
    assert.equal(classifySmtpError(smtpError({ code: "ESOCKET", command: "DATA" })), "UNCERTAIN");
  });
  it("treats other 5xx (bad login, message too big) as permanent", () => {
    assert.equal(classifySmtpError(smtpError({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" })), "FAILED");
    assert.equal(classifySmtpError(smtpError({ responseCode: 552, command: "DATA" })), "FAILED");
  });
});

describe("the single retry layer", () => {
  const noSleep = { sleeps: [] as number[] };
  const sleep = async (ms: number) => { noSleep.sleeps.push(ms); };
  afterEach(() => { noSleep.sleeps = []; });

  it("retries a temporary failure with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const r = await sendWithRetry(async () => {
      calls++;
      if (calls < 3) throw smtpError({ responseCode: 421, command: "MAIL FROM" });
      return { messageId: "<ok>" };
    }, { sleep });
    assert.equal(r.ok, true);
    assert.equal(calls, 3);
    assert.equal(noSleep.sleeps.length, 2);
    assert.ok(noSleep.sleeps[0]! >= 1000 && noSleep.sleeps[0]! < 1300, `first wait ~1s, got ${noSleep.sleeps[0]}`);
    assert.ok(noSleep.sleeps[1]! >= 2000 && noSleep.sleeps[1]! < 2300, `second wait ~2s, got ${noSleep.sleeps[1]}`);
  });
  it("gives up after 2 retries (3 attempts in all)", async () => {
    let calls = 0;
    const r = await sendWithRetry(async () => { calls++; throw smtpError({ code: "ECONNECTION" }); }, { sleep });
    assert.equal(r.ok, false);
    assert.equal(calls, 3);
    if (!r.ok) assert.equal(r.kind, "RETRYABLE");
  });
  it("makes exactly one attempt for a hard bounce", async () => {
    let calls = 0;
    const r = await sendWithRetry(async () => { calls++; throw smtpError({ code: "EENVELOPE", responseCode: 550 }); }, { sleep });
    assert.equal(calls, 1);
    if (!r.ok) assert.equal(r.kind, "RECIPIENT_REJECTED");
  });
  it("makes exactly one attempt when the provider may have accepted it (timeout after DATA)", async () => {
    let calls = 0;
    const r = await sendWithRetry(async () => { calls++; throw smtpError({ code: "ETIMEDOUT", command: "DATA" }); }, { sleep });
    assert.equal(calls, 1);
    assert.equal(noSleep.sleeps.length, 0);
    if (!r.ok) assert.equal(r.kind, "UNCERTAIN");
  });
});

describe("development vs production delivery", () => {
  const saved = { url: env.publicSiteUrl, transport: process.env.EMAIL_TRANSPORT, allow: process.env.EMAIL_DEV_ALLOWLIST, smtp: { ...env.smtp } };
  afterEach(() => {
    env.publicSiteUrl = saved.url;
    env.smtp = { ...saved.smtp };
    if (saved.transport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = saved.transport;
    if (saved.allow === undefined) delete process.env.EMAIL_DEV_ALLOWLIST; else process.env.EMAIL_DEV_ALLOWLIST = saved.allow;
  });
  const withSmtp = () => { env.smtp = { ...env.smtp, host: "smtp-relay.brevo.com", user: "u@smtp-brevo.com", pass: "x" }; };

  it("a localhost setup is development: emails go to the console even with Brevo credentials present", () => {
    if (env.isProduction) return; // NODE_ENV=production on this machine: not applicable
    env.publicSiteUrl = "http://localhost:3100";
    delete process.env.EMAIL_TRANSPORT;
    withSmtp();
    assert.equal(isProductionDeployment(), false);
    assert.equal(transportMode(), "console");
    assert.equal(routeFor("player@gmail.com"), "console");
  });
  it("the production site uses SMTP", () => {
    env.publicSiteUrl = "https://tournament.tnja-329-2017.in";
    delete process.env.EMAIL_TRANSPORT;
    withSmtp();
    assert.equal(isProductionDeployment(), true);
    assert.equal(transportMode(), "smtp");
    assert.equal(routeFor("player@gmail.com"), "smtp");
  });
  it("production without SMTP credentials reports 'unavailable' (never pretends to send)", () => {
    env.publicSiteUrl = "https://tournament.tnja-329-2017.in";
    delete process.env.EMAIL_TRANSPORT;
    env.smtp = { ...env.smtp, host: "", user: "", pass: "" };
    assert.equal(routeFor("player@gmail.com"), "unavailable");
  });
  it("EMAIL_TRANSPORT=smtp in development only reaches allow-listed test addresses", () => {
    if (env.isProduction) return;
    env.publicSiteUrl = "http://localhost:3100";
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.EMAIL_DEV_ALLOWLIST = "dev@tnja.test, @example.test";
    withSmtp();
    assert.equal(devRecipientAllowed("dev@tnja.test"), true);
    assert.equal(routeFor("someone@example.test"), "smtp");
    assert.equal(routeFor("real.player@gmail.com"), "console");
  });
  it("EMAIL_TRANSPORT=console wins everywhere", () => {
    env.publicSiteUrl = "https://tournament.tnja-329-2017.in";
    process.env.EMAIL_TRANSPORT = "console";
    withSmtp();
    assert.equal(routeFor("player@gmail.com"), "console");
  });
});
