const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 30 * 1024 * 1024
});
const PORT = process.env.PORT || 55000;
const USERS_FILE = path.join(__dirname, "users.json");
const HISTORY_FILE = path.join(__dirname, "chat_history.txt");
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const DEFAULT_AVATAR = "https://i.imgur.com/4M34hi2.png";
const MAX_HISTORY_MESSAGES = 500;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

app.use(express.static("public"));
app.use("/uploads", express.static(UPLOADS_DIR));

app.get(["/", "/index.html", "/chat.html", "/admin.html"], (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

let onlineUsers = {};
let pendingWatchers = {};

function normalizeUsername(username = "") {
    return username.trim().toLowerCase();
}

function loadRegisteredUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
            return {};
        }

        const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        console.error("No se pudo leer users.json:", error.message);
        return {};
    }
}

function saveRegisteredUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function ensureUploadsDir() {
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
}

function normalizeUsersData(data) {
    const safeData = data && typeof data === "object" ? data : {};
    const keys = Object.keys(safeData);

    for (const key of keys) {
        const user = safeData[key] || {};
        safeData[key] = {
            username: user.username || key,
            avatar: user.avatar || DEFAULT_AVATAR,
            passwordHash: user.passwordHash || "",
            createdAt: user.createdAt || new Date().toISOString(),
            role: user.role === "admin" ? "admin" : "user",
            status: ["approved", "pending", "rejected"].includes(user.status) ? user.status : "approved",
            reviewedBy: user.reviewedBy || null,
            reviewedAt: user.reviewedAt || null
        };
    }

    const admins = Object.values(safeData).filter((u) => u.role === "admin");
    if (admins.length === 0 && keys.length > 0) {
        const firstKey = keys[0];
        safeData[firstKey].role = "admin";
        safeData[firstKey].status = "approved";
    }

    return safeData;
}

function getPendingRequests() {
    return Object.values(registeredUsers)
        .filter((u) => u.status === "pending")
        .map((u) => ({
            username: u.username,
            avatar: u.avatar || DEFAULT_AVATAR,
            createdAt: u.createdAt
        }));
}

function emitPendingRequestsToAdmins() {
    const pending = getPendingRequests();

    for (const [socketId, user] of Object.entries(onlineUsers)) {
        if (user.role === "admin") {
            io.to(socketId).emit("pendingRequests", pending);
        }
    }
}

let registeredUsers = normalizeUsersData(loadRegisteredUsers());
saveRegisteredUsers(registeredUsers);
ensureUploadsDir();

function loadChatHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) {
            fs.writeFileSync(HISTORY_FILE, "", "utf8");
            return [];
        }

        const raw = fs.readFileSync(HISTORY_FILE, "utf8");
        if (!raw) return [];

        const lines = raw.split(/\r?\n/).filter(Boolean);
        const parsed = [];

        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                if (msg && typeof msg === "object") {
                    parsed.push(msg);
                }
            } catch {
                // Ignorar línea dañada
            }
        }

        return parsed.slice(-MAX_HISTORY_MESSAGES);
    } catch (error) {
        console.error("No se pudo leer chat_history.txt:", error.message);
        return [];
    }
}

function appendChatHistory(message) {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(message) + "\n", "utf8");
}

let chatHistory = loadChatHistory();
let messagesSinceCompaction = 0;

function compactHistoryFileIfNeeded() {
    messagesSinceCompaction += 1;

    if (chatHistory.length < MAX_HISTORY_MESSAGES) return;
    if (messagesSinceCompaction < 50) return;

    const content = chatHistory.map((m) => JSON.stringify(m)).join("\n") + "\n";
    fs.writeFileSync(HISTORY_FILE, content, "utf8");
    messagesSinceCompaction = 0;
}

function buildMessage({ user, text, avatar, type = "text", mediaUrl = "", fileName = "" }) {
    return {
        user,
        text,
        avatar: avatar || DEFAULT_AVATAR,
        type,
        mediaUrl,
        fileName,
        timestamp: new Date().toISOString()
    };
}

function broadcastMessage(messageData) {
    const message = buildMessage(messageData);
    io.emit("message", message);

    chatHistory.push(message);
    if (chatHistory.length > MAX_HISTORY_MESSAGES) {
        chatHistory = chatHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    appendChatHistory(message);
    compactHistoryFileIfNeeded();
}

function parseDataUrl(dataUrl = "") {
    const match = /^data:(.+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;

    return {
        mimeType: match[1],
        base64Data: match[2]
    };
}

function getExtensionFromMime(mimeType = "") {
    const map = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "video/ogg": "ogv",
        "video/quicktime": "mov"
    };

    return map[mimeType] || "bin";
}

io.on("connection", (socket) => {

    socket.on("register", async ({ username, avatar, password }) => {
        const cleanUsername = (username || "").trim();
        const cleanPassword = password || "";
        const cleanAvatar = (avatar || "").trim() || DEFAULT_AVATAR;
        const userKey = normalizeUsername(cleanUsername);
        const usernamePattern = /^[a-zA-Z0-9_.-]{3,20}$/;

        if (!usernamePattern.test(cleanUsername)) {
            socket.emit("errorMsg", "Username inválido (3-20, solo letras, números, _, -, .)");
            return;
        }

        if (cleanPassword.length < 4) {
            socket.emit("errorMsg", "La contraseña debe tener al menos 4 caracteres");
            return;
        }

        if (registeredUsers[userKey]) {
            socket.emit("errorMsg", "Ese username ya existe o está pendiente de aprobación");
            return;
        }

        try {
            const passwordHash = await bcrypt.hash(cleanPassword, 10);

            registeredUsers[userKey] = {
                username: cleanUsername,
                avatar: cleanAvatar,
                passwordHash,
                createdAt: new Date().toISOString(),
                role: "user",
                status: "pending",
                reviewedBy: null,
                reviewedAt: null
            };

            saveRegisteredUsers(registeredUsers);

            if (!pendingWatchers[userKey]) {
                pendingWatchers[userKey] = new Set();
            }
            pendingWatchers[userKey].add(socket.id);

            socket.emit("registerPending", {
                username: cleanUsername,
                message: "Solicitud enviada. Un admin debe aprobar tu acceso."
            });

            emitPendingRequestsToAdmins();
        } catch (error) {
            console.error("Error al registrar usuario:", error.message);
            socket.emit("errorMsg", "No se pudo registrar el usuario");
        }
    });

    socket.on("login", async ({ username, password }) => {
        const cleanUsername = (username || "").trim();
        const cleanPassword = password || "";
        const userKey = normalizeUsername(cleanUsername);
        const registeredUser = registeredUsers[userKey];

        if (!registeredUser) {
            socket.emit("errorMsg", "Usuario no encontrado");
            return;
        }

        if (registeredUser.status === "pending") {
            socket.emit("errorMsg", "Tu solicitud sigue pendiente de aprobación");
            if (!pendingWatchers[userKey]) {
                pendingWatchers[userKey] = new Set();
            }
            pendingWatchers[userKey].add(socket.id);
            return;
        }

        if (registeredUser.status === "rejected") {
            socket.emit("errorMsg", "Tu solicitud fue rechazada por un administrador");
            return;
        }

        const validPassword = await bcrypt.compare(cleanPassword, registeredUser.passwordHash);
        if (!validPassword) {
            socket.emit("errorMsg", "Contraseña incorrecta");
            return;
        }

        onlineUsers[socket.id] = {
            username: registeredUser.username,
            avatar: registeredUser.avatar || DEFAULT_AVATAR,
            role: registeredUser.role || "user"
        };

        socket.emit("authSuccess", onlineUsers[socket.id]);
        socket.emit("chatHistory", chatHistory);

        if (onlineUsers[socket.id].role === "admin") {
            socket.emit("pendingRequests", getPendingRequests());
        }

        broadcastMessage({
            user: "Sistema",
            text: registeredUser.username + " entró al chat"
        });
    });

    socket.on("reviewRequest", ({ username, action }) => {
        const admin = onlineUsers[socket.id];
        if (!admin || admin.role !== "admin") {
            socket.emit("errorMsg", "No autorizado");
            return;
        }

        const targetUsername = (username || "").trim();
        const targetKey = normalizeUsername(targetUsername);
        const targetUser = registeredUsers[targetKey];

        if (!targetUser) {
            socket.emit("errorMsg", "Solicitud no encontrada");
            return;
        }

        if (targetUser.status !== "pending") {
            socket.emit("errorMsg", "Esa solicitud ya fue revisada");
            return;
        }

        const isApprove = action === "approve";
        targetUser.status = isApprove ? "approved" : "rejected";
        targetUser.reviewedBy = admin.username;
        targetUser.reviewedAt = new Date().toISOString();

        saveRegisteredUsers(registeredUsers);
        emitPendingRequestsToAdmins();

        const targetSockets = pendingWatchers[targetKey];
        if (targetSockets && targetSockets.size > 0) {
            for (const targetSocketId of targetSockets) {
                io.to(targetSocketId).emit("requestReviewed", {
                    status: targetUser.status,
                    username: targetUser.username,
                    by: admin.username
                });
            }

            if (!isApprove) {
                pendingWatchers[targetKey].clear();
            }
        }
    });

    socket.on("sendMessage", (msg) => {
        const user = onlineUsers[socket.id];

        if (!user) return;

        const cleanMessage = (msg || "").trim();
        if (!cleanMessage) return;

        broadcastMessage({
            user: user.username,
            avatar: user.avatar,
            text: cleanMessage
        });
    });

    socket.on("sendMedia", ({ dataUrl, fileName }) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        const parsed = parseDataUrl(dataUrl);
        if (!parsed) {
            socket.emit("errorMsg", "Archivo inválido");
            return;
        }

        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/webm",
            "video/ogg",
            "video/quicktime"
        ];

        if (!allowedTypes.includes(parsed.mimeType)) {
            socket.emit("errorMsg", "Solo se permiten imágenes o videos comunes");
            return;
        }

        const fileBuffer = Buffer.from(parsed.base64Data, "base64");
        if (fileBuffer.length > MAX_MEDIA_BYTES) {
            socket.emit("errorMsg", "Archivo demasiado pesado (máx 25MB)");
            return;
        }

        const extension = getExtensionFromMime(parsed.mimeType);
        const safeBaseName = (fileName || "archivo")
            .replace(/[^a-zA-Z0-9_.-]/g, "_")
            .slice(0, 40);
        const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeBaseName}.${extension}`;
        const storedPath = path.join(UPLOADS_DIR, storedName);

        fs.writeFileSync(storedPath, fileBuffer);

        broadcastMessage({
            user: user.username,
            avatar: user.avatar,
            type: parsed.mimeType.startsWith("image/") ? "image" : "video",
            text: "",
            mediaUrl: `/uploads/${storedName}`,
            fileName: fileName || storedName
        });
    });

    socket.on("disconnect", () => {
        const user = onlineUsers[socket.id];
        if (user) {
            broadcastMessage({
                user: "Sistema",
                text: user.username + " salió"
            });
            delete onlineUsers[socket.id];
        }

        for (const key of Object.keys(pendingWatchers)) {
            pendingWatchers[key].delete(socket.id);
            if (pendingWatchers[key].size === 0) {
                delete pendingWatchers[key];
            }
        }
    });
});

server.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));




