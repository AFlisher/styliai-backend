// Deterministic env for the Critical Supertest suites. Required BEFORE the
// Express app is imported so module-load-time reads (e.g. the Google client
// id in authController) see these values.
process.env.NODE_ENV = "test";
process.env.SUPABASE_JWT_SECRET = "test-supabase-secret";
process.env.ADMIN_JWT_SECRET = "test-admin-secret";
process.env.GOOGLE_WEB_CLIENT_ID = "test-google-client-id";
process.env.BACKEND_URL = "http://localhost:3000";
process.env.IMAGE_PROVIDER = "gemini";
// Keep the client-reported reward path enabled (default) so behavior matches
// production; SSV tests exercise the callback path regardless.
delete process.env.ENABLE_CLIENT_AD_REWARD;
