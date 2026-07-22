jest.mock("../../models/generationFeedbackModel", () => ({
  addFeedback: jest.fn(),
}));

const generationFeedbackModel = require("../../models/generationFeedbackModel");
const { submitFeedback } = require("../generationFeedbackController");

function makeReqRes({ body = {} } = {}) {
  const req = { body, user: { id: "user-1" } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

const VALID_BODY = {
  rating: 5,
  comment: "Loved it!",
  generationId: "11111111-1111-4111-8111-111111111111",
  styleId: "22222222-2222-4222-8222-222222222222",
  categoryId: "33333333-3333-4333-8333-333333333333",
  generationTimeMs: 4200,
  appVersion: "1.0.0",
};

describe("generationFeedbackController.submitFeedback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generationFeedbackModel.addFeedback.mockResolvedValue({
      id: "feedback-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("saves feedback and returns 201 with the new id", async () => {
    const { req, res, next } = makeReqRes({ body: VALID_BODY });

    await submitFeedback(req, res, next);

    expect(generationFeedbackModel.addFeedback).toHaveBeenCalledWith({
      userId: "user-1",
      generationId: VALID_BODY.generationId,
      styleId: VALID_BODY.styleId,
      categoryId: VALID_BODY.categoryId,
      rating: 5,
      comment: "Loved it!",
      generationTimeMs: 4200,
      appVersion: "1.0.0",
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: "feedback-1", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a rating-only submission (comment/ids all optional)", async () => {
    const { req, res, next } = makeReqRes({ body: { rating: 3 } });

    await submitFeedback(req, res, next);

    expect(generationFeedbackModel.addFeedback).toHaveBeenCalledWith({
      userId: "user-1",
      generationId: null,
      styleId: null,
      categoryId: null,
      rating: 3,
      comment: null,
      generationTimeMs: null,
      appVersion: null,
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects with VALIDATION_ERROR when rating is missing", async () => {
    const { req, res, next } = makeReqRes({ body: {} });

    await submitFeedback(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(generationFeedbackModel.addFeedback).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when rating is out of range", async () => {
    const { req, res, next } = makeReqRes({ body: { rating: 6 } });

    await submitFeedback(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(generationFeedbackModel.addFeedback).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when comment exceeds the max length", async () => {
    const { req, res, next } = makeReqRes({ body: { rating: 4, comment: "x".repeat(2001) } });

    await submitFeedback(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(generationFeedbackModel.addFeedback).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when generationId is not a valid uuid", async () => {
    const { req, res, next } = makeReqRes({ body: { rating: 4, generationId: "not-a-uuid" } });

    await submitFeedback(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
  });

  it("maps a model failure to INTERNAL_ERROR/500", async () => {
    generationFeedbackModel.addFeedback.mockRejectedValue(new Error("db down"));
    const { req, res, next } = makeReqRes({ body: VALID_BODY });

    await submitFeedback(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INTERNAL_ERROR", statusCode: 500 })
    );
  });
});
