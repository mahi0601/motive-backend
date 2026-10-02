// Invite lifecycle — the fix for inviteMember requiring the invitee to
// already have an account (see workspace.service.js's own note on why
// createInvite replaced it). The two things that actually matter here are
// security properties, not happy-path plumbing: an invite can only be
// accepted by the email it was sent to, and only the owner can manage
// members — a miss on either is a workspace-isolation bug, same severity
// class as permissions.test.js's matrix.
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const { makeUser, makeWorkspaceWithMembers, testEmail, cleanupUsers } = require('./helpers/fixtures');

// createInvite deliberately never returns the raw token (only the invite
// email ever carries it — see workspace.service.js). Tests that need to
// actually accept/decline/inspect-by-token build a pending invite row
// directly, minting a token the same way the service does, rather than
// reaching into its internals.
const crypto = require('crypto');
function mintToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, tokenHash };
}

describe('workspace invite lifecycle', () => {
  let owner, editor, outsider;
  let workspace;

  beforeAll(async () => {
    // isPro: true so the free-tier member cap (a real, separate business
    // rule — see workspace.service.js's own plan member limit) doesn't
    // interfere with what these tests are actually about: invite
    // authorization and the accept-by-email-match logic. The fixture
    // workspace already sits at exactly the free limit (owner + editor = 2)
    // before any test-specific invite is even created.
    owner = await makeUser('inviteOwner', { isPro: true });
    editor = await makeUser('inviteEditor');
    outsider = await makeUser('inviteOutsider');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [editor] });
  });

  afterAll(async () => {
    await cleanupUsers(owner, editor, outsider);
    await prisma.$disconnect();
  });

  describe('createInvite — owner-only', () => {
    test('the owner can invite an email with no existing account', async () => {
      const email = testEmail('brandNew');
      const invite = await workspaceService.createInvite(workspace.id, owner.id, email, 'editor');
      expect(invite.email).toBe(email.toLowerCase()); // createInvite normalizes case
      expect(invite.status).toBe('pending');
      expect(invite.tokenHash).toBeUndefined(); // never leaves the service
    });

    test('an editor (non-owner) cannot invite', async () => {
      await expect(
        workspaceService.createInvite(workspace.id, editor.id, testEmail('blocked'), 'editor')
      ).rejects.toThrow();
    });

    test('an outsider cannot invite', async () => {
      await expect(
        workspaceService.createInvite(workspace.id, outsider.id, testEmail('blocked2'), 'editor')
      ).rejects.toThrow();
    });

    test('re-inviting the same email recycles the row instead of creating a second one', async () => {
      const email = testEmail('reinvite');
      await workspaceService.createInvite(workspace.id, owner.id, email, 'editor');
      await workspaceService.createInvite(workspace.id, owner.id, email, 'viewer');
      const rows = await prisma.workspaceInvite.findMany({ where: { workspaceId: workspace.id, email } });
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('viewer'); // the second call's role won
    });
  });

  describe('listInvites / resendInvite / revokeInvite — owner-only', () => {
    let inviteEmail, inviteId;

    beforeAll(async () => {
      inviteEmail = testEmail('manage');
      const invite = await workspaceService.createInvite(workspace.id, owner.id, inviteEmail, 'editor');
      inviteId = invite.id;
    });

    test('a non-owner cannot list pending invites', async () => {
      await expect(workspaceService.listInvites(workspace.id, editor.id)).rejects.toThrow();
    });

    test('the owner sees the pending invite, without its token hash', async () => {
      const invites = await workspaceService.listInvites(workspace.id, owner.id);
      const found = invites.find((i) => i.id === inviteId);
      expect(found).toBeTruthy();
      expect(found.tokenHash).toBeUndefined();
    });

    test('a non-owner cannot resend or revoke', async () => {
      await expect(workspaceService.resendInvite(workspace.id, inviteId, editor.id)).rejects.toThrow();
      await expect(workspaceService.revokeInvite(workspace.id, inviteId, editor.id)).rejects.toThrow();
    });

    test('the owner can revoke; the invite is then rejected on accept', async () => {
      await workspaceService.revokeInvite(workspace.id, inviteId, owner.id);
      const row = await prisma.workspaceInvite.findUnique({ where: { id: inviteId } });
      expect(row.status).toBe('revoked');
    });
  });

  describe('acceptInvite — the email-match check is the one that matters', () => {
    async function makePendingInvite(email, role = 'editor') {
      const { raw, tokenHash } = mintToken();
      const invite = await prisma.workspaceInvite.create({
        data: {
          workspaceId: workspace.id,
          email: email.toLowerCase(),
          role,
          tokenHash,
          status: 'pending',
          invitedById: owner.id,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });
      return { raw, invite };
    }

    test('acceptInvite succeeds when the caller\'s email matches the invite, and notifies the inviter', async () => {
      const invitee = await makeUser('acceptMatch');
      const email = invitee.email;
      const { raw } = await makePendingInvite(email);
      const { workspace: ws, notification } = await workspaceService.acceptInvite(raw, invitee.id, email);
      expect(ws.id).toBe(workspace.id);
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
      });
      expect(member).toBeTruthy();
      expect(member.role).toBe('editor');

      // The owner gets told a real person joined — closes the loop that used
      // to leave this silent (see workspace.service.js#acceptInvite).
      expect(notification).toBeTruthy();
      expect(notification.userId).toBe(owner.id);
      expect(notification.type).toBe('invite_accepted');
      const stored = await prisma.notification.findUnique({ where: { id: notification.id } });
      expect(stored).toBeTruthy();

      await cleanupUsers(invitee);
    });

    test('acceptInvite is refused when the caller is logged in as a different email', async () => {
      const { raw } = await makePendingInvite(testEmail('sentTo'));
      await expect(
        workspaceService.acceptInvite(raw, outsider.id, outsider.email)
      ).rejects.toThrow();
      // and it must NOT have created a membership as a side effect
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: outsider.id } },
      });
      expect(member).toBeNull();
    });

    test('acceptInvite is refused on an expired invite', async () => {
      const { raw, tokenHash } = mintToken();
      const invitee = await makeUser('acceptExpired');
      await prisma.workspaceInvite.create({
        data: {
          workspaceId: workspace.id, email: invitee.email, role: 'editor', tokenHash,
          status: 'pending', invitedById: owner.id, expiresAt: new Date(Date.now() - 1000),
        },
      });
      await expect(workspaceService.acceptInvite(raw, invitee.id, invitee.email)).rejects.toThrow();
      await cleanupUsers(invitee);
    });

    test('acceptInvite is refused on an already-accepted invite', async () => {
      const invitee = await makeUser('acceptTwice');
      const { raw } = await makePendingInvite(invitee.email);
      await workspaceService.acceptInvite(raw, invitee.id, invitee.email);
      await expect(workspaceService.acceptInvite(raw, invitee.id, invitee.email)).rejects.toThrow();
      await cleanupUsers(invitee);
    });

    test('acceptInvite is refused on a revoked invite', async () => {
      const invitee = await makeUser('acceptRevoked');
      const { raw, invite } = await makePendingInvite(invitee.email);
      await workspaceService.revokeInvite(workspace.id, invite.id, owner.id);
      await expect(workspaceService.acceptInvite(raw, invitee.id, invitee.email)).rejects.toThrow();
      await cleanupUsers(invitee);
    });

    test('getInviteByToken never exposes the token hash or the workspace id', async () => {
      const { raw } = await makePendingInvite(testEmail('metadata'));
      const meta = await workspaceService.getInviteByToken(raw);
      expect(meta.tokenHash).toBeUndefined();
      expect(meta.workspaceId).toBeUndefined();
      expect(meta.workspaceName).toBe(workspace.name);
    });
  });

  describe('updateMemberRole / removeMember — owner-only, owner is untouchable', () => {
    test('a non-owner cannot change roles or remove members', async () => {
      await expect(workspaceService.updateMemberRole(workspace.id, editor.id, 'viewer', editor.id)).rejects.toThrow();
      await expect(workspaceService.removeMember(workspace.id, editor.id, outsider.id)).rejects.toThrow();
    });

    test('the owner can change a member\'s role', async () => {
      const updated = await workspaceService.updateMemberRole(workspace.id, editor.id, 'viewer', owner.id);
      expect(updated.role).toBe('viewer');
      await workspaceService.updateMemberRole(workspace.id, editor.id, 'editor', owner.id); // restore for other tests
    });

    test('the owner cannot be demoted or removed via these endpoints', async () => {
      await expect(workspaceService.updateMemberRole(workspace.id, owner.id, 'viewer', owner.id)).rejects.toThrow();
      await expect(workspaceService.removeMember(workspace.id, owner.id, owner.id)).rejects.toThrow();
    });

    test('the owner can remove a member', async () => {
      const toRemove = await makeUser('removable');
      await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: toRemove.id, role: 'viewer' } });
      await workspaceService.removeMember(workspace.id, toRemove.id, owner.id);
      const gone = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: toRemove.id } },
      });
      expect(gone).toBeNull();
      await cleanupUsers(toRemove);
    });
  });

  describe('transferOwnership — Workspace.ownerId and both member roles move together', () => {
    test('a non-owner cannot transfer ownership', async () => {
      await expect(workspaceService.transferOwnership(workspace.id, editor.id, editor.id)).rejects.toThrow();
    });

    test('the owner can transfer to an existing member; both roles flip, getRole agrees', async () => {
      const transferOwner = await makeUser('transferOwner');
      const transferTarget = await makeUser('transferTarget');
      const ws = await makeWorkspaceWithMembers(transferOwner, { editors: [transferTarget] });

      await workspaceService.transferOwnership(ws.id, transferTarget.id, transferOwner.id);

      const updatedWs = await prisma.workspace.findUnique({ where: { id: ws.id } });
      expect(updatedWs.ownerId).toBe(transferTarget.id);

      const oldOwnerMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: transferOwner.id } },
      });
      const newOwnerMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: transferTarget.id } },
      });
      expect(oldOwnerMember.role).toBe('editor');
      expect(newOwnerMember.role).toBe('owner');

      // getRole derives 'owner' from Workspace.ownerId directly (see its own
      // comment) — this is exactly the desync this transaction guards against.
      expect(await workspaceService.getRole(ws.id, transferTarget.id)).toBe('owner');
      expect(await workspaceService.getRole(ws.id, transferOwner.id)).toBe('editor');

      await cleanupUsers(transferOwner, transferTarget);
    });

    test('cannot transfer ownership to someone who is not a member', async () => {
      const transferOwner = await makeUser('transferOwnerB');
      const ws = await makeWorkspaceWithMembers(transferOwner);
      const stranger = await makeUser('transferStranger');
      await expect(workspaceService.transferOwnership(ws.id, stranger.id, transferOwner.id)).rejects.toThrow();
      await cleanupUsers(transferOwner, stranger);
    });
  });

  describe('leaveWorkspace — self-service, owner cannot leave', () => {
    test('the owner cannot leave their own workspace', async () => {
      await expect(workspaceService.leaveWorkspace(workspace.id, owner.id)).rejects.toThrow();
    });

    test('a non-owner member can leave without affecting anyone else', async () => {
      const leaver = await makeUser('leaver');
      await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: leaver.id, role: 'viewer' } });

      await workspaceService.leaveWorkspace(workspace.id, leaver.id);

      const gone = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: leaver.id } },
      });
      expect(gone).toBeNull();
      expect(await workspaceService.getRole(workspace.id, owner.id)).toBe('owner');
      expect(await workspaceService.getRole(workspace.id, editor.id)).toBe('editor');

      await cleanupUsers(leaver);
    });

    test('a non-member cannot "leave" a workspace they never joined', async () => {
      await expect(workspaceService.leaveWorkspace(workspace.id, outsider.id)).rejects.toThrow();
    });
  });
});
