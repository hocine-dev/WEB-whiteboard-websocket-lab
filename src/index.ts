import './index.css';
import nameGenerator from './name-generator';

function getCookie(name: string): string | null {
  const cookies = document.cookie.split(';');
  const cookie = cookies.find((c) => c.trim().startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
}

let wsname: string | null = getCookie('wsname');
if (!wsname) {
  wsname = nameGenerator();
  document.cookie = 'wsname=' + encodeURIComponent(wsname);
}

type RoomSummary = {
  id: string;
  name: string;
  userCount: number;
};

type DrawingTool = 'pen' | 'eraser';

type DrawStroke = {
  from: string;
  color: string;
  tool: DrawingTool;
  size: number;
  strokeId?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type ServerMessage =
  | { type: 'rooms:list'; rooms: RoomSummary[] }
  | { type: 'room:joined'; room: { id: string; name: string }; user: { name: string; color: string } }
  | { type: 'room:error'; message: string }
  | { type: 'chat:message'; roomId: string; from: string; text: string; sentAt: number }
  | { type: 'drawing:state'; roomId: string; strokes: DrawStroke[] }
  | { type: 'drawing:stroke'; roomId: string; stroke: DrawStroke }
  | { type: 'drawing:clear'; roomId: string; by: string };

let currentRoomId: string | null = null;
let currentTool: DrawingTool = 'pen';
let brushSize = 4;
let currentUserColor = '#4ec9ff';
let isDrawing = false;
let lastPoint: { x: number; y: number } | null = null;
let roomStrokes: DrawStroke[] = [];
let localStrokeCounter = 0;
const pendingStrokeEchoes = new Set<string>();

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

const canvas = document.querySelector('#whiteboard') as HTMLCanvasElement | null;
const toolPenButton = document.querySelector('#tool-pen') as HTMLButtonElement | null;
const toolEraserButton = document.querySelector('#tool-eraser') as HTMLButtonElement | null;
const brushSizeInput = document.querySelector('#brush-size') as HTMLInputElement | null;
const clearButton = document.querySelector('#btn-clear') as HTMLButtonElement | null;
const saveButton = document.querySelector('#btn-save') as HTMLButtonElement | null;

const context = canvas ? canvas.getContext('2d') : null;
const ws = new WebSocket('ws://localhost:1234');

function hashColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 78%, 58%)`;
}

function sendJSON(payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function updateToolButtons(): void {
  if (toolPenButton) {
    toolPenButton.classList.toggle('active', currentTool === 'pen');
  }
  if (toolEraserButton) {
    toolEraserButton.classList.toggle('active', currentTool === 'eraser');
  }
}

function clearCanvasVisual(): void {
  if (!canvas || !context) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  context.clearRect(0, 0, rect.width, rect.height);
}

function drawStroke(stroke: DrawStroke): void {
  if (!canvas || !context) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x1 = stroke.x1 * rect.width;
  const y1 = stroke.y1 * rect.height;
  const x2 = stroke.x2 * rect.width;
  const y2 = stroke.y2 * rect.height;

  context.save();
  context.lineWidth = Math.max(1, stroke.size);

  if (stroke.tool === 'eraser') {
    context.globalCompositeOperation = 'destination-out';
    context.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = stroke.color;
  }

  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.restore();
}

function redrawCanvas(): void {
  clearCanvasVisual();
  for (const stroke of roomStrokes) {
    drawStroke(stroke);
  }
}

function setupCanvasSize(): void {
  if (!canvas || !context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.lineCap = 'round';
  context.lineJoin = 'round';

  redrawCanvas();
}

function pointerToNormalizedPoint(event: PointerEvent): { x: number; y: number } | null {
  if (!canvas) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y))
  };
}

function pushLocalStroke(stroke: DrawStroke): void {
  roomStrokes.push(stroke);
  drawStroke(stroke);
}

function beginDraw(event: PointerEvent): void {
  if (!canvas || !currentRoomId) {
    return;
  }

  const point = pointerToNormalizedPoint(event);
  if (!point) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  isDrawing = true;
  lastPoint = point;
}

function moveDraw(event: PointerEvent): void {
  if (!isDrawing || !lastPoint || !currentRoomId) {
    return;
  }

  const point = pointerToNormalizedPoint(event);
  if (!point) {
    return;
  }

  const stroke: DrawStroke = {
    from: userName,
    color: currentUserColor,
    tool: currentTool,
    size: brushSize,
    strokeId: `${Date.now()}-${localStrokeCounter++}`,
    x1: lastPoint.x,
    y1: lastPoint.y,
    x2: point.x,
    y2: point.y
  };

  if (stroke.strokeId) {
    pendingStrokeEchoes.add(stroke.strokeId);
  }

  pushLocalStroke(stroke);

  sendJSON({
    type: 'drawing:stroke',
    strokeId: stroke.strokeId,
    tool: stroke.tool,
    size: stroke.size,
    x1: stroke.x1,
    y1: stroke.y1,
    x2: stroke.x2,
    y2: stroke.y2
  });

  lastPoint = point;
}

function endDraw(event: PointerEvent): void {
  if (!canvas) {
    return;
  }

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  isDrawing = false;
  lastPoint = null;
}

function resetCanvasStateForRoom(): void {
  roomStrokes = [];
  pendingStrokeEchoes.clear();
  redrawCanvas();
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

function showLobby(): void {
  if (lobbyScreen) {
    lobbyScreen.classList.remove('hidden');
  }
  if (canvasScreen) {
    canvasScreen.classList.add('hidden');
  }

  currentRoomId = null;
  isDrawing = false;
  lastPoint = null;
}

function showCanvas(roomId: string, roomName: string): void {
  currentRoomId = roomId;

  if (roomTitle) {
    roomTitle.textContent = roomName;
  }

  clearMessages();
  resetCanvasStateForRoom();

  if (lobbyScreen) {
    lobbyScreen.classList.add('hidden');
  }
  if (canvasScreen) {
    canvasScreen.classList.remove('hidden');
  }

  requestAnimationFrame(() => {
    setupCanvasSize();
  });
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
      currentUserColor = data.user?.color || hashColor(userName);
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

    if (data.type === 'drawing:state') {
      if (!currentRoomId || data.roomId !== currentRoomId) {
        return;
      }

      roomStrokes = Array.isArray(data.strokes) ? data.strokes : [];
      redrawCanvas();
      return;
    }

    if (data.type === 'drawing:stroke') {
      if (!currentRoomId || data.roomId !== currentRoomId) {
        return;
      }

      const stroke = data.stroke;
      if (stroke.from === userName && stroke.strokeId && pendingStrokeEchoes.has(stroke.strokeId)) {
        pendingStrokeEchoes.delete(stroke.strokeId);
        return;
      }

      pushLocalStroke(stroke);
      return;
    }

    if (data.type === 'drawing:clear') {
      if (!currentRoomId || data.roomId !== currentRoomId) {
        return;
      }

      resetCanvasStateForRoom();
      return;
    }
  } catch {
    console.warn('Message serveur ignore (format non JSON).');
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

if (toolPenButton) {
  toolPenButton.addEventListener('click', () => {
    currentTool = 'pen';
    updateToolButtons();
  });
}

if (toolEraserButton) {
  toolEraserButton.addEventListener('click', () => {
    currentTool = 'eraser';
    updateToolButtons();
  });
}

if (brushSizeInput) {
  brushSizeInput.addEventListener('input', () => {
    const value = Number(brushSizeInput.value);
    brushSize = Number.isFinite(value) ? Math.max(1, value) : 4;
  });
}

if (clearButton) {
  clearButton.addEventListener('click', () => {
    if (!currentRoomId) {
      return;
    }

    // Retour visuel immédiat pour l'utilisateur qui clique.
    resetCanvasStateForRoom();

    // Synchronise ensuite l'effacement avec les autres participants de la salle.
    sendJSON({ type: 'drawing:clear' });
  });
}

if (saveButton && canvas) {
  saveButton.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `canvas-${Date.now()}.png`;
    link.click();
  });
}

if (canvas) {
  canvas.addEventListener('pointerdown', beginDraw);
  canvas.addEventListener('pointermove', moveDraw);
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  canvas.addEventListener('pointerleave', endDraw);
}

window.addEventListener('resize', () => {
  if (!canvasScreen?.classList.contains('hidden')) {
    setupCanvasSize();
  }
});

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

updateToolButtons();
setupCanvasSize();