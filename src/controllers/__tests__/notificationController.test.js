jest.mock("../../models/notificationModel", () => ({
  getNotifications: jest.fn(),
  getUnreadCount: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
  createNotification: jest.fn(),
}));

const notificationModel = require("../../models/notificationModel");
const {
  getNotifications,
  markRead,
  markAllRead,
} = require("../notificationController");

function makeReqRes({ user = { id: "u1" }, params = {} } = {}) {
  const req = { user, params };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
  return { req, res };
}

const ROWS = [
  { id: "n1", type: "welcome", title: "Welcome to StyliAI", body: "...", isRead: false, createdAt: "2026-07-16T00:00:00Z" },
];

describe("notificationController.getNotifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns the caller's notifications plus their unread count", async () => {
    notificationModel.getNotifications.mockResolvedValue(ROWS);
    notificationModel.getUnreadCount.mockResolvedValue(1);
    const { req, res } = makeReqRes();

    await getNotifications(req, res);

    expect(notificationModel.getNotifications).toHaveBeenCalledWith("u1");
    expect(notificationModel.getUnreadCount).toHaveBeenCalledWith("u1");
    expect(res.json).toHaveBeenCalledWith({ notifications: ROWS, unreadCount: 1 });
  });

  it("responds 500 when the model fails", async () => {
    notificationModel.getNotifications.mockRejectedValue(new Error("db down"));
    notificationModel.getUnreadCount.mockResolvedValue(0);
    const { req, res } = makeReqRes();

    await getNotifications(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("notificationController.markRead", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("marks the notification read scoped to the caller and returns the fresh unread count", async () => {
    notificationModel.markRead.mockResolvedValue({ id: "n1" });
    notificationModel.getUnreadCount.mockResolvedValue(0);
    const { req, res } = makeReqRes({ params: { id: "n1" } });

    await markRead(req, res);

    expect(notificationModel.markRead).toHaveBeenCalledWith("u1", "n1");
    expect(res.json).toHaveBeenCalledWith({ unreadCount: 0 });
  });

  it("returns 404 when the notification doesn't exist or belongs to another user", async () => {
    notificationModel.markRead.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { id: "someone-elses" } });

    await markRead(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("treats a malformed uuid as 404, not a server error", async () => {
    notificationModel.markRead.mockRejectedValue(Object.assign(new Error("bad uuid"), { code: "22P02" }));
    const { req, res } = makeReqRes({ params: { id: "not-a-uuid" } });

    await markRead(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("notificationController.markAllRead", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("marks everything read for the caller and returns unreadCount 0", async () => {
    notificationModel.markAllRead.mockResolvedValue();
    const { req, res } = makeReqRes();

    await markAllRead(req, res);

    expect(notificationModel.markAllRead).toHaveBeenCalledWith("u1");
    expect(res.json).toHaveBeenCalledWith({ unreadCount: 0 });
  });
});
