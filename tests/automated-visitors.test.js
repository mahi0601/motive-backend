// Link previews (Slack, WhatsApp, iMessage), search crawlers and scripts open a status link
// without a person behind it. They must not count as a client looking, or the "views" number
// and the "your client opened the page" message would be wrong from day one. Anything that
// looks like a real browser, or that we cannot tell, still counts: under-counting a client is
// worse than counting a stray script.
const { isAutomated } = require('../src/utils/automatedVisitors');

describe('isAutomated', () => {
  test.each([
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['Slack-ImgProxy'],
    ['WhatsApp/2.23.20.0 A'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['Twitterbot/1.0'],
    ['LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)'],
    ['TelegramBot (like TwitterBot)'],
    ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
    ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)'],
    ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['curl/8.4.0'],
    ['Wget/1.21.3'],
    ['python-requests/2.31.0'],
    ['Go-http-client/2.0'],
    ['PostmanRuntime/7.36.0'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0.0.0 Safari/537.36'],
    ['Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)'],
    ['Better Uptime Bot'],
    ['Embedly/0.2'],
    ['Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)'],
  ])('%s is automated', (ua) => {
    expect(isAutomated(ua)).toBe(true);
  });

  test.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'],
    ['Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'],
    // Our own test tooling, and a missing header: not recognisable as a bot, so they count.
    ['node-superagent/8.1.2'],
    ['TestBrowser'],
    [''],
    [undefined],
    [null],
  ])('%j is treated as a person', (ua) => {
    expect(isAutomated(ua)).toBe(false);
  });

  test('matching ignores case, and a very long header is handled quickly', () => {
    expect(isAutomated('SLACKBOT')).toBe(true);
    const t = Date.now();
    expect(isAutomated('x'.repeat(100000))).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
