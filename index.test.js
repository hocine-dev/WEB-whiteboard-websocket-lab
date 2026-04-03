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