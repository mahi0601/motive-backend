// Regression tests for the Socket.io authorization fix — page rooms used to
// have zero access control: an invalid/missing token still joined `page:join`
// (the catch only logged, it didn't stop the join), and there was no
// membership check at all, so anyone holding a pageId received that page's
// live block:created/updated/reordered events. This exercises the exact two
// functions the fix lives in (`handshakeAuth`, `handlePageJoin`) against a
// stub socket — no live socket.io server/client pair needed, since neither
// function touches anything socket.io-specific beyond `data`/`join`/`to`.
//
// Same real-dev-database convention as permissions.test.js: fresh fixtures,
// torn down in afterAll.
const { handshakeAuth, handlePageJoin } = require('../src/sockets/socket.handler');
const { signAccessToken, signRefreshToken } = require('../src/utils/jwt.util');
const pageService = require('../src/services/page.service');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

// Minimal stand-in for a socket.io Socket — just enough surface for
// handshakeAuth/handlePageJoin to run against.
function makeFakeSocket(authToken) {
  const joined = [];
  const emitted = [];
  return {
    id: 'fake-socket-id',
    handshake: { auth: { token: authToken } },
    data: {},
    join: (room) => joined.push(room),
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
    _joined: joined,
    _emitted: emitted,
  };
}

describe('socket auth', () => {
  let owner, outsider;
  let workspace, page;

  beforeAll(async () => {
    owner = await makeUser('socketOwner');
    outsider = await makeUser('socketOutsider'); // not a member of `workspace`
    workspace = await makeWorkspaceWithMembers(owner, {});
    page = await pageService.create({ title: 'Private page', workspaceId: workspace.id }, owner.id);
  });

  afterAll(async () => {
    await cleanupUsers(owner, outsider);
  });

  describe('handshakeAuth', () => {
    it('rejects a connection with no token', (done) => {
      const socket = makeFakeSocket(undefined);
      handshakeAuth(socket, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(socket.data.userId).toBeUndefined();
        done();
      });
    });

    it('rejects a connection with a malformed token', (done) => {
      const socket = makeFakeSocket('not-a-real-token');
      handshakeAuth(socket, (err) => {
        expect(err).toBeInstanceOf(Error);
        done();
      });
    });

    it('rejects a refresh token presented as the handshake token', (done) => {
      const socket = makeFakeSocket(signRefreshToken(owner.id, 0, 'sid', 0));
      handshakeAuth(socket, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(socket.data.userId).toBeUndefined();
        done();
      });
    });

    it('accepts a valid access token and sets socket.data.userId', async () => {
      const socket = makeFakeSocket(await accessTokenFor(owner));
      await new Promise((resolve) =>
        handshakeAuth(socket, (err) => {
          expect(err).toBeUndefined();
          expect(socket.data.userId).toBe(owner.id);
          resolve();
        })
      );
    });

    it('rejects a validly signed access token whose session was revoked', async () => {
      const { accessToken, refreshToken } = await require('../src/services/token.service').issueTokens(owner);
      await require('../src/services/auth.service').logout(refreshToken);
      const socket = makeFakeSocket(accessToken);
      await new Promise((resolve) =>
        handshakeAuth(socket, (err) => {
          expect(err).toBeInstanceOf(Error);
          expect(socket.data.userId).toBeUndefined();
          resolve();
        })
      );
    });

    it('rejects an old-style access token with no session id', (done) => {
      const socket = makeFakeSocket(signAccessToken(owner.id));
      handshakeAuth(socket, (err) => {
        expect(err).toBeInstanceOf(Error);
        done();
      });
    });
  });

  describe('handlePageJoin', () => {
    it('does not join the room, and emits nothing, for a user with no access to the page', async () => {
      const socket = makeFakeSocket(signAccessToken(outsider.id));
      socket.data.userId = outsider.id; // as handshakeAuth would have set it

      await handlePageJoin(socket, { pageId: page.id, name: 'Outsider' });

      expect(socket._joined).toEqual([]);
      expect(socket._emitted).toEqual([]);
      expect(socket.data.pageId).toBeUndefined();
    });

    it('joins the room and announces presence for a user who can access the page', async () => {
      const socket = makeFakeSocket(signAccessToken(owner.id));
      socket.data.userId = owner.id;

      await handlePageJoin(socket, { pageId: page.id, name: 'Owner' });

      expect(socket._joined).toEqual([`page:${page.id}`]);
      expect(socket.data.pageId).toBe(page.id);
      expect(socket._emitted).toEqual([
        {
          room: `page:${page.id}`,
          event: 'presence:join',
          payload: { socketId: socket.id, user: { id: owner.id, name: 'Owner' } },
        },
      ]);
    });

    it('is a no-op with no pageId', async () => {
      const socket = makeFakeSocket(signAccessToken(owner.id));
      socket.data.userId = owner.id;

      await handlePageJoin(socket, {});

      expect(socket._joined).toEqual([]);
    });
  });
});
