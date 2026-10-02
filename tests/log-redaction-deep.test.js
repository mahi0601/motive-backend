// Redaction used to cover only the top level and one level down. Real log lines
// nest deeper (a request wrapped in a context object wrapped in an error), so the
// sensitive field names are redacted two levels below the root as well.
const pino = require('pino');
const { pinoOptions } = require('../src/config/logger');

const capture = (obj) => {
  const lines = [];
  pino({ ...pinoOptions, level: 'info' }, { write: (c) => lines.push(String(c)) }).info(obj, 'deep');
  return lines.join('');
};

const FIELDS = ['password', 'token', 'accessToken', 'refreshToken', 'csrfToken', 'email', 'authorization', 'cookie', 'secret', 'apiKey'];

describe('deep log redaction', () => {
  test.each(FIELDS)('"%s" is redacted at the top, one level down and two levels down', (field) => {
    const out = capture({ [field]: 'LEAK-TOP', a: { [field]: 'LEAK-ONE' }, b: { c: { [field]: 'LEAK-TWO' } } });
    expect(out).not.toMatch(/LEAK-(TOP|ONE|TWO)/);
    expect(out).toContain('[redacted]');
  });

  test('harmless fields at the same depth are kept, so logs stay useful', () => {
    const out = capture({ b: { c: { statusCode: 500, route: '/api/tasks' } } });
    expect(out).toContain('/api/tasks');
    expect(out).toContain('500');
  });
});
