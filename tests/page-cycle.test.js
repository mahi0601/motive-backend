// Regression test for the page-tree cycle DoS fix. page.service.js#update
// accepted `parentId` with no ancestry check — re-parenting a page onto its
// own descendant created a cycle, and the next remove() walked it via
// collectDescendantIds's `WITH RECURSIVE ... UNION ALL` CTE, which had no
// cycle detection and no depth cap, spinning until the connection died.
//
// Same real-dev-database convention as permissions.test.js.
const pageService = require('../src/services/page.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('page tree cycle prevention', () => {
  let owner;
  let root, child, grandchild;

  beforeAll(async () => {
    owner = await makeUser('pageCycleOwner');
    root = await pageService.create({ title: 'Root' }, owner.id);
    child = await pageService.create({ title: 'Child', parentId: root.id }, owner.id);
    grandchild = await pageService.create({ title: 'Grandchild', parentId: child.id }, owner.id);
  });

  afterAll(async () => {
    await cleanupUsers(owner);
  });

  test('rejects a page becoming its own parent', async () => {
    await expect(pageService.update(root.id, { parentId: root.id }, owner.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('rejects re-parenting a page onto its own direct child', async () => {
    await expect(pageService.update(root.id, { parentId: child.id }, owner.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('rejects re-parenting a page onto its own grandchild', async () => {
    await expect(pageService.update(root.id, { parentId: grandchild.id }, owner.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('a legitimate re-parent (no cycle) still succeeds', async () => {
    // Move grandchild up to be a direct child of root — not a cycle, since
    // root isn't a descendant of grandchild.
    const updated = await pageService.update(grandchild.id, { parentId: root.id }, owner.id);
    expect(updated.parentId).toBe(root.id);
  });

  test('remove() still terminates and archives the whole (now-shallower) subtree', async () => {
    // Regression guard for the fix itself, not just the rejection above —
    // if the cycle check had a gap, this is where an actual cycle would
    // have made collectDescendantIds's recursive CTE spin forever instead
    // of returning.
    const result = await pageService.remove(root.id, owner.id);
    expect(result.archived).toBeGreaterThanOrEqual(2); // root + at least child
  });
});
