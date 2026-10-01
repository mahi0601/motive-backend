// A socket authenticates once, at connect. Without explicit revocation, a user
// who is logged out everywhere, removed from a workspace, downgraded, or whose
// account is deleted would keep receiving live page content (and presence) over
// the already-open connection until it happened to drop.
const http = require('http');
const { io: connect } = require('socket.io-client');
const { initSocket, getIO } = require('../src/sockets/socket.handler');
const pageService = require('../src/services/page.service');
const workspaceService = require('../src/services/workspace.service');
const authService = require('../src/services/auth.service');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('socket revocation (real server)', () => {
  let server, port, owner, member, workspace, page;
  const clients = [];

  const connectAs = async (user) => {
    const token = await accessTokenFor(user);
    return new Promise((resolve, reject) => {
      const c = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(c);
      c.once('connect', () => resolve(c));
      c.once('connect_error', reject);
    });
  };

  beforeEach(async () => {
    owner = await makeUser('revOwner');
    member = await makeUser('revMember');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [member] });
    page = await pageService.create({ title: 'P', workspaceId: workspace.id }, owner.id);
  });
  afterEach(async () => {
    while (clients.length) clients.pop().disconnect();
    await cleanupUsers(owner, member);
  });
  beforeAll(async () => {
    server = http.createServer();
    initSocket(server);
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });
  afterAll(async () => {
    getIO()?.close();
    await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  });

  // Joins the member to the page and returns what that member's socket hears afterwards.
  async function joinedMember() {
    const socket = await connectAs(member);
    socket.emit('page:join', { pageId: page.id, name: 'M' });
    await sleep(200);
    const heard = [];
    socket.on('block:created', (b) => heard.push(b));
    const revoked = [];
    socket.on('access:revoked', (p) => revoked.push(p));
    return { socket, heard, revoked };
  }
  const ownerEdits = async () => {
    // Broadcasts block:created to the page room the same way the REST path does.
    getIO().to(`page:${page.id}`).emit('block:created', { id: 'b1' });
    await sleep(200);
  };

  test('control: a joined member receives page broadcasts', async () => {
    const { heard } = await joinedMember();
    await ownerEdits();
    expect(heard).toHaveLength(1);
  });

  test('removing a member stops live page events on their open socket', async () => {
    const { socket, heard, revoked } = await joinedMember();
    await workspaceService.removeMember(workspace.id, member.id, owner.id);
    await sleep(300);
    await ownerEdits();
    expect(heard).toEqual([]);
    expect(revoked).toHaveLength(1);
    expect(socket.connected).toBe(true); // only the lost page is dropped, not the whole connection
  });

  test('leaving a workspace does the same', async () => {
    const { heard } = await joinedMember();
    await workspaceService.leaveWorkspace(workspace.id, member.id);
    await sleep(300);
    await ownerEdits();
    expect(heard).toEqual([]);
  });

  test('a member who keeps access keeps receiving events after an unrelated role change', async () => {
    const { heard } = await joinedMember();
    await workspaceService.updateMemberRole(workspace.id, member.id, 'viewer', owner.id);
    await sleep(300);
    await ownerEdits();
    expect(heard).toHaveLength(1); // viewers can still read
  });

  test('logout-everywhere disconnects every socket of that user', async () => {
    const { socket } = await joinedMember();
    const second = await connectAs(member);
    await authService.revokeAll(member.id);
    await sleep(300);
    expect(socket.connected).toBe(false);
    expect(second.connected).toBe(false);
  });
});
