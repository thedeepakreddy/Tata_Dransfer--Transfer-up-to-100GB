import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import http from "http";
import { attachSignaling, MAX_MESSAGE_BYTES } from "./signaling-core.js";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost';
      const pathname = request.url ? new URL(request.url, `http://${host}`).pathname : '';
      if (pathname === "/signaling" || pathname === "/signaling/") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      console.error("Error in upgrade handler:", err);
      socket.destroy();
    }
  });

  // Room management, relaying, validation, limits and heartbeats are shared
  // with the standalone signaling-server.js (see signaling-core.js).
  attachSignaling(wss);

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
