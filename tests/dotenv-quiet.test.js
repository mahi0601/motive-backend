// dotenv 17 and later print "injected env (N) from .env" to stdout every time
// they load. It is only a count, never a value, but it ends up in every
// production log and in the output of one-off scripts. The app loads dotenv in
// three places; each must load it quietly. These tests run the real entry
// points in a child process, so they hold for whichever dotenv version is
// installed.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
// Everything the process printed, from either stream (dotenv's notice goes to
// whichever the installed version chooses).
const run = (code) => {
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, SENTRY_DSN: '' }, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
};

describe('loading configuration is quiet', () => {
  test('src/instrument.js (loaded first by index.js) prints nothing', () => {
    expect(run("require('./src/instrument')")).toBe('');
  });

  test('src/config/env.js prints nothing', () => {
    expect(run("require('./src/config/env')")).toBe('');
  });

  test('every place the app calls dotenv passes quiet: true', () => {
    const fs = require('fs');
    for (const file of ['src/instrument.js', 'src/config/env.js', 'scripts/funnel.js']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toMatch(/dotenv'\)\.config\(\{ quiet: true \}\)/);
    }
  });
});
