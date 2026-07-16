const db = require("../config/db");

async function getNotifications(userId, { limit = 50 } = {}) {
  const result = await db.query(
    `
    SELECT
      id,
      type,
      title,
      body,
      is_read AS "isRead",
      created_at AS "createdAt"
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [userId, limit]
  );

  return result.rows;
}

async function getUnreadCount(userId) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = false`,
    [userId]
  );

  return result.rows[0].count;
}

/**
 * Marks one notification as read, scoped to the owning user so a caller can
 * never mark another user's notification. Returns the row id or undefined
 * when nothing matched (not found / not owned).
 */
async function markRead(userId, notificationId) {
  const result = await db.query(
    `
    UPDATE notifications
    SET is_read = true
    WHERE id = $1 AND user_id = $2
    RETURNING id
    `,
    [notificationId, userId]
  );

  return result.rows[0];
}

async function markAllRead(userId) {
  await db.query(
    `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`,
    [userId]
  );
}

/**
 * Inserts a notification. Accepts an optional `queryable` (a client already
 * inside a transaction, e.g. registration's user+profile insert) so the
 * welcome notification can be atomic with account creation; defaults to the
 * shared pool for fire-and-forget producers like generation-complete.
 */
async function createNotification(
  { userId, type, title, body },
  queryable = db
) {
  await queryable.query(
    `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`,
    [userId, type, title, body]
  );
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  createNotification,
};
