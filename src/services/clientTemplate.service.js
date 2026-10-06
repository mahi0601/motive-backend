// Saved client templates: the structure of a client the owner keeps for next time. The snapshot
// is built by workspaceCopy.service.js#collectStructure, so it is sanitised when SAVED: no
// comments, files, people, approvals, share link or links to uploads, and dates are day offsets.
// Templates are private to their owner; another owner's id is always "not found".
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const workspaceService = require('./workspace.service');
const copy = require('./workspaceCopy.service');
const withLock = require('../utils/advisoryLock');

const MAX_TEMPLATES = 20;
const MAX_SNAPSHOT_BYTES = 2_000_000;

const countsOf = (s) => ({ tasks: s?.tasks?.length ?? 0, pages: s?.pages?.length ?? 0, milestones: s?.milestones?.length ?? 0 });
const present = (t) => ({ id: t.id, name: t.name, description: t.description, createdAt: t.createdAt, counts: countsOf(t.snapshot) });

exports.save = async (ownerId, { workspaceId, name, description = '' }) => {
  await workspaceService.assertOwner(workspaceId, ownerId);
  const have = await prisma.clientTemplate.count({ where: { ownerId } });
  if (have >= MAX_TEMPLATES) throw AppError.conflict(`You can keep up to ${MAX_TEMPLATES} client templates. Delete one to save another.`);

  const snapshot = await copy.collectStructure(workspaceId);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new AppError('This client is too large to save as a template. Leave out long pages or archive some first.', 422);
  }

  // Counted again under a per-owner lock (the snapshot above is slow, so parallel saves overlap).
  const row = await withLock(`templates:${ownerId}`, async (tx) => {
    if (
      (await tx.clientTemplate.count({ where: { ownerId } })) >= MAX_TEMPLATES
    ) {
      throw AppError.conflict(
        `You can keep up to ${MAX_TEMPLATES} client templates. Delete one to save another.`,
      );
    }
    return tx.clientTemplate.create({
      data: {
        ownerId,
        name: String(name).trim(),
        description: String(description).trim(),
        snapshot,
      },
    });
  });
  const counts = countsOf(snapshot);
  await audit.record({ type: 'client_template_saved', actorId: ownerId, meta: counts });
  return present(row);
};

exports.list = async (ownerId) => {
  const rows = await prisma.clientTemplate.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
  return rows.map(present);
};

exports.remove = async (ownerId, id) => {
  const { count } = await prisma.clientTemplate.deleteMany({ where: { id, ownerId } });
  if (!count) throw AppError.notFound('Template not found');
};

exports.use = async (ownerId, id, input = {}) => {
  const template = await prisma.clientTemplate.findFirst({ where: { id, ownerId } });
  if (!template) throw AppError.notFound('Template not found');
  const include = { tasks: true, pages: true, milestones: true, statusText: true, ...(input.include || {}) };
  const start = input.startDate ? new Date(input.startDate) : null;
  const { workspace, counts } = await copy.createFromStructure(template.snapshot, { ownerId, name: String(input.name).trim(), start, include });
  await audit.record({ type: 'client_template_used', actorId: ownerId, workspaceId: workspace.id, meta: counts });
  return { workspace: { id: workspace.id, name: workspace.name }, counts };
};
