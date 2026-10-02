// The invite email's header carries the Clientglass logo: a hosted PNG on the
// frontend's own origin (absolute URL — mail clients can't resolve a relative
// one, and don't render SVG), with alt text so "Clientglass" still shows when a
// client blocks images. The other thing pinned here is that user-supplied names
// stay escaped now that the template has changed.
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const emailService = require('../src/services/email.service');
const workspaceService = require('../src/services/workspace.service');
const { makeUser, makeWorkspaceWithMembers, testEmail, cleanupUsers } = require('./helpers/fixtures');

describe('invite email header', () => {
  let owner;
  let workspace;
  let sendEmail;

  beforeAll(async () => {
    // Pro, so the free-seat limit (which counts pending invites) does not get in the way of an email-content test.
    owner = await makeUser('inviteEmailOwner', { isPro: true });
    workspace = await makeWorkspaceWithMembers(owner);
  });

  beforeEach(() => {
    sendEmail = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanupUsers(owner);
    await prisma.$disconnect();
  });

  const inviteAndGetHtml = async () => {
    await workspaceService.createInvite(workspace.id, owner.id, testEmail('invitee'), 'editor');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    return sendEmail.mock.calls[0][0].html;
  };

  test('shows the logo image from the frontend origin, at half its 2× size, with "Clientglass" as alt text', async () => {
    const html = await inviteAndGetHtml();
    expect(html).toContain(`src="${config.frontendUrl}/brand/logo-email.png"`);
    expect(html).toContain('alt="Clientglass"');
    expect(html).toContain('width="173"');
    expect(html).toContain('height="40"');
    // The alt text is styled white and bold so the fallback looks like the old text header.
    expect(html).toMatch(/<img[^>]*color:#FFFFFF[^>]*font-weight:700/);
  });

  test('the header keeps a solid petrol background for clients that ignore gradients', async () => {
    const html = await inviteAndGetHtml();
    expect(html).toContain('background-color:#0E4C5C');
    expect(html).toContain('linear-gradient(135deg,#0E4C5C,#1B7A8C)');
  });

  test('the old text-only "Clientglass" header span is gone', async () => {
    const html = await inviteAndGetHtml();
    expect(html).not.toContain('<span style="color:#FFFFFF;font-size:18px;font-weight:700;">Clientglass</span>');
  });

  test('workspace and inviter names are still HTML-escaped after the template change', async () => {
    const evil = await prisma.workspace.update({ where: { id: workspace.id }, data: { name: '<b onmouseover=x>Acme</b>' } });
    expect(evil.name).toContain('<b');
    const html = await inviteAndGetHtml();
    expect(html).not.toContain('<b onmouseover=x>');
    expect(html).toContain('&lt;b onmouseover=x&gt;Acme&lt;/b&gt;');
  });
});
