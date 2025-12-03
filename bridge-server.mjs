import { createServer } from "http";
import { bridgeHandler } from "./bridge.mjs";

const PORT = parseInt(process.env.BRIDGE_PORT || "4000", 10);

process.env.UV_THREADPOOL_SIZE = 128;

if (global.gc) {
    setInterval(() => {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        if (used > 3000) global.gc();
    }, 30000);
}

const server = createServer((req, res) => {
    bridgeHandler(req, res);
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;

server.on("error", err => console.error(`Bridge error: ${err}`));

server.listen(PORT, () => {
    console.log(`Bridge ${process.pid} listening on port ${PORT}`);
});