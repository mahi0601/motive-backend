const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { getPagination, paginated } = require('../utils/pagination');

exports.listForUser = async (userId, query) => {
  const { page, limit, skip } = getPagination(query, { defaultLimit: 30, maxLimit: 100 });
  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId } }),
    // Independent of pagination — the unread badge must reflect ALL unread
    // notifications, not just whatever fits on the current page.
    prisma.notification.count({ where: { userId, read: false } }),
  ]);
  return { unreadCount, ...paginated(items, total, { page, limit }) };
};

exports.markAsRead = async (id, userId) => {
  // Scoped by userId too — otherwise any authenticated user could mark
  // another user's notification as read (IDOR).
  const { count } = await prisma.notification.updateMany({ where: { id, userId }, data: { read: true } });
  if (!count) throw AppError.notFound('Notification not found');
};

exports.clearAll = (userId) => prisma.notification.deleteMany({ where: { userId } });
