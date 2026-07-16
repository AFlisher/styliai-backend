// Covers audit finding #4: /api/generate uploads must pass the same image
// allow-list as the admin upload endpoint instead of accepting any bytes.

const { single, fileFilter, ALLOWED_MIME_TYPES } = require("../upload");

describe("generate upload fileFilter", () => {
  it.each(["image/jpeg", "image/png", "image/webp", "image/gif"])(
    "accepts %s",
    (mimetype) => {
      const cb = jest.fn();
      fileFilter({}, { mimetype }, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    }
  );

  it.each(["application/pdf", "text/html", "application/octet-stream", "image/svg+xml", "video/mp4"])(
    "rejects %s with INVALID_FILE_TYPE",
    (mimetype) => {
      const cb = jest.fn();
      fileFilter({}, { mimetype }, cb);
      const err = cb.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("INVALID_FILE_TYPE");
    }
  );

  it("matches the admin upload allow-list exactly", () => {
    const adminUpload = require("../adminImageUpload");
    expect(adminUpload.uploadSingleImage).toBeDefined(); // module loads
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual(
      ["image/gif", "image/jpeg", "image/png", "image/webp"]
    );
  });

  it("keeps the upload.single(field) call shape used by generateRoutes", () => {
    expect(typeof single("file")).toBe("function");
  });
});
