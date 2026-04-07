﻿import './index.css';
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

type SavedDrawingSummary = {
  id: string;
  name: string;
  savedAt: number;
  savedBy: string;
  strokeCount: number;
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

type ConnectedUser = {
  name: string;
  color: string;
};

//-------------------Les message que le serveur peut envoyer au client-------------------//
type ServerMessage =
  | { type: 'rooms:list'; rooms: RoomSummary[] }
  | { type: 'room:joined'; room: { id: string; name: string }; user: { name: string; color: string } }
  | { type: 'room:error'; message: string }
  | { type: 'drawing:saved:list'; saves: SavedDrawingSummary[] }
  | { type: 'drawing:saved'; save: SavedDrawingSummary }
  | { type: 'drawing:deleted'; saveId: string }
  | { type: 'drawing:restored'; saveId: string; room: { id: string; name: string } }
  | { type: 'users:list'; roomId: string; users: ConnectedUser[] }
  | { type: 'chat:message'; roomId: string; from: string; text: string; sentAt: number }
  | { type: 'drawing:state'; roomId: string; strokes: DrawStroke[]; updatedBy?: string }
  | { type: 'drawing:stroke'; roomId: string; stroke: DrawStroke }
  | { type: 'drawing:clear'; roomId: string; by: string };


//-------------------Variables d'état globales-------------------//
let currentRoomId: string | null = null;
let currentTool: DrawingTool = 'pen';
let brushSize = 4;
let currentUserColor = '#4ec9ff';
let isDrawing = false;
let lastPoint: { x: number; y: number } | null = null;
let currentStrokeId: string | null = null;
let roomStrokes: DrawStroke[] = [];
let localStrokeCounter = 0;
const pendingStrokeEchoes = new Set<string>();
let isHistoryMode = false;
let historySnapshot: DrawStroke[] = [];
let historySteps: DrawStroke[][] = [];
let historyCursor = 0;

const userName = wsname || 'Anonymous';

//-------element html-------------------------------//
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
const savedDrawingsList = document.querySelector('#saved-drawings') as HTMLUListElement | null;
const newRoomInput = document.querySelector('#new-room-name') as HTMLInputElement | null;
const newRoomButton = document.querySelector('#new-room-btn') as HTMLButtonElement | null;
const leaveButton = document.querySelector('#leave-btn') as HTMLButtonElement | null;

const messagesList = document.querySelector('#messages') as HTMLUListElement | null;
const connectedUsersList = document.querySelector('#connected-users') as HTMLUListElement | null;
const chatForm = document.querySelector('#chat-form') as HTMLFormElement | null;
const chatInput = document.querySelector('#chat-input') as HTMLInputElement | null;

const canvas = document.querySelector('#whiteboard') as HTMLCanvasElement | null;
const toolPenButton = document.querySelector('#tool-pen') as HTMLButtonElement | null;
const toolEraserButton = document.querySelector('#tool-eraser') as HTMLButtonElement | null;
const brushSizeInput = document.querySelector('#brush-size') as HTMLInputElement | null;
const clearButton = document.querySelector('#btn-clear') as HTMLButtonElement | null;
const saveButton = document.querySelector('#btn-save') as HTMLButtonElement | null;
const saveStatus = document.querySelector('#save-status') as HTMLSpanElement | null;
const historyButton = document.querySelector('#btn-history') as HTMLButtonElement | null;
const historyBackButton = document.querySelector('#btn-history-back') as HTMLButtonElement | null;
const historyForwardButton = document.querySelector('#btn-history-forward') as HTMLButtonElement | null;
const historyApplyButton = document.querySelector('#btn-history-apply') as HTMLButtonElement | null;
const historyExitButton = document.querySelector('#btn-history-exit') as HTMLButtonElement | null;
const historyStep = document.querySelector('#history-step') as HTMLSpanElement | null;

const context = canvas ? canvas.getContext('2d') : null;
const ws = new WebSocket('ws://localhost:1234');
let saveStatusTimer: ReturnType<typeof setTimeout> | null = null;


//------------------------crrer une couleur local-----------------------//
function hashColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 78%, 58%)`;
}



//-------------------------Affichage du statut de sauvegarde-----------------------//
function showSaveStatus(message: string, state: 'pending' | 'success' | 'error', autoHideMs = 2200): void {
  if (!saveStatus) {
    return;
  }

  saveStatus.textContent = message;
  saveStatus.classList.remove('hidden', 'pending', 'success', 'error');
  saveStatus.classList.add(state);

  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }

  if (autoHideMs > 0) {
    saveStatusTimer = setTimeout(() => {
      saveStatus?.classList.add('hidden');
      saveStatus?.classList.remove('pending', 'success', 'error');
      saveStatusTimer = null;
    }, autoHideMs);
  }
}
//-------------------------Gestion des outils de dessin-----------------------//
function updateToolButtons(): void {
  if (toolPenButton) {
    toolPenButton.classList.toggle('active', currentTool === 'pen');
  }
  if (toolEraserButton) {
    toolEraserButton.classList.toggle('active', currentTool === 'eraser');
  }
}
//--------------------------Gestion du canvas et des traits-----------------------//
function clearCanvasVisual(): void {
  if (!canvas || !context) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  context.clearRect(0, 0, rect.width, rect.height);
}
//--------------------------Dessine un trait sur le canvas en fonction des données normalisées-----------------------//
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


//--------------------------Redessine tout le canvas à partir de l'état actuel des traits de la salle-----------------------//
function redrawCanvas(): void {
  clearCanvasVisual();
  for (const stroke of roomStrokes) {
    drawStroke(stroke);
  }
}

//----------------Ajuste la taille du canvas pour qu'il soit net---------------------/
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

//----------Convertit la position de la souris en coordonnées normalisées (entre 0 et 1)------------------------//
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

//--------------------------Gère l'ajout d'un trait localement -----------------------//
function pushLocalStroke(stroke: DrawStroke): void {
  roomStrokes.push(stroke);
  drawStroke(stroke);
}

//---------------------------dessine un aperçu de l'état du dessin correspondant à la position actuelle du curseur dans l'historique-----------------------//
function drawHistoryPreview(): void {
  if (!context || !canvas) {
    return;
  }

  clearCanvasVisual();
  for (let stepIndex = 0; stepIndex < historyCursor; stepIndex += 1) {
    const step = historySteps[stepIndex];
    for (const stroke of step) {
      drawStroke(stroke);
    }
  }
}

//--------------------------Construit une liste d'étapes d'historique à partir de la liste complète des traits, en regroupant les traits qui font partie du même "trait continu" (même strokeId)-----------------------//
function buildHistorySteps(strokes: DrawStroke[]): DrawStroke[][] {
  const steps: DrawStroke[][] = [];
  let currentKey = '';

  for (let i = 0; i < strokes.length; i += 1) {
    const stroke = strokes[i];
    const key = stroke.strokeId || `segment-${i}`;

    if (steps.length === 0 || key !== currentKey) {
      steps.push([stroke]);
      currentKey = key;
    } else {
      steps[steps.length - 1].push(stroke);
    }
  }

  return steps;
}

//---------------------------Met à jour l'état des contrôles de navigation dans l'historique en fonction de la position actuelle du curseur et du nombre total d'étapes-----------------------//
function updateHistoryControls(): void {
  if (historyBackButton) {
    historyBackButton.disabled = historyCursor <= 0;
  }
  if (historyForwardButton) {
    historyForwardButton.disabled = historyCursor >= historySteps.length;
  }
  if (historyStep) {
    historyStep.textContent = `${historyCursor} / ${historySteps.length}`;
  }
}

//---------------------------show/hide des controles de navigation dans l'historique-----------------------//
function setHistoryControlsVisible(visible: boolean): void {
  const controls = [historyBackButton, historyForwardButton, historyApplyButton, historyExitButton, historyStep];
  controls.forEach((element) => {
    if (element) {
      element.classList.toggle('hidden', !visible);
    }
  });

  if (historyButton) {
    historyButton.disabled = visible;
  }
}


//--------------------------Entre en mode historique pour permettre à l'utilisateur de naviguer dans les étapes précédentes du dessin-----------------------//
function enterHistoryMode(): void {
  if (isHistoryMode || !currentRoomId) {
    return;
  }

  isHistoryMode = true;
  historySnapshot = roomStrokes.map((stroke) => ({ ...stroke }));
  historySteps = buildHistorySteps(historySnapshot);
  historyCursor = historySteps.length;
  setHistoryControlsVisible(true);
  updateHistoryControls();
  drawHistoryPreview();
}
//--------------------------Quitte le mode historique et revient à l'affichage normal du canvas-----------------------//
function exitHistoryMode(skipRedraw = false): void {
  if (!isHistoryMode) {
    return;
  }

  isHistoryMode = false;
  historySnapshot = [];
  historySteps = [];
  historyCursor = 0;
  setHistoryControlsVisible(false);
  if (!skipRedraw) {
    redrawCanvas();
  }
}

function beginDraw(event: PointerEvent): void {
  if (!canvas || !currentRoomId || isHistoryMode) {
    return;
  }

  const point = pointerToNormalizedPoint(event);
  if (!point) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  isDrawing = true;
  lastPoint = point;
  currentStrokeId = `${Date.now()}-${localStrokeCounter++}`;
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
    strokeId: currentStrokeId || `${Date.now()}-${localStrokeCounter++}`,
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


//---------------------------Termine le dessin en cours et libère la capture du pointeur-----------------------//
function endDraw(event: PointerEvent): void {
  if (!canvas) {
    return;
  }

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  isDrawing = false;
  lastPoint = null;
  currentStrokeId = null;
}

//---------------------------Réinitialise l'état du canvas et des traits pour la salle actuelle (utilisé lors de la connexion à une salle ou après un effacement)-----------------------//
function resetCanvasStateForRoom(): void {
  roomStrokes = [];
  pendingStrokeEchoes.clear();
  if (isHistoryMode) {
    historySnapshot = [];
    historySteps = [];
    historyCursor = 0;
    updateHistoryControls();
  }
  redrawCanvas();
}


//----------------------------Efface les messages du chat-----------------------//
function clearMessages(): void {
  if (messagesList) {
    messagesList.innerHTML = '';
  }
}

//----------------------------Ajoute un message au chat de la salle actuelle-----------------------//
function addMessageToChat(from: string, text: string): void {
  if (!messagesList) {
    return;
  }

  const line = document.createElement('li');
  line.textContent = `[${from}] ${text}`;
  messagesList.appendChild(line);
  messagesList.scrollTop = messagesList.scrollHeight;
}
//----------------------------Affiche la liste des utilisateurs connectés à la salle actuelle-----------------------//
function renderConnectedUsers(users: ConnectedUser[]): void {
  if (!connectedUsersList) {
    return;
  }

  connectedUsersList.innerHTML = '';

  for (const user of users) {
    const item = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'user-color-dot';
    dot.style.backgroundColor = user.color;

    const name = document.createElement('span');
    name.textContent = user.name;

    item.appendChild(dot);
    item.appendChild(name);
    connectedUsersList.appendChild(item);
  }
}
//----------------------------Affiche l'écran de lobby et masque le canvas, réinitialise les états liés à la salle et au dessin-----------------------//
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
  if (saveStatus) {
    saveStatus.classList.add('hidden');
    saveStatus.classList.remove('pending', 'success', 'error');
  }
  exitHistoryMode();
  renderConnectedUsers([]);
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
//----------------------------Affiche la liste des salles disponibles dans le lobby-----------------------//
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
//----------------------------Affiche la liste des dessins sauvegardés disponibles pour restauration dans le canvas-----------------------//
function renderSavedDrawings(saves: SavedDrawingSummary[]): void {
  if (!savedDrawingsList) {
    return;
  }

  savedDrawingsList.innerHTML = '';

  for (const save of saves) {
    const item = document.createElement('li');

    const content = document.createElement('div');
    content.className = 'saved-content';

    const title = document.createElement('div');
    title.className = 'room-name';
    title.textContent = save.name;

    const meta = document.createElement('div');
    meta.className = 'saved-meta';
    meta.textContent = `${save.strokeCount} trait(s) • ${save.savedBy}`;

    content.appendChild(title);
    content.appendChild(meta);

    const restoreButton = document.createElement('button');
    restoreButton.className = 'restore-btn';
    restoreButton.type = 'button';
    restoreButton.textContent = 'Restaurer';
    restoreButton.addEventListener('click', () => {
      sendJSON({ type: 'drawing:restore', saveId: save.id });
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-save-btn';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Supprimer';
    deleteButton.addEventListener('click', () => {
      const confirmed = window.confirm(`Supprimer la sauvegarde "${save.name}" ?`);
      if (!confirmed) {
        return;
      }

      sendJSON({ type: 'drawing:delete', saveId: save.id });
    });

    const actions = document.createElement('div');
    actions.className = 'saved-actions';
    actions.appendChild(restoreButton);
    actions.appendChild(deleteButton);

    item.appendChild(content);
    item.appendChild(actions);
    savedDrawingsList.appendChild(item);
  }
}



//--------COMMUNICATION WEBSOCKET------------------------------------------------------

//------------------------Envoi de messages au serveur-----------------------//
function sendJSON(payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}





ws.onopen = (event: Event) => {
  console.log('WebSocket connection opened:', event);
  sendJSON({ type: 'room:list' });
  sendJSON({ type: 'drawing:saved:list' });
};
//---router cote client---------------
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
      showSaveStatus(data.message || 'Erreur côté serveur', 'error', 3000);
      console.warn(data.message);
      return;
    }

    if (data.type === 'drawing:saved:list') {
      renderSavedDrawings(data.saves);
      return;
    }

    if (data.type === 'drawing:saved') {
      showSaveStatus('Sauvegarde terminée', 'success');
      sendJSON({ type: 'drawing:saved:list' });
      return;
    }

    if (data.type === 'drawing:deleted') {
      showSaveStatus('Sauvegarde supprimée', 'success');
      return;
    }

    if (data.type === 'drawing:restored') {
      sendJSON({ type: 'room:join', roomId: data.room.id });
      return;
    }

    if (data.type === 'users:list') {
      if (currentRoomId && data.roomId === currentRoomId) {
        renderConnectedUsers(data.users);
      }
      return;
    }

    if (data.type === 'chat:message') {
      if (currentRoomId && data.roomId === currentRoomId) {
        addMessageToChat(data.from, data.text);
      }
      return;
    }

    if (data.type === 'drawing:state') {  // Réception de l'historique complet à la connexion
      if (!currentRoomId || data.roomId !== currentRoomId) {
        return;
      }

      roomStrokes = Array.isArray(data.strokes) ? data.strokes : [];
        if (!isHistoryMode) {
          redrawCanvas();
        }
      return;
    }

    if (data.type === 'drawing:stroke') {   // Réception d'un trait tracé par quelqu'un d'autre
      if (!currentRoomId || data.roomId !== currentRoomId) {
        return;
      }

      const stroke = data.stroke;
      if (stroke.from === userName && stroke.strokeId && pendingStrokeEchoes.has(stroke.strokeId)) {
        pendingStrokeEchoes.delete(stroke.strokeId);
        return;
      }

      roomStrokes.push(stroke);
      if (!isHistoryMode) {
        drawStroke(stroke);
      }
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
    if (!currentRoomId || isHistoryMode) {
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
    if (!currentRoomId) {
      showSaveStatus('Rejoins un canvas avant de sauvegarder', 'error', 3000);
      return;
    }

    const saveName = roomTitle?.textContent?.trim() || 'Dessin';
    showSaveStatus('Sauvegarde en cours...', 'pending', 0);
    sendJSON({ type: 'drawing:save', name: saveName });
  });
}

if (historyButton) {
  historyButton.addEventListener('click', () => {
    enterHistoryMode();
  });
}

if (historyBackButton) {
  historyBackButton.addEventListener('click', () => {
    if (!isHistoryMode || historyCursor <= 0) {
      return;
    }

    historyCursor -= 1;
    updateHistoryControls();
    drawHistoryPreview();
  });
}

if (historyForwardButton) {
  historyForwardButton.addEventListener('click', () => {
    if (!isHistoryMode || historyCursor >= historySteps.length) {
      return;
    }

    historyCursor += 1;
    updateHistoryControls();
    drawHistoryPreview();
  });
}

if (historyApplyButton) {
  historyApplyButton.addEventListener('click', () => {
    if (!isHistoryMode || !currentRoomId) {
      return;
    }

    const selectedStrokes = historySteps
      .slice(0, historyCursor)
      .flat()
      .map((stroke) => ({ ...stroke }));

    // Applique d'abord localement pour éviter le retour visuel à l'état précédent.
    roomStrokes = selectedStrokes;
    redrawCanvas();

    sendJSON({ type: 'drawing:applyState', strokes: selectedStrokes });
    exitHistoryMode(true);
  });
}

if (historyExitButton) {
  historyExitButton.addEventListener('click', () => {
    exitHistoryMode();
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
setHistoryControlsVisible(false);
