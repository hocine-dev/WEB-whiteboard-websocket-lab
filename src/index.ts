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
    document.cookie = "wsname=" + encodeURIComponent(wsname);
}

// Affichage du nom dans l'en-tête
const headerParagraph = document.querySelector('header>p') as HTMLParagraphElement;
if (headerParagraph) {
  headerParagraph.textContent = wsname;
}

// Connexion WebSocket au serveur
const ws = new WebSocket("ws://localhost:1234");

// Notification à l'ouverture de la connexion WebSocket
ws.onopen = (event: Event) => {
  console.log('WebSocket connection opened:', event);
};

// Écouter les messages du serveur et les afficher dans la liste
const messages = document.querySelector('#messages') as HTMLUListElement;
ws.onmessage = (event: MessageEvent) => {
  const line = document.createElement('li');
  line.textContent = event.data;
  messages.appendChild(line);
};

// Fonction pour envoyer un message via WebSocket lorsque l'utilisateur soumet le formulaire
function sendMessage(event: Event): void {
  event.preventDefault();
  event.stopPropagation();

  const sendInput = document.querySelector('form input') as HTMLInputElement;
  if (sendInput.value.trim() !== '') {
    // Envoyer le message via WebSocket
    ws.send(sendInput.value);
    sendInput.value = '';
  }
}

// Récupérer le formulaire et l'élément d'entrée
const sendForm = document.querySelector('form') as HTMLFormElement;
if (sendForm) {
  sendForm.addEventListener('submit', sendMessage, true);
  sendForm.addEventListener('blur', sendMessage, true);
}
