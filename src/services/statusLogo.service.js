// The studio's own logo on the public status page. Stored in Postgres, not on disk or in R2:
// local uploads vanish on a redeploy, R2 may not be set up, and a file on another origin would be
// blocked by the web app's image policy. The API serves it from the same place as the page's data.
//
// PNG or JPEG only, up to 256 KB, and judged by the file's first bytes, never its name or the
// type the browser claims. No SVG: it can carry script. A paid feature, checked on write and
// again when served so a lapsed plan stops showing it (like hiding "Powered by Clientglass").
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { shareWhere } = require('../utils/shareToken');
const workspaceService = require('./workspace.service');

const MAX_BYTES = 256 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

const sniff = (buf) => {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length > PNG.length && buf.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (buf.length > JPEG.length && buf.subarray(0, JPEG.length).equals(JPEG)) return 'image/jpeg';
  return null;
};
exports.MAX_BYTES = MAX_BYTES;
exports.sniff = sniff;

exports.save = async (workspaceId, requesterId, file) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const owner = await prisma.user.findUnique({ where: { id: requesterId }, select: { isPro: true } });
  if (!owner?.isPro) throw AppError.paymentRequired('Showing your own logo on the client page is part of Clientglass Pro.');
  if (!file?.buffer?.length) throw AppError.badRequest('Choose a PNG or JPEG image.');
  if (file.buffer.length > MAX_BYTES) throw new AppError('That logo is too large. Use an image under 256 KB.', 413);
  const mime = sniff(file.buffer);
  if (!mime) throw AppError.badRequest('The logo must be a PNG or JPEG image.');

  const now = new Date();
  await prisma.$transaction([
    prisma.workspaceLogo.upsert({
      where: { workspaceId },
      create: { workspaceId, mime, data: file.buffer },
      update: { mime, data: file.buffer },
    }),
    prisma.workspace.update({ where: { id: workspaceId }, data: { statusLogoUpdatedAt: now } }),
  ]);
  return { statusLogoUpdatedAt: now };
};

exports.remove = async (workspaceId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  await prisma.$transaction([
    prisma.workspaceLogo.deleteMany({ where: { workspaceId } }),
    prisma.workspace.update({ where: { id: workspaceId }, data: { statusLogoUpdatedAt: null } }),
  ]);
};

// Public: the link is the credential. Unknown, rotated and disabled links, a workspace with no
// logo and a lapsed plan are all the same "not found".
exports.getByToken = async (rawToken) => {
  const ws = await prisma.workspace.findFirst({
    where: shareWhere(rawToken),
    select: { owner: { select: { isPro: true } }, logo: { select: { mime: true, data: true } } },
  });
  if (!ws?.logo || !ws.owner.isPro) throw AppError.notFound('Not found');
  return { mime: ws.logo.mime, data: Buffer.from(ws.logo.data) };
};
