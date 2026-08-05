"use strict";

/**
 * Regression suite for the CI failure this fixes: "supabaseUrl is required."
 *
 * THE BUG, exactly as it happened: `config/supabase.js` called
 * `createClient()` at IMPORT time with no guard. `@supabase/supabase-js`
 * throws synchronously when the URL is missing, so merely REQUIRING this
 * module - never mind using it - crashed in any environment without
 * SUPABASE_URL set. A clean CI checkout is exactly that environment: `.env`
 * is gitignored and never checked out, and the test workflow correctly does
 * not fabricate Supabase credentials for a suite that mocks every external
 * dependency. 11 suites failed this way, none of which touch Supabase Storage
 * at all - they failed purely because IMPORTING this file was made
 * conditional on an env var that had nothing to do with what they test.
 *
 * The two properties below are the whole fix, and each is asserted directly
 * rather than inferred from a passing integration test, because a passing
 * integration test proves the fix today but not that it stays fixed - a
 * future change to this file could silently reintroduce eager construction
 * and every test using it would still pass, having never actually asked.
 *
 * Every test uses jest.isolateModules() rather than a custom test-only reset
 * export on the module itself: the module-level `client` singleton is
 * production behaviour worth keeping exactly as-is, and isolateModules gives
 * each test its own module registry without adding a single line of
 * test-only code to production source (the same pattern src/__tests__/
 * lifecycle.test.js already uses for db.js's pool).
 */

const ORIGINAL_ENV = { ...process.env };

function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.keys(vars).forEach((key) => {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  });
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("importing the module never constructs a client", () => {
  it("does not throw when required with no Supabase config at all", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      // THE regression assertion. Before the fix, this line alone threw
      // "supabaseUrl is required." - not a test failure inside a test body,
      // a crash while Jest was still loading the file.
      expect(() => {
        jest.isolateModules(() => {
          require("../supabase");
        });
      }).not.toThrow();
    });
  });

  it("does not call createClient just from being required", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      jest.isolateModules(() => {
        jest.doMock("@supabase/supabase-js", () => ({
          createClient: jest.fn(() => ({ storage: {} })),
        }));
        require("../supabase");
        const { createClient } = require("@supabase/supabase-js");

        // Construction must be deferred all the way to first USE. If this
        // fires just from the require() above, the fix has regressed back
        // to eager construction.
        expect(createClient).not.toHaveBeenCalled();
      });
    });
  });

  it("does not throw even when required many times over (no cached failure state)", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      expect(() => {
        jest.isolateModules(() => {
          require("../supabase");
          require("../supabase");
          require("../supabase");
        });
      }).not.toThrow();
    });
  });
});

describe("validation is preserved at first actual use", () => {
  it("throws a clear, actionable error the first time a property is read, with no config set", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      jest.isolateModules(() => {
        const supabase = require("../supabase");
        expect(() => supabase.storage).toThrow(/SUPABASE_URL/);
        expect(() => supabase.storage).toThrow(/SUPABASE_SERVICE_KEY/);
      });
    });
  });

  it("throws when only SUPABASE_URL is set", () => {
    withEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_KEY: undefined }, () => {
      jest.isolateModules(() => {
        const supabase = require("../supabase");
        expect(() => supabase.storage).toThrow(/SUPABASE_SERVICE_KEY/);
      });
    });
  });

  it("throws when only SUPABASE_SERVICE_KEY is set", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: "service-key" }, () => {
      jest.isolateModules(() => {
        const supabase = require("../supabase");
        expect(() => supabase.storage).toThrow(/SUPABASE_URL/);
      });
    });
  });

  it("throws on method calls, not just property reads", () => {
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      jest.isolateModules(() => {
        const supabase = require("../supabase");
        // .storage.from(...) is the real-world access pattern every consumer
        // uses; asserting the chained call is what proves the Proxy's `get`
        // trap fires on the outer property before the inner one is ever
        // reached, rather than only on a bare top-level read.
        expect(() => supabase.storage.from("avatars")).toThrow(/SUPABASE_URL/);
      });
    });
  });
});

describe("a correctly configured environment", () => {
  it("constructs the client on first use, with the configured credentials", () => {
    withEnv(
      { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_KEY: "real-looking-key" },
      () => {
        jest.isolateModules(() => {
          const mockClient = { storage: { from: jest.fn() } };
          const createClient = jest.fn(() => mockClient);
          jest.doMock("@supabase/supabase-js", () => ({ createClient }));

          const supabase = require("../supabase");

          expect(createClient).not.toHaveBeenCalled();
          const { storage } = supabase;
          expect(createClient).toHaveBeenCalledWith(
            "https://proj.supabase.co",
            "real-looking-key"
          );
          expect(storage).toBe(mockClient.storage);
        });
      }
    );
  });

  it("builds the client exactly once, reusing it across every subsequent access", () => {
    withEnv(
      { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_KEY: "real-looking-key" },
      () => {
        jest.isolateModules(() => {
          const createClient = jest.fn(() => ({ storage: {}, auth: {} }));
          jest.doMock("@supabase/supabase-js", () => ({ createClient }));

          const supabase = require("../supabase");

          // eslint-disable-next-line no-unused-expressions
          supabase.storage;
          // eslint-disable-next-line no-unused-expressions
          supabase.auth;
          // eslint-disable-next-line no-unused-expressions
          supabase.storage;

          // One client for the process lifetime, exactly as the pre-fix
          // eager version guaranteed - only the WHEN changed, not the WHAT.
          expect(createClient).toHaveBeenCalledTimes(1);
        });
      }
    );
  });
});

describe("the real app can be loaded with no Supabase config at all", () => {
  it("requiring src/app.js does not throw without SUPABASE_URL", () => {
    // This is the exact shape of the original CI failure, one level up:
    // app.js pulls this module in transitively through creationsController,
    // styleController, and accountDeletionService, and none of those files
    // should need Supabase configured just to be loaded into memory.
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
      expect(() => {
        jest.isolateModules(() => {
          require("../../app");
        });
      }).not.toThrow();
    });
  });
});
