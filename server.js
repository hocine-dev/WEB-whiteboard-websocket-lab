import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';

const port = 1234;
const host = '0.0.0.0';

// Crée un serveur HTTP bas niveau (TCP, sockets, handshake HTTP, etc.).
const server = http.createServer();

// Place un serveur WebSocket au-dessus du serveur HTTP.
const wss = new WebSocketServer({
  server: server
});

// Les salles sont stockées en mémoire tant que le serveur tourne.
// Chaque salle garde la liste des clients connectés pour compter les participants.
const rooms = new Map();

function createRoom(name) {
  const id = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const room = {
    id,
    name,
    createdAt: Date.now(),
    users: new Set()
  };
  rooms.set(id, room);
  return room;
}

function serializeRooms() {
  return Array.from(rooms.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => ({
      id: room.id,
      name: room.name,
      userCount: room.users.size
    }));
}

function sendJSON(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

function broadcastRooms() {
  const payload = {
    type: 'rooms:list',
    rooms: serializeRooms()
  };
  wss.clients.forEach((client) => {
    sendJSON(client, payload);
  });
}

function broadcastChatToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  room.users.forEach((member) => {
    sendJSON(member, payload);
  });
}

function removeClientFromRoom(client) {
  if (!client.currentRoomId) {
    return;
  }

  const room = rooms.get(client.currentRoomId);
  if (room) {
    room.users.delete(client);
  }

  client.currentRoomId = null;
}


// Écoute les nouvelles connexions WebSocket.
wss.on('connection', function(client, request) {

  // Récupère le nom depuis les cookies.
  const cookies = request.headers.cookie ? request.headers.cookie.split(';') : [];
  let wsname = cookies.find((c) => c.match(/^\s*wsname/));
  
  if (wsname) {
    wsname = wsname.split('=')[1];
    console.log("First connection from", wsname);

    // On rattache l'identifiant de salle active au client.
    client.currentRoomId = null;

    // Envoie la liste actuelle des salles à chaque nouvelle connexion.
    sendJSON(client, {
      type: 'rooms:list',
      rooms: serializeRooms()
    });

    // Écoute chaque message reçu pour ce client.
    client.on('message', function(message) {
      const messageText = String(message);

      // Protocole JSON: gestion des salles et futurs événements de dessin.
      try {
        const payload = JSON.parse(messageText);

        if (payload.type === 'room:list') {
          sendJSON(client, {
            type: 'rooms:list',
            rooms: serializeRooms()
          });
          return;
        }

        if (payload.type === 'room:create') {
          const roomName = String(payload.name || '').trim();
          if (roomName.length > 0) {
            createRoom(roomName);
            broadcastRooms();
          }
          return;
        }

        if (payload.type === 'room:join') {
          const roomId = String(payload.roomId || '');
          const room = rooms.get(roomId);
          if (!room) {
            sendJSON(client, { type: 'room:error', message: 'Room not found' });
            return;
          }

          removeClientFromRoom(client);
          room.users.add(client);
          client.currentRoomId = roomId;

          sendJSON(client, {
            type: 'room:joined',
            room: {
              id: room.id,
              name: room.name
            }
          });

          broadcastRooms();
          return;
        }

        if (payload.type === 'room:leave') {
          removeClientFromRoom(client);
          broadcastRooms();
          return;
        }

        if (payload.type === 'chat:send') {
          const text = String(payload.text || '').trim();

          if (!client.currentRoomId) {
            sendJSON(client, {
              type: 'room:error',
              message: 'Aucune salle rejointe pour envoyer un message'
            });
            return;
          }

          if (text.length === 0) {
            return;
          }

          broadcastChatToRoom(client.currentRoomId, {
            type: 'chat:message',
            roomId: client.currentRoomId,
            from: decodeURIComponent(wsname),
            text,
            sentAt: Date.now()
          });
          return;
        }

        sendJSON(client, {
          type: 'room:error',
          message: 'Type de message non pris en charge'
        });
        return;
      } catch {
        // Le serveur n'accepte plus les anciens messages texte.
        sendJSON(client, {
          type: 'room:error',
          message: 'Format invalide, JSON attendu'
        });
      }
    });

    client.on('close', function() {
      removeClientFromRoom(client);
      broadcastRooms();
    });
  }
});

// Démarre l'écoute HTTP sur l'hôte et le port définis.
server.listen(port, host, function() {
  console.log('Listening on ' + server.address().address + ':' + server.address().port);
});

process.on('SIGINT', function() {
  process.exit(0);
});
