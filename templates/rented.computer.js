// The whole of Mollama on a rented computer: it connects out to the Mollama server as one of its person's
// computers and passes the server's requests to the Ollama running beside it. It opens no door of its own,
// takes no part in pooling or training, and needs nothing but Node 22.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MB = 1024 * 1024;
const RECONNECT_MS = 5000;
const QUIET_MS = 90000;

const link = (() => {
    try {
        return JSON.parse(fs.readFileSync(process.env.MOLLAMA_LINK || '/opt/mollama/link.json', 'utf8'));
    } catch {
        return { socket: process.env.MOLLAMA_SOCKET, deviceId: process.env.MOLLAMA_DEVICE, key: process.env.MOLLAMA_KEY };
    }
})();
if (!link.socket || !link.deviceId || !link.key) {
    console.error('No link to Mollama was given.');
    process.exit(2);
}

const ollamaUrl = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/[/]+$/, '');
const modelsFolder = () => process.env.OLLAMA_MODELS || ['/usr/share/ollama/.ollama/models', path.join(os.homedir(), '.ollama', 'models')].find((folder) => fs.existsSync(folder)) || '/';

const run = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 10000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

const readGpus = async () => (await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']))
    .split(/\r?\n/).map((line) => line.split(',').map((part) => part.trim()))
    .map(([name, total]) => ({ name, memoryMb: Number(total) }))
    .filter((gpu) => gpu.name && gpu.memoryMb > 0);

const readDisk = async () => {
    try {
        const stats = await fs.promises.statfs(modelsFolder());
        return { diskFreeMb: Math.round((stats.bavail * stats.bsize) / MB), diskTotalMb: Math.round((stats.blocks * stats.bsize) / MB) };
    } catch {
        return { diskFreeMb: null, diskTotalMb: null };
    }
};

const readHardware = async () => {
    const [gpus, disk] = await Promise.all([readGpus(), readDisk()]);
    const cpus = os.cpus();
    return {
        hostname: os.hostname(),
        platform: process.platform,
        cpu: cpus[0]?.model?.trim() || null,
        cpuThreads: cpus.length,
        memoryMb: Math.round(os.totalmem() / MB),
        gpus,
        gpuMemoryMb: gpus.reduce((largest, gpu) => Math.max(largest, gpu.memoryMb), 0),
        ...disk,
        modelsPath: modelsFolder(),
        detectedAt: new Date().toISOString()
    };
};

const readFreeMemory = async () => {
    const card = (await run('nvidia-smi', ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits']))
        .split(/\r?\n/).map((line) => line.split(',').map(Number)).filter(([total, free]) => total > 0 && free >= 0).sort((a, b) => b[0] - a[0])[0];
    return { freeMb: Math.round(os.freemem() / MB), gpuFreeMb: card ? card[1] : null };
};

const ANSWERS = { hardware: readHardware, disk: readDisk, memory: readFreeMemory };

let socket = null;
let heard = 0;
const running = new Map();

const send = (message) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
};

const askOllama = (message, signal) => new Promise((resolve, reject) => {
    const body = message.body === undefined ? undefined : String(message.body);
    const request = http.request(ollamaUrl + message.path, {
        method: message.method || 'GET',
        signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    request.on('error', reject);
    request.end(body);
});

const answerRequest = async (message) => {
    let sent = 0;
    const reply = (part) => send({ id: message.id, n: sent += 1, ...part });
    if (typeof message.path !== 'string' || !message.path.startsWith('/api/') || message.via) return reply({ type: 'error', code: 'REFUSED' });
    const stop = new AbortController();
    running.set(message.id, stop);
    try {
        const answer = await askOllama(message, stop.signal);
        reply({ type: 'head', status: answer.statusCode, headers: { 'content-type': answer.headers['content-type'] || 'application/json' } });
        for await (const chunk of answer) reply({ type: 'chunk', data: Buffer.from(chunk).toString('base64') });
        reply({ type: 'end' });
    } catch (error) {
        if (!stop.signal.aborted) reply({ type: 'error', code: 'OLLAMA_DOWN', message: error.message });
    } finally {
        running.delete(message.id);
    }
    return undefined;
};

const onMessage = async (text) => {
    heard = Date.now();
    let message;
    try {
        message = JSON.parse(text);
    } catch {
        return;
    }
    if (message.type === 'request') await answerRequest(message);
    else if (message.type === 'cancel') running.get(message.id)?.abort();
    else if (message.type === 'ask') {
        const answer = ANSWERS[message.what];
        if (answer) send({ id: message.id, type: 'answer', data: await answer() });
        else send({ id: message.id, type: 'error', code: 'REFUSED' });
    } else if (message.type === 'tools') send({ id: message.id, type: 'error', code: 'REFUSED' });
    else if (message.type === 'train' && message.action === 'state') {
        send({ type: 'train-state', data: { version: 2, kit: 'unsupported', detail: 'A rented computer does not train models yet.' } });
    }
};

const connect = () => {
    const current = new WebSocket(link.socket);
    socket = current;
    let again = false;
    const retry = () => {
        if (again) return;
        again = true;
        for (const stop of running.values()) stop.abort();
        running.clear();
        setTimeout(connect, RECONNECT_MS);
    };
    current.addEventListener('open', () => {
        heard = Date.now();
        current.send(JSON.stringify({ type: 'hello', deviceId: link.deviceId, key: link.key, resume: true }));
    });
    current.addEventListener('message', (event) => {
        onMessage(String(event.data)).catch((error) => console.error('A message could not be answered:', error.message));
    });
    current.addEventListener('close', (event) => {
        // The server no longer knows this computer: its rental has ended, so there is nothing left to do.
        if (event.code === 1008 || (event.code === 1000 && event.reason === 'Removed')) {
            console.log('Mollama has let this computer go.');
            process.exit(0);
        }
        retry();
    });
    current.addEventListener('error', retry);
};

setInterval(() => {
    if (socket?.readyState === 1 && heard && Date.now() - heard > QUIET_MS) socket.close();
}, 15000);

connect();
