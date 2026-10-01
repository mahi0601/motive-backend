// Built-in template catalog: every entry must be usable as-is — a unique key,
// only block types the schema knows about, and content shaped the way the
// editor and template.service.js#use expect.
const builtins = require('../src/data/builtinTemplates');
const templateService = require('../src/services/template.service');
const prisma = require('../src/config/prisma');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

// Mirrors the BlockType enum in schema.prisma.
const BLOCK_TYPES = [
  'paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered',
  'todo', 'toggle', 'quote', 'code', 'divider', 'image', 'callout', 'table', 'embed',
];

describe('built-in templates', () => {
  test('keys are unique and every template has the fields the gallery needs', () => {
    const keys = builtins.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of builtins) {
      expect(t.name).toBeTruthy();
      expect(t.icon).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.blocks.length).toBeGreaterThan(0);
    }
  });

  test('every block uses a real BlockType with object content', () => {
    for (const t of builtins) {
      for (const b of t.blocks) {
        expect(BLOCK_TYPES).toContain(b.type);
        expect(b.content).toEqual(expect.any(Object));
      }
    }
  });

  test('the Agency category has the four client-work templates', () => {
    const agency = builtins.filter((t) => t.category === 'Agency').map((t) => t.key).sort();
    expect(agency).toEqual(['client-onboarding', 'retainer-tracker', 'website-project', 'weekly-client-update']);
  });

  describe('using an Agency template', () => {
    let user;
    beforeAll(async () => {
      user = await makeUser('agency-template');
    });
    afterAll(async () => {
      await cleanupUsers(user);
      await prisma.$disconnect();
    });

    test.each(['client-onboarding', 'website-project', 'weekly-client-update', 'retainer-tracker'])(
      '%s creates a page with all of its blocks',
      async (key) => {
        const tpl = builtins.find((t) => t.key === key);
        const page = await templateService.use(key, user.id);
        expect(page.title).toBe(tpl.name);
        expect(await prisma.block.count({ where: { pageId: page.id } })).toBe(tpl.blocks.length);
      }
    );

    test('they show up in the gallery listing under "Agency"', async () => {
      const { builtIn } = await templateService.list(user.id);
      expect(builtIn.filter((t) => t.category === 'Agency')).toHaveLength(4);
    });
  });
});
