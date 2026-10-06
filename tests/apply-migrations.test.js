const { directUrl } = require('../src/utils/applyMigrations');

describe('applyMigrations', () => {
  test('uses the direct host: every "-pooler" and the pgbouncer parameter are removed', () => {
    expect(directUrl('postgresql://u:p@ep-a-pooler.eu.neon.tech/db?sslmode=require&pgbouncer=true')).toBe(
      'postgresql://u:p@ep-a.eu.neon.tech/db?sslmode=require'
    );
    expect(directUrl('postgresql://u:p@ep-a-pooler.neon.tech/db?pgbouncer=true')).toBe('postgresql://u:p@ep-a.neon.tech/db');
  });
  test('is a no-op outside production', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    expect(() => require('../src/utils/applyMigrations')()).not.toThrow();
    process.env.NODE_ENV = before;
  });
});
