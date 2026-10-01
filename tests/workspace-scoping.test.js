// Workspace-scoped reads and search. The UI now passes the active workspaceId
// when it lists tasks/pages, and search covers shared workspaces — these pin
// down exactly who sees what.
const prisma = require('../src/config/prisma');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const blockService = require('../src/services/block.service');
const workspaceService = require('../src/services/workspace.service');
const templateService = require('../src/services/template.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const titles = (items) => items.map((i) => i.title).sort();

describe('workspace-scoped lists and search', () => {
  let owner, editor, outsider;
  let shared, ownerDefault;

  beforeAll(async () => {
    owner = await makeUser('owner');
    editor = await makeUser('editor');
    outsider = await makeUser('outsider');
    // The owner's personal workspace must exist BEFORE the shared one:
    // getDefault() is "the oldest workspace you belong to", so creating the
    // shared one first would make it the owner's default.
    ownerDefault = await workspaceService.getDefault(owner.id);
    shared = await makeWorkspaceWithMembers(owner, { editors: [editor] });

    await taskService.create({ title: 'Shared rocket task', workspaceId: shared.id }, editor.id);
    await taskService.create({ title: 'Private rocket task' }, owner.id); // owner's default workspace
    await taskService.create({ title: 'Outsider rocket task' }, outsider.id);
  });

  afterAll(async () => {
    await cleanupUsers(owner, editor, outsider);
    await prisma.$disconnect();
  });

  describe('task list', () => {
    test('a shared workspace lists every member’s tasks in it, and nothing else', async () => {
      const { items } = await taskService.getAll(owner.id, { skip: 0, limit: 50, workspaceId: shared.id });
      expect(titles(items)).toEqual(['Shared rocket task']);
    });

    test('a non-member cannot list a workspace', async () => {
      await expect(
        taskService.getAll(outsider.id, { skip: 0, limit: 50, workspaceId: shared.id })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('the default workspace also lists the owner’s legacy tasks with no workspace', async () => {
      await prisma.task.create({ data: { title: 'Legacy task', userId: owner.id, workspaceId: null } });

      const own = await taskService.getAll(owner.id, { skip: 0, limit: 50, workspaceId: ownerDefault.id });
      expect(titles(own.items)).toEqual(['Legacy task', 'Private rocket task']);

      // …but never inside a different workspace.
      const sharedList = await taskService.getAll(owner.id, { skip: 0, limit: 50, workspaceId: shared.id });
      expect(titles(sharedList.items)).not.toContain('Legacy task');
    });
  });

  describe('page list', () => {
    test('lists a shared workspace’s pages, plus legacy pages only in the default workspace', async () => {
      await pageService.create({ title: 'Shared page', workspaceId: shared.id }, editor.id);
      await prisma.page.create({ data: { title: 'Legacy page', ownerId: owner.id, workspaceId: null } });

      const sharedPages = await pageService.list(owner.id, { workspaceId: shared.id });
      expect(titles(sharedPages)).toEqual(['Shared page']);

      const ownPages = await pageService.list(owner.id, { workspaceId: ownerDefault.id });
      expect(titles(ownPages)).toContain('Legacy page');
      expect(titles(ownPages)).not.toContain('Shared page');
    });

    test('a non-member gets nothing for a workspace', async () => {
      expect(await pageService.list(outsider.id, { workspaceId: shared.id })).toEqual([]);
    });
  });

  describe('task search', () => {
    test('finds own and shared-workspace tasks, never a stranger’s', async () => {
      const found = await taskService.search('rocket', owner.id);
      expect(titles(found)).toEqual(['Private rocket task', 'Shared rocket task']);
    });

    test('a member finds tasks teammates created in a shared workspace', async () => {
      const found = await taskService.search('ROCKET', editor.id); // case-insensitive
      expect(titles(found)).toContain('Shared rocket task');
      expect(titles(found)).not.toContain('Private rocket task');
    });
  });

  describe('page search', () => {
    let sharedPage;

    beforeAll(async () => {
      sharedPage = await pageService.create({ title: 'Kickoff notes', workspaceId: shared.id }, owner.id);
      await blockService.create(sharedPage.id, { type: 'paragraph', content: { html: 'Discuss <b>Quarterly</b> Roadmap' } }, owner.id);
      await blockService.create(sharedPage.id, { type: 'paragraph', content: { text: 'legacy PLAIN text' } }, owner.id);
    });

    test('matches block text case-insensitively, including rich-text html and legacy text', async () => {
      const rich = await pageService.search('quarterly roadmap', editor.id);
      expect(rich.map((p) => p.id)).toContain(sharedPage.id);

      const legacy = await pageService.search('plain TEXT', editor.id);
      expect(legacy.map((p) => p.id)).toContain(sharedPage.id);
    });

    test('does not match on html tag names', async () => {
      const found = await pageService.search('strong', owner.id);
      expect(found.map((p) => p.id)).not.toContain(sharedPage.id);
      // "b" appears only as a <b> tag around "Quarterly" — not as text.
      const tagOnly = await pageService.search('<b>', owner.id);
      expect(tagOnly.map((p) => p.id)).not.toContain(sharedPage.id);
    });

    test('a stranger cannot find a shared page by title or content', async () => {
      expect((await pageService.search('Kickoff', outsider.id)).map((p) => p.id)).not.toContain(sharedPage.id);
      expect((await pageService.search('Quarterly', outsider.id)).map((p) => p.id)).not.toContain(sharedPage.id);
    });

    test('LIKE wildcards in the search term are literal', async () => {
      expect(await pageService.search('%', outsider.id)).toEqual([]);
      const pctOwner = await pageService.search('%', owner.id);
      expect(pctOwner.map((p) => p.id)).not.toContain(sharedPage.id);
    });
  });

  describe('templates', () => {
    test('a page created from a template lands in the requested workspace', async () => {
      const page = await templateService.use('blank', editor.id, { workspaceId: shared.id });
      expect(page.workspaceId).toBe(shared.id);
    });

    test('defaults to the caller’s own workspace when none is given', async () => {
      const page = await templateService.use('blank', owner.id);
      expect(page.workspaceId).toBe(ownerDefault.id);
    });

    test('refuses a workspace the caller cannot write to', async () => {
      await expect(templateService.use('blank', outsider.id, { workspaceId: shared.id })).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });
});
