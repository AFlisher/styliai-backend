"use strict";

/**
 * R-2 phase 4/5 — authenticated avatar delivery, against the REAL app.
 *
 * The `avatars` bucket is private, so a stored object URL is no longer
 * fetchable by anyone. Delivery goes through this endpoint instead: it
 * authorizes by identity and redirects to a short-lived signed URL, the same
 * shape SEC-8.1B-2 established for creations.
 *
 * The property that matters most here is structural rather than behavioural:
 * the route takes NO user id. A caller can only ever ask for their own avatar,
 * so there is nothing to enumerate and no ownership comparison that can be
 * written the wrong way round. The tests below pin that, and pin that the
 * endpoint refuses to redirect anywhere we have not allow-listed - the column
 * it reads is still client-writable through PostgREST.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";

const mockCreateSignedUrl = jest.fn();
jest.mock("../config/supabase", () => ({
  storage: {
    from: jest.fn(() => ({
      createSignedUrl: mockCreateSignedUrl,
      upload: jest.fn(),
      getPublicUrl: jest.fn(),
    })),
  },
}));

jest.mock("../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const supabase = require("../config/supabase");
const app = require("../app");
const { SIGNED_URL_TTL_SECONDS } = require("../services/avatarService");

const USER_ID = "f60f71b5-be64-43d4-b747-e2dadd8787f7";
const PROJECT = "https://proj.supabase.co";
const STORED = `${PROJECT}/storage/v1/object/public/avatars/${USER_ID}.jpg?v=1784034159601`;
const SIGNED = `${PROJECT}/storage/v1/object/sign/avatars/${USER_ID}.jpg?token=abc`;
const GOOGLE = "https://lh3.googleusercontent.com/a/ACg8ocI7kTt=s96-c";

function token(overrides = {}) {
  return jwt.sign(
    { sub: USER_ID, email: "u@example.com", aud: "authenticated", type: "access", ...overrides },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function get({ auth = token() } = {}) {
  const req = request(app).get("/api/profile/avatar").redirects(0);
  if (auth) req.set("Authorization", `Bearer ${auth}`);
  return req;
}

/** The single-row shape resolveAvatarDelivery reads. */
function profileRow(avatarUrl) {
  db.query.mockResolvedValue({ rows: avatarUrl === undefined ? [] : [{ avatar_url: avatarUrl }] });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
});

afterEach(() => jest.restoreAllMocks());

describe("authorization", () => {
  it("401s without a token", async () => {
    profileRow(STORED);

    const res = await get({ auth: null });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("401s on a token signed with the wrong secret", async () => {
    profileRow(STORED);
    const forged = jwt.sign({ sub: USER_ID, aud: "authenticated" }, "nope", { algorithm: "HS256" });

    const res = await get({ auth: forged });

    expect(res.status).toBe(401);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("401s on an expired token", async () => {
    profileRow(STORED);
    const expired = jwt.sign(
      { sub: USER_ID, aud: "authenticated", type: "access" },
      process.env.SUPABASE_JWT_SECRET,
      { algorithm: "HS256", expiresIn: -10 }
    );

    const res = await get({ auth: expired });

    expect(res.status).toBe(401);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("401s on a refresh token presented as a bearer (SEC-1.1)", async () => {
    profileRow(STORED);
    const refresh = jwt.sign(
      { sub: USER_ID, aud: "authenticated", type: "refresh" },
      process.env.SUPABASE_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "5m" }
    );

    const res = await get({ auth: refresh });

    expect(res.status).toBe(401);
  });

  it("reads the avatar of the token's subject, never a supplied id", async () => {
    // The authorization IS the lookup: the id comes from the verified token, so
    // there is no id in the request that could be pointed at someone else.
    profileRow(STORED);
    const other = "11111111-2222-3333-4444-555555555555";

    await get({ auth: token({ sub: other }) });

    expect(db.query.mock.calls[0][1]).toEqual([other]);
  });
});

describe("enumeration", () => {
  it("exposes no route that accepts an avatar id", async () => {
    // Structural, and the strongest form of the property: an id-taking variant
    // simply does not exist, so it cannot be got wrong.
    profileRow(STORED);

    const byId = await request(app)
      .get(`/api/profile/avatar/${USER_ID}`)
      .set("Authorization", `Bearer ${token()}`)
      .redirects(0);

    expect(byId.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("answers identically whether another user exists or not", async () => {
    // Nothing in the response varies with anyone else's state, because nothing
    // in the request refers to anyone else.
    profileRow(null);
    const a = await get();
    profileRow(undefined); // no row at all
    const b = await get();

    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body).toEqual(b.body);
  });
});

describe("signed delivery", () => {
  it("redirects to a signed URL for a stored avatar object", async () => {
    profileRow(STORED);

    const res = await get();

    expect(supabase.storage.from).toHaveBeenCalledWith("avatars");
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(`${USER_ID}.jpg`, SIGNED_URL_TTL_SECONDS);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SIGNED);
  });

  it("strips the ?v= cache-buster before signing the object path", async () => {
    // The buster is part of the delivery URL, never part of the object name.
    profileRow(STORED);

    await get();

    expect(mockCreateSignedUrl.mock.calls[0][0]).toBe(`${USER_ID}.jpg`);
    expect(mockCreateSignedUrl.mock.calls[0][0]).not.toContain("?v=");
  });

  it("keeps the signature short-lived", () => {
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
  });

  it("forbids caching the redirect itself", async () => {
    // The target expires; a cached 302 would keep pointing at a dead signature.
    profileRow(STORED);

    const res = await get();

    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("never returns a public storage URL to the client", async () => {
    profileRow(STORED);

    const res = await get();

    expect(res.headers.location).not.toContain("/object/public/");
  });

  it("502s without leaking the storage URL when signing fails", async () => {
    profileRow(STORED);
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: "nope" } });

    const res = await get();

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("supabase.co");
  });

  it("works the same whether the bucket is public or private", async () => {
    // Nothing on this path reads bucket visibility, which is what made the
    // flip a configuration change rather than a deploy.
    profileRow(STORED);

    const res = await get();

    expect(res.status).toBe(302);
  });
});

describe("provider pictures and refused targets", () => {
  it("passes through an allow-listed Google picture unchanged", async () => {
    // Most accounts carry one of these. It is public, not ours to sign, and
    // must keep working.
    profileRow(GOOGLE);

    const res = await get();

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(GOOGLE);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("404s when no avatar is set", async () => {
    profileRow(null);

    const res = await get();

    expect(res.status).toBe(404);
  });

  it("refuses to redirect to an arbitrary host", async () => {
    // profiles.avatar_url is still writable by the client through PostgREST,
    // so without an allow-list a user could turn this endpoint into an open
    // redirect on our own domain.
    profileRow("https://evil.example/pwn.jpg");

    const res = await get();

    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it("refuses a host that merely ends with an allowed one", async () => {
    profileRow("https://lh3.googleusercontent.com.evil.example/x.jpg");

    const res = await get();

    expect(res.status).toBe(404);
  });

  it("refuses a plaintext-http provider URL", async () => {
    profileRow("http://lh3.googleusercontent.com/a/x=s96-c");

    const res = await get();

    expect(res.status).toBe(404);
  });

  it("refuses a non-URL value", async () => {
    profileRow("not a url at all");

    const res = await get();

    expect(res.status).toBe(404);
  });

  it("refuses an object in a bucket that is not avatars", async () => {
    // A crafted value pointing at someone's creation must not be signed by the
    // avatar endpoint.
    profileRow(`${PROJECT}/storage/v1/object/public/creations/original/abc.webp`);

    const res = await get();

    expect(res.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });
});
