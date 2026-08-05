const { createClient } = require("@supabase/supabase-js");

/**
 * Sprint 4 - CI regression fix.
 *
 * THE BUG: this file used to call `createClient()` at IMPORT time, eagerly,
 * with no guard. `@supabase/supabase-js` throws synchronously if the URL is
 * missing, so merely requiring this module - not using it, just requiring it -
 * crashed the moment `SUPABASE_URL` was unset.
 *
 * That is precisely the environment a clean CI checkout is: `.env` is
 * gitignored and never checked out, and the Sprint 3 `test.yml` workflow
 * correctly does not fabricate Supabase credentials for a suite that mocks
 * every external dependency. The moment that workflow ran on a truly clean
 * tree, `require("../app")` - which nearly every integration test does -
 * pulled this module in transitively (via `creationsController.js`,
 * `styleController.js` -> `creationAssetCleanup.js`, `accountDeletionService.js`
 * -> `avatarService.js`, and `healthController.js`'s own lazy require) and
 * threw "supabaseUrl is required." before a single test in the file could run.
 * 11 suites failed this way - none of them exercise Supabase Storage at all;
 * they failed purely because IMPORTING this file was made conditional on an
 * env var that has nothing to do with what they test.
 *
 * `healthController.js` had already worked around this correctly for itself,
 * with a comment explaining exactly why: "Required lazily, not at module
 * load... requiring it at the top would make merely loading app.js fail in
 * every suite that has not mocked it." That comment described the right fix -
 * it just needed to live HERE, once, rather than be re-discovered by every
 * future consumer that forgets to require this module lazily.
 *
 * THE FIX: defer construction to first ACTUAL USE, not first import. A Proxy
 * is what makes this transparent - every existing consumer's
 * `supabase.storage.from(...)` keeps working completely unchanged; the only
 * difference is WHEN the client gets built.
 *
 * This does not remove any deliberate validation. Nothing in
 * `validateSecrets.js` or `server.js` asserts SUPABASE_URL/SUPABASE_SERVICE_KEY
 * at boot - the eager throw was never a designed fail-fast guarantee, it was
 * an accidental side effect of the underlying library's own constructor
 * argument check. Production is unaffected: those variables are always set
 * there, so the client is still built once, on first use, and reused for the
 * process lifetime exactly as before - just not the instant this file is
 * merely required.
 *
 * If Storage is ever genuinely used with the variables missing (a real
 * misconfiguration, in any environment), the error still fires - just at the
 * point of use rather than at import - with the same message, now naming
 * both variables so the fix is obvious without reading this file's source.
 */

let client = null;

function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      throw new Error(
        "[config/supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY must both be " +
          "set to use Supabase Storage. This is thrown at first USE, not at " +
          "import, so requiring this module in a test that never touches " +
          "storage is always safe."
      );
    }

    client = createClient(url, key);
  }
  return client;
}

module.exports = new Proxy(
  {},
  {
    get(_target, prop, receiver) {
      return Reflect.get(getClient(), prop, receiver);
    },
    // Belt and suspenders: a caller checking `typeof supabase.storage` or
    // `'storage' in supabase` must see the real client's shape, not the empty
    // target object the Proxy wraps.
    has(_target, prop) {
      return Reflect.has(getClient(), prop);
    },
  }
);
