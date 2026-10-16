
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { io } = require("socket.io-client");

const BASE_URL = "https://classic.talkomatic.co";
const TOKEN_FILE = path.join(__dirname, "talkomatic-token.json");
const DATABASE_FILE = path.join(__dirname, "message-logs.json");

const BOT_NAME = "Message Logger";
const BOT_LOCATION = "by @future butters";
const GITHUB_URL = "https://github.com/absolutecc3d/Talko-Logger/tree/main";

const MAX_LOGS = 20000;
const MAX_OUTPUT_LENGTH = 4300;
const MAX_DISPLAY_TEXT = 230;
const CAPTURE_DELAY = 2000;
const COMMAND_DELAY = 1200;
const MAX_RESULTS = 50;

let socket;
let roomId = "";
let connected = false;
let signedIn = false;
let database = { rooms: {} };
let roomData;
let sessionCounter = 0;

const users = new Map();
const sessions = new Map();
const commandTimers = new Map();
const captureTimers = new Map();
const lastProcessedText = new Map();

function log(message, type = "INFO") {
  console.log(
    `[${new Date().toLocaleTimeString()}] [${type}] ${message}`
  );
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error("Missing talkomatic-token.json");
  }

  const data = JSON.parse(
    fs.readFileSync(TOKEN_FILE, "utf8")
  );

  const token = typeof data === "string"
    ? data
    : data.token ||
      data.botToken ||
      data.accessToken ||
      data.data?.token;

  if (!token) {
    throw new Error("No token found in talkomatic-token.json");
  }

  return String(token).trim();
}

function loadDatabase() {
  try {
    database = JSON.parse(
      fs.readFileSync(DATABASE_FILE, "utf8")
    );
  } catch {
    database = { rooms: {} };
  }

  if (
    !database ||
    typeof database !== "object" ||
    Array.isArray(database)
  ) {
    database = { rooms: {} };
  }

  if (
    !database.rooms ||
    typeof database.rooms !== "object" ||
    Array.isArray(database.rooms)
  ) {
    database.rooms = {};
  }

  if (
    !database.rooms[roomId] ||
    typeof database.rooms[roomId] !== "object"
  ) {
    database.rooms[roomId] = {
      logs: [],
      totalRecorded: 0
    };
  }

  roomData = database.rooms[roomId];

  if (!Array.isArray(roomData.logs)) {
    roomData.logs = [];
  }

  if (!Number.isFinite(roomData.totalRecorded)) {
    roomData.totalRecorded = roomData.logs.length;
  }

  roomData.logs = roomData.logs.filter(entry =>
    entry &&
    typeof entry.text === "string" &&
    typeof entry.username === "string"
  );

  for (const entry of roomData.logs) {
    if (typeof entry.hidden !== "boolean") {
      entry.hidden = false;
    }
  }

  saveDatabase();
}

function saveDatabase() {
  const temporaryFile = `${DATABASE_FILE}.tmp`;

  try {
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(database, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryFile, DATABASE_FILE);
  } catch (error) {
    log(`Failed to save database: ${error.message}`, "ERROR");
  }
}

function getUserId(user) {
  return user?.id ||
    user?.userId ||
    user?.socketId ||
    null;
}

function getUsername(user) {
  return String(
    user?.username ||
    user?.name ||
    user?.displayName ||
    "Unknown"
  ).trim().slice(0, 80);
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function safeText(text) {
  return String(text || "").trim();
}

function truncate(text, max = MAX_DISPLAY_TEXT) {
  const value = String(text || "").replace(/\r/g, "");

  return value.length > max
    ? `${value.slice(0, max - 3)}...`
    : value;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function isBot(user) {
  return normalizeName(getUsername(user)) ===
    normalizeName(BOT_NAME);
}

function cancelTimer(map, key) {
  if (map.has(key)) {
    clearTimeout(map.get(key));
    map.delete(key);
  }
}

function getSession(userId) {
  return sessions.get(String(userId));
}

function startSession(userId) {
  const user = users.get(String(userId));

  const session = {
    id: `${roomId}-${userId}-${Date.now()}-${++sessionCounter}`,
    userId: String(userId),
    username: getUsername(user),
    startedAt: Date.now(),
    latestText: ""
  };

  sessions.set(String(userId), session);

  return session;
}

function getVisibleEntriesForSession(sessionId) {
  return roomData.logs.filter(entry =>
    entry.sessionId === sessionId &&
    !entry.hidden
  );
}

function hideOlderVersions(sessionId, keepEntryId) {
  let changed = false;

  for (const entry of roomData.logs) {
    if (
      entry.sessionId === sessionId &&
      entry.id !== keepEntryId &&
      !entry.hidden
    ) {
      entry.hidden = true;
      entry.hiddenBy = keepEntryId;
      entry.hiddenAt = Date.now();
      changed = true;
    }
  }

  if (changed) {
    saveDatabase();
  }
}

function recordText(userId, text, reason = "observed", sessionId = null) {
  userId = String(userId);

  const user = users.get(userId);
  if (!user || isBot(user)) return null;

  const content = safeText(text);

  if (!content || content.startsWith("!")) return null;

  const existing = sessionId
    ? getVisibleEntriesForSession(sessionId)
    : [];

  const duplicate = existing.find(entry =>
    entry.text === content
  );

  if (duplicate) {
    if (reason === "final") {
      duplicate.reason = "final";
      duplicate.timestamp = Date.now();
      hideOlderVersions(sessionId, duplicate.id);
      saveDatabase();
    }

    return duplicate;
  }

  const entry = {
    id: ++roomData.totalRecorded,
    timestamp: Date.now(),
    userId,
    username: getUsername(user),
    text: content,
    reason,
    hidden: false,
    sessionId
  };

  roomData.logs.push(entry);

  if (roomData.logs.length > MAX_LOGS) {
    roomData.logs.splice(
      0,
      roomData.logs.length - MAX_LOGS
    );
  }

  if (sessionId && reason === "final") {
    hideOlderVersions(sessionId, entry.id);
  }

  saveDatabase();

  log(
    `Recorded ${entry.reason} text from ${entry.username}: ` +
    truncate(entry.text, 100)
  );

  return entry;
}

function applyDiff(current, diff) {
  if (!diff) return current;

  if (diff.type === "full-replace") {
    return String(diff.text || "");
  }

  if (diff.type === "add") {
    const index = Math.max(
      0,
      Math.min(current.length, Number(diff.index) || 0)
    );

    return current.slice(0, index) +
      String(diff.text || "") +
      current.slice(index);
  }

  if (diff.type === "delete") {
    const index = Math.max(
      0,
      Math.min(current.length, Number(diff.index) || 0)
    );

    const count = Math.max(0, Number(diff.count) || 0);

    return current.slice(0, index) +
      current.slice(index + count);
  }

  if (diff.type === "replace") {
    const index = Math.max(
      0,
      Math.min(current.length, Number(diff.index) || 0)
    );

    const count = Math.max(1, Number(diff.count) || 1);

    return current.slice(0, index) +
      String(diff.text || "") +
      current.slice(index + count);
  }

  return current;
}

function recordPreviousVersion(userId, oldText, newText) {
  const oldValue = safeText(oldText);
  const newValue = safeText(newText);

  if (!oldValue || oldValue.startsWith("!")) return;
  if (oldValue === newValue) return;

  const wasShortened = newValue.length < oldValue.length;
  const wasReplaced =
    !oldValue.includes(newValue) &&
    !newValue.includes(oldValue);

  if (!wasShortened && !wasReplaced) return;

  const session = getSession(userId);
  if (!session) return;

  recordText(
    userId,
    oldValue,
    "edited",
    session.id
  );
}

function scheduleCapture(userId, text) {
  userId = String(userId);

  cancelTimer(captureTimers, userId);

  const content = safeText(text);

  if (!content || content.startsWith("!")) return;

  const session = getSession(userId);
  if (!session) return;

  const sessionId = session.id;

  const timer = setTimeout(() => {
    captureTimers.delete(userId);

    const currentSession = getSession(userId);
    const user = users.get(userId);

    if (!currentSession || !user) return;
    if (currentSession.id !== sessionId) return;

    const currentText = safeText(user.typing);

    if (currentText !== content) return;

    currentSession.latestText = currentText;

    const entry = recordText(
      userId,
      currentText,
      "final",
      sessionId
    );

    if (entry) {
      hideOlderVersions(sessionId, entry.id);
    }
  }, CAPTURE_DELAY);

  captureTimers.set(userId, timer);
}

function finishSession(userId, finalText) {
  userId = String(userId);

  cancelTimer(captureTimers, userId);

  const session = getSession(userId);
  if (!session) return;

  const content = safeText(finalText || session.latestText);

  if (content && !content.startsWith("!")) {
    const entry = recordText(
      userId,
      content,
      "final",
      session.id
    );

    if (entry) {
      hideOlderVersions(session.id, entry.id);
    }
  }

  sessions.delete(userId);
}

function sendMessage(text) {
  if (!connected || !socket) return;

  socket.emit("chat update", {
    diff: {
      type: "full-replace",
      text: String(text).slice(0, MAX_OUTPUT_LENGTH)
    }
  });
}

function show(text) {
  const header =
    `MESSAGE LOGGER | ROOM ${roomId}\n` +
    "----------------------------------------\n\n";

  const footer =
    "\n\n----------------------------------------\n" +
    "Local message history | !help";

  const content = String(text || "").trim();

  const available = MAX_OUTPUT_LENGTH -
    header.length -
    footer.length;

  const body = content.length > available
    ? `${content.slice(0, available - 30)}\n\n[Output shortened]`
    : content;

  sendMessage(header + body + footer);
}

function getLatestLogs(count = 15, raw = false) {
  return roomData.logs
    .filter(entry => raw || !entry.hidden)
    .slice(-count)
    .reverse();
}

function formatEntry(entry) {
  const hiddenLabel = entry.hidden ? " [HIDDEN]" : "";
  const reason = entry.reason || "observed";

  return [
    `#${entry.id} | ${formatDate(entry.timestamp)}`,
    `@${entry.username} [${reason}]${hiddenLabel}`,
    truncate(entry.text, MAX_DISPLAY_TEXT)
  ].join("\n");
}

function showEntries(title, entries) {
  if (!entries.length) {
    show(`${title}\n\nNo matching entries found.`);
    return;
  }

  show(
    `${title}\n` +
    `Showing ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n\n` +
    entries.map(formatEntry).join("\n\n")
  );
}

function handleLogs(argument) {
  const parts = argument.trim().split(/\s+/).filter(Boolean);

  let raw = false;

  if (parts[0]?.toLowerCase() === "raw") {
    raw = true;
    parts.shift();
  }

  let limit = 15;
  const lastPart = parts[parts.length - 1];

  if (/^\d+$/.test(lastPart || "")) {
    limit = Math.max(
      1,
      Math.min(MAX_RESULTS, Number(lastPart))
    );

    parts.pop();
  }

  const username = parts.join(" ").trim();

  if (!username) {
    return showEntries(
      raw ? "RAW TYPING HISTORY" : "LATEST RECORDED TEXT",
      getLatestLogs(limit, raw)
    );
  }

  const matches = roomData.logs
    .filter(entry =>
      normalizeName(entry.username) === normalizeName(username) &&
      (raw || !entry.hidden)
    )
    .slice(-limit)
    .reverse();

  showEntries(
    `${raw ? "RAW HISTORY" : "RECENT HISTORY"}: ${username}`,
    matches
  );
}

function handleSearch(query) {
  if (!query.trim()) {
    show("Usage: !search keyword");
    return;
  }

  const wanted = query.toLowerCase();

  const matches = roomData.logs
    .filter(entry =>
      !entry.hidden &&
      entry.text.toLowerCase().includes(wanted)
    )
    .slice(-MAX_RESULTS)
    .reverse();

  showEntries(`SEARCH RESULTS: ${query}`, matches);
}

function showStats() {
  const visible = roomData.logs.filter(entry => !entry.hidden);
  const hidden = roomData.logs.filter(entry => entry.hidden);

  const uniqueUsers = new Set(
    roomData.logs.map(entry => entry.userId)
  );

  const latest = visible[visible.length - 1];

  show([
    "LOGGER STATISTICS",
    "",
    `Room: ${roomId}`,
    `Visible entries: ${visible.length}`,
    `Hidden older versions: ${hidden.length}`,
    `Total entries recorded: ${roomData.totalRecorded}`,
    `Unique users recorded: ${uniqueUsers.size}`,
    `Storage limit: ${MAX_LOGS} entries`,
    `Latest visible entry: ${latest ? formatDate(latest.timestamp) : "None"}`
  ].join("\n"));
}

function clearLogs() {
  roomData.logs = [];
  roomData.totalRecorded = 0;

  saveDatabase();

  show(
    "LOCAL HISTORY CLEARED\n\n" +
    "All recorded history for this room has been cleared."
  );

  log(`Local history cleared for room ${roomId}`, "WARN");
}

function showHelp() {
  show([
    "COMMANDS",
    "",
    "!logs",
    "Show the latest consolidated entries.",
    "",
    "!logs username",
    "Show visible entries from a user.",
    "",
    "!logs username 50",
    "Show up to 50 visible entries.",
    "",
    "!logs raw username",
    "Show hidden and visible versions for a user.",
    "",
    "!logs raw username 50",
    "Show up to 50 raw entries.",
    "",
    "!logs raw",
    "Show the latest raw entries from everyone.",
    "",
    "!search keyword",
    "Search visible entries.",
    "",
    "!logstats",
    "Show recording statistics.",
    "",
    "!logclear",
    "Clear this room's history.",
    "",
    "Consolidation waits 2 seconds after typing stops.",
    "Older versions are hidden, not deleted.",
    "Raw history only contains updates the logger observed."
  ].join("\n"));
}

function handleCommand(text, user) {
  const match = text.trim().match(/^!(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return;

  const command = match[1].toLowerCase();
  const argument = (match[2] || "").trim();

  log(`Command from ${getUsername(user)}: !${command}`);

  switch (command) {
    case "help":
      showHelp();
      break;

    case "logs":
      handleLogs(argument);
      break;

    case "search":
      handleSearch(argument);
      break;

    case "logstats":
      showStats();
      break;

    case "logclear":
      clearLogs();
      break;

    default:
      show(`Unknown command: !${command}\n\nUse !help.`);
  }
}

function handleUserUpdate(data) {
  if (!data?.userId || !data?.diff) return;

  const userId = String(data.userId);
  const user = users.get(userId);

  if (!user || isBot(user)) return;

  const oldText = String(user.typing || "");
  const newText = applyDiff(oldText, data.diff);

  if (newText === oldText) return;

  if (!safeText(newText)) {
    finishSession(userId, oldText);

    user.typing = "";
    cancelTimer(commandTimers, userId);
    lastProcessedText.delete(userId);

    return;
  }

  if (!getSession(userId)) {
    startSession(userId);
  }

  recordPreviousVersion(userId, oldText, newText);

  user.typing = newText;

  const session = getSession(userId);
  if (session) {
    session.latestText = newText;
  }

  if (newText.trimStart().startsWith("!")) {
    cancelTimer(captureTimers, userId);
    cancelTimer(commandTimers, userId);

    const timer = setTimeout(() => {
      commandTimers.delete(userId);

      const currentText = safeText(user.typing);

      if (!currentText.startsWith("!")) return;
      if (lastProcessedText.get(userId) === currentText) return;

      lastProcessedText.set(userId, currentText);

      handleCommand(currentText, user);
    }, COMMAND_DELAY);

    commandTimers.set(userId, timer);
    return;
  }

  cancelTimer(commandTimers, userId);
  lastProcessedText.delete(userId);

  scheduleCapture(userId, newText);
}

function registerUsers(userList) {
  const list = Array.isArray(userList)
    ? userList
    : Object.values(userList || {});

  for (const item of list) {
    const id = getUserId(item);
    if (!id) continue;

    const userId = String(id);
    const existing = users.get(userId);

    users.set(userId, {
      ...existing,
      ...item,
      typing: existing?.typing || ""
    });
  }
}

function handleUserJoined(user) {
  const id = getUserId(user);
  if (!id) return;

  const userId = String(id);
  const existing = users.get(userId);

  users.set(userId, {
    ...existing,
    ...user,
    typing: existing?.typing || ""
  });

  log(`User joined: ${getUsername(user)}`);
}

function handleUserLeft(userOrId) {
  const id = typeof userOrId === "string"
    ? userOrId
    : getUserId(userOrId);

  if (!id) return;

  const userId = String(id);
  const user = users.get(userId);

  if (user?.typing) {
    finishSession(userId, user.typing);
  } else {
    cancelTimer(captureTimers, userId);
    sessions.delete(userId);
  }

  users.delete(userId);
  cancelTimer(commandTimers, userId);
  lastProcessedText.delete(userId);
}

async function start() {
  const rl = readline.createInterface({ input, output });

  try {
    roomId = (
      await rl.question("Enter the six-digit Talkomatic room ID: ")
    ).trim();
  } finally {
    rl.close();
  }

  if (!/^\d{6}$/.test(roomId)) {
    throw new Error("Room ID must be exactly six digits.");
  }

  loadDatabase();

  const token = readToken();

  console.log("");
  console.log("MESSAGE LOGGER");
  console.log("------------------------------");
  console.log(`Room: ${roomId}`);
  console.log("Local storage: message-logs.json");
  console.log(`Capture delay: ${CAPTURE_DELAY}ms`);
  console.log(`Maximum entries: ${MAX_LOGS}`);
  console.log("");

  socket = io(BASE_URL, {
    auth: callback => callback({ token }),
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    timeout: 20000
  });

  socket.on("connect", () => {
    log("Connected to Talkomatic");

    connected = false;
    signedIn = false;

    socket.emit("join lobby", {
      username: BOT_NAME,
      location: BOT_LOCATION
    });
  });

  socket.on("signin status", payload => {
    log(`Sign-in status: ${JSON.stringify(payload)}`);

    if (!payload?.isSignedIn) {
      signedIn = false;
      log("Sign-in wasn't confirmed. Check the token.", "ERROR");
      return;
    }

    if (signedIn) return;

    signedIn = true;
    socket.emit("join room", { roomId });
  });

  socket.on("room joined", data => {
    connected = true;
    registerUsers(data?.users || []);

    log(`Joined room ${roomId}`);

    sendMessage(
      `MESSAGE LOGGER | ROOM ${roomId}\n` +
      "----------------------------------------\n" +
      "Logger is online.\n" +
      "Consolidated logging enabled.\n" +
      `Get the bot: ${GITHUB_URL}\n` +
      "Use !help to see commands."
    );
  });

  socket.on("user joined", handleUserJoined);
  socket.on("user left", handleUserLeft);
  socket.on("chat update", handleUserUpdate);

  socket.on("connect_error", error => {
    log(`Connection error: ${error.message}`, "ERROR");
  });

  socket.on("disconnect", reason => {
    connected = false;
    signedIn = false;
    log(`Disconnected: ${reason}`, "WARN");
  });

  socket.on("afk warning", payload => {
    socket.emit("afk response", payload || {});
  });

  socket.on("kicked", payload => {
    log(`Bot was kicked: ${JSON.stringify(payload || {})}`, "ERROR");
  });

  socket.on("error", error => {
    log(
      `Socket error: ${error?.message || JSON.stringify(error)}`,
      "ERROR"
    );
  });
}

function shutdown() {
  for (const timer of commandTimers.values()) {
    clearTimeout(timer);
  }

  for (const timer of captureTimers.values()) {
    clearTimeout(timer);
  }

  saveDatabase();

  if (socket) socket.disconnect();

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", error => {
  log(`Unexpected error: ${error.stack || error.message}`, "ERROR");
});

process.on("unhandledRejection", error => {
  log(`Unhandled rejection: ${error?.stack || error}`, "ERROR");
});

start().catch(error => {
  log(error.stack || error.message, "ERROR");
  process.exit(1);
});
