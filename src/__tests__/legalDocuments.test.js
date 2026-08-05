"use strict";

/**
 * Sprint 1 / B-2 — the hosted legal documents.
 *
 * These assertions exist because the failure they guard against is silent and
 * expensive: a privacy policy URL that 404s does not break the app, does not
 * appear in any log the team reads, and is discovered by a store reviewer
 * rejecting the submission days later.
 *
 * What is asserted is reachability and shape, never wording - the text is a
 * legal artefact that will be edited by someone who is not reading this file,
 * and a test that pins prose would be deleted the first time it was right to
 * change a sentence.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";
process.env.ADMIN_JWT_SECRET = "test-only-admin-secret-never-used-in-production";

jest.mock("../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../services/sessionService", () => require("../../test/mocks/activeSession"));

const request = require("supertest");
const app = require("../app");

const DOCUMENTS = [
  "/legal/privacy-policy.html",
  "/legal/terms-of-service.html",
  "/legal/account-deletion.html",
];

describe("reachability", () => {
  it.each(DOCUMENTS)("serves %s to an anonymous caller", async (url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text.length).toBeGreaterThan(500);
  });

  it("serves the document index", async () => {
    const res = await request(app).get("/legal/");

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/privacy-policy\.html/);
    expect(res.text).toMatch(/terms-of-service\.html/);
    expect(res.text).toMatch(/account-deletion\.html/);
  });

  it("resolves the extension-less form, so a mistyped store listing still works", async () => {
    const res = await request(app).get("/legal/privacy-policy");
    expect(res.status).toBe(200);
  });

  it("serves the stylesheet the documents reference", async () => {
    const res = await request(app).get("/legal/_shared.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });
});

describe("no authentication is required", () => {
  it.each(DOCUMENTS)("%s carries no auth challenge", async (url) => {
    const res = await request(app).get(url);

    // A store reviewer has no account. Anything other than 200 here is a
    // failed submission.
    expect(res.status).toBe(200);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("content requirements the stores actually check", () => {
  it("the deletion page explains both the in-app path and the no-app-access path", async () => {
    const res = await request(app).get("/legal/account-deletion.html");

    // Play requires the public URL to describe how to request deletion without
    // assuming the app is installed.
    expect(res.text).toMatch(/Delete Account/i);
    expect(res.text).toMatch(/cannot access the app/i);
  });

  it("the deletion page states what is retained after deletion", async () => {
    const res = await request(app).get("/legal/account-deletion.html");
    expect(res.text).toMatch(/What is kept/i);
  });

  it("the privacy policy discloses that photos are sent to a third-party provider", async () => {
    const res = await request(app).get("/legal/privacy-policy.html");
    expect(res.text).toMatch(/third-party AI/i);
  });

  it("every document is cross-linked to the other two", async () => {
    for (const url of DOCUMENTS) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(url);
      const others = DOCUMENTS.filter((d) => d !== url);
      others.forEach((other) => expect(res.text).toContain(other));
    }
  });
});

describe("publication readiness", () => {
  /**
   * The placeholder convention is `[[PLACEHOLDER: ...]]`. This test does not
   * fail on their presence - they are correct while the documents are drafts -
   * it asserts the convention is intact, so the pre-publication check
   * (`grep -r "\[\[PLACEHOLDER" public/legal`) is guaranteed to find all of
   * them rather than silently missing a differently-spelled one.
   */
  it.each(DOCUMENTS)("%s marks unresolved company facts with the agreed token", async (url) => {
    const res = await request(app).get(url);

    const matches = res.text.match(/\[\[PLACEHOLDER:/g) || [];
    expect(matches.length).toBeGreaterThan(0);

    // No half-written variants that a grep would miss.
    expect(res.text).not.toMatch(/\[PLACEHOLDER(?!:)/);
    expect(res.text).not.toMatch(/TODO|FIXME|Lorem ipsum/i);
  });

  it("each document carries a version and an effective date field", async () => {
    for (const url of DOCUMENTS) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(url);
      expect(res.text).toMatch(/Document version:/i);
      expect(res.text).toMatch(/Effective date:/i);
    }
  });
});
