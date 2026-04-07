import http from 'http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';


//------------------Configuration du serveur-------------------//
const defaultPort = Number(process.env.WS_PORT || 1234);
const defaultHost = process.env.WS_HOST || '0.0.0.0';

// Crée un serveur HTTP bas niveau 
const server = http.createServer();

// Place un serveur WebSocket au-dessus du serveur HTTP.
const wss = new WebSocketServer({
  server: server
});

const STORE_FILE = new URL('./drawings-store.json', import.meta.url);


//L'objet en mémoire qui va toutes les sauvegardes chargées depuis le fichier.
const persistentStore = {
  saves: []
};

let storeLoaded = false;
let serverStarted = false;

//----Création des salles
const rooms = new Map();





//------------------Fontions Utilitaires-----------------------------------------//




/**
 * Génère une couleur unique (format HSL) basée sur le nom de l'utilisateur.
 * @param {string} name - Le nom de l'utilisateur.
 * @returns {string} La couleur générée au format `hsl(h, s, l)`.
 */
//---------------------------------------------------------------------------------------------------------//
function computeUserColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }

  return `hsl(${hash}, 78%, 58%)`;
}


/**
 * Charge les sauvegardes depuis le fichier JSON  vers la mémoire.
 * Si le fichier n'existe pas, initialise un tableau vide.
 * @returns {void}
 */
//---------------------------------------------------------------------------------------------------------//
function loadPersistentStore() {
  try {
    /* node:coverage ignore next */
    if (!fs.existsSync(STORE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const saves = Array.isArray(parsed?.saves) ? parsed.saves : [];

    persistentStore.saves = saves.map((save) => ({
      id: String(save?.id || `${Date.now()}-${Math.random()}`),
      name: String(save?.name || 'Dessin sauvegarde'),
      savedAt: Number(save?.savedAt) || Date.now(),
      savedBy: String(save?.savedBy || 'Inconnu'),
      strokes: sanitizeStrokeList(Array.isArray(save?.strokes) ? save.strokes : [])
    }));
  } catch (error) {
    /* node:coverage ignore next */
    console.error('Impossible de charger drawings-store.json:', error);
    /* node:coverage ignore next */
    persistentStore.saves = [];
  }
}

function writePersistentStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(persistentStore, null, 2), 'utf8');
}



//-------------Logique de gestion des salles, des utilisateurs et des dessins-----------------//

/**
 * Crée une nouvelle salle et l'ajoute au Map `rooms`.
 * @param {string} name - Le nom souhaité pour la nouvelle salle.
 * @returns {Object} L'objet complet représentant la salle créée.*/
//---------------------------------------------------------------------------------------------------------//
function createRoom(name) {
  const id = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const room = {
    id,
    name,
    createdAt: Date.now(),
    users: new Set(),
    drawing: []
  };
  rooms.set(id, room);
  return room;
}

/**
 * Calcule un nom de salle unique lors de la restauration d'une sauvegarde pour éviter les doublons.
 * Ajoute ou incrémente un suffixe numérique .
 * @param {string} baseName - Le nom de base du dessin à restaurer.
 * @returns {string} Le nouveau nom unique de la salle.*/
//---------------------------------------------------------------------------------------------------------//
function createRestoredRoomName(baseName) {
  const cleanBaseName = String(baseName || 'Dessin').trim() || 'Dessin';
  const escapedName = cleanBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixPattern = new RegExp(`^${escapedName}(\\d+)$`);

  let maxSuffix = 0;

  for (const room of rooms.values()) {
    const match = String(room.name).match(suffixPattern);
    /* node:coverage ignore next */
    if (!match) {
      continue;
    }

    const value = Number(match[1]);
    /* node:coverage ignore next */
    if (Number.isFinite(value) && value > maxSuffix) {
      maxSuffix = value;
    }
  }

  return `${cleanBaseName}${maxSuffix + 1}`;
}




/**
 * Prépare la liste des salles actives pour l'envoi aux clients.
 * @returns {Array<{id: string, name: string, userCount: number}>} La liste formatée et triée par date.*/
//---------------------------------------------------------------------------------------------------------//

function serializeRooms() {
  return Array.from(rooms.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => ({
      id: room.id,
      name: room.name,
      userCount: room.users.size
    }));
}

/**
 * Prépare la liste des sauvegardes persistantes pour l'envoi aux clients.
 * @returns {Array<Object>} La liste des sauvegardes formatée et triée.
 */
//---------------------------------------------------------------------------------------------------------//

function serializeSavedDrawings() {
  return persistentStore.saves
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((save) => ({
      id: save.id,
      name: save.name,
      savedAt: save.savedAt,
      savedBy: save.savedBy,
      strokeCount: save.strokes.length
    }));
}
/**
 * Prépare la liste des utilisateurs présents dans une salle.
 * @param {Object} room - L'objet salle concerné.
 * @returns {Array<{name: string, color: string}>} La liste des utilisateurs formatée.
 */
//---------------------------------------------------------------------------------------------------------//

function serializeUsers(room) {
  /* node:coverage ignore next */
  if (!room) {
    return [];
  }

  return Array.from(room.users)
    .map((client) => ({
      name: client.userName,
      color: client.userColor
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Convertit un objet en chaîne JSON et l'envoie à un client si sa connexion est ouverte.
 * @param {WebSocket} client - Le client destinataire.
 * @param {Object} payload - Les données à envoyer.
 * @returns {void}
 */
function sendJSON(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

/**
 * Diffuse la liste à jour des salles à tous les clients connectés au serveur.
 * @returns {void}
 */

function broadcastRooms() {
  const payload = {
    type: 'rooms:list',
    rooms: serializeRooms()
  };
  wss.clients.forEach((client) => {
    sendJSON(client, payload);
  });
}

/**
 * Diffuse la liste à jour des sauvegardes à TOUS les clients connectés au serveur.
 * @returns {void}
 */

function broadcastSavedDrawingsList() {
  const payload = {
    type: 'drawing:saved:list',
    saves: serializeSavedDrawings()
  };

  wss.clients.forEach((client) => {
    sendJSON(client, payload);
  });
}


/**
 * Diffuse un message de chat uniquement aux membres d'une salle spécifique.
 * @param {string} roomId - L'identifiant de la salle.
 * @param {Object} payload - Le message de chat à envoyer.
 * @returns {void}
 */

function broadcastChatToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  /* node:coverage ignore next */
  if (!room) {
    return;
  }

  room.users.forEach((member) => {
    sendJSON(member, payload);
  });
}

/**
 * Diffuse un événement de dessin aux membres d'une salle spécifique.
 * @param {string} roomId - L'identifiant de la salle.
 * @param {Object} payload - L'objet représentant le trait de dessin ou l'état.
 * @returns {void}
 */
function broadcastDrawingToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  /* node:coverage ignore next */
  if (!room) {
    return;
  }

  room.users.forEach((member) => {
    sendJSON(member, payload);
  });
}

/**
 * Diffuse la liste mise à jour des utilisateurs présents dans une salle spécifique.
 * @param {string} roomId - L'identifiant de la salle.
 * @returns {void}
 */

function broadcastUsersToRoom(roomId) {
  const room = rooms.get(roomId);
  /* node:coverage ignore next */
  if (!room) {
    return;
  }

  const payload = {
    type: 'users:list',
    roomId,
    users: serializeUsers(room)
  };

  room.users.forEach((member) => {
    sendJSON(member, payload);
  });
}


//Securite et nettoyage de donnes

/**
 * Nettoie et valide un trait de dessin reçu d'un client. 
 * Rejette le trait si les coordonnées sont invalides.
 * @param {Object} rawStroke - Les données brutes du trait envoyées par le client.
 * @returns {Object|null} L'objet trait validé, ou null si les données sont corrompues.
 */

function sanitizeStrokePayload(rawStroke) {
  const stroke = {
    from: String(rawStroke?.from || ''),
    color: String(rawStroke?.color || '#000000'),
    tool: rawStroke?.tool === 'eraser' ? 'eraser' : 'pen',
    size: Number(rawStroke?.size) || 1,
    strokeId: String(rawStroke?.strokeId || `${Date.now()}-${Math.random()}`),
    x1: Number(rawStroke?.x1),
    y1: Number(rawStroke?.y1),
    x2: Number(rawStroke?.x2),
    y2: Number(rawStroke?.y2)
  };

  const coords = [stroke.x1, stroke.y1, stroke.x2, stroke.y2];
  const hasInvalidCoord = coords.some((n) => !Number.isFinite(n) || n < 0 || n > 1);
  if (hasInvalidCoord) {
    return null;
  }

  return stroke;
}


/**
 * Applique le nettoyage sur une liste complète de traits (utilisé lors des chargements de sauvegardes).
 * @param {Array<Object>} rawList - La liste brute de traits.
 * @returns {Array<Object>} La liste contenant uniquement les traits validés.
 */


function sanitizeStrokeList(rawList) {
  return rawList
    .map((stroke) => sanitizeStrokePayload(stroke))
    .filter((stroke) => stroke !== null);
}



//--Deconnexion-------------------


/**
 * Retire un client de sa salle actuelle et met à jour son état.
 * @param {WebSocket} client - Le client à retirer de sa salle.
 * @returns {string|null} L'ID de l'ancienne salle, ou null si le client n'était dans aucune salle.
 */

function removeClientFromRoom(client) {
  if (!client.currentRoomId) {
    return null;
  }

  const previousRoomId = client.currentRoomId;

  const room = rooms.get(client.currentRoomId);
  if (room) {
    room.users.delete(client);
  }

  client.currentRoomId = null;
  return previousRoomId;
}

//------------------------Gestion de connexion et routage --------------------------------/

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
    client.userName = decodeURIComponent(wsname);
    client.userColor = computeUserColor(client.userName);

    // Envoie la liste actuelle des salles à chaque nouvelle connexion.
    sendJSON(client, {
      type: 'rooms:list',
      rooms: serializeRooms()
    });

    sendJSON(client, {
      type: 'drawing:saved:list',
      saves: serializeSavedDrawings()
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

          const previousRoomId = removeClientFromRoom(client);
          if (previousRoomId && previousRoomId !== roomId) {
            broadcastUsersToRoom(previousRoomId);
          }

          room.users.add(client);
          client.currentRoomId = roomId;

          sendJSON(client, {
            type: 'room:joined',
            room: {
              id: room.id,
              name: room.name
            },
            user: {
              name: client.userName,
              color: client.userColor
            }
          });

          sendJSON(client, {
            type: 'drawing:state',
            roomId: room.id,
            strokes: room.drawing
          });

          broadcastUsersToRoom(roomId);

          broadcastRooms();
          return;
        }

        if (payload.type === 'room:leave') {
          const previousRoomId = removeClientFromRoom(client);
          if (previousRoomId) {
            broadcastUsersToRoom(previousRoomId);
          }
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
            from: client.userName,
            text,
            sentAt: Date.now()
          });
          return;
        }

        if (payload.type === 'drawing:stroke') {
          if (!client.currentRoomId) {
            sendJSON(client, {
              type: 'room:error',
              message: 'Aucune salle rejointe pour dessiner'
            });
            return;
          }

          const stroke = sanitizeStrokePayload({
            from: client.userName,
            color: client.userColor,
            tool: payload.tool,
            size: payload.size,
            strokeId: payload.strokeId,
            x1: payload.x1,
            y1: payload.y1,
            x2: payload.x2,
            y2: payload.y2
          });

          if (!stroke) {
            return;
          }

          const room = rooms.get(client.currentRoomId);
          /* node:coverage ignore next */
          if (!room) {
            return;
          }

          room.drawing.push(stroke);

          broadcastDrawingToRoom(client.currentRoomId, {
            type: 'drawing:stroke',
            roomId: client.currentRoomId,
            stroke
          });
          return;
        }

        if (payload.type === 'drawing:applyState') {
          if (!client.currentRoomId) {
            return;
          }

          const room = rooms.get(client.currentRoomId);
          /* node:coverage ignore next */
          if (!room) {
            return;
          }

          const incoming = Array.isArray(payload.strokes) ? payload.strokes : [];
          const sanitized = incoming
            .map((stroke) => sanitizeStrokePayload(stroke))
            .filter((stroke) => stroke !== null);

          room.drawing = sanitized;

          broadcastDrawingToRoom(client.currentRoomId, {
            type: 'drawing:state',
            roomId: client.currentRoomId,
            strokes: room.drawing,
            updatedBy: client.userName
          });
          return;
        }

        if (payload.type === 'drawing:saved:list') {
          sendJSON(client, {
            type: 'drawing:saved:list',
            saves: serializeSavedDrawings()
          });
          return;
        }

        if (payload.type === 'drawing:save') {
          if (!client.currentRoomId) {
            sendJSON(client, {
              type: 'room:error',
              message: 'Aucune salle active pour sauvegarder'
            });
            return;
          }

          const room = rooms.get(client.currentRoomId);
          /* node:coverage ignore next */
          if (!room) {
            return;
          }

          const requestedName = String(payload.name || '').trim();
          const saveName = requestedName.length > 0 ? requestedName : room.name;

          const save = {
            id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            name: saveName,
            savedAt: Date.now(),
            savedBy: client.userName,
            strokes: room.drawing.map((stroke) => ({ ...stroke }))
          };

          persistentStore.saves.unshift(save);
          if (persistentStore.saves.length > 200) {
            persistentStore.saves = persistentStore.saves.slice(0, 200);
          }

          writePersistentStore();
          broadcastSavedDrawingsList();

          sendJSON(client, {
            type: 'drawing:saved',
            save: {
              id: save.id,
              name: save.name,
              savedAt: save.savedAt,
              savedBy: save.savedBy,
              strokeCount: save.strokes.length
            }
          });
          return;
        }

        if (payload.type === 'drawing:restore') {
          const saveId = String(payload.saveId || '');
          const saved = persistentStore.saves.find((save) => save.id === saveId);
          if (!saved) {
            sendJSON(client, {
              type: 'room:error',
              message: 'Sauvegarde introuvable'
            });
            return;
          }

          const restoredRoomName = createRestoredRoomName(saved.name);
          const restoredRoom = createRoom(restoredRoomName);
          restoredRoom.drawing = saved.strokes.map((stroke) => ({ ...stroke }));

          broadcastRooms();

          sendJSON(client, {
            type: 'drawing:restored',
            saveId: saved.id,
            room: {
              id: restoredRoom.id,
              name: restoredRoom.name
            }
          });
          return;
        }

        if (payload.type === 'drawing:delete') {
          const saveId = String(payload.saveId || '');
          const saveIndex = persistentStore.saves.findIndex((save) => save.id === saveId);

          if (saveIndex < 0) {
            sendJSON(client, {
              type: 'room:error',
              message: 'Sauvegarde introuvable'
            });
            return;
          }

          persistentStore.saves.splice(saveIndex, 1);
          writePersistentStore();
          broadcastSavedDrawingsList();

          sendJSON(client, {
            type: 'drawing:deleted',
            saveId
          });
          return;
        }

        if (payload.type === 'drawing:clear') {
          if (!client.currentRoomId) {
            return;
          }

          const room = rooms.get(client.currentRoomId);
          /* node:coverage ignore next */
          if (!room) {
            return;
          }

          room.drawing = [];

          broadcastDrawingToRoom(client.currentRoomId, {
            type: 'drawing:clear',
            roomId: client.currentRoomId,
            by: client.userName
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
      const previousRoomId = removeClientFromRoom(client);
      if (previousRoomId) {
        broadcastUsersToRoom(previousRoomId);
      }
      broadcastRooms();
    });
  }
});


/**
 * Démarre le serveur WebSocket et charge l'historique persistant.
 * @param {Object} options - Options de démarrage .
 * @returns {Promise<http.Server>} Promesse résolue une fois le serveur démarré.
 */
export function startServer(options = {}) {
  const port = Number(options.port || defaultPort);
  const host = String(options.host || defaultHost);

  if (!storeLoaded) {
    loadPersistentStore();
    storeLoaded = true;
  }

  if (serverStarted) {
    return Promise.resolve(server);
  }

  return new Promise((resolve, reject) => {
    /* node:coverage ignore next */
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      serverStarted = true;
      console.log('Listening on ' + server.address().address + ':' + server.address().port);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}


/**
 * Arrête le serveur et ferme toutes les connexions clientes proprement.
 * @returns {Promise<void>} Promesse résolue une fois l'arrêt complet.
 */

export function stopServer() {
  if (!serverStarted) {
    return Promise.resolve();
  }

  wss.clients.forEach((client) => {
    try {
      client.close();
    } catch {
      /* node:coverage ignore next */
      // Ignore erreurs de fermeture client.
    }
  });

  return new Promise((resolve, reject) => {
    server.close((error) => {
      /* node:coverage ignore next */
      if (error) {
        reject(error);
        return;
      }

      serverStarted = false;
      resolve();
    });
  });
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error('Erreur au demarrage du serveur:', error);
    process.exit(1);
  });

  process.on('SIGINT', function() {
    stopServer().finally(() => {
      process.exit(0);
    });
  });
}