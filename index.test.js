/* node:coverage disable */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const TEST_PORT = 1235;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}`;

let serverModule;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*Crée un client WebSocket simulant un utilisateur avec un nom spécifique (via Cookie)*/
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
/** Crée un client sans cookie pour tester les cas d'erreur de sécurité/anonymat */
function createAnonymousClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timeout ouverture WebSocket anonyme'));
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
/**
 * Attend de recevoir un message JSON spécifique du serveur qui valide une condition (predicate)
 */
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

function sendRaw(ws, text) {
  ws.send(text);
}
/** Vérifie qu'un message spécifique n'est pas reçu pendant un certain temps */
function expectNoJson(ws, predicate, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
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
      reject(new Error('Message inattendu reçu'));
    }

    ws.on('message', onMessage);
  });
}
/** * Simule le comportement initial du client : demande la liste des salles et des sauvegardes
 */
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

// ============================================================================
// CYCLE DE VIE DU SERVEUR DE TEST
// ============================================================================
before(async () => {
  serverModule = await import('./server.js');
  await serverModule.startServer({
    port: TEST_PORT,
    host: '127.0.0.1'
  });

  // Couvre le chemin startServer quand le serveur est déjà démarré.
  await serverModule.startServer({
    port: TEST_PORT,
    host: '127.0.0.1'
  });
});

after(async () => {
  if (!serverModule) {
    return;
  }

  await Promise.race([serverModule.stopServer(), wait(2000)]);

  // Couvre le chemin stopServer quand le serveur est déjà arrêté.
  await serverModule.stopServer();
});

// ============================================================================
// TESTS DES FONCTIONNALITÉS (FEAT)
// ============================================================================
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

test('feat5 - sauvegarder, restaurer puis supprimer une sauvegarde', async () => {
  const alice = await createClient('alice-save');

  try {
    await consumeHandshakeMessages(alice);

    const roomName = `feat5-save-${Date.now()}`;
    const roomCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });

    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room, 'La salle du test sauvegarde doit exister');

    const joinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room?.id === room.id
    );
    const initialStatePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(alice, { type: 'room:join', roomId: room.id });
    await joinedPromise;
    await initialStatePromise;

    sendJson(alice, {
      type: 'drawing:stroke',
      strokeId: `feat5-stroke-${Date.now()}`,
      tool: 'pen',
      size: 3,
      x1: 0.1,
      y1: 0.1,
      x2: 0.2,
      y2: 0.2
    });

    await waitForJson(
      alice,
      (msg) => msg.type === 'drawing:stroke' && msg.roomId === room.id
    );

    const saveName = 'dessinSauvegarde';
    const savedPromise = waitForJson(alice, (msg) => msg.type === 'drawing:saved');
    sendJson(alice, { type: 'drawing:save', name: saveName });
    const saved = await savedPromise;

    assert.equal(saved.save.name, saveName);
    assert.ok(saved.save.id, 'Un id de sauvegarde est attendu');

    const savedListPromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:saved:list' && msg.saves.some((s) => s.id === saved.save.id)
    );
    sendJson(alice, { type: 'drawing:saved:list' });
    const savedList = await savedListPromise;
    const savedEntry = savedList.saves.find((s) => s.id === saved.save.id);

    assert.ok(savedEntry, 'La sauvegarde doit apparaitre dans la liste');
    assert.equal(savedEntry.name, saveName);
    assert.ok(savedEntry.strokeCount >= 1, 'La sauvegarde doit contenir au moins un trait');

    const restorePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:restored' && msg.saveId === saved.save.id
    );
    sendJson(alice, { type: 'drawing:restore', saveId: saved.save.id });
    const restored = await restorePromise;

    assert.ok(restored.room?.id, 'La restauration doit creer une nouvelle salle');
    assert.equal(restored.room.name, `${saveName}1`);

    const deleteAckPromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:deleted' && msg.saveId === saved.save.id
    );
    sendJson(alice, { type: 'drawing:delete', saveId: saved.save.id });
    await deleteAckPromise;

    const listAfterDeletePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:saved:list' && !msg.saves.some((s) => s.id === saved.save.id)
    );
    sendJson(alice, { type: 'drawing:saved:list' });
    const listAfterDelete = await listAfterDeletePromise;
    assert.ok(!listAfterDelete.saves.some((s) => s.id === saved.save.id));
  } finally {
    alice.close();
  }
});

// ============================================================================
// TESTS DE COUVERTURE (CAS LIMITES ET ERREURS)
// ============================================================================
test('coverage - protocole: json invalide, type inconnu, room introuvable', async () => {
  const alice = await createClient('alice-errors');

  try {
    await consumeHandshakeMessages(alice);

    const invalidJsonPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Format invalide, JSON attendu'
    );
    sendRaw(alice, 'not-a-json');
    await invalidJsonPromise;

    const unknownTypePromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Type de message non pris en charge'
    );
    sendJson(alice, { type: 'unknown:type' });
    await unknownTypePromise;

    const roomNotFoundPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Room not found'
    );
    sendJson(alice, { type: 'room:join', roomId: 'missing-room' });
    await roomNotFoundPromise;
  } finally {
    alice.close();
  }
});

test('coverage - erreurs metier sans salle active', async () => {
  const alice = await createClient('alice-no-room');

  try {
    await consumeHandshakeMessages(alice);

    const chatErrorPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Aucune salle rejointe pour envoyer un message'
    );
    sendJson(alice, { type: 'chat:send', text: 'hello' });
    await chatErrorPromise;

    const drawErrorPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Aucune salle rejointe pour dessiner'
    );
    sendJson(alice, { type: 'drawing:stroke', x1: 0, y1: 0, x2: 0.1, y2: 0.1 });
    await drawErrorPromise;

    const saveErrorPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Aucune salle active pour sauvegarder'
    );
    sendJson(alice, { type: 'drawing:save', name: 'x' });
    await saveErrorPromise;

    const restoreErrorPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Sauvegarde introuvable'
    );
    sendJson(alice, { type: 'drawing:restore', saveId: 'missing-save' });
    await restoreErrorPromise;

    const deleteErrorPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:error' && msg.message === 'Sauvegarde introuvable'
    );
    sendJson(alice, { type: 'drawing:delete', saveId: 'missing-save' });
    await deleteErrorPromise;
  } finally {
    alice.close();
  }
});

test('coverage - chat diffuse, clear diffuse, stroke invalide ignore', async () => {
  const alice = await createClient('alice-chat');
  const bob = await createClient('bob-chat');
  const charlie = await createClient('charlie-chat');

  try {
    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);
    await consumeHandshakeMessages(charlie);

    const roomName = `coverage-chat-${Date.now()}`;
    const createdPromise = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });
    const roomListMsg = await createdPromise;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room);

    const aliceJoinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room.id === room.id
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
      (msg) => msg.type === 'room:joined' && msg.room.id === room.id
    );
    const bobStatePromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(bob, { type: 'room:join', roomId: room.id });
    await bobJoinedPromise;
    await bobStatePromise;

    const chatMessagePromise = waitForJson(
      bob,
      (msg) => msg.type === 'chat:message' && msg.roomId === room.id && msg.text === 'bonjour'
    );
    sendJson(alice, { type: 'chat:send', text: 'bonjour' });
    const chatMessage = await chatMessagePromise;
    assert.equal(chatMessage.from, 'alice-chat');

    // message chat vide: ne doit rien diffuser.
    sendJson(alice, { type: 'chat:send', text: '   ' });
    await expectNoJson(bob, (msg) => msg.type === 'chat:message' && msg.text.trim().length === 0);

    // trait invalide: ne doit rien diffuser.
    sendJson(alice, {
      type: 'drawing:stroke',
      strokeId: `bad-${Date.now()}`,
      tool: 'pen',
      size: 3,
      x1: 2,
      y1: 2,
      x2: 3,
      y2: 3
    });
    await expectNoJson(bob, (msg) => msg.type === 'drawing:stroke' && msg.roomId === room.id);

    // clear diffusé aux membres de la salle.
    const clearPromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:clear' && msg.roomId === room.id && msg.by === 'alice-chat'
    );
    sendJson(alice, { type: 'drawing:clear' });
    await clearPromise;

    // nouveau join -> état vide après clear.
    const charlieJoinedPromise = waitForJson(
      charlie,
      (msg) => msg.type === 'room:joined' && msg.room.id === room.id
    );
    const charlieStatePromise = waitForJson(
      charlie,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(charlie, { type: 'room:join', roomId: room.id });
    await charlieJoinedPromise;
    const charlieState = await charlieStatePromise;
    assert.equal(charlieState.strokes.length, 0);
  } finally {
    alice.close();
    bob.close();
    charlie.close();
  }
});

test('coverage - switch de salle et client sans cookie', async () => {
  const anonymous = await createAnonymousClient();
  const alice = await createClient('alice-switch');
  const bob = await createClient('bob-switch');

  try {
    // Sans cookie wsname, le serveur ne répond pas au protocole.
    sendJson(anonymous, { type: 'room:list' });
    await expectNoJson(anonymous, (msg) => msg.type === 'rooms:list', 400);

    await consumeHandshakeMessages(alice);
    await consumeHandshakeMessages(bob);

    const roomAName = `switch-A-${Date.now()}`;
    const roomBName = `switch-B-${Date.now()}`;

    const roomACreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomAName)
    );
    sendJson(alice, { type: 'room:create', name: roomAName });
    const roomsAfterA = await roomACreated;
    const roomA = roomsAfterA.rooms.find((r) => r.name === roomAName);
    assert.ok(roomA);

    const roomBCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomBName)
    );
    sendJson(alice, { type: 'room:create', name: roomBName });
    const roomsAfterB = await roomBCreated;
    const roomB = roomsAfterB.rooms.find((r) => r.name === roomBName);
    assert.ok(roomB);

    const aliceJoinARoomPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room.id === roomA.id
    );
    const aliceStateARoomPromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === roomA.id
    );
    sendJson(alice, { type: 'room:join', roomId: roomA.id });
    await aliceJoinARoomPromise;
    await aliceStateARoomPromise;

    const bobJoinARoomPromise = waitForJson(
      bob,
      (msg) => msg.type === 'room:joined' && msg.room.id === roomA.id
    );
    const bobStateARoomPromise = waitForJson(
      bob,
      (msg) => msg.type === 'drawing:state' && msg.roomId === roomA.id
    );
    sendJson(bob, { type: 'room:join', roomId: roomA.id });
    await bobJoinARoomPromise;
    await bobStateARoomPromise;

    const bobUsersAfterSwitchPromise = waitForJson(
      bob,
      (msg) => msg.type === 'users:list'
        && msg.roomId === roomA.id
        && Array.isArray(msg.users)
        && msg.users.length === 1
        && msg.users[0].name === 'bob-switch'
    );

    // Join roomB depuis roomA: couvre previousRoomId && previousRoomId !== roomId.
    const aliceJoinBRoomPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room.id === roomB.id
    );
    const aliceStateBRoomPromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === roomB.id
    );
    sendJson(alice, { type: 'room:join', roomId: roomB.id });
    await aliceJoinBRoomPromise;
    await aliceStateBRoomPromise;
    await bobUsersAfterSwitchPromise;

    // leave quand déjà hors salle: pas d'erreur, pas de crash.
    sendJson(alice, { type: 'room:leave' });
    await wait(50);
    sendJson(alice, { type: 'room:leave' });
    await wait(50);
  } finally {
    anonymous.close();
    alice.close();
    bob.close();
  }
});

test('coverage - applyState et clear sans salle ne plantent pas', async () => {
  const alice = await createClient('alice-no-room-2');

  try {
    await consumeHandshakeMessages(alice);

    sendJson(alice, { type: 'drawing:applyState', strokes: [] });
    sendJson(alice, { type: 'drawing:clear' });

    // Aucune erreur attendue dans ces cas: on vérifie seulement que la connexion reste vivante.
    sendJson(alice, { type: 'room:list' });
    const roomsList = await waitForJson(alice, (msg) => msg.type === 'rooms:list');
    assert.ok(Array.isArray(roomsList.rooms));
  } finally {
    alice.close();
  }
});

test('coverage - la liste des sauvegardes est plafonnee a 200', async () => {
  const alice = await createClient('alice-cap-saves');

  try {
    await consumeHandshakeMessages(alice);

    const roomName = `cap-saves-${Date.now()}`;
    const roomCreated = waitForJson(
      alice,
      (msg) => msg.type === 'rooms:list' && msg.rooms.some((r) => r.name === roomName)
    );
    sendJson(alice, { type: 'room:create', name: roomName });
    const roomListMsg = await roomCreated;
    const room = roomListMsg.rooms.find((r) => r.name === roomName);
    assert.ok(room);

    const joinedPromise = waitForJson(
      alice,
      (msg) => msg.type === 'room:joined' && msg.room.id === room.id
    );
    const statePromise = waitForJson(
      alice,
      (msg) => msg.type === 'drawing:state' && msg.roomId === room.id
    );
    sendJson(alice, { type: 'room:join', roomId: room.id });
    await joinedPromise;
    await statePromise;

    for (let i = 0; i < 205; i += 1) {
      sendJson(alice, { type: 'drawing:save', name: `cap-${i}` });
    }

    await wait(300);

    const savedListPromise = waitForJson(alice, (msg) => msg.type === 'drawing:saved:list');
    sendJson(alice, { type: 'drawing:saved:list' });
    const savedList = await savedListPromise;
    assert.ok(savedList.saves.length <= 200);
    assert.ok(savedList.saves.length > 0);
  } finally {
    alice.close();
  }
});