// Socket.io events are client-controlled input. socket.io invokes listeners from
// process.nextTick, so a synchronous throw inside one — e.g. destructuring a
// `null` payload — surfaces as an uncaughtException, and src/server.js answers
// that with process.exit(1). One malformed message from ANY logged-in user used
// to restart the whole (single-instance) API. These tests run a REAL socket.io
// server and clients, because only that reproduces the crash path.
const http = require('http');
const { io: connect } = require('socket.io-client');
const { initSocket, getIO } = require('../src/sockets/socket.handler');
const { signAccessToken } = require('../src/utils/jwt.util');
const pageService = require('../src/services/page.service');
const prisma = require('../src/config/prisma');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('socket hardening (real server)', () => {
  let server;
  let port;
  let owner;
  let member;
  let workspace;
  let page1;
  let page2;
  const clients = [];
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);

  const connectAs = (user) =>
    new Promise((resolve, reject) => {
      const client = connect(`http://localhost:${port}`, {
        auth: { token: signAccessToken(user.id) },
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(client);
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });

  // Collects every payload of `event` the client receives from now on.
  const collect = (client, event) => {
    const seen = [];
    client.on(event, (payload) => seen.push(payload));
    return seen;
  };

  beforeAll(async () => {
    owner = await makeUser('sockHardOwner');
    member = await makeUser('sockHardMember');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [member] });
    page1 = await pageService.create({ title: 'One', workspaceId: workspace.id }, owner.id);
    page2 = await pageService.create({ title: 'Two', workspaceId: workspace.id }, owner.id);

    server = http.createServer();
    initSocket(server);
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
    process.on('uncaughtException', onUncaught);
  });

  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    clients.forEach((c) => c.disconnect());
    getIO()?.close();
    await new Promise((resolve) => server.close(resolve));
    await cleanupUsers(owner, member);
    await prisma.$disconnect();
  });

  afterEach(() => {
    // Each test starts from fresh connections.
    while (clients.length) clients.pop().disconnect();
  });

  test('malformed payloads on every event neither crash the process nor stop the server working', async () => {
    const attacker = await connectAs(member);
    const bad = [null, undefined, 'x', 42, true, [], [1, 2], { pageId: { $ne: null } }, { pageId: 12345 }, { x: 'a', y: null }];
    for (const event of ['page:join', 'page:leave', 'cursor:move']) {
      for (const payload of bad) attacker.emit(event, payload);
    }
    await sleep(250);
    expect(uncaught.map((e) => e.message)).toEqual([]);

    // …and the server still does its job afterwards: a valid join is announced to a peer.
    const watcher = await connectAs(owner);
    watcher.emit('page:join', { pageId: page1.id, name: 'Owner' });
    await sleep(150);
    const joins = collect(watcher, 'presence:join');
    attacker.emit('page:join', { pageId: page1.id, name: 'Member' });
    await sleep(250);
    expect(joins).toHaveLength(1);
    expect(joins[0].user.id).toBe(member.id);
  });

  test('page:leave for a room the socket never joined emits nothing to that room', async () => {
    const insider = await connectAs(owner);
    insider.emit('page:join', { pageId: page1.id, name: 'Owner' });
    await sleep(150);
    const leaves = collect(insider, 'presence:leave');

    // The member is connected but has NOT joined page1; naming the room must not broadcast a fake "left".
    const outsider = await connectAs(member);
    outsider.emit('page:leave', { pageId: page1.id });
    await sleep(250);
    expect(leaves).toEqual([]);
  });

  test('cursor:move is throttled per socket', async () => {
    const a = await connectAs(owner);
    const b = await connectAs(member);
    a.emit('page:join', { pageId: page1.id, name: 'A' });
    b.emit('page:join', { pageId: page1.id, name: 'B' });
    await sleep(250);
    const cursors = collect(a, 'cursor:move');

    for (let i = 0; i < 80; i += 1) b.emit('cursor:move', { x: 0.5, y: 0.5 });
    await sleep(400);

    expect(cursors.length).toBeGreaterThanOrEqual(1); // legitimate movement still gets through
    expect(cursors.length).toBeLessThan(10); // a flood does not
  });

  test('after leaving a page, a socket can no longer send cursor events into it', async () => {
    const watcher = await connectAs(owner);
    watcher.emit('page:join', { pageId: page1.id, name: 'Owner' });
    const roamer = await connectAs(member);
    roamer.emit('page:join', { pageId: page1.id, name: 'Member' });
    await sleep(250);
    const cursors = collect(watcher, 'cursor:move');

    roamer.emit('page:leave', { pageId: page1.id });
    await sleep(100);
    // socket.to(room).emit() reaches a room whether or not the sender is still in it.
    roamer.emit('cursor:move', { x: 0.1, y: 0.2 });
    await sleep(250);
    expect(cursors).toEqual([]);
  });

  test('non-finite or non-numeric cursor coordinates are dropped', async () => {
    const watcher = await connectAs(owner);
    watcher.emit('page:join', { pageId: page1.id, name: 'Owner' });
    const mover = await connectAs(member);
    mover.emit('page:join', { pageId: page1.id, name: 'Member' });
    await sleep(250);
    const cursors = collect(watcher, 'cursor:move');

    for (const bad of [{ x: 'a', y: 1 }, { x: null, y: 1 }, { x: 1 }, { x: {}, y: [] }, { x: Infinity, y: 0 }]) {
      mover.emit('cursor:move', bad);
      await sleep(40);
    }
    await sleep(150);
    expect(cursors).toEqual([]);
  });

  test('the presence name is capped and must be a string', async () => {
    const watcher = await connectAs(owner);
    watcher.emit('page:join', { pageId: page1.id, name: 'Owner' });
    await sleep(150);
    const joins = collect(watcher, 'presence:join');

    const long = await connectAs(member);
    long.emit('page:join', { pageId: page1.id, name: 'x'.repeat(500) });
    await sleep(250);
    expect(joins[0].user.name).toHaveLength(80);

    const odd = await connectAs(member);
    odd.emit('page:join', { pageId: page1.id, name: { toString: 'nope' } });
    await sleep(250);
    expect(joins[1].user.name).toBe('Someone');
  });

  test('joining a second page leaves the first, so presence and rooms do not pile up', async () => {
    const watcher = await connectAs(owner);
    watcher.emit('page:join', { pageId: page1.id, name: 'Owner' });
    await sleep(150);
    const leaves = collect(watcher, 'presence:leave');

    const roamer = await connectAs(member);
    roamer.emit('page:join', { pageId: page1.id, name: 'Member' });
    await sleep(200);
    roamer.emit('page:join', { pageId: page2.id, name: 'Member' });
    await sleep(250);

    expect(leaves).toHaveLength(1);
    expect(leaves[0].socketId).toBe(roamer.id);
  });
});
