import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const TEST_PORT = 1235;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}`;

let serverProcess;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(userName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        Cookie: `wsname=${encodeURIComponent(userName)}`
      }
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timeout ouverture WebSocket'));
    }, 5000);

    ws.once('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForJson(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timeout attente message serveur'));
    }, timeoutMs);

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (!predicate(parsed)) {
        return;
      }

      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    }

    ws.on('message', onMessage);
  });
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function consumeHandshakeMessages(ws) {
  sendJson(ws, { type: 'room:list' });
  sendJson(ws, { type: 'drawing:saved:list' });

  return new Promise((resolve, reject) => {
    let hasRoomsList = false;
    let hasSavedList = false;

    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timeout handshake initial serveur'));
    }, 5000);

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (parsed.type === 'rooms:list') {
        hasRoomsList = true;
      }

      if (parsed.type === 'drawing:saved:list') {
        hasSavedList = true;
      }

      if (hasRoomsList && hasSavedList) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    }

    ws.on('message', onMessage);
  });
}

before(async () => {
  serverProcess = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      WS_PORT: String(TEST_PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stderr.on('data', () => {
    // Consomme stderr pour éviter le blocage du buffer.
  });

  const [chunk] = await once(serverProcess.stdout, 'data');
  const output = String(chunk);
  assert.match(output, /Listening on/);
});

after(async () => {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  serverProcess.kill('SIGINT');
  await Promise.race([
    once(serverProcess, 'exit'),
    wait(2000)
  ]);
});

test('feat1 - creer un canvas puis le voir dans la liste', async () => {
  const alice = await createClient('alice');
  const bob = await createClient('bob');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);

    const roomName = `feat1-room-${Date.now()}`;

    const aliceRoomListPromise = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    const bobRoomListPromise = waitForJson(
      bob,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );

    sendJson(alice, { type: 'room:create', name: roomName });

    const aliceRooms = await aliceRoomListPromise;
    const bobRooms = await bobRoomListPromise;

    const aliceRoom = aliceRooms.rooms.find((room) => room.name === roomName);
    const bobRoom = bobRooms.rooms.find((room) => room.name === roomName);

    assert.ok(aliceRoom, 'La salle doit apparaitre pour alice');
    assert.ok(bobRoom, 'La salle doit apparaitre pour bob');
  } finally {
    alice.close();
    bob.close();
  }
});

test('feat1 - rejoindre un canvas retourne room:joined et drawing:state', async () => {
  const alice = await createClient('alice-join');
  const bob = await createClient('bob-join');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);

    const roomName = `feat1-join-${Date.now()}`;

    const createdList = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );

    sendJson(alice, { type: 'room:create', name: roomName });

    const roomListMsg = await createdList;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle créée doit exister avant le join');

    const joinedPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const statePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );

    sendJson(bob, { type: 'room:join', roomId: room.id });

    const joined = await joinedPromise;
    const state = await statePromise;

    assert.equal(joined.room.name, roomName);
    assert.equal(joined.user.name, 'bob-join');
    assert.ok(/^hsl\(/.test(joined.user.color), 'Couleur utilisateur attendue');

    assert.equal(state.roomId, room.id);
    assert.ok(Array.isArray(state.strokes), 'L etat du dessin doit etre un tableau');
    assert.equal(state.strokes.length, 0);
  } finally {
    alice.close();
    bob.close();
  }
});

test('feat2 - un trait est diffuse en temps reel et rejoue aux nouveaux arrivants', async () => {
  const alice = await createClient('alice-draw');
  const bob = await createClient('bob-draw');
  const charlie = await createClient('charlie-draw');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);
    await consumeHandshakeMessages(charlie);

    const roomName = `feat2-draw-${Date.now()}`;

    const roomCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });

    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle du test draw doit exister');

    const aliceJoinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const aliceStatePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(alice, { type: 'room:join', roomId: room.id });
    const aliceJoined = await aliceJoinedPromise;
    await aliceStatePromise;

    const bobJoinedPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const bobStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(bob, { type: 'room:join', roomId: room.id });
    await bobJoinedPromise;
    await bobStatePromise;

    const strokePayload = {
      type: 'drawing:stroke',
      strokeId: `stroke-${Date.now()}`,
      tool: 'pen',
      size: 5,
      x1: 0.1,
      y1: 0.2,
      x2: 0.3,
      y2: 0.4
    };

    const bobStrokePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:stroke' && msg.roomId === room.id
    );

    sendJson(alice, strokePayload);
    const bobStrokeMessage = await bobStrokePromise;

    assert.equal(bobStrokeMessage.stroke.from, 'alice-draw');
    assert.equal(bobStrokeMessage.stroke.color, aliceJoined.user.color);
    assert.equal(bobStrokeMessage.stroke.tool, 'pen');
    assert.equal(bobStrokeMessage.stroke.size, 5);

    const charlieJoinedPromise = waitForJson(
      charlie,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const charlieStatePromise = waitForJson(
      charlie,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id && msg.strokes.length >= 1
    );

    sendJson(charlie, { type: 'room:join', roomId: room.id });
    await charlieJoinedPromise;
    const charlieState = await charlieStatePromise;

    assert.equal(charlieState.strokes.length, 1);
    assert.equal(charlieState.strokes[0].from, 'alice-draw');
    assert.equal(charlieState.strokes[0].strokeId, strokePayload.strokeId);
  } finally {
    alice.close();
    bob.close();
    charlie.close();
  }
});

test('feat2 - la couleur utilisateur est stable pour un nom donne et differente entre utilisateurs', async () => {
  const aliceA = await createClient('alice-color');
  const bob = await createClient('bob-color');
  const aliceB = await createClient('alice-color');

  try {
    await consumeHandshakeMessages(aliceA);
    await consumeHandshakeMessages(bob);
    await consumeHandshakeMessages(aliceB);

    const roomName = `feat2-color-${Date.now()}`;
    const roomCreated = waitForJson(
      aliceA,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(aliceA, { type: 'room:create', name: roomName });

    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle du test couleur doit exister');

    const aliceAJoinedPromise = waitForJson(
      aliceA,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const aliceAStatePromise = waitForJson(
      aliceA,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(aliceA, { type: 'room:join', roomId: room.id });
    const aliceAJoined = await aliceAJoinedPromise;
    await aliceAStatePromise;

    const bobJoinedPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const bobStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(bob, { type: 'room:join', roomId: room.id });
    const bobJoined = await bobJoinedPromise;
    await bobStatePromise;

    const aliceBJoinedPromise = waitForJson(
      aliceB,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const aliceBStatePromise = waitForJson(
      aliceB,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(aliceB, { type: 'room:join', roomId: room.id });
    const aliceBJoined = await aliceBJoinedPromise;
    await aliceBStatePromise;

    assert.equal(aliceAJoined.user.color, aliceBJoined.user.color);
    assert.notEqual(aliceAJoined.user.color, bobJoined.user.color);
  } finally {
    aliceA.close();
    bob.close();
    aliceB.close();
  }
});

test('feat3 - appliquer un etat historique diffuse drawing:state avec updatedBy', async () => {
  const alice = await createClient('alice-history');
  const bob = await createClient('bob-history');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);

    const roomName = `feat3-history-${Date.now()}`;
    const roomCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });

    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle du test historique doit exister');

    const aliceJoinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const aliceStatePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(alice, { type: 'room:join', roomId: room.id });
    await aliceJoinedPromise;
    await aliceStatePromise;

    const bobJoinedPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const bobStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(bob, { type: 'room:join', roomId: room.id });
    await bobJoinedPromise;
    await bobStatePromise;

    const validStroke = {
      from: 'alice-history',
      color: 'hsl(10, 70%, 50%)',
      tool: 'pen',
      size: 4,
      strokeId: `history-valid-${Date.now()}`,
      x1: 0.1,
      y1: 0.1,
      x2: 0.2,
      y2: 0.2
    };

    const invalidStroke = {
      from: 'alice-history',
      color: 'hsl(10, 70%, 50%)',
      tool: 'pen',
      size: 4,
      strokeId: `history-invalid-${Date.now()}`,
      x1: 2,
      y1: 2,
      x2: 3,
      y2: 3
    };

    const aliceUpdatedStatePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id && msg.updatedBy === 'bob-history'
    );
    const bobUpdatedStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id && msg.updatedBy === 'bob-history'
    );

    sendJson(bob, {
      type: 'drawing:applyState',
      strokes: [validStroke, invalidStroke]
    });

    const aliceUpdatedState = await aliceUpdatedStatePromise;
    const bobUpdatedState = await bobUpdatedStatePromise;

    assert.equal(aliceUpdatedState.strokes.length, 1);
    assert.equal(aliceUpdatedState.strokes[0].strokeId, validStroke.strokeId);
    assert.equal(aliceUpdatedState.updatedBy, 'bob-history');

    assert.equal(bobUpdatedState.strokes.length, 1);
    assert.equal(bobUpdatedState.strokes[0].strokeId, validStroke.strokeId);
    assert.equal(bobUpdatedState.updatedBy, 'bob-history');
  } finally {
    alice.close();
    bob.close();
  }
});

test('feat4 - users:list est diffuse avec couleurs et mis a jour au depart', async () => {
  const alice = await createClient('alice-users');
  const bob = await createClient('bob-users');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);

    const roomName = `feat4-users-${Date.now()}`;
    const roomCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });

    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle du test users:list doit exister');

    const aliceJoinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const aliceStatePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(alice, { type: 'room:join', roomId: room.id });
    await aliceJoinedPromise;
    await aliceStatePromise;

    const aliceUsersWithTwoPromise = waitForJson(
      alice,
      (msg) => msg.type === 'users:list'
        && msg.roomId === room.id
        && Array.isArray(msg.users)
        && msg.users.some((u) => u.name === 'alice-users')
        && msg.users.some((u) => u.name === 'bob-users')
    );

    const bobJoinedPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const bobStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );

    sendJson(bob, { type: 'room:join', roomId: room.id });
    await bobJoinedPromise;
    await bobStatePromise;

    const usersWithTwo = await aliceUsersWithTwoPromise;
    const aliceEntry = usersWithTwo.users.find((u) => u.name === 'alice-users');
    const bobEntry = usersWithTwo.users.find((u) => u.name === 'bob-users');

    assert.ok(aliceEntry, 'alice doit etre dans users:list');
    assert.ok(bobEntry, 'bob doit etre dans users:list');
    assert.ok(/^hsl\(/.test(aliceEntry.color), 'La couleur alice doit etre un hsl');
    assert.ok(/^hsl\(/.test(bobEntry.color), 'La couleur bob doit etre un hsl');
    assert.notEqual(aliceEntry.color, bobEntry.color, 'Deux noms differents -> couleurs differentes');

    const aliceUsersAfterLeavePromise = waitForJson(
      alice,
      (msg) => msg.type === 'users:list'
        && msg.roomId === room.id
        && Array.isArray(msg.users)
        && msg.users.length === 1
        && msg.users[0].name === 'alice-users'
    );

    sendJson(bob, { type: 'room:leave' });

    const usersAfterLeave = await aliceUsersAfterLeavePromise;
    assert.equal(usersAfterLeave.users.length, 1);
    assert.equal(usersAfterLeave.users[0].name, 'alice-users');
  } finally {
    alice.close();
    bob.close();
  }
});
