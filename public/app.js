const STORAGE_KEY = "guessing-game-player";

const state = {
  sessionId: "",
  playerId: "",
  displayName: "",
  session: null,
  pollTimer: null
};

const createForm = document.querySelector("#create-form");
const joinForm = document.querySelector("#join-form");
const createNameInput = document.querySelector("#create-name");
const joinCodeInput = document.querySelector("#join-code");
const joinNameInput = document.querySelector("#join-name");
const entryFeedback = document.querySelector("#entry-feedback");
const sessionFeedback = document.querySelector("#session-feedback");
const sessionTitle = document.querySelector("#session-title");
const sessionMeta = document.querySelector("#session-meta");
const leaveButton = document.querySelector("#leave-button");
const playerCount = document.querySelector("#player-count");
const playersList = document.querySelector("#players-list");
const masterControls = document.querySelector("#master-controls");
const questionForm = document.querySelector("#question-form");
const questionInput = document.querySelector("#question-input");
const answerInput = document.querySelector("#answer-input");
const startButton = document.querySelector("#start-button");
const masterName = document.querySelector("#master-name");
const roundTitle = document.querySelector("#round-title");
const roundStatus = document.querySelector("#round-status");
const countdownPill = document.querySelector("#countdown-pill");
const chatFeed = document.querySelector("#chat-feed");
const guessForm = document.querySelector("#guess-form");
const guessInput = document.querySelector("#guess-input");

function loadStoredIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.sessionId = saved.sessionId || "";
    state.playerId = saved.playerId || "";
    state.displayName = saved.displayName || "";
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function saveStoredIdentity() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: state.sessionId,
      playerId: state.playerId,
      displayName: state.displayName
    })
  );
}

function clearStoredIdentity() {
  state.sessionId = "";
  state.playerId = "";
  state.displayName = "";
  state.session = null;
  localStorage.removeItem(STORAGE_KEY);
}

function showFeedback(target, message, type = "success") {
  target.hidden = false;
  target.textContent = message;
  target.className = `feedback ${type}`;
}

function hideFeedback(target) {
  target.hidden = true;
  target.textContent = "";
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || "Request failed.");
  }

  return data;
}

function isViewerGameMaster() {
  return Boolean(state.session?.viewer?.isGameMaster);
}

function formatTimeLeft(expiresAt) {
  if (!expiresAt) {
    return "--";
  }

  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  return `${seconds}s`;
}

function createPlayerCard(player) {
  const card = document.createElement("article");
  card.className = "player-card";

  const top = document.createElement("div");
  top.className = "player-row";

  const name = document.createElement("strong");
  name.textContent = player.displayName;

  const role = document.createElement("span");
  role.className = "tag";
  role.textContent = player.isGameMaster ? "Game master" : "Player";

  top.append(name, role);

  const score = document.createElement("p");
  score.textContent = `${player.score} point${player.score === 1 ? "" : "s"}`;

  card.append(top, score);
  return card;
}

function createMessageBubble(event) {
  const bubble = document.createElement("article");
  bubble.className = `message-bubble ${event.type === "guess" ? "guess" : "system"}`;

  const text = document.createElement("p");
  text.textContent = event.message;

  const time = document.createElement("span");
  time.textContent = new Date(event.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  bubble.append(text, time);
  return bubble;
}

function renderPlayers(players) {
  playerCount.textContent = `${players.length} connected`;
  playersList.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (const player of players) {
    fragment.append(createPlayerCard(player));
  }
  playersList.append(fragment);
}

function renderChat(events) {
  chatFeed.replaceChildren();

  if (!events.length) {
    const empty = document.createElement("article");
    empty.className = "empty-feed";
    empty.textContent = "Session activity will appear here.";
    chatFeed.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const event of events) {
    fragment.append(createMessageBubble(event));
  }

  chatFeed.append(fragment);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function renderRound(session) {
  const round = session.round;
  const viewer = session.viewer;
  const lastRound = session.lastRoundSummary;

  masterName.textContent = `Game master: ${session.gameMasterName || "-"}`;

  if (!round) {
    if (lastRound) {
      const winner = session.players.find((player) => player.id === lastRound.winnerPlayerId);
      roundTitle.textContent = lastRound.question;
      roundStatus.textContent = winner
        ? winner.id === viewer?.id
          ? `You have won. The answer was ${lastRound.answer}.`
          : `${winner.displayName} won. The answer was ${lastRound.answer}.`
        : `No winner this round. The answer was ${lastRound.answer}.`;
    } else {
      roundTitle.textContent = "Waiting in the lobby";
      roundStatus.textContent = viewer?.isGameMaster
        ? "Write the next question and answer, then start when at least 3 players are ready."
        : "The game master is preparing the next round.";
    }
    countdownPill.textContent = "Timer: --";
    guessInput.disabled = true;
    guessForm.querySelector("button").disabled = true;
    return;
  }

  countdownPill.textContent = `Timer: ${formatTimeLeft(round.expiresAt)}`;

  if (round.status === "draft") {
    roundTitle.textContent = "Question ready";
    roundStatus.textContent = viewer?.isGameMaster
      ? "Your question is saved. Start the round when everyone is in."
      : "A question is ready. Waiting for the game master to start.";
    guessInput.disabled = true;
    guessForm.querySelector("button").disabled = true;
    return;
  }

  roundTitle.textContent = round.question;

  if (round.status === "active") {
    roundStatus.textContent = viewer?.isGameMaster
      ? "Players are guessing now."
      : `${round.attemptsRemaining} of ${round.maxAttempts} attempts left.`;

    const canGuess =
      !viewer?.isGameMaster &&
      round.attemptsRemaining > 0 &&
      session.status === "in_progress";

    guessInput.disabled = !canGuess;
    guessForm.querySelector("button").disabled = !canGuess;
    return;
  }

  const winner = session.players.find((player) => player.id === round.winnerPlayerId);
  roundStatus.textContent = winner
    ? winner.id === viewer?.id
      ? `You have won. The answer was ${round.answer}.`
      : `${winner.displayName} won. The answer was ${round.answer}.`
    : `No winner this round. The answer was ${round.answer}.`;
  guessInput.disabled = true;
  guessForm.querySelector("button").disabled = true;
}

function renderSession() {
  const session = state.session;

  if (!session || !session.viewer) {
    sessionTitle.textContent = "No active session";
    sessionMeta.innerHTML = "<span>Choose a name to get started.</span>";
    leaveButton.hidden = true;
    renderPlayers([]);
    renderChat([]);
    masterControls.hidden = true;
    guessForm.hidden = true;
    roundTitle.textContent = "Waiting in the lobby";
    roundStatus.textContent = "The current game master can prepare the next question.";
    countdownPill.textContent = "Timer: --";
    return;
  }

  leaveButton.hidden = false;
  sessionTitle.textContent = `Session ${session.id}`;
  sessionMeta.innerHTML = `
    <span>${session.playerCount} players connected</span>
    <span>${session.status === "in_progress" ? "Game in progress" : "Lobby open"}</span>
    <span>You are ${session.viewer.displayName}</span>
  `;

  renderPlayers(session.players);
  renderChat(session.events || []);
  renderRound(session);

  masterControls.hidden = !isViewerGameMaster();
  guessForm.hidden = isViewerGameMaster();

  if (isViewerGameMaster()) {
    startButton.disabled =
      session.playerCount < 3 || !session.round || session.round.status !== "draft";
  }
}

async function refreshSession(showErrors = false) {
  if (!state.sessionId || !state.playerId) {
    return;
  }

  try {
    const data = await request(
      `/api/sessions/${encodeURIComponent(state.sessionId)}?playerId=${encodeURIComponent(state.playerId)}`
    );
    state.session = data.session;
    renderSession();
    hideFeedback(sessionFeedback);
  } catch (error) {
    if (showErrors) {
      showFeedback(sessionFeedback, error.message, "error");
    }
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    refreshSession();
  }, 1500);
}

async function createSession(event) {
  event.preventDefault();
  hideFeedback(entryFeedback);

  try {
    const data = await request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: createNameInput.value })
    });

    state.sessionId = data.session.id;
    state.playerId = data.playerId;
    state.displayName = data.session.viewer.displayName;
    state.session = data.session;
    saveStoredIdentity();
    renderSession();
    startPolling();
    showFeedback(entryFeedback, data.message);
    createForm.reset();
  } catch (error) {
    showFeedback(entryFeedback, error.message, "error");
  }
}

async function joinSession(event) {
  event.preventDefault();
  hideFeedback(entryFeedback);

  try {
    const code = joinCodeInput.value.trim().toUpperCase();
    const data = await request(`/api/sessions/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: joinNameInput.value })
    });

    state.sessionId = data.session.id;
    state.playerId = data.playerId;
    state.displayName = data.session.viewer.displayName;
    state.session = data.session;
    saveStoredIdentity();
    renderSession();
    startPolling();
    showFeedback(entryFeedback, data.message);
    joinForm.reset();
  } catch (error) {
    showFeedback(entryFeedback, error.message, "error");
  }
}

async function leaveSession() {
  if (!state.sessionId || !state.playerId) {
    return;
  }

  try {
    const data = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: state.playerId })
    });

    clearInterval(state.pollTimer);
    clearStoredIdentity();
    renderSession();
    showFeedback(entryFeedback, data.message);
  } catch (error) {
    showFeedback(sessionFeedback, error.message, "error");
  }
}

async function saveQuestion(event) {
  event.preventDefault();

  try {
    const data = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: state.playerId,
        question: questionInput.value,
        answer: answerInput.value
      })
    });

    state.session = data.session;
    renderSession();
    showFeedback(sessionFeedback, data.message);
  } catch (error) {
    showFeedback(sessionFeedback, error.message, "error");
  }
}

async function startRound() {
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: state.playerId })
    });

    state.session = data.session;
    questionForm.reset();
    renderSession();
    showFeedback(sessionFeedback, data.message);
  } catch (error) {
    showFeedback(sessionFeedback, error.message, "error");
  }
}

async function submitGuess(event) {
  event.preventDefault();

  try {
    const data = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: state.playerId,
        guess: guessInput.value
      })
    });

    guessForm.reset();
    state.session = data.session;
    renderSession();
    showFeedback(sessionFeedback, data.message);
  } catch (error) {
    showFeedback(sessionFeedback, error.message, "error");
  }
}

createForm.addEventListener("submit", createSession);
joinForm.addEventListener("submit", joinSession);
questionForm.addEventListener("submit", saveQuestion);
guessForm.addEventListener("submit", submitGuess);
startButton.addEventListener("click", startRound);
leaveButton.addEventListener("click", leaveSession);

loadStoredIdentity();
renderSession();

if (state.sessionId && state.playerId) {
  startPolling();
  refreshSession(true);
}
