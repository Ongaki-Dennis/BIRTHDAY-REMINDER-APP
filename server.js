require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "game-sessions.json");
const ROUND_DURATION_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const WIN_POINTS = 10;

let dataLock = Promise.resolve();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function sanitizeText(value, maxLength = 120) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function withDataLock(task) {
  const run = async () => task();
  const next = dataLock.then(run, run);
  dataLock = next.catch(() => {});
  return next;
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "{\n  \"sessions\": []\n}\n", "utf8");
  }
}

async function readStore() {
  await ensureDataFile();
  const content = await fs.readFile(DATA_FILE, "utf8");

  try {
    const parsed = JSON.parse(content);
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch {
    return { sessions: [] };
  }
}

async function writeStore(store) {
  await ensureDataFile();
  await fs.writeFile(DATA_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function createEvent(type, message, meta = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    message,
    createdAt: new Date().toISOString(),
    ...meta
  };
}

function createPlayer(displayName) {
  return {
    id: crypto.randomUUID(),
    displayName,
    score: 0,
    joinedAt: new Date().toISOString()
  };
}

function createSession(gameMasterName) {
  const gameMaster = createPlayer(gameMasterName);

  return {
    id: crypto.randomUUID().slice(0, 8).toUpperCase(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "lobby",
    roundNumber: 0,
    currentGameMasterId: gameMaster.id,
    players: [gameMaster],
    round: null,
    lastRoundSummary: null,
    events: [
      createEvent("system", `${gameMaster.displayName} created the session and became game master.`)
    ]
  };
}

function getPlayer(session, playerId) {
  return session.players.find((player) => player.id === playerId);
}

function getGameMaster(session) {
  return getPlayer(session, session.currentGameMasterId) || null;
}

function getNextGameMasterId(session, currentId) {
  if (!session.players.length) {
    return null;
  }

  const currentIndex = session.players.findIndex((player) => player.id === currentId);

  if (currentIndex === -1) {
    return session.players[0].id;
  }

  return session.players[(currentIndex + 1) % session.players.length].id;
}

function buildPublicRound(round, viewerId, session) {
  if (!round) {
    return null;
  }

  const isGameMaster = session.currentGameMasterId === viewerId;
  const viewerAttemptsUsed = round.attemptsByPlayer?.[viewerId] || 0;
  const answerVisible = round.status === "ended" || isGameMaster;

  return {
    question: round.question,
    answer: answerVisible ? round.answer : null,
    status: round.status,
    createdBy: round.createdBy,
    startedAt: round.startedAt,
    expiresAt: round.expiresAt,
    endedAt: round.endedAt,
    winnerPlayerId: round.winnerPlayerId,
    endReason: round.endReason,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - viewerAttemptsUsed),
    maxAttempts: MAX_ATTEMPTS
  };
}

function buildSessionView(session, viewerId) {
  const viewer = getPlayer(session, viewerId);
  const gameMaster = getGameMaster(session);

  return {
    id: session.id,
    status: session.status,
    roundNumber: session.roundNumber,
    playerCount: session.players.length,
    currentGameMasterId: session.currentGameMasterId,
    gameMasterName: gameMaster ? gameMaster.displayName : null,
    viewer: viewer
      ? {
          id: viewer.id,
          displayName: viewer.displayName,
          score: viewer.score,
          isGameMaster: viewer.id === session.currentGameMasterId
        }
      : null,
    players: session.players.map((player) => ({
      id: player.id,
      displayName: player.displayName,
      score: player.score,
      isGameMaster: player.id === session.currentGameMasterId
    })),
    round: buildPublicRound(session.round, viewerId, session),
    lastRoundSummary: session.lastRoundSummary,
    events: session.events.slice(-80)
  };
}

function ensureSessionExists(store, sessionId) {
  const session = store.sessions.find((entry) => entry.id === sessionId);

  if (!session) {
    const error = new Error("Session not found.");
    error.statusCode = 404;
    throw error;
  }

  return session;
}

function ensurePlayerInSession(session, playerId) {
  const player = getPlayer(session, playerId);

  if (!player) {
    const error = new Error("Player not found in this session.");
    error.statusCode = 404;
    throw error;
  }

  return player;
}

function ensureGameMaster(session, playerId) {
  if (session.currentGameMasterId !== playerId) {
    const error = new Error("Only the current game master can do that.");
    error.statusCode = 403;
    throw error;
  }
}

function expireRoundIfNeeded(session) {
  if (!session.round || session.round.status !== "active") {
    return false;
  }

  if (Date.now() < new Date(session.round.expiresAt).getTime()) {
    return false;
  }

  endRound(session, {
    endReason: "time_expired",
    message: `Time is up. The answer was "${session.round.answer}".`
  });

  return true;
}

function endRound(session, { winnerPlayerId = null, endReason, message }) {
  if (!session.round) {
    return;
  }

  const completedRound = {
    question: session.round.question,
    answer: session.round.answer,
    winnerPlayerId,
    endReason,
    endedAt: new Date().toISOString()
  };

  session.round.status = "ended";
  session.round.endedAt = completedRound.endedAt;
  session.round.winnerPlayerId = winnerPlayerId;
  session.round.endReason = endReason;
  session.status = "lobby";

  if (winnerPlayerId) {
    const winner = getPlayer(session, winnerPlayerId);

    if (winner) {
      winner.score += WIN_POINTS;
    }
  }

  session.events.push(createEvent("system", message, { winnerPlayerId, endReason }));

  const previousGameMasterId = session.currentGameMasterId;
  session.currentGameMasterId = getNextGameMasterId(session, previousGameMasterId);
  session.lastRoundSummary = completedRound;
  session.round = null;

  const nextGameMaster = getGameMaster(session);

  if (nextGameMaster) {
    session.events.push(
      createEvent(
        "system",
        `${nextGameMaster.displayName} is now the game master for the next round.`
      )
    );
  }
}

function validateSessionCode(sessionId) {
  const normalized = sanitizeText(sessionId, 8).toUpperCase();

  if (!/^[A-Z0-9]{6,8}$/.test(normalized)) {
    const error = new Error("Enter a valid session code.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "guessing-game",
    roundDurationSeconds: ROUND_DURATION_MS / 1000,
    maxAttempts: MAX_ATTEMPTS,
    winPoints: WIN_POINTS
  });
});

app.post("/api/sessions", async (req, res) => {
  const displayName = sanitizeText(req.body?.displayName, 40);

  if (displayName.length < 2) {
    res.status(400).json({ message: "Display name must be at least 2 characters long." });
    return;
  }

  const result = await withDataLock(async () => {
    const store = await readStore();
    const session = createSession(displayName);
    store.sessions.push(session);
    await writeStore(store);

    return {
      message: `Session ${session.id} is ready.`,
      playerId: session.currentGameMasterId,
      session: buildSessionView(session, session.currentGameMasterId)
    };
  });

  res.status(201).json(result);
});

app.post("/api/sessions/:id/join", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const displayName = sanitizeText(req.body?.displayName, 40);

  if (displayName.length < 2) {
    res.status(400).json({ message: "Display name must be at least 2 characters long." });
    return;
  }

  try {
    const result = await withDataLock(async () => {
      const store = await readStore();
      const session = ensureSessionExists(store, sessionId);
      expireRoundIfNeeded(session);

      if (session.status === "in_progress") {
        const error = new Error("You cannot join while a game is in progress.");
        error.statusCode = 409;
        throw error;
      }

      const duplicateName = session.players.some(
        (player) => player.displayName.toLowerCase() === displayName.toLowerCase()
      );

      if (duplicateName) {
        const error = new Error("That display name is already in this session.");
        error.statusCode = 409;
        throw error;
      }

      const player = createPlayer(displayName);
      session.players.push(player);
      session.updatedAt = new Date().toISOString();
      session.events.push(createEvent("system", `${displayName} joined the session.`));
      await writeStore(store);

      return {
        message: `${displayName} joined session ${session.id}.`,
        playerId: player.id,
        session: buildSessionView(session, player.id)
      };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Join failed." });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const viewerId = sanitizeText(req.query.playerId, 64);

  try {
    const session = await withDataLock(async () => {
      const store = await readStore();
      const entry = ensureSessionExists(store, sessionId);
      const changed = expireRoundIfNeeded(entry);

      if (changed) {
        entry.updatedAt = new Date().toISOString();
        await writeStore(store);
      }

      return entry;
    });

    res.json({ session: buildSessionView(session, viewerId) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not load session." });
  }
});

app.post("/api/sessions/:id/leave", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const playerId = sanitizeText(req.body?.playerId, 64);

  if (!playerId) {
    res.status(400).json({ message: "Player id is required." });
    return;
  }

  try {
    const result = await withDataLock(async () => {
      const store = await readStore();
      const session = ensureSessionExists(store, sessionId);
      const player = ensurePlayerInSession(session, playerId);
      const leavingWasGameMaster = playerId === session.currentGameMasterId;

      session.players = session.players.filter((entry) => entry.id !== playerId);
      session.events.push(createEvent("system", `${player.displayName} left the session.`));

      if (!session.players.length) {
        store.sessions = store.sessions.filter((entry) => entry.id !== session.id);
        await writeStore(store);
        return {
          deleted: true,
          message: "Session deleted because all players left."
        };
      }

      if (session.status === "in_progress" && leavingWasGameMaster) {
        endRound(session, {
          endReason: "player_left",
          message: `The round ended because ${player.displayName} left. The answer was "${session.round.answer}".`
        });
      } else if (leavingWasGameMaster) {
        session.currentGameMasterId = getNextGameMasterId(session, playerId);
        const nextGameMaster = getGameMaster(session);

        if (nextGameMaster) {
          session.events.push(
            createEvent("system", `${nextGameMaster.displayName} is now the game master.`)
          );
        }
      }

      session.updatedAt = new Date().toISOString();
      await writeStore(store);

      return {
        deleted: false,
        message: `${player.displayName} left the session.`
      };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not leave session." });
  }
});

app.post("/api/sessions/:id/question", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const playerId = sanitizeText(req.body?.playerId, 64);
  const question = sanitizeText(req.body?.question, 180);
  const answer = sanitizeText(req.body?.answer, 120);

  if (question.length < 6) {
    res.status(400).json({ message: "Question must be at least 6 characters long." });
    return;
  }

  if (answer.length < 1) {
    res.status(400).json({ message: "Answer is required." });
    return;
  }

  try {
    const result = await withDataLock(async () => {
      const store = await readStore();
      const session = ensureSessionExists(store, sessionId);
      ensurePlayerInSession(session, playerId);
      ensureGameMaster(session, playerId);
      expireRoundIfNeeded(session);

      if (session.status === "in_progress") {
        const error = new Error("You cannot change the question during an active round.");
        error.statusCode = 409;
        throw error;
      }

      session.round = {
        question,
        answer,
        status: "draft",
        createdBy: playerId,
        startedAt: null,
        expiresAt: null,
        endedAt: null,
        winnerPlayerId: null,
        endReason: null,
        attemptsByPlayer: {},
        guesses: []
      };
      session.updatedAt = new Date().toISOString();
      session.events.push(createEvent("system", "A new question is ready. The game master can start the round."));
      await writeStore(store);

      return {
        message: "Question saved. Start the round when everyone is ready.",
        session: buildSessionView(session, playerId)
      };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not save question." });
  }
});

app.post("/api/sessions/:id/start", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const playerId = sanitizeText(req.body?.playerId, 64);

  try {
    const result = await withDataLock(async () => {
      const store = await readStore();
      const session = ensureSessionExists(store, sessionId);
      ensurePlayerInSession(session, playerId);
      ensureGameMaster(session, playerId);
      expireRoundIfNeeded(session);

      if (session.players.length < 3) {
        const error = new Error("At least 3 players are required before the game starts.");
        error.statusCode = 400;
        throw error;
      }

      if (!session.round || session.round.status !== "draft") {
        const error = new Error("Create a question and answer before starting the game.");
        error.statusCode = 400;
        throw error;
      }

      session.status = "in_progress";
      session.roundNumber += 1;
      session.round.status = "active";
      session.round.startedAt = new Date().toISOString();
      session.round.expiresAt = new Date(Date.now() + ROUND_DURATION_MS).toISOString();
      session.updatedAt = new Date().toISOString();
      session.events.push(
        createEvent(
          "system",
          `Round ${session.roundNumber} started. Players have ${MAX_ATTEMPTS} attempts and 60 seconds.`
        )
      );
      await writeStore(store);

      return {
        message: "Game started.",
        session: buildSessionView(session, playerId)
      };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not start game." });
  }
});

app.post("/api/sessions/:id/guess", async (req, res) => {
  const sessionId = validateSessionCode(req.params.id);
  const playerId = sanitizeText(req.body?.playerId, 64);
  const guess = sanitizeText(req.body?.guess, 120);

  if (guess.length < 1) {
    res.status(400).json({ message: "Enter a guess before submitting." });
    return;
  }

  try {
    const result = await withDataLock(async () => {
      const store = await readStore();
      const session = ensureSessionExists(store, sessionId);
      const player = ensurePlayerInSession(session, playerId);
      expireRoundIfNeeded(session);

      if (session.status !== "in_progress" || !session.round || session.round.status !== "active") {
        const error = new Error("There is no active round right now.");
        error.statusCode = 409;
        throw error;
      }

      if (playerId === session.currentGameMasterId) {
        const error = new Error("The game master cannot submit guesses.");
        error.statusCode = 403;
        throw error;
      }

      const attemptsUsed = session.round.attemptsByPlayer[playerId] || 0;

      if (attemptsUsed >= MAX_ATTEMPTS) {
        const error = new Error("You have used all 3 attempts.");
        error.statusCode = 409;
        throw error;
      }

      const isCorrect = guess.toLowerCase() === session.round.answer.toLowerCase();
      session.round.attemptsByPlayer[playerId] = attemptsUsed + 1;
      session.round.guesses.push({
        playerId,
        guess,
        createdAt: new Date().toISOString(),
        isCorrect
      });
      session.events.push(
        createEvent(
          isCorrect ? "winner" : "guess",
          isCorrect
            ? `${player.displayName} guessed the correct answer.`
            : `${player.displayName} guessed "${guess}" and it was not correct.`,
          { playerId, guess, isCorrect }
        )
      );

      if (isCorrect) {
        endRound(session, {
          winnerPlayerId: playerId,
          endReason: "winner",
          message: `${player.displayName} won the round. The answer was "${session.round.answer}".`
        });
      }

      session.updatedAt = new Date().toISOString();
      await writeStore(store);

      return {
        message: isCorrect ? "You have won." : "Guess submitted.",
        session: buildSessionView(session, playerId)
      };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || "Could not submit guess." });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Unexpected server error.", error);
  res.status(500).json({ message: "Something unexpected happened." });
});

async function startServer() {
  await ensureDataFile();

  app.listen(PORT, () => {
    console.log(`Guessing game running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start the guessing game.", error);
  process.exit(1);
});
