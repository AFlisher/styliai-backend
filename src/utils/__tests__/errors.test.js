const { AppError, ErrorCodes } = require("../errors");

describe("AppError", () => {
  it("carries code, message, and statusCode, and is a real Error", () => {
    const err = new AppError(ErrorCodes.NOT_FOUND, "Style preset not found.", 404);

    expect(err).toBeInstanceOf(Error);
    expect(err.isAppError).toBe(true);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Style preset not found.");
    expect(err.statusCode).toBe(404);
  });

  it("exposes every error code the global handler and clients rely on", () => {
    expect(ErrorCodes).toMatchObject({
      VALIDATION_ERROR: "VALIDATION_ERROR",
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
      PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
      INTERNAL_ERROR: "INTERNAL_ERROR",
    });
  });
});
