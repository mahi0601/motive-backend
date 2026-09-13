// Shared test fixtures — extracted from permissions.test.js so every new
// test file (auth/payment/recurrence/momentum, and whatever Workstream
// B/D/E add later) doesn't re-derive its own slightly-different copy of
// "make a throwaway user" and quietly drift out of sync with itself.
//
// Every user/workspace created here is fresh, uniquely named, and meant to
// be torn down with `cleanupUsers` in the caller's `afterAll` — nothing in
// this file ever reads or touches a real account. See README's Testing
// section for why this runs against the real dev database rather than a
// separate one, and why `npm test` uses --runInBand.
const prisma = require('../../src/config/prisma');
const workspaceService = require('../../src/services/workspace.service');

// Module-scoped, so every test file that requires this gets its own RUN_ID
// (Jest isolates modules per test file by default) — plus a per-call
// counter as cheap insurance against two calls in the same millisecond.
const RUN_ID = Date.now();
let counter = 0;
const testEmail = (label) => `test-${RUN_ID}-${counter++}-${label}@example.invalid`;

async function makeUser(label, overrides = {}) {
  return prisma.user.create({
    data: { name: `Test ${label}`, email: testEmail(label), password: null, ...overrides },
  });
}

// A workspace owned by `owner`, with `editors`/`viewers` (arrays of user
// records) added as members with those exact roles — the shape every
// permission-style test needs (see permissions.test.js).
async function makeWorkspaceWithMembers(owner, { editors = [], viewers = [] } = {}) {
  const workspace = await workspaceService.create({ name: `Test workspace (${owner.id})` }, owner.id);
  for (const editor of editors) {
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: editor.id, role: 'editor' } });
  }
  for (const viewer of viewers) {
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' } });
  }
  return workspace;
}

// Deletes the given users — cascades everything they own (workspaces,
// memberships, tasks, pages, blocks under those pages) per the schema's
// onDelete: Cascade relations, so this is the one call a test file's
// afterAll needs, not a hand-rolled multi-table cleanup.
async function cleanupUsers(...users) {
  const ids = users.filter(Boolean).map((u) => u.id);
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

module.exports = { testEmail, makeUser, makeWorkspaceWithMembers, cleanupUsers };
