import './index.css';
import nameGenerator from './name-generator';

// Définition de la fonction pour récupérer un cookie par son nom
function getCookie(name: string): string | null {
  const cookies = document.cookie.split(';');
  const cookie = cookies.find(c => c.trim().startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
}

// Vérification et récupération du nom depuis le cookie
let wsname: string | null = getCookie('wsname');
if (!wsname) {
  // Si le nom n'est pas défini, générer un nouveau nom
  wsname = nameGenerator();
  document.cookie = 'wsname=' + encodeURIComponent(wsname);
}

type RoomSummary = {
  id: string;
  name: string;
  userCount: number;
};

type ServerMessage =
  | { type: 'rooms:list'; rooms: RoomSummary[] }
  | { type: 'room:joined'; room: { id: string; name: string } }
  | { type: 'room:error'; message: string }
  | { type: 'chat:message'; roomId: string; from: string; text: string; sentAt: number };

let currentRoomId: string | null = null;

const userName = wsname || 'Anonymous';

const userNameInLobby = document.querySelector('#user-name') as HTMLElement | null;
if (userNameInLobby) {
  userNameInLobby.textContent = userName;
}

const userNameInCanvas = document.querySelector('#canvas-user-name') as HTMLElement | null;
if (userNameInCanvas) {
  userNameInCanvas.textContent = userName;
}

const lobbyScreen = document.querySelector('#lobby') as HTMLElement | null;
const canvasScreen = document.querySelector('#canvas-screen') as HTMLElement | null;
const roomTitle = document.querySelector('#room-title') as HTMLElement | null;

const roomList = document.querySelector('#room-list') as HTMLUListElement | null;
const newRoomInput = document.querySelector('#new-room-name') as HTMLInputElement | null;
const newRoomButton = document.querySelector('#new-room-btn') as HTMLButtonElement | null;
const leaveButton = document.querySelector('#leave-btn') as HTMLButtonElement | null;
const messagesList = document.querySelector('#messages') as HTMLUListElement | null;
const chatForm = document.querySelector('#chat-form') as HTMLFormElement | null;
const chatInput = document.querySelector('#chat-input') as HTMLInputElement | null;

// Connexion WebSocket au serveur
const ws = new WebSocket('ws://localhost:1234');

function sendJSON(payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function showLobby(): void {
  if (lobbyScreen) {
    lobbyScreen.classList.remove('hidden');
  }
  if (canvasScreen) {
    canvasScreen.classList.add('hidden');
  }

  currentRoomId = null;
}

function clearMessages(): void {
  if (messagesList) {
    messagesList.innerHTML = '';
  }
}

function addMessageToChat(from: string, text: string): void {
  if (!messagesList) {
    return;
  }

  const line = document.createElement('li');
  line.textContent = `[${from}] ${text}`;
  messagesList.appendChild(line);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function showCanvas(roomId: string, roomName: string): void {
  currentRoomId = roomId;

  if (roomTitle) {
    roomTitle.textContent = roomName;
  }

  clearMessages();

  if (lobbyScreen) {
    lobbyScreen.classList.add('hidden');
  }
  if (canvasScreen) {
    canvasScreen.classList.remove('hidden');
  }
}

function renderRooms(rooms: RoomSummary[]): void {
  if (!roomList) {
    return;
  }

  roomList.innerHTML = '';

  for (const room of rooms) {
    const item = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = room.name;

    const users = document.createElement('span');
    users.className = 'room-users';
    users.textContent = `${room.userCount} participant(s)`;

    const joinButton = document.createElement('button');
    joinButton.className = 'join-btn';
    joinButton.type = 'button';
    joinButton.textContent = 'Rejoindre';
    joinButton.addEventListener('click', () => {
      sendJSON({ type: 'room:join', roomId: room.id });
    });

    item.appendChild(name);
    item.appendChild(users);
    item.appendChild(joinButton);

    roomList.appendChild(item);
  }
}

// Notification à l'ouverture de la connexion WebSocket
ws.onopen = (event: Event) => {
  console.log('WebSocket connection opened:', event);
  sendJSON({ type: 'room:list' });
};

ws.onmessage = (event: MessageEvent) => {
  const raw = String(event.data);

  try {
    const data = JSON.parse(raw) as ServerMessage;

    if (data.type === 'rooms:list') {
      renderRooms(data.rooms);
      return;
    }

    if (data.type === 'room:joined') {
      showCanvas(data.room.id, data.room.name);
      return;
    }

    if (data.type === 'room:error') {
      console.warn(data.message);
      return;
    }

    if (data.type === 'chat:message') {
      if (currentRoomId && data.roomId === currentRoomId) {
        addMessageToChat(data.from, data.text);
      }
      return;
    }
  } catch {
    console.warn('Message serveur ignoré (format non JSON).');
  }
};

if (newRoomButton && newRoomInput) {
  newRoomButton.addEventListener('click', () => {
    const roomName = newRoomInput.value.trim();
    if (!roomName) {
      return;
    }

    sendJSON({ type: 'room:create', name: roomName });
    newRoomInput.value = '';
  });
}

if (leaveButton) {
  leaveButton.addEventListener('click', () => {
    sendJSON({ type: 'room:leave' });
    showLobby();
  });
}

if (chatForm && chatInput) {
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const text = chatInput.value.trim();
    if (!text || !currentRoomId) {
      return;
    }

    sendJSON({ type: 'chat:send', text });
    chatInput.value = '';
  });
}
