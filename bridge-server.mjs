import cluster from "cluster";
import os from "os";

const PORT = parseInt(process.env.BRIDGE_PORT || "4000", 10);
const isPrimary = cluster.isPrimary ?? cluster.isMaster;
const isPm2Managed = Boolean(process.env.pm_id || process.env.PM2_HOME || process.env.PM2);
const cpuCount = os.availableParallelism ? os.availableParallelism() : (os.cpus()?.length || 1);
const workerCount = Math.max(1, parseInt(process.env.BRIDGE_WORKERS || "", 10) || cpuCount);
const threadPoolSize = String(Math.max(4, Math.min(64, (cpuCount || 1) * 4)));
const shouldUseCluster = !isPm2Managed && isPrimary && workerCount > 1 && process.env.BRIDGE_DISABLE_CLUSTER !== "1";

const startWorker = () => {
    const env = {
        ...process.env,
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || threadPoolSize
    };
    const worker = cluster.fork(env);
    worker.on("online", () => console.log(`Bridge worker ${worker.process.pid} online`));
    worker.on("exit", (code, signal) => {
        console.error(`Bridge worker ${worker.process.pid} exited (${signal || code}), restarting...`);
        if (shouldUseCluster) setTimeout(() => startWorker(), 500);
    });
    return worker;
};

if (shouldUseCluster) {
    console.log(`Bridge primary starting ${workerCount} workers on port ${PORT} (threadpool ${threadPoolSize})`);
    for (let i = 0; i < workerCount; i++) startWorker();
} else {
    process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || threadPoolSize;

    const { createServer } = await import("http");
    const { bridgeHandler } = await import("./bridge.mjs");

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

    server.on("error", err => console.error(`Bridge error (pid ${process.pid}): ${err}`));

    server.listen(PORT, () => {
        console.log(`Bridge worker ${process.pid} listening on port ${PORT}`);
    });
}
