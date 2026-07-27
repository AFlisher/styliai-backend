require('dotenv').config();

// SEC-17.1: assert signing-secret quality before anything is served. This lives
// in the entrypoint rather than in the middleware that consumes the secret so
// that it runs exactly once, on the real boot path, and never against the
// throwaway secrets the test suite sets.
const { validateAdminJwtSecret } = require('./src/config/validateSecrets');
validateAdminJwtSecret();

const app = require("./src/app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 StyliAI Server is running on port ${PORT}`);
});