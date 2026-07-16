const notificationModel = require("../models/notificationModel");

async function getNotifications(req, res) {
  try {
    const userId = req.user.id;
    const [notifications, unreadCount] = await Promise.all([
      notificationModel.getNotifications(userId),
      notificationModel.getUnreadCount(userId),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load notifications." });
  }
}

async function markRead(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const updated = await notificationModel.markRead(userId, id);
    if (!updated) {
      return res.status(404).json({ message: "Notification not found." });
    }

    const unreadCount = await notificationModel.getUnreadCount(userId);
    return res.json({ unreadCount });
  } catch (err) {
    console.error(err);

    // Malformed UUID in :id
    if (err.code === "22P02") {
      return res.status(404).json({ message: "Notification not found." });
    }

    return res.status(500).json({ message: "Failed to update notification." });
  }
}

async function markAllRead(req, res) {
  try {
    const userId = req.user.id;
    await notificationModel.markAllRead(userId);
    return res.json({ unreadCount: 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to update notifications." });
  }
}

module.exports = {
  getNotifications,
  markRead,
  markAllRead,
};
