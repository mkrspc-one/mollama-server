import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statfs, readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { Ollama } from 'ollama';
import Anthropic from '@anthropic-ai/sdk';
import { Client, StreamableHTTPClientTransport, SSEClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

const ERROR_TABLE = {
    OLLAMA_DOWN: {
        status: 503,
        message: 'Ollama is not running on the computer chosen for models.',
        action: 'Start Ollama there, or pick another computer.'
    },
    MODEL_MISSING: {
        status: 404,
        message: 'This model is not installed on this device.',
        action: 'Download the model first.'
    },
    MODEL_NOT_FOUND: {
        status: 404,
        message: 'No model with this name could be found.',
        action: 'Check the spelling. A model name looks like llama3.2:3b.'
    },
    MODEL_TOO_LARGE: {
        status: 422,
        message: 'This model is too large for this device.',
        action: 'Pick a smaller model. The Discover tab shows which ones fit.'
    },
    NOT_ENOUGH_MEMORY: {
        status: 409,
        message: 'This model needs more memory than this computer has free, and loading it could freeze the whole computer.',
        action: 'Pick a smaller model, or close large apps and unload other models first.'
    },
    MODEL_IN_USE: {
        status: 409,
        message: 'This model is answering right now, so it was not removed from memory.',
        action: 'Wait for the reply to finish, or stop it and remove the model.'
    },
    OUT_OF_MEMORY: {
        status: 422,
        message: 'This model needs more memory than this device has free.',
        action: 'Unload other models or pick a smaller one.'
    },
    DISK_FULL: {
        status: 422,
        message: 'There is not enough disk space on this device.',
        action: 'Remove a model you no longer use, then try again.'
    },
    DOWNLOAD_INTERRUPTED: {
        status: 502,
        message: 'The download stopped before it finished.',
        action: 'Resume the download. It continues from where it stopped.'
    },
    NO_TOOL_SUPPORT: {
        status: 422,
        message: 'This model cannot use tools.',
        action: 'Pick a model that supports tools.'
    },
    REPLY_CUT: {
        status: 422,
        message: 'The model ran out of room before it finished, so this reply is incomplete.',
        action: 'Ask again in a new chat, turn off a long skill, or pick a model that can read more.'
    },
    RENTAL_ENDED: {
        status: 410,
        message: 'The rented computer was ended while this reply was being written, so it is incomplete.',
        action: 'Rent a computer again or choose another one, then ask again.'
    },
    SERVER_RESTARTED: {
        status: 503,
        message: 'Mollama restarted while this reply was being written, so it is incomplete.',
        action: 'Ask again to get the whole reply.'
    },
    CALL_UNREADABLE: {
        status: 502,
        message: 'The model tried to use a function but wrote the request so that it could not be read.',
        action: 'Ask again. If it keeps happening, pick a model that is better with tools.'
    },
    TOO_LONG: {
        status: 422,
        message: 'This message is too long for this model, even with the earlier messages compressed.',
        action: 'Shorten the message or send it in parts, or pick a model that can read more.'
    },
    NO_MODELS: {
        status: 409,
        message: 'No model is installed on this device yet.',
        action: 'Download one on the Models page.'
    },
    QUEUE_FULL: {
        status: 429,
        message: 'You already have 5 requests waiting for the model.',
        action: 'Wait for one to finish, then try again.'
    },
    CHAT_FULL: {
        status: 422,
        message: 'This chat has reached its limit of 200 messages.',
        action: 'Start a new chat from a summary.'
    },
    DOCUMENT_TOO_LONG: {
        status: 422,
        message: 'This document is longer than this model can read.',
        action: 'Use a shorter document, or pick a model that can read more.'
    },
    FILE_TOO_LARGE: {
        status: 413,
        message: 'This file is larger than 20 MB.',
        action: 'Use a smaller file.'
    },
    FILE_UNREADABLE: {
        status: 415,
        message: 'This kind of file cannot be read as text.',
        action: 'Use a text, Markdown, CSV, PDF or Word (.docx) file.'
    },
    FILE_NOT_FOUND: {
        status: 404,
        message: 'This file could not be found, or you do not have access to it.',
        action: 'Pick another file.'
    },
    FILE_NOT_SAVED: {
        status: 403,
        message: 'The file could not be saved in this folder.',
        action: 'Pick a folder you are allowed to add files to.'
    },
    NO_VISION: {
        status: 400,
        message: 'This model cannot see images.',
        action: 'Pick a model marked Vision to attach an image.'
    },
    IMAGE_TOO_LARGE: {
        status: 413,
        message: 'This image is larger than 4 MB, or the chat already holds 10 MB of images.',
        action: 'Use a smaller image, or start a new chat.'
    },
    FILES_DOWN: {
        status: 503,
        message: 'Your files could not be reached. FilesystemOne may still be starting up, which can take a minute.',
        action: 'Try again in a minute. Everything else keeps working.'
    },
    REMOTE_BLOCKED: {
        status: 400,
        message: 'This address cannot be loaded.',
        action: 'Only public https addresses can be shown.'
    },
    REMOTE_FAILED: {
        status: 502,
        message: 'The file could not be loaded from its address.',
        action: 'Check the address, or open it in a new tab.'
    },
    SEARCH_DOWN: {
        status: 502,
        message: 'The search service could not be reached.',
        action: 'Check the search service set on the server.'
    },
    SEARCH_LIMITED: {
        status: 503,
        message: 'The search service is limiting requests right now.',
        action: 'Wait a few minutes before searching again.'
    },
    LIBRARY_UNREACHABLE: {
        status: 502,
        message: 'The list of models could not be loaded from ollama.com.',
        action: 'Check the connection and try again, or add a model by its name.'
    },
    LIBRARY_UNREADABLE: {
        status: 502,
        message: 'The list of models on ollama.com could not be read.',
        action: 'Add a model by its name for now. The page layout on ollama.com may have changed.'
    },
    SEARCH_REFUSED: {
        status: 502,
        message: 'The search service refused the request.',
        action: 'Check the search key or settings on the server.'
    },
    REMOTE_NOT_FOUND: {
        status: 404,
        message: 'Nothing exists at this address.',
        action: 'The address may have been written from memory instead of found. Ask the model to search for the file again.'
    },
    REMOTE_BUSY: {
        status: 503,
        message: 'The site is limiting how often its files can be loaded.',
        action: 'Wait a moment and try again, or open the address in a new tab.'
    },
    REMOTE_TOO_LARGE: {
        status: 413,
        message: 'This file is larger than 50 MB.',
        action: 'Open it in a new tab instead.'
    },
    NO_DEVICE: {
        status: 503,
        message: 'No device is connected to your account.',
        action: 'Open the Mollama desktop app on a computer and sign in.'
    },
    NOTHING_READY: {
        status: 503,
        message: 'None of your computers can run models right now.',
        action: 'Open the Mollama desktop app on one of them and make sure Ollama is running.'
    },
    DEVICE_PAUSED: {
        status: 503,
        message: 'This computer is paused.',
        action: 'Resume it on the Devices page, or pick another computer.'
    },
    KEY_REFUSED: {
        status: 401,
        message: 'The online service did not accept your key.',
        action: 'Replace the key on the Models page, under Online.'
    },
    OUT_OF_CREDIT: {
        status: 402,
        message: 'Your account with this online service is out of credit or over its limit.',
        action: 'Add credit with that service, or pick another model.'
    },
    PROVIDER_BUSY: {
        status: 429,
        message: 'The online service is taking too many requests right now.',
        action: 'Try again in a moment.'
    },
    PROVIDER_DOWN: {
        status: 503,
        message: 'The online service could not be reached.',
        action: 'Try again shortly, or pick another model.'
    },
    POOL_NOT_READY: {
        status: 503,
        message: 'Your pool is not ready right now.',
        action: 'Open Pooling on the Devices page: choose a primary computer, which runs the model, and set another as a secondary computer, which lends its memory, both connected.'
    },
    POOL_FAILED: {
        status: 503,
        message: 'The pool could not start this model.',
        action: 'Close large apps on the pooled computers and try again, or pick a smaller model.'
    },
    POOL_STOPPED: {
        status: 503,
        message: 'A computer in the pool stopped answering, so the reply stopped.',
        action: 'Check that every pooled computer is awake and connected, then try again.'
    },
    DEVICE_OFFLINE: {
        status: 503,
        message: 'This device is not connected right now.',
        action: 'Open the Mollama desktop app on that computer, or pick another device.'
    },
    UNKNOWN: {
        status: 502,
        message: 'Ollama reported a problem it did not explain.',
        action: 'Try again. If it keeps happening, restart Ollama.'
    }
};

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

// What Ollama says when a model's function call is not something it can parse.
export const UNREADABLE_CALL = /tool call|invalid character .{1,12}(looking for|after|in )|unexpected end of JSON|cannot unmarshal/i;
const RULES = [
    ['DISK_FULL', /no space left|not enough (disk )?space|insufficient disk/i],
    ['OUT_OF_MEMORY', /requires more system memory|out of memory|insufficient memory|not enough memory|cuda error.*memory/i],
    ['NO_TOOL_SUPPORT', /does not support (tools|tool use|function calling)|support tool use|(tools?|function calling|tool use) (is|are) not (supported|enabled|available)/i],
    ['TOO_LONG', /context length|context window|exceeds? (the )?(maximum |available )?context|prompt is too long/i],
    ['DOWNLOAD_INTERRUPTED', /unexpected eof|connection reset|stalled|max retries exceeded|pull.*interrupted/i],
    ['MODEL_MISSING', /model.*not found|not found.*model|try pulling it first|file does not exist|manifest.*(unknown|not found)/i],
    ['CALL_UNREADABLE', UNREADABLE_CALL]
];

// Codes whose detail is written by Mollama itself, so the person is shown it: why a pool did not start, or how much
// memory a model needs.
const SHOWN_DETAIL = new Set(['POOL_FAILED', 'POOL_STOPPED', 'NOT_ENOUGH_MEMORY', 'RENTAL_ENDED']);
export class OllamaError extends Error {
    constructor(code, detail = null) {
        const entry = ERROR_TABLE[code] || ERROR_TABLE.UNKNOWN;
        super(entry.message);
        this.name = 'OllamaError';
        this.code = ERROR_TABLE[code] ? code : 'UNKNOWN';
        this.status = entry.status;
        this.action = entry.action;
        this.detail = detail;
    }

    toJSON() {
        const shown = SHOWN_DETAIL.has(this.code) && typeof this.detail === 'string' && this.detail.trim() ? { detail: this.detail.trim().slice(0, 300) } : {};
        return { code: this.code, message: this.message, action: this.action, ...shown };
    }
}

export const mapOllamaError = (error) => {
    if (error instanceof OllamaError) return error;

    const text = String(error?.error || error?.message || '');
    const causeCode = error?.cause?.code || error?.code;

    if (CONNECTION_CODES.has(causeCode) || /fetch failed|timed out waiting for ollama/i.test(text)) {
        return new OllamaError('OLLAMA_DOWN', text);
    }
    for (const [code, pattern] of RULES) {
        if (pattern.test(text)) return new OllamaError(code, text);
    }
    if (error?.status_code === 404) return new OllamaError('MODEL_MISSING', text);

    return new OllamaError('UNKNOWN', text);
};

export const ERROR_CODES = Object.keys(ERROR_TABLE);

const STATUS_TIMEOUT_MS = 3000;

const defaultFactory = (host, fetchThrough = null) => new Ollama(fetchThrough ? { host, fetch: fetchThrough } : { host });
let clientFactory = defaultFactory;
// Ollama answers a chat only once the model is in memory, and a request that has not been answered yet can only be
// ended through its own signal. A signal given with a chat is joined to that request, so Stop works while a model loads.
const stoppable = (through, signal) => (input, init = {}) => through(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });

export const setOllamaClientFactory = (factory) => {
    clientFactory = factory;
};

export const resetOllamaClientFactory = () => {
    clientFactory = defaultFactory;
};

const withTimeout = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for Ollama')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const createOllamaClient = (host, fetchThrough = null) => {
    const make = (signal) => {
        if (!signal) return fetchThrough ? defaultFactory(host, fetchThrough) : clientFactory(host);
        if (!fetchThrough && clientFactory !== defaultFactory) return clientFactory(host, signal);
        return defaultFactory(host, stoppable(fetchThrough || fetch, signal));
    };
    const call = async (run, signal) => {
        try {
            return await run(make(signal));
        } catch (error) {
            throw mapOllamaError(error);
        }
    };

    return {
        host,

        async status() {
            try {
                const { version } = await withTimeout(make().version(), STATUS_TIMEOUT_MS);
                return { available: true, version };
            } catch {
                return { available: false, version: null };
            }
        },

        list: () => call((client) => client.list()),
        running: () => call((client) => client.ps()),
        show: (model) => call((client) => client.show({ model })),
        remove: (model) => call((client) => client.delete({ model })),
        create: (request) => call((client) => client.create(request)),
        pull: (model) => call((client) => client.pull({ model, stream: true })),
        chat: (request, signal) => call((client) => client.chat(request), signal),
        unload: (model) => call((client) => client.generate({ model, prompt: '', keep_alive: 0 })),
        load: (model, keepAlive, numCtx) => call((client) => client.generate({ model, prompt: '', keep_alive: keepAlive, options: { num_ctx: numCtx } }))
    };
};

// Holds the live connection from each signed-in desktop app and carries Ollama requests to it.
// A request travels as { id, type: 'request', method, path, headers, body } and comes back as
// 'head', then 'chunk' messages (base64), then 'end'; 'ask' fetches hardware or disk details.
export class DeviceGateway extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.devices = new Map();
        this.counter = 0;
        this.helloMs = 10000;
        this.pingMs = 25000;
        this.askMs = 15000;
        // A link that drops usually comes back in seconds. What a computer was being asked is held that long, and goes on
        // where it was when the app returns to this same server: the app keeps the model writing meanwhile.
        this.parkMs = 2 * 60 * 1000;
        this.parked = new Map();
        this.session = crypto.randomUUID();
    }

    isOnline(deviceId) {
        return this.devices.has(String(deviceId));
    }

    publicAddress(deviceId) {
        return this.devices.get(String(deviceId))?.publicAddress || null;
    }

    // The address a link arrives from is kept in memory only, to tell which computers share a home network.
    handleConnection(ws, verify, req = null) {
        const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
        const publicAddress = forwarded || String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
        const timer = setTimeout(() => ws.close(1008, 'No hello'), this.helloMs);
        timer.unref?.();
        ws.once('message', async (raw) => {
            clearTimeout(timer);
            let hello = null;
            try {
                hello = JSON.parse(String(raw));
            } catch {
                hello = null;
            }
            let deviceId = null;
            try {
                deviceId = hello ? await verify(hello) : null;
            } catch {
                // The hello could not be checked just now (database slow, server starting): the app keeps its link and tries again.
                return ws.close(1011, 'Try again');
            }
            if (!deviceId) return ws.close(1008, 'Device not recognised');
            return this.attach(String(deviceId), ws, hello, publicAddress);
        });
    }

    attach(deviceId, ws, hello = {}, publicAddress = null) {
        const entry = { ws, pending: new Map(), publicAddress, resume: hello.resume === true, since: Date.now(), missed: 0 };
        const earlier = this.devices.get(deviceId);
        this.devices.set(deviceId, entry);
        // What was being asked when the link dropped moves to the new one, from the last piece that arrived.
        const have = {};
        const dropped = this.parked.get(deviceId);
        clearTimeout(dropped?.timer);
        this.parked.delete(deviceId);
        const held = entry.resume && hello.session === this.session && Array.isArray(hello.held) ? new Set(hello.held.map(String)) : new Set();
        for (const from of [dropped?.entry, earlier].filter(Boolean)) {
            for (const [id, waiting] of [...from.pending]) {
                if (!waiting.moveTo || !held.has(id)) {
                    if (from !== earlier) waiting.fail();
                    continue;
                }
                from.pending.delete(id);
                waiting.moveTo(entry);
                entry.pending.set(id, waiting);
                have[id] = waiting.got;
            }
        }
        earlier?.ws.close(1000, 'Replaced');

        ws.on('message', (raw) => {
            let message = null;
            try {
                message = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (message.type === 'goodbye') {
                entry.leaving = true;
                return;
            }
            if (message.type === 'network') {
                if (message.data && Array.isArray(message.data.addresses)) this.emit('network', deviceId, { addresses: message.data.addresses.slice(0, 16) });
                return;
            }
            if (message.type === 'pool-state') {
                entry.pool = message.data && typeof message.data === 'object' ? message.data : null;
                this.emit('pool', deviceId, entry.pool);
                return;
            }
            if (message.type === 'train-state') {
                if (message.data && typeof message.data === 'object') this.emit('train', deviceId, message.data);
                return;
            }
            if (!['head', 'chunk', 'end', 'error', 'answer'].includes(message.type)) return;
            const waiting = entry.pending.get(String(message.id));
            // A piece sent again after the link came back is not taken twice.
            if (waiting && message.n) {
                if (message.n <= waiting.got) return;
                waiting.got = message.n;
            }
            waiting?.[message.type]?.(message);
        });
        // A busy computer may miss a check or two; one that misses three has gone.
        ws.on('pong', () => { entry.missed = 0; });
        const beat = setInterval(() => {
            if (entry.missed >= 3) return ws.terminate();
            entry.missed += 1;
            try { ws.ping(); } catch { /* closing */ }
            // The app cannot see a ping, so it is told as well, and knows by it that the link is alive.
            if (entry.resume) this.send(entry, { type: 'beat' });
            return undefined;
        }, this.pingMs);
        beat.unref?.();
        ws.on('close', (code, reason) => {
            clearInterval(beat);
            const current = this.devices.get(deviceId) === entry;
            if (current) this.devices.delete(deviceId);
            const park = current && entry.resume && !entry.leaving && !entry.removed && this.parkMs > 0;
            for (const waiting of [...entry.pending.values()]) if (!park || !waiting.moveTo) waiting.fail();
            this.emit('closed', deviceId, { code, reason: String(reason || '').slice(0, 80), missed: entry.missed, seconds: Math.round((Date.now() - entry.since) / 1000), replaced: !current, held: entry.pending.size });
            if (park && entry.pending.size > 0) {
                const timer = setTimeout(() => {
                    this.parked.delete(deviceId);
                    for (const waiting of [...entry.pending.values()]) waiting.fail();
                }, this.parkMs);
                timer.unref?.();
                this.parked.set(deviceId, { entry, timer });
            }
            if (current) this.emit(entry.leaving ? 'goodbye' : 'offline', deviceId);
        });
        ws.on('error', () => {});

        this.send(entry, { type: 'welcome', session: this.session, have });
        this.emit('online', deviceId, hello, Boolean(earlier));
    }

    send(entry, message) {
        try {
            entry.ws.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    // What the desktop app last said about its part in a pool, kept in memory only.
    poolState(deviceId) {
        return this.devices.get(String(deviceId))?.pool || null;
    }

    order(deviceId, message) {
        const entry = this.devices.get(String(deviceId));
        return entry ? this.send(entry, message) : false;
    }

    // Asks the main computer whether a lending computer's gate lets it in.
    probe(deviceId, address, port, ms = 10000) {
        return this.query(deviceId, { type: 'pool', action: 'probe', address, port }, ms);
    }

    // Sends a message that the desktop app answers once.
    query(deviceId, message, ms = this.askMs) {
        return new Promise((resolve, reject) => {
            const entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));
            const id = String(++this.counter);
            const timer = setTimeout(() => finish(() => reject(new Error('silent'))), ms);
            timer.unref?.();
            const finish = (settle) => { clearTimeout(timer); entry.pending.delete(id); settle(); };
            entry.pending.set(id, {
                answer: (message) => finish(() => resolve(message.data)),
                error: () => finish(() => reject(new Error('silent'))),
                fail: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE')))
            });
            if (!this.send(entry, { id, ...message })) entry.pending.get(id)?.fail();
            return undefined;
        });
    }

    disconnect(deviceId) {
        const entry = this.devices.get(String(deviceId));
        if (!entry) return;
        entry.removed = true;
        entry.ws.close(1000, 'Removed');
    }

    // Asks the desktop app about the tool servers on its computer. An app too old to know the question stays silent.
    // A check starts the tool server and may ask its app too, which takes up to about half a minute.
    tools(deviceId, request, ms = request?.action === 'call' ? 70000 : request?.action === 'check' ? this.askMs * 3 : this.askMs) {
        return new Promise((resolve, reject) => {
            const entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));
            const id = String(++this.counter);
            const timer = setTimeout(() => finish(() => reject(new Error('silent'))), ms);
            timer.unref?.();
            const finish = (settle) => { clearTimeout(timer); entry.pending.delete(id); settle(); };
            entry.pending.set(id, {
                answer: (message) => finish(() => resolve(message.data)),
                error: () => finish(() => reject(new Error('silent'))),
                fail: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE')))
            });
            if (!this.send(entry, { id, type: 'tools', ...request })) entry.pending.get(id)?.fail();
        });
    }

    ask(deviceId, what) {
        return new Promise((resolve, reject) => {
            const entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));
            const id = String(++this.counter);
            const timer = setTimeout(() => finish(() => reject(new OllamaError('DEVICE_OFFLINE'))), this.askMs);
            timer.unref?.();
            const finish = (settle) => {
                clearTimeout(timer);
                entry.pending.delete(id);
                settle();
            };
            entry.pending.set(id, {
                answer: (message) => finish(() => resolve(message.data)),
                error: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE'))),
                fail: () => finish(() => reject(new OllamaError('DEVICE_OFFLINE')))
            });
            if (!this.send(entry, { id, type: 'ask', what })) entry.pending.get(id)?.fail();
            return undefined;
        });
    }

    // 'via' sends the requests to something else the app runs for Mollama: 'pool' is a pooled model on the main computer.
    fetcher(deviceId, via = null) {
        return (input, init = {}) => new Promise((resolve, reject) => {
            let entry = this.devices.get(String(deviceId));
            if (!entry) return reject(new OllamaError('DEVICE_OFFLINE'));

            const id = String(++this.counter);
            const url = new URL(typeof input === 'string' ? input : input.url);
            let controller = null;
            let answered = false;
            const drop = (error) => {
                if (!entry.pending.delete(id)) return;
                if (answered) {
                    try {
                        controller.error(error);
                    } catch { /* already closed */ }
                } else {
                    reject(error);
                }
            };
            const cancel = () => {
                if (entry.pending.has(id)) this.send(entry, { id, type: 'cancel' });
            };
            const stream = new ReadableStream({
                start: (given) => { controller = given; },
                cancel: () => {
                    cancel();
                    entry.pending.delete(id);
                }
            });

            entry.pending.set(id, {
                got: 0,
                moveTo: (next) => { entry = next; },
                head: (message) => {
                    answered = true;
                    const empty = [204, 205, 304].includes(message.status);
                    if (empty) entry.pending.delete(id);
                    resolve(new Response(empty ? null : stream, { status: message.status, headers: message.headers || {} }));
                },
                chunk: (message) => {
                    try {
                        controller.enqueue(new Uint8Array(Buffer.from(message.data, 'base64')));
                    } catch { /* reader gone */ }
                },
                end: () => {
                    entry.pending.delete(id);
                    try {
                        controller.close();
                    } catch { /* already closed */ }
                },
                error: (message) => drop(message.code === 'POOL_DOWN' ? new OllamaError('POOL_STOPPED', typeof message.detail === 'string' ? message.detail : null) : new OllamaError(message.code === 'OLLAMA_DOWN' ? 'OLLAMA_DOWN' : 'DEVICE_OFFLINE')),
                fail: () => drop(new OllamaError('DEVICE_OFFLINE'))
            });

            init.signal?.addEventListener('abort', () => {
                cancel();
                drop(new DOMException('This operation was aborted', 'AbortError'));
            }, { once: true });

            const headers = {};
            new Headers(init.headers || {}).forEach((value, name) => { headers[name] = value; });
            const sent = this.send(entry, {
                id,
                type: 'request',
                ...(via ? { via } : {}),
                method: init.method || 'GET',
                path: url.pathname + url.search,
                headers,
                body: init.body === undefined || init.body === null ? undefined : String(init.body)
            });
            if (!sent) entry.pending.get(id)?.fail();
            return undefined;
        });
    }
}

export const deviceGateway = new DeviceGateway();

const MB = 1024 * 1024;

// Graphics a model can run on, checked a different way on each kind of machine:
// Nvidia cards anywhere, the built-in graphics of an Apple-chip Mac, and AMD cards on Windows and Linux.
// Anything else reports no usable graphics, so models are sized for the processor and system memory.
const APPLE_GRAPHICS_SHARE = 2 / 3;
const SMALLEST_USEFUL_CARD_MB = 2048;
const DISPLAY_ADAPTERS = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Select-Object DriverDesc, 'HardwareInformation.qwMemorySize' | ConvertTo-Json -Compress";

const runQuietly = (file, args) => new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

export const parseNvidiaSmi = (text) =>
    String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, total] = line.split(',').map((part) => part.trim());
            const memoryMb = Number(total);
            if (!name || !Number.isFinite(memoryMb) || memoryMb <= 0) return null;
            return { name, memoryMb };
        })
        .filter(Boolean);

// An Apple chip's graphics share the system memory; about two thirds of it can hold a model.
export const appleGpus = ({ platform, arch, cpu, memoryMb }) => (platform === 'darwin' && arch === 'arm64' && memoryMb > 0
    ? [{ name: `${cpu || 'Apple chip'} built-in graphics`, memoryMb: Math.round(memoryMb * APPLE_GRAPHICS_SHARE) }]
    : []);

// Windows lists every display adapter with its own memory; only AMD cards with real memory of their own count here.
export const parseDisplayAdapters = (text) => {
    let rows = [];
    try {
        rows = JSON.parse(String(text || '').trim() || '[]');
    } catch {
        return [];
    }
    return (Array.isArray(rows) ? rows : [rows]).map((row) => {
        const name = String(row?.DriverDesc || '').trim();
        const memoryMb = Math.round(Number(row?.['HardwareInformation.qwMemorySize'] || 0) / MB);
        return /radeon|\bamd\b/i.test(name) && memoryMb >= SMALLEST_USEFUL_CARD_MB ? { name, memoryMb } : null;
    }).filter(Boolean);
};

const readLinuxAmd = async () => {
    const found = [];
    for (const card of await readdir('/sys/class/drm').catch(() => [])) {
        if (!/^card\d+$/.test(card)) continue;
        const device = `/sys/class/drm/${card}/device`;
        const vendor = (await readFile(`${device}/vendor`, 'utf8').catch(() => '')).trim();
        const bytes = Number((await readFile(`${device}/mem_info_vram_total`, 'utf8').catch(() => '0')).trim());
        if (vendor === '0x1002' && bytes >= SMALLEST_USEFUL_CARD_MB * MB) found.push({ name: 'AMD Radeon graphics card', memoryMb: Math.round(bytes / MB) });
    }
    return found;
};

const readGpus = async () => {
    try {
        const nvidia = parseNvidiaSmi(await runQuietly('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']));
        if (nvidia.length) return nvidia;
        const apple = appleGpus({ platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model?.trim(), memoryMb: Math.round(os.totalmem() / MB) });
        if (apple.length) return apple;
        if (process.platform === 'win32') return parseDisplayAdapters(await runQuietly('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DISPLAY_ADAPTERS]));
        if (process.platform === 'linux') return await readLinuxAmd();
        return [];
    } catch {
        return [];
    }
};

export const modelsFolder = () => process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');

export const readDisk = async () => {
    for (const folder of [modelsFolder(), os.homedir()]) {
        try {
            const stats = await statfs(folder);
            return {
                diskFreeMb: Math.round((stats.bavail * stats.bsize) / MB),
                diskTotalMb: Math.round((stats.blocks * stats.bsize) / MB)
            };
        } catch {
            continue;
        }
    }
    return { diskFreeMb: null, diskTotalMb: null };
};

export const detectHardware = async () => {
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
        detectedAt: new Date()
    };
};

export const GPU_HEADROOM_MB = 1536;
export const RAM_RESERVE_MB = 4096;

export const VERDICTS = {
    gpu: 'Runs fully on GPU',
    mixed: 'Runs with CPU help (slower)',
    cpu: 'Runs on the processor (slower)',
    too_large: 'Too large for this device'
};

export const memoryNeededMb = (entry) => Math.round(entry.sizeMb * 1.1 + 800);

const speedRange = (verdict, entry) => {
    const size = entry.parameters;
    if (verdict === 'gpu') {
        if (size <= 4.5) return [60, 120];
        if (size <= 9) return [35, 70];
        if (size <= 15) return [20, 40];
        if (size <= 33) return [12, 28];
        return [6, 14];
    }
    if (verdict === 'mixed') {
        if (entry.moe) return [15, 35];
        if (size <= 9) return [8, 20];
        if (size <= 15) return [4, 10];
        return [1, 5];
    }
    if (verdict === 'cpu') {
        if (size <= 4.5) return [8, 20];
        if (size <= 9) return [3, 8];
        return [1, 4];
    }
    return null;
};

export const fitModel = (entry, hardware) => {
    const gpuMemoryMb = Number(hardware?.gpuMemoryMb) || 0;
    const memoryMb = Number(hardware?.memoryMb) || 0;
    const hasGpu = gpuMemoryMb > 0;
    const usableGpu = hasGpu ? Math.max(0, gpuMemoryMb - GPU_HEADROOM_MB) : 0;
    // On a chip whose graphics share the system memory, the graphics part is not counted a second time.
    const usableRam = Math.max(0, memoryMb - (hardware?.gpuShared ? gpuMemoryMb : 0) - RAM_RESERVE_MB);
    const needed = memoryNeededMb(entry);

    let verdict = 'too_large';
    if (hasGpu && needed <= usableGpu) verdict = 'gpu';
    else if (hasGpu && needed <= usableGpu + usableRam) verdict = 'mixed';
    else if (!hasGpu && needed <= usableRam) verdict = 'cpu';

    // Where the model sits once running, and what each memory has left of its whole. On a chip whose graphics share
    // the system memory, all of it comes out of that one memory.
    const gpuMb = hasGpu ? Math.min(needed, usableGpu) : 0;
    const place = verdict === 'too_large' ? null : {
        gpuMb,
        ramMb: needed - gpuMb,
        gpuLeftMb: hasGpu ? gpuMemoryMb - gpuMb : null,
        ramLeftMb: Math.max(0, memoryMb - (hardware?.gpuShared ? needed : needed - gpuMb))
    };

    return {
        verdict,
        label: VERDICTS[verdict],
        fits: verdict !== 'too_large',
        memoryNeededMb: needed,
        place,
        tokensPerSecond: speedRange(verdict, entry)
    };
};

// The computer as it is right now, in the same shape, so the same fit can be asked of it: no more than what is free,
// keeping a little back so other apps carry on. A desktop app too old to say leaves the computer's own sizes.
export const MEMORY_SPARE_MB = 2048;
export const freeHardware = (hardware, free) => {
    if (!(Number(free?.freeMb) > 0)) return hardware;
    const memory = Math.max(0, Number(free.freeMb) - MEMORY_SPARE_MB);
    const total = Number(hardware?.memoryMb) || 0;
    const gpuTotal = Number(hardware?.gpuMemoryMb) || 0;
    // An Apple chip's graphics use the same memory, so what is free is free to both, once.
    if (hardware.gpuShared) return { ...hardware, memoryMb: Math.min(total, memory + RAM_RESERVE_MB + GPU_HEADROOM_MB), gpuMemoryMb: Math.min(gpuTotal, memory + GPU_HEADROOM_MB) };
    const gpuFree = free.gpuFreeMb === null || free.gpuFreeMb === undefined ? NaN : Number(free.gpuFreeMb);
    return { ...hardware, memoryMb: Math.min(total, memory + RAM_RESERVE_MB), gpuMemoryMb: Number.isFinite(gpuFree) ? Math.min(gpuTotal, Math.max(0, gpuFree) + GPU_HEADROOM_MB) : gpuTotal };
};

// What a computer can give a pooled model, in MB: its graphics memory, or with none, its system memory, less its reserve.
export const poolShareMb = (hardware) => Math.max(0, (Number(hardware?.gpuMemoryMb) || 0) > 0
    ? Number(hardware.gpuMemoryMb) - GPU_HEADROOM_MB
    : (Number(hardware?.memoryMb) || 0) - RAM_RESERVE_MB);
// How fast a device reads its share of a model, roughly: a graphics card's own memory, then an Apple chip's shared
// memory, then a processor's system memory.
const speedClass = (hardware) => ((Number(hardware?.gpuMemoryMb) || 0) > 0 ? (hardware.gpuShared ? 2 : 3) : 1);
// The split of a pooled model, in GB per device in llama.cpp's order: the fastest devices are filled first, up to what
// each can give, so the slow ones hold as little as possible. When the model needs more than they can give together,
// the split follows what each can give.
export const splitBySpeed = (devices, neededMb) => {
    const shares = devices.map((hardware) => poolShareMb(hardware));
    const total = shares.reduce((sum, mb) => sum + mb, 0);
    const toGb = (mb) => Math.round((mb / 1024) * 10) / 10;
    if (!(neededMb > 0) || total < neededMb) return shares.map((mb) => Math.max(0.1, toGb(mb)));
    const given = shares.map(() => 0);
    let left = neededMb;
    for (const index of devices.map((hardware, at) => at).sort((a, b) => speedClass(devices[b]) - speedClass(devices[a]) || shares[b] - shares[a])) {
        given[index] = Math.min(shares[index], left);
        left -= given[index];
    }
    return given.map((mb) => Math.max(0.1, toGb(mb)));
};

// The split sent to the main computer. A model larger than the devices' graphics memory together gets none: llama.cpp's
// --fit, which puts the layers that do not fit in the main computer's system memory, gives up when a split is set
// (measured 2026-11-22: ErrorOutOfDeviceMemory with one, loaded without).
export const poolSplit = (devices, neededMb) => {
    const graphics = devices.reduce((sum, hardware) => sum + poolShareMb(hardware), 0);
    return neededMb > 0 && graphics >= neededMb ? splitBySpeed(devices, neededMb) : [];
};

// Whether a model fits several computers pooled: what they can give together against what the model needs. A pooled
// model runs slower than on one computer, so no speed is promised.
export const fitPool = (entry, computers) => {
    if (!entry || entry.cloudOnly || !Array.isArray(computers) || computers.length < 2) return null;
    // Graphics memory everywhere, plus the system memory of the computer that runs the model, which takes the layers that
    // do not fit graphics memory (llama.cpp's --fit), as one computer does with CPU help. That is the one marked 'runs'
    // (the main computer chosen), or with none chosen yet, the one with most to spare. A lending computer gives only its
    // graphics memory, and an Apple chip's memory is its graphics memory, so neither adds system memory.
    const runner = computers.some((hardware) => hardware?.runs) ? computers.filter((hardware) => hardware?.runs) : computers;
    const spare = Math.max(0, ...runner.map((hardware) => ((Number(hardware?.gpuMemoryMb) || 0) > 0 && !hardware.gpuShared ? (Number(hardware.memoryMb) || 0) - RAM_RESERVE_MB : 0)));
    const shared = computers.reduce((sum, hardware) => sum + poolShareMb(hardware), 0);
    const memoryMb = shared + spare;
    const needed = memoryNeededMb(entry);
    // Where it sits pooled: what the computers lend first, the rest in the primary computer's system memory.
    const gpuMb = Math.min(needed, shared);
    const lent = computers.reduce((sum, hardware) => sum + ((Number(hardware?.gpuMemoryMb) || 0) > 0 ? Number(hardware.gpuMemoryMb) : Number(hardware?.memoryMb) || 0), 0);
    const place = needed > memoryMb ? null : { gpuMb, ramMb: needed - gpuMb, gpuLeftMb: lent - gpuMb, ramLeftMb: spare > 0 ? spare + RAM_RESERVE_MB - (needed - gpuMb) : null };
    return { fits: needed <= memoryMb, memoryMb, memoryNeededMb: needed, place };
};

// Pooling: computers that can share one model are those on the same home network, found from what each desktop app
// reports (its private addresses, never its public one) and the address its link arrives from. A direct cable between
// two computers gives both a 169.254 address. Nothing is pooled on a network Windows marks Public.
const ipv4 = (text) => {
    const parts = String(text || '').split('.').map(Number);
    return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
};
export const privateKind = (address) => {
    const [a, b] = ipv4(address) || [];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'home';
    if (a === 169 && b === 254) return 'cable';
    return null;
};
export const subnetOf = (address, prefix) => {
    const parts = ipv4(address);
    const bits = Number(prefix);
    if (!parts || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
    const value = parts.reduce((sum, part) => sum * 256 + part, 0);
    const network = value - (value % 2 ** (32 - bits));
    return `${[24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256).join('.')}/${bits}`;
};
export const POOL_REASONS = {
    offline: 'Not connected right now. Open the Mollama desktop app on it.',
    paused: 'Paused. Resume it to pool it.',
    update: 'Its desktop app does not say which network it is on yet: pooling comes with the next Mollama desktop app release.',
    public: 'Windows marks its network as Public, so it is never pooled. Pool only on a home network you trust; if this is one, set the network to Private in Windows settings.',
    nonetwork: 'It is not on a home network or a direct cable.',
    alone: 'No other computer of yours is on the same network.',
    online: 'This is an online service, not a computer.'
};
// computers: [{ id, name, online, paused, publicAddress, hardware }]. Gives the groups of two or more that can pool,
// and for each computer left out, why.
export const poolGroups = (computers) => {
    const groups = new Map();
    const reasons = new Map();
    for (const computer of computers) {
        const network = computer.hardware?.network;
        if (!computer.online) reasons.set(computer.id, 'offline');
        else if (computer.paused) reasons.set(computer.id, 'paused');
        else if (!network || !Array.isArray(network.addresses)) reasons.set(computer.id, 'update');
        else {
            const usable = network.addresses.filter((entry) => privateKind(entry.address) && !(privateKind(entry.address) === 'home' && entry.category === 'public'));
            if (usable.length === 0) {
                reasons.set(computer.id, network.addresses.some((entry) => entry.category === 'public') ? 'public' : 'nonetwork');
                continue;
            }
            for (const entry of usable) {
                const subnet = subnetOf(entry.address, entry.prefix);
                if (!subnet || !computer.publicAddress) continue;
                const key = `${computer.publicAddress}|${subnet}`;
                if (!groups.has(key)) groups.set(key, { network: subnet, via: privateKind(entry.address), computers: [] });
                groups.get(key).computers.push({ id: computer.id, name: computer.name, address: entry.address, wired: Boolean(entry.wired), gpuMemoryMb: computer.hardware.gpuMemoryMb || 0, memoryMb: computer.hardware.memoryMb || 0 });
            }
        }
    }
    const shared = [...groups.values()].filter((group) => group.computers.length >= 2)
        .map((group) => ({
            ...group,
            wired: group.computers.every((one) => one.wired),
            combined: {
                gpuMemoryMb: group.computers.reduce((sum, one) => sum + one.gpuMemoryMb, 0),
                memoryMb: group.computers.reduce((sum, one) => sum + one.memoryMb, 0)
            }
        }))
        .sort((a, b) => Number(b.via === 'cable') - Number(a.via === 'cable') || Number(b.wired) - Number(a.wired) || b.computers.length - a.computers.length);
    const pooled = new Set(shared.flatMap((group) => group.computers.map((one) => one.id)));
    const left = computers.filter((computer) => !pooled.has(computer.id)).map((computer) => {
        const reason = reasons.get(computer.id) || 'alone';
        const fix = reason === 'public' ? [...new Set((computer.hardware?.network?.addresses || []).filter((entry) => entry.category === 'public' && entry.interface).map((entry) => String(entry.interface).slice(0, 60)))] : [];
        return { id: computer.id, name: computer.name, reason, message: POOL_REASONS[reason], ...(fix.length > 0 ? { publicNetworks: fix } : {}) };
    });
    return { groups: shared, left };
};

export const fitNotes = (catalogue, hardware) => {
    const gpuMemoryMb = Number(hardware?.gpuMemoryMb) || 0;
    const usableGpu = Math.max(0, gpuMemoryMb - GPU_HEADROOM_MB);
    const verdicts = catalogue.map((entry) => ({ entry, verdict: fitModel(entry, hardware).verdict }));
    const notes = [];
    if (gpuMemoryMb === 0) notes.push('No graphics card: models run on the processor, which is slower. More system memory lets larger models run.');
    const medium = catalogue.filter((entry) => entry.parameters >= 7 && entry.parameters <= 9).map(memoryNeededMb).sort((a, b) => a - b);
    if (medium.length > 1 && medium[0] + medium[1] <= usableGpu) notes.push('This graphics card has room for two 7 to 8B models at once, for example one for chat and one for code.');
    if (verdicts.some(({ entry, verdict }) => entry.moe && verdict === 'mixed')) notes.push('A large mixture-of-experts model runs here with help from system memory, so system memory matters as much as graphics memory.');
    if (verdicts.every(({ verdict }) => verdict === 'too_large')) notes.push('None of the listed models fits this device. A smaller model not on this list may still run, slowly.');
    return notes;
};

const byParameters = (a, b) => a.parameters - b.parameters;
const general = (entry) => entry.goodFor.includes('chat');

export const rankCatalogue = (catalogue, hardware) => {
    const entries = catalogue.map((entry) => ({ ...entry, fit: fitModel(entry, hardware), pick: null }));
    const lowestSpeed = (entry) => entry.fit.tokensPerSecond?.[0] ?? 0;
    let pool = entries.filter((entry) => entry.fit.verdict === 'gpu' || entry.fit.verdict === 'cpu');
    if (pool.length === 0) pool = entries.filter((entry) => entry.fit.verdict === 'mixed');
    pool = pool.filter((entry) => lowestSpeed(entry) >= 3).sort(byParameters);
    const base = pool.some(general) ? pool.filter(general) : pool;

    // The fastest pick is the smallest model of at least a billion parameters, so it is quick and still useful;
    // smaller ones are listed but not recommended.
    const fast = base.find((entry) => entry.parameters >= 1) || base[0] || null;
    const carried = entries
        .filter((entry) => entry.fit.verdict === 'mixed' && entry.moe && !pool.includes(entry))
        .sort((x, y) => byParameters(y, x));
    const best = carried.find(general) || carried[0] || (base.length > 1 ? base[base.length - 1] : null);
    const rest = base.filter((entry) => entry !== fast && entry !== best);
    const balanced = [...rest].reverse().find((entry) => lowestSpeed(entry) >= 20) || rest[rest.length - 1] || null;

    if (fast) fast.pick = 'fast';
    if (balanced) balanced.pick = 'balanced';
    if (best) best.pick = 'best';
    // A fourth, for a particular kind of work: the largest model that still runs well here and is made for code,
    // or failing that for reasoning.
    const free = [...pool].reverse().filter((entry) => !entry.pick);
    const special = free.find((entry) => entry.goodFor.includes('code')) || free.find((entry) => entry.goodFor.includes('reasoning')) || null;
    if (special) special.pick = special.goodFor.includes('code') ? 'code' : 'reasoning';

    // Each pick carries its name and the numbers it was chosen on: how much memory it needs, how much this computer has
    // for models, and the expected speed. The speed is an estimate from the model's size and where it runs, not a measurement.
    const gpuMb = Number(hardware?.gpuMemoryMb) || 0;
    const usableGpu = gpuMb > 0 ? Math.max(0, gpuMb - GPU_HEADROOM_MB) : 0;
    const usableRam = Math.max(0, (Number(hardware?.memoryMb) || 0) - (hardware?.gpuShared ? gpuMb : 0) - RAM_RESERVE_MB);
    const gb = (mb) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
    const room = (entry) => (entry.fit.verdict === 'gpu' ? `${gb(usableGpu)} of graphics memory` : entry.fit.verdict === 'mixed' ? `${gb(usableGpu + usableRam)} of graphics and system memory` : `${gb(usableRam)} of system memory`);
    const speed = (entry) => (entry.fit.tokensPerSecond ? `about ${entry.fit.tokensPerSecond[0]} to ${entry.fit.tokensPerSecond[1]} tokens a second` : 'speed unknown');
    const needs = (entry) => `needs ${gb(entry.fit.memoryNeededMb)} of the ${room(entry)} this computer has free for models`;
    const PICKS = {
        fast: ['Fastest', (entry) => `The smallest capable model that runs fully here: ${speed(entry)}; ${needs(entry)}.`],
        balanced: ['Best balance', (entry) => `The largest model that still answers quickly: ${speed(entry)}; ${needs(entry)}.`],
        best: ['Best quality', (entry) => `The largest model this computer can run: ${needs(entry)}; ${speed(entry)}.`],
        code: ['Best for code', (entry) => `The largest model made for code that runs well here: ${speed(entry)}; ${needs(entry)}.`],
        reasoning: ['Best at reasoning', (entry) => `The largest reasoning model that runs well here: ${speed(entry)}; ${needs(entry)}.`]
    };
    for (const entry of entries) {
        if (!entry.pick) continue;
        entry.pickLabel = PICKS[entry.pick][0];
        entry.pickWhy = PICKS[entry.pick][1](entry);
    }

    const order = { fast: 0, balanced: 1, best: 2, code: 3, reasoning: 3 };
    return entries.sort((a, b) => {
        const pickA = a.pick ? order[a.pick] : 9;
        const pickB = b.pick ? order[b.pick] : 9;
        if (pickA !== pickB) return pickA - pickB;
        if (a.fit.fits !== b.fit.fits) return a.fit.fits ? -1 : 1;
        return byParameters(a, b);
    });
};

const PRIORITY = { interactive: 0, background: 1 };

export class GenerationQueue extends EventEmitter {
    constructor({ maxConcurrent = 1, perUserLimit = 5 } = {}) {
        super();
        this.setMaxListeners(200);
        this.maxConcurrent = maxConcurrent;
        this.perUserLimit = perUserLimit;
        this.waiting = [];
        this.running = new Set();
        this.lastServed = new Map();
        this.tick = 0;
        this.sequenceNumber = 0;
    }

    waitingFor(userId) {
        return this.waiting.filter((job) => job.userId === String(userId)).length;
    }

    order() {
        const served = new Map(this.lastServed);
        const pool = [...this.waiting];
        const ordered = [];
        let tick = this.tick;
        while (pool.length > 0) {
            pool.sort((a, b) =>
                PRIORITY[a.priority] - PRIORITY[b.priority]
                || (served.get(a.userId) || 0) - (served.get(b.userId) || 0)
                || a.sequence - b.sequence);
            const next = pool.shift();
            served.set(next.userId, ++tick);
            ordered.push(next);
        }
        return ordered;
    }

    // Each computer is its own lane: replies wait only behind others on the same computer.
    runningIn(lane) {
        return [...this.running].filter((job) => job.lane === String(lane)).length;
    }

    busyIn(lane) {
        return this.runningIn(lane) > 0 || this.waiting.some((job) => job.lane === String(lane));
    }

    ahead(job) {
        if (job.state !== 'waiting') return 0;
        return this.order().filter((other) => other.lane === job.lane).indexOf(job) + this.runningIn(job.lane);
    }

    add({ userId, priority = 'interactive', run, lane = 'local' }) {
        if (this.waitingFor(userId) >= this.perUserLimit) throw new OllamaError('QUEUE_FULL');
        const job = { userId: String(userId), priority, run, lane: String(lane), state: 'waiting', sequence: ++this.sequenceNumber };
        job.done = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        job.ahead = () => this.ahead(job);
        job.cancel = () => this.cancel(job);
        this.waiting.push(job);
        setImmediate(() => this.pump());
        return job;
    }

    cancel(job) {
        if (job.state !== 'waiting') return false;
        this.waiting = this.waiting.filter((other) => other !== job);
        job.state = 'cancelled';
        job.resolve(null);
        this.emit('moved');
        return true;
    }

    pump() {
        for (;;) {
            const job = this.order().find((next) => this.runningIn(next.lane) < this.maxConcurrent);
            if (!job) break;
            this.waiting = this.waiting.filter((other) => other !== job);
            this.lastServed.set(job.userId, ++this.tick);
            this.running.add(job);
            job.state = 'running';
            Promise.resolve()
                .then(() => job.run())
                .then(job.resolve, job.reject)
                .finally(() => {
                    job.state = 'finished';
                    this.running.delete(job);
                    this.emit('moved');
                    this.pump();
                });
        }
        this.emit('moved');
    }
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// An image is kept with its chat as it is and sent to a model that can see. A chat is one record, so its images are kept small.
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const imageTypeOf = (name) => IMAGE_TYPES[path.extname(String(name || '')).toLowerCase()] || null;
// What an image is, read from its first bytes, for the services that need to be told.
const imageMime = (base64) => {
    const head = Buffer.from(String(base64).slice(0, 24), 'base64');
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return 'image/png';
};
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

const PLAIN_TEXT = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml', '.html', '.htm',
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.css', '.ini', '.toml'
]);
const NEVER_TEXT = new Set(['.doc', '.xls', '.xlsx', '.ppt', '.pptx']);

const looksLikeText = (buffer) => {
    const sample = buffer.subarray(0, 8000);
    if (sample.includes(0)) return false;
    const decoded = new TextDecoder('utf-8').decode(sample);
    return (decoded.match(/�/g) || []).length < 3;
};

export const extractText = async ({ buffer, name }) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new OllamaError('FILE_UNREADABLE');
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new OllamaError('FILE_TOO_LARGE');
    const extension = path.extname(String(name || '')).toLowerCase();

    let text;
    try {
        if (extension === '.pdf') {
            const { extractText: readPdf } = await import('unpdf');
            const result = await readPdf(new Uint8Array(buffer), { mergePages: true });
            text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
        } else if (extension === '.docx') {
            const mammoth = (await import('mammoth')).default;
            text = (await mammoth.extractRawText({ buffer })).value;
        } else if (PLAIN_TEXT.has(extension) || (!NEVER_TEXT.has(extension) && looksLikeText(buffer))) {
            text = buffer.toString('utf8').replace(/^﻿/, '');
        } else {
            throw new OllamaError('FILE_UNREADABLE');
        }
    } catch (error) {
        if (error instanceof OllamaError) throw error;
        throw new OllamaError('FILE_UNREADABLE', error.message);
    }

    text = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new OllamaError('FILE_UNREADABLE', 'no text found');
    return text;
};

const realFetch = (...args) => fetch(...args);
let filesFetch = realFetch;

export const setFilesFetch = (replacement) => {
    filesFetch = replacement || realFetch;
};

// A program a model writes runs in a Render sandbox: a small computer of its own, started from the prepared snapshot
// (mkrspc-python/prepare_sandbox.py), with no network, none of this server's settings, and thrown away when the job ends.
// This server only holds the key that starts it. It is optional: without the three settings no program is run.
let sandboxClient = null;
export const setSandboxClient = (replacement) => {
    sandboxClient = replacement;
};
export const sandboxReady = () => Boolean(process.env.SANDBOX_API_KEY && process.env.SANDBOX_WORKSPACE_ID && process.env.SANDBOX_SNAPSHOT);
const sandboxesOf = async () => {
    if (sandboxClient) return sandboxClient;
    const { Render } = await import('@renderinc/sdk');
    return new Render({ token: process.env.SANDBOX_API_KEY, ownerId: process.env.SANDBOX_WORKSPACE_ID }).sandboxes;
};
const PROGRAM_RUNS = { python: ['python', 'py'], node: ['node', 'js'], bash: ['bash', 'sh'] };
const SANDBOX_FILES = 40;
const SANDBOX_BYTES = 25 * 1024 * 1024;
// A sandbox kept for one chat between its programs, so files one run leaves are there for the next: let go after
// KEEP_IDLE_MS with nothing run, and never kept past KEEP_LIFE_SECONDS. A job that may reach the network is never kept.
let keepIdleMs = 10 * 60 * 1000;
const KEEP_LIFE_SECONDS = 2 * 60 * 60;
export const MAX_PROGRAM_SECONDS = 30 * 60;
const keptSandboxes = new Map();
export const letSandboxGo = async (key) => {
    const held = keptSandboxes.get(key);
    if (!held) return;
    keptSandboxes.delete(key);
    clearTimeout(held.timer);
    await (await sandboxesOf()).terminate(held.id).catch(() => {});
};
// For tests: how long a kept sandbox waits, and letting every kept one go now.
export const setSandboxKeepMs = (ms) => {
    keepIdleMs = ms ?? 10 * 60 * 1000;
};
export const releaseSandboxes = async () => {
    for (const key of [...keptSandboxes.keys()]) await letSandboxGo(key);
};
// Read by Python as it starts, beside the program: a program stopped for running too long says where it was, and a call
// that was made wrongly is followed by what that call accepts, so a model mends it instead of guessing again.
export const PYTHON_HOOK = String.raw`import sys

def _explain(error, trace):
    import ast, difflib, inspect, os
    main = os.path.abspath(sys.argv[0])
    found = None
    while trace is not None:
        if os.path.abspath(trace.tb_frame.f_code.co_filename) == main:
            found = trace
        trace = trace.tb_next
    said = []
    if isinstance(error, AttributeError) and getattr(error, 'name', None) and getattr(error, 'obj', None) is not None:
        near = difflib.get_close_matches(error.name, [n for n in dir(error.obj) if not n.startswith('_')], 6, 0.4)
        if near:
            said.append('The nearest names there are: ' + ', '.join(near))
    if isinstance(error, ImportError) and getattr(error, 'name', None) in sys.modules and getattr(error, 'name_from', None):
        near = difflib.get_close_matches(error.name_from, dir(sys.modules[error.name]), 6, 0.4)
        if near:
            said.append('The nearest names in ' + error.name + ' are: ' + ', '.join(near))
    if isinstance(error, TypeError) and found is not None:
        frame = found.tb_frame
        line = found.tb_lineno
        calls = [n for n in ast.walk(ast.parse(open(main, encoding='utf-8').read())) if isinstance(n, ast.Call) and n.lineno <= line <= n.end_lineno]
        try:
            spot = list(frame.f_code.co_positions())[found.tb_lasti // 2]
            exact = [n for n in calls if (n.lineno, n.end_lineno, n.col_offset, n.end_col_offset) == tuple(spot)]
            calls = exact or calls
        except Exception:
            pass
        def look(node):
            if isinstance(node, ast.Name):
                for names in (frame.f_locals, frame.f_globals, __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)):
                    if node.id in names:
                        return names[node.id]
                raise NameError(node.id)
            if isinstance(node, ast.Attribute):
                return getattr(look(node.value), node.attr)
            raise ValueError()
        for call in calls[:3]:
            try:
                called = look(call.func)
                said.append('What it accepts: ' + ast.unparse(call.func) + str(inspect.signature(called)))
                about = (inspect.getdoc(called) or '').strip().split('\n\n')[0].replace('\n', ' ')
                if about:
                    said.append(about[:200])
            except Exception:
                pass
    if said:
        print('\n' + '\n'.join(said)[:1500], file=sys.stderr)

def _hook(kind, error, trace):
    sys.__excepthook__(kind, error, trace)
    try:
        _explain(error, trace)
    except Exception:
        pass

sys.excepthook = _hook
try:
    import faulthandler, signal
    faulthandler.register(signal.SIGTERM, all_threads=False, chain=True)
except Exception:
    pass
`;
// The network is shut unless a job names the few addresses it may reach.
export const runInSandbox = async ({ language, code, files = [], seconds = 300, allow = [], keep = null }) => {
    const [command, ending] = PROGRAM_RUNS[language] || PROGRAM_RUNS.python;
    const sandboxes = await sandboxesOf();
    const networkPolicy = allow.length > 0 ? { type: 'allow-list', rules: allow.map((domain) => ({ domain })) } : { type: 'deny-all' };
    const runFor = Math.min(Math.max(Math.round(seconds), 30), MAX_PROGRAM_SECONDS);
    const keeping = Boolean(keep) && allow.length === 0;
    const start = async () => {
        try {
            return await sandboxes.create({ snapshotName: process.env.SANDBOX_SNAPSHOT, networkPolicy, timeoutSeconds: keeping ? KEEP_LIFE_SECONDS : Math.max(900, runFor + 300), idleTimeoutSeconds: keeping ? 900 : 300, wait: { timeoutMs: 120000 } });
        } catch (error) {
            throw new Error(`A sandbox could not be started: ${String(error?.message || error).slice(0, 200)}`);
        }
    };
    const held = keeping ? keptSandboxes.get(keep) : null;
    let sandbox = null;
    let createdAt = Date.now();
    let fresh = true;
    if (held && Date.now() + (runFor + 120) * 1000 < held.createdAt + KEEP_LIFE_SECONDS * 1000) {
        clearTimeout(held.timer);
        sandbox = { id: held.id };
        createdAt = held.createdAt;
        fresh = false;
    } else if (held) {
        await letSandboxGo(keep);
    }
    if (!sandbox) sandbox = await start();
    try {
        const exec = async (line) => {
            let stdout = '';
            let stderr = '';
            let exitCode = null;
            for await (const event of await sandboxes.exec(sandbox.id, line)) {
                if (event.type === 'output' && event.stream === 'stderr') stderr += event.data;
                else if (event.type === 'output') stdout += event.data;
                else if (event.type === 'exit') exitCode = event.exit_code;
            }
            return { stdout, stderr, exitCode };
        };
        // A kept sandbox may have been closed meanwhile; then a new one is started and the earlier files are gone.
        try {
            await exec('mkdir -p /root/work /root/job/hook');
        } catch (error) {
            if (fresh) throw error;
            keptSandboxes.delete(keep);
            await sandboxes.terminate(sandbox.id).catch(() => {});
            sandbox = await start();
            createdAt = Date.now();
            fresh = true;
            await exec('mkdir -p /root/work /root/job/hook');
        }
        for (const file of files) await sandboxes.upload(sandbox.id, `/root/work/${file.path}`, file.buffer);
        await sandboxes.upload(sandbox.id, `/root/job/main.${ending}`, Buffer.from(code));
        if (language === 'python') await sandboxes.upload(sandbox.id, '/root/job/hook/sitecustomize.py', Buffer.from(PYTHON_HOOK));
        await exec('touch /root/job/.start');
        const began = Date.now();
        const ran = await exec(`cd /root/work && export HOME=/root PATH=/root/env/bin:$PATH NODE_PATH=/root/node/node_modules PYTHONUNBUFFERED=1 PYTHONPATH=/root/job/hook && timeout -k 5 ${runFor} ${command} /root/job/main.${ending}`);
        const ranMs = Date.now() - began;
        // Ended with a kill signal well before its time is up: the computer ended it itself, which is nearly always memory.
        const killed = ran.exitCode === 137 && ranMs < runFor * 1000;
        const listed = await exec(`cd /root/work && find . -type f -newer /root/job/.start | sed 's|^./||' | head -${SANDBOX_FILES + 1}`);
        const made = [];
        let size = 0;
        const skipped = [];
        for (const path of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
            if (made.length >= SANDBOX_FILES) {
                skipped.push(path);
                continue;
            }
            const download = await sandboxes.download(sandbox.id, `/root/work/${path}`, undefined, { maxSizeBytes: SANDBOX_BYTES }).catch(() => null);
            const buffer = download ? Buffer.from(download.data) : null;
            if (!buffer || size + buffer.length > SANDBOX_BYTES) {
                skipped.push(path);
                continue;
            }
            size += buffer.length;
            made.push({ path, buffer });
        }
        return { exitCode: ran.exitCode, timedOut: ran.exitCode === 124 || (ran.exitCode === 137 && !killed), killed, ranMs, seconds: runFor, stdout: ran.stdout, stderr: ran.stderr, files: made, skipped, kept: keeping, fresh: keeping && Boolean(held) && fresh };
    } finally {
        if (keeping) {
            const timer = setTimeout(() => { letSandboxGo(keep); }, keepIdleMs);
            timer.unref?.();
            keptSandboxes.set(keep, { id: sandbox.id, createdAt, timer });
        } else {
            await sandboxes.terminate(sandbox.id).catch(() => {});
        }
    }
};

// Files an earlier run left in a chat's kept sandbox, read without running anything. Null when that sandbox has gone.
export const takeFromSandbox = async (keep, paths) => {
    const held = keptSandboxes.get(keep);
    if (!held) return null;
    const sandboxes = await sandboxesOf();
    const files = [];
    const missing = [];
    let size = 0;
    for (const path of paths) {
        const download = await sandboxes.download(held.id, `/root/work/${path}`, undefined, { maxSizeBytes: SANDBOX_BYTES }).catch(() => null);
        const buffer = download ? Buffer.from(download.data) : null;
        if (!buffer || size + buffer.length > SANDBOX_BYTES) {
            missing.push(path);
            continue;
        }
        size += buffer.length;
        files.push({ path, buffer });
    }
    return { files, missing };
};

let filesRetryMs = 3000;
let filesWakeMs = 90000;
export const setFilesWakeMs = (ms, retryMs) => {
    filesWakeMs = ms ?? 90000;
    filesRetryMs = retryMs ?? 3000;
};
export const createFilesClient = ({ baseUrl, accessToken }) => {
    const root = `${String(baseUrl || '').replace(/\/+$/, '')}/api/v1/files`;
    const csrf = 'ai-base-server';
    const headers = { Cookie: `accessToken=${accessToken}; csrfToken=${csrf}`, 'X-CSRF-Token': csrf, Accept: 'application/json' };

    // A FilesystemOne that has gone to sleep answers 502 to 504, or not at all, while it starts, which can take over a
    // minute; it is asked again for up to 90 seconds.
    const call = async (url, options = {}, failure = 'FILE_NOT_FOUND') => {
        const until = Date.now() + filesWakeMs;
        let response;
        for (;;) {
            let problem = null;
            try {
                response = await filesFetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20000) });
                if ([502, 503, 504].includes(response.status)) problem = `status ${response.status}`;
            } catch (error) {
                problem = `${error.message}${error.cause ? `: ${error.cause.code || error.cause.message}` : ''}`;
            }
            if (!problem) break;
            if (Date.now() + filesRetryMs >= until || options.body instanceof FormData) throw new OllamaError('FILES_DOWN', problem);
            await new Promise((resolve) => setTimeout(resolve, filesRetryMs));
        }
        if (response.status >= 500 || response.status === 429) throw new OllamaError('FILES_DOWN', `status ${response.status}`);
        if (!response.ok) throw new OllamaError(failure, `status ${response.status}`);
        return response;
    };
    const address = (filePath, part) => `${root}/${encodeURIComponent(filePath)}/${part}`;

    return {
        async browse(folder) {
            const response = await call(`${root}/directory/contents?filePath=${encodeURIComponent(folder)}`);
            const body = await response.json();
            const entries = (body.contents || []).map((entry) => ({
                name: entry.fileName,
                path: entry.filePath,
                type: entry.type === 'directory' ? 'folder' : 'file',
                size: entry.size || 0,
                updatedAt: entry.updatedAt || null
            }));
            return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1));
        },

        async text(filePath) {
            const name = filePath.split('/').pop();
            const extension = path.extname(name).toLowerCase();
            if (!['.pdf', '.docx'].includes(extension)) {
                const body = await (await call(address(filePath, 'content'))).json();
                if (body.fileType === 'text' && typeof body.content === 'string') {
                    const text = body.content.trim();
                    if (!text) throw new OllamaError('FILE_UNREADABLE', 'empty file');
                    return { name, text };
                }
            }
            const response = await call(address(filePath, 'download'), { headers: { Accept: '*/*' } });
            if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) throw new OllamaError('FILE_TOO_LARGE');
            const buffer = Buffer.from(await response.arrayBuffer());
            return { name, text: await extractText({ buffer, name }) };
        },

        // A file as it is stored, for work that needs more than its text.
        async bytes(filePath) {
            const response = await call(address(filePath, 'download'), { headers: { Accept: '*/*' } });
            if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) throw new OllamaError('FILE_TOO_LARGE');
            return { name: filePath.split('/').pop(), buffer: Buffer.from(await response.arrayBuffer()) };
        },

        // Files put into a folder as they are. A name already taken there is not overwritten: the new file is renamed.
        async upload(folder, entries) {
            const form = new FormData();
            entries.forEach((entry) => form.append('files', new Blob([entry.buffer]), entry.path));
            form.append('relativePaths', JSON.stringify(entries.map((entry) => entry.path)));
            form.append('basePath', folder);
            form.append('onConflict', 'rename');
            await call(`${root}/upload`, { method: 'POST', body: form }, 'FILE_NOT_SAVED');
        },

        async save(folder, name, content) {
            const filePath = `${folder.replace(/\/+$/, '')}/${name}`;
            const response = await call(root, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath, content, onConflict: 'rename' })
            }, 'FILE_NOT_SAVED');
            const body = await response.json();
            return { path: body.file?.filePath || filePath };
        }
    };
};

export const MAX_REMOTE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export const isPublicAddress = (address) => {
    const family = net.isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
        if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
        if (a === 203 && b === 0 && c === 113) return false;
        return true;
    }
    if (family === 6) {
        const text = address.toLowerCase();
        const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPublicAddress(mapped[1]);
        if (text === '::' || text === '::1') return false;
        if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(text)) return false;
        if (text.startsWith('::ffff:') || text.startsWith('64:ff9b:')) return false;
        return true;
    }
    return false;
};

const realRemote = {
    lookup: (host) => dns.lookup(host, { all: true }),
    request: (url, pinned) => new Promise((resolve, reject) => {
        const request = https.get(url, {
            timeout: 20000,
            headers: { 'User-Agent': 'Mollama/1.0 (local file viewer)', Accept: '*/*' },
            lookup: (hostname, options, callback) => (options?.all
                ? callback(null, [{ address: pinned.address, family: pinned.family }])
                : callback(null, pinned.address, pinned.family))
        }, (response) => resolve({ status: response.statusCode, headers: response.headers, stream: response }));
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    })
};
let remote = realRemote;
let remoteRetryMs = 1500;

// Returns what was in place before, so a test can put it back.
export const setRemoteTransport = (replacement) => {
    const before = remote === realRemote ? null : remote;
    remote = replacement ? { ...realRemote, ...replacement } : realRemote;
    remoteRetryMs = replacement ? 0 : 1500;
    return before;
};

export const fetchRemote = async (address, redirects = 0, retried = false) => {
    let url;
    try {
        url = new URL(String(address));
    } catch {
        throw new OllamaError('REMOTE_BLOCKED');
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new OllamaError('REMOTE_BLOCKED');

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
        addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await remote.lookup(host);
    } catch (error) {
        throw new OllamaError('REMOTE_FAILED', error.message);
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new OllamaError('REMOTE_BLOCKED');
    }

    let response;
    try {
        response = await remote.request(url, addresses[0]);
    } catch (error) {
        throw new OllamaError('REMOTE_FAILED', error.message);
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        response.stream?.destroy?.();
        if (redirects >= MAX_REDIRECTS) throw new OllamaError('REMOTE_FAILED', 'too many redirects');
        return fetchRemote(new URL(response.headers.location, url).href, redirects + 1);
    }
    if ([429, 503].includes(response.status)) {
        response.stream?.destroy?.();
        if (retried) throw new OllamaError('REMOTE_BUSY', `status ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, remoteRetryMs));
        return fetchRemote(url.href, redirects, true);
    }
    if (response.status !== 200) {
        response.stream?.destroy?.();
        throw new OllamaError([404, 410].includes(response.status) ? 'REMOTE_NOT_FOUND' : 'REMOTE_FAILED', `status ${response.status}`);
    }
    if (Number(response.headers['content-length']) > MAX_REMOTE_BYTES) {
        response.stream?.destroy?.();
        throw new OllamaError('REMOTE_TOO_LARGE');
    }
    return { stream: response.stream, contentType: response.headers['content-type'] || null, size: Number(response.headers['content-length']) || null };
};

const SEARCH_SMALL_WORDS = new Set(['an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'from', 'by', 'at', 'as', 'is']);
let searchFetch = realFetch;

export const setSearchFetch = (replacement) => {
    const before = searchFetch;
    searchFetch = replacement || realFetch;
    return before;
};

const searchKey = () => String(process.env.TAVILY_API_KEY || '').trim();
export const searchReady = () => Boolean(searchKey());

const askSearch = async (url, options) => {
    let response;
    try {
        response = await searchFetch(url, { ...options, signal: AbortSignal.timeout(20000) });
    } catch (error) {
        throw new OllamaError('SEARCH_DOWN', error.message);
    }
    if ([429, 432, 433].includes(response.status)) throw new OllamaError('SEARCH_LIMITED', `status ${response.status}`);
    if (!response.ok) throw new OllamaError('SEARCH_REFUSED', `status ${response.status}`);
    try {
        return await response.json();
    } catch {
        throw new OllamaError('SEARCH_REFUSED', 'the answer was not JSON');
    }
};

export const searchWeb = async (query) => {
    const body = await askSearch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${searchKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' })
    });
    const wanted = [...new Set((String(query).toLowerCase().replace(/\b(?:site|filetype):\S+/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) || []).filter((word) => !SEARCH_SMALL_WORDS.has(word)))];
    const needed = Math.min(2, wanted.length);
    const results = (Array.isArray(body?.results) ? body.results : []).filter((result) => {
        const text = `${result.title ?? ''} ${result.content ?? ''} ${result.url ?? ''}`.toLowerCase();
        return wanted.filter((word) => text.includes(word)).length >= needed;
    });
    return results.slice(0, 5).map((result) => ({
        title: String(result.title ?? ''),
        url: String(result.url ?? ''),
        content: String(result.content ?? '')
    }));
};

// The list of models comes live from ollama.com, which has no data address for its library, so its pages are read.
const LIBRARY = 'https://ollama.com';
const LIBRARY_KEEP_MS = 6 * 60 * 60 * 1000;
const LIBRARY_PAGES = 40;
const LIBRARY_ABILITIES = new Set(['vision', 'tools', 'thinking', 'embedding', 'audio', 'cloud']);
const MB_PER_BILLION = 650;
const SHORT_NAMES = new Set(['gpt', 'oss', 'glm', 'lfm', 'ai', 'llm', 'qwq', 'bge']);
let libraryFetch = null;
let libraryList = null;
const librarySizeCache = new Map();
export const setLibraryFetch = (custom) => {
    libraryFetch = custom;
    libraryList = null;
    librarySizeCache.clear();
};

// Pages after the first are only given to the site's own "load more" request, which the HX-Request header marks.
const libraryPage = async (address, more = false) => {
    let response;
    try {
        response = await (libraryFetch || fetch)(`${LIBRARY}${address}`, { headers: { Accept: 'text/html', ...(more ? { 'HX-Request': 'true' } : {}) }, signal: AbortSignal.timeout(12000) });
    } catch {
        throw new OllamaError('LIBRARY_UNREACHABLE');
    }
    if (!response.ok) throw new OllamaError('LIBRARY_UNREACHABLE');
    return response.text();
};

// "gemma3:12b" reads as "Gemma 3 12B"; the Ollama name is always shown beside it.
// A computer's network name made readable, for computers the person has not named: the network part is dropped and
// a Mac's own pattern spelled out ("Davids-MacBook-Pro.local" becomes "David's MacBook Pro").
export const computerName = (hostname) => {
    const bare = String(hostname || '').split('.')[0] || String(hostname || '');
    if (!/mac|imac|mbp/i.test(bare)) return bare;
    return bare.replace(/[-_]+/g, ' ').replace(/\bMBP\b/i, 'MacBook Pro').replace(/\b([A-Za-z]+?)s (MacBook|iMac|Mac)\b/, "$1's $2").trim();
};

// An online service's model id made readable when the service gives no name of its own: date stamps and "cloud"
// marks dropped, and version numbers joined ("claude-sonnet-4-5-20250929" becomes "Claude Sonnet 4.5").
export const cloudTitle = (id) => {
    const bare = String(id).replace(/^models\//, '').replace(/[-:]cloud$/i, '').replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/i, '');
    return friendlyName(bare).replace(/\b(\d) (\d)\b/g, '$1.$2').replace(/\b(\d+(?:\.\d+)?)([bmt])\b/g, (whole, size, unit) => size + unit.toUpperCase());
};

export const friendlyName = (tag) => {
    const [name, size = ''] = String(tag).split(':');
    if (name.includes('/')) return String(tag);
    const words = name.split(/[-_]/).filter(Boolean).map((word) => (SHORT_NAMES.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.replace(/^([a-z]{3,})(\d)/i, '$1 $2').replace(/^[a-z]/, (letter) => letter.toUpperCase())));
    const sized = parseParameters(size) !== null ? size.toUpperCase().replace('X', 'x') : size && size !== 'latest' ? size : '';
    return [...words, sized].filter(Boolean).join(' ');
};

const plainText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// "12b" is 12 billion parameters, "270m" is 0.27, "e4b" is 4 and "8x7b" is eight experts of 7.
export const parseParameters = (size) => {
    const several = String(size).match(/^(\d+)x(\d+(?:\.\d+)?)b$/);
    if (several) return Number(several[1]) * Number(several[2]);
    const single = String(size).match(/^e?(\d+(?:\.\d+)?)([bm])$/);
    return single ? Number(single[1]) / (single[2] === 'm' ? 1000 : 1) : null;
};

export const parseLibrary = (html) => {
    const seen = new Set();
    return String(html).split(/<a\s[^>]*?href="\/library\//).slice(1).map((block) => {
        const name = block.match(/^([a-z0-9][a-z0-9._-]*)"/i)?.[1];
        if (!name || seen.has(name)) return null;
        seen.add(name);
        const body = block.split('</a>')[0];
        const words = [...body.matchAll(/<span[^>]*>\s*([^<>]{1,24}?)\s*<\/span>/g)].map((match) => match[1].trim());
        return {
            name,
            description: plainText(body.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || ''),
            capabilities: [...new Set(words.filter((word) => LIBRARY_ABILITIES.has(word)))],
            sizes: [...new Set(words.filter((word) => parseParameters(word) !== null))],
            pulls: Number((body.match(/title="([\d,]+) downloads"/)?.[1] || '').replace(/,/g, '')) || 0,
            updated: body.match(/title="Updated ([^"]+)"/)?.[1] || null
        };
    }).filter(Boolean);
};

// The size on disk of each tag of one model, in megabytes.
export const parseLibrarySizes = (html) => {
    const sizes = new Map();
    for (const match of String(html).matchAll(/href="\/library\/[^":]+:([^"]+)"([\s\S]{0,3000}?)<\/a>/g)) {
        if (sizes.has(match[1])) continue;
        const size = plainText(match[2]).match(/([\d.]+)\s*(GB|MB)\b/);
        if (size) sizes.set(match[1], Math.round(Number(size[1]) * (size[2] === 'GB' ? 1024 : 1)));
    }
    return sizes;
};

export const librarySizes = async (name) => {
    const kept = librarySizeCache.get(name);
    if (kept && kept.until > Date.now()) return kept.sizes;
    try {
        const sizes = parseLibrarySizes(await libraryPage(`/library/${encodeURIComponent(name)}/tags`));
        librarySizeCache.set(name, { sizes, until: Date.now() + LIBRARY_KEEP_MS });
        return sizes;
    } catch {
        return new Map();
    }
};

// Reads the exact sizes of several models, a few at a time.
export const loadLibrarySizes = async (names) => {
    const waiting = [...new Set(names)].filter((name) => !(librarySizeCache.get(name)?.until > Date.now()));
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (waiting.length > 0) await librarySizes(waiting.shift());
    }));
};

// Every model in the library: the first page, then each further page until one adds nothing new.
export const libraryModels = async () => {
    if (libraryList && libraryList.until > Date.now()) return libraryList.models;
    const models = parseLibrary(await libraryPage('/search'));
    if (models.length === 0) throw new OllamaError('LIBRARY_UNREADABLE');
    let complete = true;
    for (let page = 2; page <= LIBRARY_PAGES; page++) {
        let found;
        try {
            found = parseLibrary(await libraryPage(`/search?page=${page}`, true));
        } catch {
            complete = false;
            break;
        }
        const fresh = found.filter((model) => !models.some((known) => known.name === model.name));
        if (fresh.length === 0) break;
        models.push(...fresh);
    }
    libraryList = { models, until: Date.now() + (complete ? LIBRARY_KEEP_MS : 5 * 60 * 1000) };
    return models;
};

const purposesOf = (model) => {
    if (model.capabilities.includes('embedding')) return ['embedding'];
    const text = `${model.name} ${model.description}`.toLowerCase();
    const purposes = ['chat', 'writing'];
    if (/\bcod(?:e|er|ing)\b|program/.test(text)) purposes.push('code');
    if (model.capabilities.includes('thinking') || /reason/.test(text)) purposes.push('reasoning');
    return purposes;
};

// One entry for each size of each model, in the shape the fit and ranking work on. A size not read yet is estimated.
// A model with no size to download runs only on Ollama's own servers: it is listed, marked as such, and cannot be downloaded.
export const libraryEntries = (models) => models
    .flatMap((model) => (model.sizes.length > 0 ? model.sizes : ['latest']).map((size) => {
        const cloudOnly = model.sizes.length === 0 && model.capabilities.includes('cloud');
        const known = librarySizeCache.get(model.name)?.sizes.get(size) || null;
        const parameters = parseParameters(size) ?? (known ? Math.round((known / MB_PER_BILLION) * 10) / 10 : 0);
        const tag = cloudOnly ? model.name : `${model.name}:${size}`;
        return {
            tag,
            cloudOnly,
            name: friendlyName(tag),
            description: model.description,
            goodFor: purposesOf(model),
            parameters,
            sizeMb: known || Math.round(parameters * MB_PER_BILLION),
            sizeEstimated: !known,
            // A size is mixture-of-experts when its name says so (8x7b, 30b-a3b), or when the whole family is: a family
            // described as both dense and mixture-of-experts has dense sizes too, so its description alone decides nothing.
            moe: /^\d+x/.test(size) || /-a\d+(\.\d+)?b$/i.test(size) || (/mixture.of.experts|\bmoe\b/i.test(model.description) && !/\bdense\b/i.test(model.description)),
            capabilities: model.capabilities.filter((ability) => ability !== 'cloud'),
            pulls: model.pulls,
            updated: model.updated
        };
    }))
    .filter((entry) => entry.sizeMb > 0 || entry.cloudOnly);

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
});

export const readPage = async (address) => {
    const { stream, contentType } = await fetchRemote(address);
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (type && !/^text\/|json|xml/.test(type)) {
        stream.destroy?.();
        return { title: '', content: `This address is a file of type ${type}, not a page of text.`, links: [], media: [], embedded: [], file: type };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_PAGE_BYTES) break;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!type.includes('html') && !/^\s*<(?:!doctype|html)/i.test(raw)) return { title: '', content: raw, links: [], media: [], embedded: [], file: type || null };

    const title = decodeEntities((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
    const absolute = (pattern) => [...new Set([...raw.matchAll(pattern)].map((match) => {
        try {
            return new URL(decodeEntities(match[1]), address).href;
        } catch {
            return null;
        }
    }).filter((link) => link && link.startsWith('https://')))];
    const links = absolute(/<a\s[^>]*?href\s*=\s*["']([^"'#]+)["']/gi);
    const media = [...new Set([
        ...absolute(/<meta\s[^>]*?(?:property|name)\s*=\s*["']og:(?:image|video|audio)[^"']*["'][^>]*?content\s*=\s*["']([^"']+)["']/gi),
        ...absolute(/<(?:img|source|video|audio|embed)\s[^>]*?(?:data-src|src)\s*=\s*["']([^"'#]+)["']/gi)
    ])];
    const content = decodeEntities(raw
        .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(?:p|div|li|h\d|tr|section|article|pre|blockquote)>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[ \t\r]+/g, ' ')
        .replace(/ ?\n[ \n]*/g, '\n')
        .trim();
    const embedded = [...new Set(raw.replace(/\\\//g, '/').match(/https:\/\/[^\s"'<>\\)]+/g) || [])].slice(0, 2000);
    return { title, content, links, media, embedded, file: null };
};

// Tool servers. Each state says what is true now; "needs" says what has to be true for the server to be usable.
export const TOOL_HEALTH = {
    healthy: { label: 'Ready', needs: [] },
    unchecked: { label: 'Not checked yet', needs: ['Mollama has not checked this one yet. Choose Check now.'] },
    signin: { label: 'Sign-in needed', needs: ['Sign in to this app, so Mollama can use it on your behalf.'] },
    refused: { label: 'Access refused', needs: ['The key or sign-in was not accepted. Sign in again, or replace the key.'] },
    unreachable: { label: 'Cannot be reached', needs: ['The address has to be the tool server address exactly as the app gives it.', 'The tool server has to be up. If it was working before, try again in a few minutes.'] },
    busy: { label: 'Busy right now', needs: ['This app is limiting how many requests it takes, so it will work again shortly.', 'If it keeps happening, add your own key for this app: your use then counts against your own allowance.'] },
    blocked: { label: 'Address not allowed', needs: ['Remote tools need a public address that starts with https.', 'For an app on your own computer, add it under Local tools instead.'] },
    empty: { label: 'No tools offered', needs: ['The server answered but offered no tools. Your account there may need a plan or permission that includes them.'] },
    offline: { label: 'Computer offline', needs: ['That computer has to be on, with the Mollama desktop app open and signed in.'] },
    outdated: { label: 'No answer in time', needs: ['The desktop app on that computer did not finish the check in time. Choose Check again.', 'If it keeps happening, update the Mollama desktop app there and open it again.'] },
    stopped: { label: 'Not running', needs: ['The tool server could not be started on that computer. The program it runs with has to be installed there.', 'If it controls an app, that app has to be open.'] },
    waiting: { label: 'App not open', needs: ['The tool server works, but the app it controls did not answer, so its tools are not offered to models yet.', 'Open the app and start its MCP server, then choose Check.'] },
    missing: { label: 'Not on that computer', needs: ['This tool server is no longer set up on that computer. Remove it here and add it again from the desktop app.'] }
};

const sealKey = () => Buffer.from(crypto.hkdfSync('sha256', String(process.env.ACCESS_TOKEN_SECRET), '', 'mollama-tool-servers', 32));
export const seal = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
};
export const unseal = (text) => {
    try {
        const [iv, tag, body] = String(text).split('.').map((part) => Buffer.from(part, 'base64url'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    } catch {
        return null;
    }
};

// Every request to a tool server goes to a public https address, held to the address that was checked.
const guardedFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new OllamaError('REMOTE_BLOCKED');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
        addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
    } catch (error) {
        throw new OllamaError('REMOTE_FAILED', error.message);
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) throw new OllamaError('REMOTE_BLOCKED');
    const pinned = addresses[0];
    const method = String(init.method || 'GET').toUpperCase();
    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            method,
            headers: Object.fromEntries(new Headers(init.headers || {})),
            timeout: 60000,
            lookup: (hostname, options, callback) => (options?.all
                ? callback(null, [{ address: pinned.address, family: pinned.family }])
                : callback(null, pinned.address, pinned.family))
        }, (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) for (const one of [].concat(value)) headers.append(name, one);
            const bare = method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
            if (bare) response.resume();
            resolve(new Response(bare ? null : Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage, headers }));
        });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
        init.signal?.addEventListener('abort', () => request.destroy(init.signal.reason || new Error('aborted')), { once: true });
        request.end(init.body == null ? undefined : typeof init.body === 'string' || init.body instanceof URLSearchParams ? String(init.body) : Buffer.from(init.body));
    });
};

const TOOL_CLIENT = { name: 'mollama', version: '1.0.0' };
const openRemote = async (address, options) => {
    const url = new URL(address);
    const first = new Client(TOOL_CLIENT);
    try {
        await first.connect(new StreamableHTTPClientTransport(url, options));
        return first;
    } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof OllamaError || [401, 403, 429].includes(error?.status)) throw error;
        const older = new Client(TOOL_CLIENT);
        try {
            await older.connect(new SSEClientTransport(url, options));
            return older;
        } catch {
            throw error;
        }
    }
};
const finishRemote = (address, keeper, params) => new StreamableHTTPClientTransport(new URL(address), { fetch: guardedFetch, authProvider: keeper }).finishAuth(params);

let toolConnector = openRemote;
let toolFinisher = finishRemote;
export const setToolConnector = (connector = null, finisher = null) => {
    toolConnector = connector || openRemote;
    toolFinisher = finisher || finishRemote;
};
export { UnauthorizedError as ToolSignInError };

// Holds one person's sign-in to one tool server while the library signs in, refreshes or uses it. "kept" is what gets sealed.
export const accountKeeper = (kept, redirectUrl) => ({
    asked: null,
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
        return { client_name: 'Mollama', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web' };
    },
    state: () => kept.state,
    clientInformation: () => kept.client,
    saveClientInformation: (client) => { kept.client = client; },
    tokens: () => kept.tokens,
    saveTokens: (tokens) => { kept.tokens = tokens; },
    redirectToAuthorization(url) { this.asked = String(url); },
    saveCodeVerifier: (verifier) => { kept.verifier = verifier; },
    codeVerifier: () => kept.verifier,
    invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'tokens') delete kept.tokens;
        if (scope === 'all' || scope === 'client') delete kept.client;
        if (scope === 'all' || scope === 'verifier') delete kept.verifier;
    }
});

// On the hosted sites every request leaves from one address, so an app that takes no sign-in would count everyone
// against one allowance. There, an app that offers free keys needs one; on a person's own computer it stays optional.
const hosted = () => process.env.NODE_ENV === 'production';
export const toolKeyNeeded = (entry) => Boolean(entry) && (entry.signIn === 'key' || (entry.signIn === 'none' && Boolean(entry.key) && hosted()));
export const listedTool = (address) => TOOL_CATALOGUE.find((entry) => entry.address === address) || null;
// Most apps take a key as a bearer token; a listed app that wants it under another name says so.
const keyHeaders = (address, key) => {
    const header = listedTool(address)?.key?.header;
    return header ? { [header]: key } : { Authorization: `Bearer ${key}` };
};

export const withToolServer = async ({ address, key = null, keeper = null }, work) => {
    const options = { fetch: guardedFetch, ...(key ? { requestInit: { headers: keyHeaders(address, key) } } : keeper ? { authProvider: keeper } : {}) };
    const client = await toolConnector(address, options);
    try {
        return await work(client);
    } finally {
        await client.close().catch(() => {});
    }
};
export const finishToolSignIn = (address, keeper, params) => toolFinisher(address, keeper, params);

export const MAX_SERVER_TOOLS = 200;
export const readTools = async (client) => {
    const { tools = [] } = await client.listTools();
    // Only what can be stored is kept: an app's odd title or an oversized description of a tool's inputs must not make the check fail.
    const text = (value, most) => (typeof value === 'string' && value.trim() ? value.slice(0, most) : null);
    const inputOf = (schema) => {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
        try {
            return JSON.stringify(schema).length <= 20000 ? schema : { type: 'object' };
        } catch {
            return null;
        }
    };
    return (Array.isArray(tools) ? tools : []).filter((tool) => text(tool?.name, 120)).slice(0, MAX_SERVER_TOOLS).map((tool) => ({
        name: text(tool.name, 120),
        title: text(tool.title, 200) || text(tool.annotations?.title, 200),
        description: text(tool.description, 600) || '',
        readOnly: tool.annotations?.readOnlyHint === true,
        input: inputOf(tool.inputSchema)
    }));
};

export const toolFault = (error, withKey = false) => {
    if (error instanceof UnauthorizedError || error?.status === 401) return withKey ? 'refused' : 'signin';
    if (error?.status === 403) return 'refused';
    if (error?.status === 429) return 'busy';
    if (error instanceof OllamaError && error.code === 'REMOTE_BLOCKED') return 'blocked';
    return 'unreachable';
};

// Online apps whose makers run a tool server of their own that any app may connect to. Each address was read from
// the maker's documentation and answered when tried on 2026-11-17, or 2026-11-24 for the image and video ones and ScrapeCreators. "signIn" is what the app asks for: an account
// (its own sign-in page), a key the person pastes, or nothing.
// An app that needs a key also says where the key is made and how, in the order a person does it.
// One whose use takes credits or a plan of the person's says so in "cost".
const app = (name, group, address, does, signIn = 'account', key = null, cost = null) => ({ name, group, address, does, signIn, key, cost });
export const TOOL_CATALOGUE = [
    app('Notion', 'Notes and docs', 'https://mcp.notion.com/mcp', 'Search, read, create and edit pages and databases'),
    app('Atlassian', 'Notes and docs', 'https://mcp.atlassian.com/v2/mcp', 'Search and edit Jira issues and Confluence pages'),
    app('Airtable', 'Notes and docs', 'https://mcp.airtable.com/mcp', 'Read and write bases and records'),
    app('Coda', 'Notes and docs', 'https://coda.io/apis/mcp', 'Read and edit docs and tables'),
    app('Linear', 'Projects', 'https://mcp.linear.app/mcp', 'Find, create and update issues and projects'),
    app('ClickUp', 'Projects', 'https://mcp.clickup.com/mcp', 'Manage tasks, docs and time'),
    app('Trello', 'Projects', 'https://mcp.trello.com/v1', 'Read and update boards, lists and cards'),
    app('Todoist', 'Projects', 'https://ai.todoist.net/mcp', 'Add, find and complete tasks'),
    app('monday.com', 'Projects', 'https://mcp.monday.com/mcp', 'Read and update boards and items'),
    app('GitHub', 'Code', 'https://api.githubcopilot.com/mcp/', 'Work with repositories, issues and pull requests', 'key', {
        page: 'https://github.com/settings/personal-access-tokens/new',
        cost: 'Free with any GitHub account.',
        steps: [
            'Open the key page while signed in to GitHub. GitHub calls the key a fine-grained personal access token.',
            'Give it a name such as Mollama, and pick when it should expire.',
            'Under Repository access, choose the repositories Mollama may work with.',
            'Under Permissions, allow what you want models to do: Contents, Issues and Pull requests cover most uses. Choose Read-only to let them look without changing anything.',
            'Choose Generate token, copy it, and paste it into the Key box here. GitHub shows it only once.'
        ]
    }),
    app('GitLab', 'Code', 'https://gitlab.com/api/v4/mcp', 'Work with issues, merge requests and pipelines'),
    app('Sentry', 'Code', 'https://mcp.sentry.dev/mcp', 'Look into errors, issues and traces'),
    app('Netlify', 'Code', 'https://mcp.netlify.com/mcp', 'Create, deploy and manage sites'),
    app('Cloudflare', 'Code', 'https://mcp.cloudflare.com/mcp', 'Manage what runs on your Cloudflare account'),
    app('Cloudflare Docs', 'Code', 'https://docs.mcp.cloudflare.com/mcp', 'Search the Cloudflare documentation', 'none'),
    app('Supabase', 'Code', 'https://mcp.supabase.com/mcp', 'Manage projects, run queries and read logs'),
    app('Neon', 'Code', 'https://mcp.neon.tech/mcp', 'Manage Postgres projects and run queries'),
    app('PostHog', 'Code', 'https://mcp.posthog.com/mcp', 'Ask about product analytics, flags and errors'),
    app('Context7', 'Code', 'https://mcp.context7.com/mcp', 'Fetch current documentation for code libraries', 'none', {
        page: 'https://context7.com/dashboard?tab=settings',
        cost: 'Free: 1,000 requests a month with a free account.',
        steps: [
            'Open the key page and sign up or sign in to Context7.',
            'In the API Keys card, choose Create API Key. Leave Write access unticked.',
            'Copy the key straight away and paste it into the Key box here. Context7 shows it only once.'
        ]
    }),
    app('DeepWiki', 'Code', 'https://mcp.deepwiki.com/mcp', 'Ask questions about public GitHub repositories', 'none'),
    app('Miro', 'Design', 'https://mcp.miro.com/', 'Read and create board content and diagrams'),
    app('Webflow', 'Design', 'https://mcp.webflow.com/mcp', 'Edit sites, pages and collection items'),
    app('Wix', 'Design', 'https://mcp.wix.com/mcp', 'Manage Wix sites'),
    app('WordPress.com', 'Design', 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', 'Manage posts, pages and site settings'),
    app('Recraft', 'Images and video', 'https://mcp.recraft.ai/mcp', 'Make and edit images, icons and vector drawings', 'account', null, 'Uses your Recraft credits. A free account has a small allowance.'),
    app('fal', 'Images and video', 'https://mcp.fal.ai/mcp-relay', 'Make images, video and audio with many models', 'account', null, 'Uses your fal credits, paid by use.'),
    app('Runway', 'Images and video', 'https://mcp.runwayml.com/mcp', 'Make images and video', 'account', null, 'Uses your Runway credits.'),
    app('invideo', 'Images and video', 'https://mcp.invideo.io/mcp', 'Make and edit video', 'account', null, 'Uses your invideo plan and credits.'),
    app('HeyGen', 'Images and video', 'https://mcp.heygen.com/mcp/v1/', 'Make video with a presenter, and translate video', 'account', null, 'Uses the credits of your HeyGen plan.'),
    app('Synthesia', 'Images and video', 'https://mcp.synthesia.io/mcp', 'Make and edit video with a presenter', 'account', null, 'Uses your Synthesia credits. A new account has some free.'),
    app('Higgsfield', 'Images and video', 'https://mcp.higgsfield.ai/mcp', 'Make images and video', 'account', null, 'Always uses your Higgsfield credits, also on plans with free use on its site.'),
    app('ScrapeCreators', 'Search and data', 'https://api.scrapecreators.com/mcp', 'Read public posts, comments and ads on TikTok, Instagram, YouTube, Reddit and X', 'account', null, 'Uses your ScrapeCreators credits. A new account has some free.'),
    app('Calendly', 'Messages and customers', 'https://mcp.calendly.com', 'Read availability and scheduled events'),
    app('Stripe', 'Payments and shops', 'https://mcp.stripe.com', 'Manage customers, invoices and subscriptions'),
    app('Hugging Face', 'Search and data', 'https://huggingface.co/mcp', 'Search models, datasets, Spaces and papers', 'none', {
        page: 'https://huggingface.co/settings/tokens',
        cost: 'Free with any Hugging Face account.',
        steps: [
            'Open the key page while signed in to Hugging Face. Hugging Face calls the key an access token.',
            'Choose New token, give it a name such as Mollama, and pick the Read role.',
            'Create it, copy it, and paste it into the Key box here.'
        ]
    }),
    app('Exa', 'Search and data', 'https://mcp.exa.ai/mcp', 'Search the web and read pages', 'none', {
        page: 'https://dashboard.exa.ai/api-keys',
        cost: 'Free: Exa gives every account credits each month.',
        header: 'x-api-key',
        steps: [
            'Open the key page and sign up or sign in to Exa.',
            'Under API Keys, create a key.',
            'Copy it and paste it into the Key box here.'
        ]
    }),
    app('Firecrawl', 'Search and data', 'https://mcp.firecrawl.dev/v2/mcp', 'Search, scrape and read web pages', 'none', {
        page: 'https://www.firecrawl.dev/app/api-keys',
        cost: 'Free: 1,000 credits with a free account.',
        steps: [
            'Open the key page and sign up or sign in to Firecrawl.',
            'Create a key, or copy the one already there.',
            'Paste it into the Key box here.'
        ]
    }),
    app('Tavily', 'Search and data', 'https://mcp.tavily.com/mcp/', 'Search the web and pull out page content'),
    app('Zapier', 'Automation', 'https://mcp.zapier.com/api/v1/connect', 'Run actions across thousands of connected apps'),
    app('Make', 'Automation', 'https://mcp.make.com/v2', 'Run and manage automation scenarios')
];

// Tool servers that run on a person's own computer, offered as suggestions. Each start command was read from the
// project's own instructions on 2026-11-18. "by" says who makes the server: the app's maker, the group behind the
// tool-server standard, or the community. A part in <angle brackets> is for the person to fill in before adding.
const NODE = 'Node.js has to be installed on this computer.';
const UV = 'uv, a small Python tool runner, has to be installed on this computer.';
// What the Tools page can check on a computer before adding: the program a tool server starts with (from its command)
// and the app it works with, so it ticks off what is there and offers to install what is not. Other steps stay steps.
const LOCAL_PROGRAM = { npx: 'node', uvx: 'uv', docker: 'docker', xcrun: 'xcode' };
const LOCAL_APP = { Blender: 'blender', 'Chrome DevTools': 'chrome', Docker: 'dockerdesktop', Xcode: 'xcode', Godot: 'godot', FreeCAD: 'freecad', 'Ableton Live': 'ableton', Git: 'git' };
const local = (name, by, command, args, does, needs, caution = null, only = null) => ({
    name, by, command, args, does, needs, caution, only,
    requires: { program: LOCAL_PROGRAM[command] || null, app: LOCAL_APP[name] || null },
    folder: /<folder>/.test(args),
    steps: needs.filter((need) => need !== NODE && need !== UV && !/^Replace <folder>/.test(need))
});
export const TOOL_LOCAL_CATALOGUE = [
    local('Blender', 'community', 'uvx', 'mcp-for-blender', 'Inspect and build 3D scenes, and import or generate assets',
        [UV, 'Blender has to be open.', 'Its add-on has to be installed once (run "uvx mcp-for-blender setup" in a terminal) and switched on in Blender.', 'In Blender, press N in the 3D view, open the MCP for Blender tab and choose Start MCP Server.'],
        'It can run code inside Blender. Made by the community, not by Blender.'),
    local('Chrome DevTools', 'maker', 'npx', '-y chrome-devtools-mcp@latest', 'Control and inspect Chrome: pages, console, network and speed',
        [NODE, 'Google Chrome has to be installed.'], 'It shows the model what is in the browser it controls.'),
    local('Playwright', 'maker', 'npx', '-y @playwright/mcp@latest', 'Drive a browser: open pages, click, type and read them',
        [NODE], 'It controls a real browser on this computer and keeps its sign-ins between uses.'),
    local('Docker', 'maker', 'docker', 'mcp gateway run', 'Use every tool server switched on in Docker Desktop',
        ['Docker Desktop has to be installed and running, with its MCP Toolkit switched on.']),
    local('Xcode', 'maker', 'xcrun', 'mcpbridge', 'Change and build the project open in Xcode',
        ['Xcode has to be open with your project.', 'In Xcode, Settings, Intelligence, allow external agents to use Xcode tools.'], 'It can change your project.', 'macOS'),
    local('Godot', 'community', 'npx', '-y @coding-solo/godot-mcp', 'Open the Godot editor, run projects and build scenes',
        [NODE, 'Godot has to be installed.'], 'It can run your Godot projects. Made by the community.'),
    local('FreeCAD', 'community', 'uvx', 'freecad-mcp', 'Create and edit CAD objects',
        [UV, 'FreeCAD has to be open.', 'Its add-on has to be copied into FreeCAD once, then started from the MCP Addon workbench with Start RPC Server.'], 'It can run code inside FreeCAD. Made by the community.'),
    local('Ableton Live', 'community', 'uvx', 'ableton-mcp', 'Create tracks and clips, edit notes and control playback',
        [UV, 'Ableton Live has to be open.', 'Its remote script has to be installed once (run "uvx --from ableton-mcp ableton-mcp-install-script" in a terminal), then chosen as a Control Surface in Live settings.'], 'Save your work first. Made by the community, not by Ableton.'),
    local('Files on this computer', 'standard', 'npx', '-y @modelcontextprotocol/server-filesystem <folder>', 'Read, write and search files in a folder you choose',
        [NODE, 'Replace <folder> with the full path of the folder to share.'], 'It can read and change every file in that folder.'),
    local('Excel files', 'community', 'uvx', 'excel-mcp-server stdio --allow-dir <folder>', 'Read and write workbooks, formulas and charts without opening Excel',
        [UV, 'Replace <folder> with the full path of the folder that holds your workbooks.'], 'It can change the workbooks in that folder. Made by the community.'),
    local('Git', 'standard', 'uvx', 'mcp-server-git --repository <folder>', 'Read history, search and commit in a repository',
        [UV, 'Git has to be installed.', 'Replace <folder> with the full path of the repository.'], 'It can make commits in that repository.'),
    local('Fetch a web page', 'standard', 'uvx', 'mcp-server-fetch', 'Fetch a web page from this computer and read it as text', [UV]),
    local('Memory', 'standard', 'npx', '-y @modelcontextprotocol/server-memory', 'Remember facts between chats in a file on this computer', [NODE]),
    local('Date and time', 'standard', 'uvx', 'mcp-server-time', 'Tell the time and convert between time zones', [UV]),
    local('Step-by-step thinking', 'standard', 'npx', '-y @modelcontextprotocol/server-sequential-thinking', 'A scratchpad for working through a problem in steps', [NODE])
];

// Online model providers. Two of them, Ollama and OpenRouter, list their models to anyone, so listing does not prove
// a key works; "proof" names an address of theirs that does.
// A person adds their own key; the provider's models then sit beside the local ones.
// Addresses and key pages were read from each provider's own documentation on 2026-11-18. "bare" providers are
// sent nothing beyond the conversation, because they refuse sampling settings or extra fields.
const keySteps = (maker, where) => [`Open the key page and sign up or sign in to ${maker}.`, where, 'Copy the key and paste it into the Key box here. Most services show it only once.'];
const online = (id, name, base, does, page, cost, where, extra = {}) => ({ id, name, base, does, type: 'openai', key: { page, cost, steps: keySteps(name, where) }, ...extra });
export const CLOUD_PROVIDERS = [
    online('ollama', 'Ollama', 'https://ollama.com', 'The large open models in Ollama\'s library, such as Kimi, GLM and DeepSeek, run on Ollama\'s computers', 'https://ollama.com/settings/keys', 'Pay for what you use, at Ollama\'s prices. There is no free allowance.', 'Under Keys, add an API key.', { type: 'ollama', proof: { path: '/api/me', method: 'POST' } }),
    online('anthropic', 'Anthropic', 'https://api.anthropic.com', 'The Claude models', 'https://platform.claude.com/settings/keys', 'Paid by use. Separate from a Claude subscription.', 'Under API keys, create a key.', { type: 'anthropic' }),
    online('openai', 'OpenAI', 'https://api.openai.com/v1', 'The GPT models', 'https://platform.openai.com/api-keys', 'Paid by use. Separate from a ChatGPT subscription.', 'Under API keys, create a new secret key.'),
    online('google', 'Google', 'https://generativelanguage.googleapis.com/v1beta/openai', 'The Gemini models', 'https://aistudio.google.com/apikey', 'Has a free allowance; paid beyond it.', 'Choose Create API key.'),
    online('moonshot', 'Moonshot', 'https://api.moonshot.ai/v1', 'The Kimi models', 'https://platform.kimi.ai/console/api-keys', 'Paid by use.', 'Under API keys, create a key. Use the international site; keys from the China site do not work here.'),
    online('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'The DeepSeek models', 'https://platform.deepseek.com/api_keys', 'Paid by use.', 'Under API keys, create a key.'),
    online('xai', 'xAI', 'https://api.x.ai/v1', 'The Grok models', 'https://console.x.ai/team/default/api-keys', 'Paid by use; add credit first.', 'Under API keys, create a key.'),
    online('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'The Mistral models', 'https://console.mistral.ai', 'Paid by use.', 'Under API keys, create a key.', { bare: true }),
    online('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'Hundreds of models from many companies behind one key', 'https://openrouter.ai/keys', 'Some models are free with daily limits; the rest are paid by use.', 'Choose Create key.', { proof: { path: '/key', method: 'GET' } }),
    online('groq', 'Groq', 'https://api.groq.com/openai/v1', 'Open models, run very fast', 'https://console.groq.com/keys', 'Has a free plan with limits.', 'Choose Create API key.'),
    online('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'Open models, run very fast', 'https://cloud.cerebras.ai', 'Has a free plan with lower limits.', 'Open API Keys in the menu and create a key.')
];
export const PROVIDER_HEALTH = {
    healthy: { label: 'Ready', needs: [] },
    unchecked: { label: 'Not checked yet', needs: ['Mollama has not checked this one yet. Choose Check.'] },
    refused: { label: 'Key refused', needs: ['The service did not accept the key. Replace it with a new one from the key page.'] },
    credit: { label: 'Out of credit', needs: ['Your account with this service is out of credit or over its limit. Add credit there.'] },
    busy: { label: 'Busy right now', needs: ['The service is taking too many requests. It will work again shortly.'] },
    unreachable: { label: 'Cannot be reached', needs: ['The service did not answer. Try again in a few minutes.'] },
    empty: { label: 'No models offered', needs: ['The service answered but listed no chat models for this key.'] }
};

const realCloudFetch = (...args) => fetch(...args);
let cloudFetch = realCloudFetch;
export const setCloudFetch = (replacement = null) => {
    cloudFetch = replacement || realCloudFetch;
    onlineNames = { at: 0, names: new Set() };
};

const cloudFault = (status, text = '') => {
    if (status === 401 || status === 403 || (status === 400 && /api key|invalid.{0,12}key|incorrect.{0,12}key/i.test(text))) return 'KEY_REFUSED';
    if (status === 402 || (status === 429 && /insufficient|credit|balance|quota|billing|exceeded_current/i.test(text))) return 'OUT_OF_CREDIT';
    if (status === 429 || status === 529) return 'PROVIDER_BUSY';
    if ([400, 404, 422].includes(status) && /does not support (tools|tool use|function calling)|support tool use|(tools?|function calling|tool use) (is|are) not (supported|enabled|available)/i.test(text)) return 'NO_TOOL_SUPPORT';
    if (status === 404) return 'MODEL_NOT_FOUND';
    if (status === 400 && /context|too long|too many tokens|maximum/i.test(text)) return 'TOO_LONG';
    return 'PROVIDER_DOWN';
};
const NOT_FOR_CHAT = /embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcri|rerank|guard|speech|video/i;
const CLOUD_CONTEXT = 128000;

const askCloud = async (entry, key, path, init = {}) => {
    let response;
    try {
        response = await (entry.fetch || cloudFetch)(`${entry.base}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    } catch (error) {
        if (error?.name === 'AbortError' || error instanceof OllamaError) throw error;
        throw new OllamaError('PROVIDER_DOWN', error?.message);
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new OllamaError(cloudFault(response.status, text), text.slice(0, 300));
    }
    return response;
};

// Turns the conversation the chat loop keeps, which is in Ollama's shape, into the shape most online services share.
// A tool result in this shape holds only text, so the pictures a tool returned follow the results as one user message.
const toSharedShape = (messages) => {
    const shaped = [];
    let pictures = [];
    const flush = () => {
        if (pictures.length === 0) return;
        shaped.push({ role: 'user', content: [{ type: 'text', text: 'The pictures the tool returned:' }, ...pictures.map((image) => ({ type: 'image_url', image_url: { url: `data:${imageMime(image)};base64,${image}` } }))] });
        pictures = [];
    };
    for (const one of toSharedTurns(messages)) {
        if (one.role !== 'tool') flush();
        shaped.push(one.message);
        if (one.role === 'tool') pictures.push(...one.images);
    }
    flush();
    return shaped;
};
const toSharedTurns = (messages) => {
    const waiting = [];
    let count = 0;
    return messages.map((message) => ({ role: message.role, images: Array.isArray(message.images) ? message.images : [], message: sharedMessage(message, waiting, () => ++count) }));
};
// Nine letters and digits for a call's id: what some Mistral templates insist on, and any other service takes.
const sharedMessage = (message, waiting, next) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: waiting.shift() || `c${String(next()).padStart(8, '0')}`, content: String(message.content ?? '') };
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const calls = message.tool_calls.map((call) => {
            const id = `c${String(next()).padStart(8, '0')}`;
            waiting.push(id);
            return { id, type: 'function', function: { name: call.function?.name, arguments: JSON.stringify(call.function?.arguments || {}) } };
        });
        return { role: 'assistant', content: message.content || '', tool_calls: calls };
    }
    if (message.role === 'user' && Array.isArray(message.images) && message.images.length > 0) {
        return { role: 'user', content: [{ type: 'text', text: String(message.content ?? '') }, ...message.images.map((image) => ({ type: 'image_url', image_url: { url: `data:${imageMime(image)};base64,${image}` } }))] };
    }
    return { role: message.role, content: String(message.content ?? '') };
};
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((piece) => piece?.type === 'text').map((piece) => piece.text || '').join('') : '');
const thoughtOf = (delta) => delta.reasoning_content || delta.reasoning
    || (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map((piece) => piece.text || '').join('') : '')
    || (Array.isArray(delta.content) ? delta.content.filter((piece) => piece?.type === 'thinking').map((piece) => (Array.isArray(piece.thinking) ? piece.thinking.map((part) => part.text || '').join('') : '')).join('') : '');

async function* sharedParts(response, started) {
    const decoder = new TextDecoder();
    const calls = new Map();
    let usage = null;
    let finish = null;
    let held = '';
    // When the first piece came, and the service's own times where it gives them (llama.cpp does, on its last piece).
    let first = 0;
    let timings = null;
    for await (const chunk of response.body) {
        held += decoder.decode(chunk, { stream: true });
        const lines = held.split('\n');
        held = lines.pop();
        for (const line of lines) {
            const data = line.startsWith('data:') ? line.slice(5).trim() : '';
            if (!data || data === '[DONE]') continue;
            let event;
            try {
                event = JSON.parse(data);
            } catch {
                continue;
            }
            if (event.error) throw new OllamaError(cloudFault(Number(event.error.code) || 500, JSON.stringify(event.error)), String(event.error.message || '').slice(0, 300));
            if (event.usage) usage = event.usage;
            if (event.timings) timings = event.timings;
            if (event.choices?.[0]?.finish_reason) finish = event.choices[0].finish_reason;
            const delta = event.choices?.[0]?.delta;
            if (!delta) continue;
            const thinking = thoughtOf(delta);
            const content = textOf(delta.content);
            if (!first && (thinking || content || (delta.tool_calls || []).length > 0)) first = Date.now();
            if (thinking) yield { message: { thinking } };
            if (content) yield { message: { content } };
            for (const call of delta.tool_calls || []) {
                const kept = calls.get(call.index ?? 0) || { name: '', text: '' };
                if (!kept.name && call.function?.name) yield { message: { tool_start: call.function.name } };
                if (call.function?.arguments) yield { message: { tool_draft: call.function.arguments } };
                calls.set(call.index ?? 0, { name: kept.name || call.function?.name || '', text: kept.text + (call.function?.arguments || '') });
            }
        }
    }
    // A call cut off before its end is never run: what there is of it goes to the chat, which asks for the rest.
    const whole = [];
    let cut = null;
    [...calls.values()].forEach((call, at, all) => {
        let input = null;
        try {
            input = JSON.parse(call.text || '{}');
        } catch {
            input = null;
        }
        if (input === null || (finish === 'length' && at === all.length - 1)) cut = { name: call.name, text: call.text };
        else whole.push({ function: { name: call.name, arguments: input } });
    });
    if (whole.length > 0) yield { message: { tool_calls: whole } };
    if (cut) yield { message: { tool_cut: cut } };
    // Reading is the wait for the first piece and writing the rest, unless the service says exactly.
    const ended = Date.now();
    const cached = Number(timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens);
    yield {
        done: true, done_reason: finish === 'length' ? 'length' : 'stop', eval_count: usage?.completion_tokens || 0, prompt_eval_count: usage?.prompt_tokens || 0, total_duration: (ended - started) * 1e6,
        prompt_eval_duration: (Number(timings?.prompt_ms) >= 0 ? Number(timings.prompt_ms) : first ? first - started : 0) * 1e6,
        eval_duration: (Number(timings?.predicted_ms) >= 0 ? Number(timings.predicted_ms) : first ? ended - first : 0) * 1e6,
        ...(Number.isFinite(cached) ? { prompt_cached: cached } : {})
    };
}

// Claude is reached through Anthropic's own library and its own request shape, not the shared one.
const claudeFault = (error) => {
    if (error instanceof OllamaError) return error;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new OllamaError('KEY_REFUSED', error.message);
    if (error instanceof Anthropic.RateLimitError) return new OllamaError(/credit|billing|spend/i.test(error.message) ? 'OUT_OF_CREDIT' : 'PROVIDER_BUSY', error.message);
    if (error instanceof Anthropic.NotFoundError) return new OllamaError('MODEL_NOT_FOUND', error.message);
    if (error instanceof Anthropic.APIConnectionError) return new OllamaError('PROVIDER_DOWN', error.message);
    if (error instanceof Anthropic.APIError) return new OllamaError(cloudFault(Number(error.status) || 500, String(error.message || '')), String(error.message || '').slice(0, 300));
    return new OllamaError('PROVIDER_DOWN', String(error?.message || ''));
};
const toClaudeShape = (messages) => {
    const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n\n');
    const waiting = [];
    let count = 0;
    const turns = [];
    for (const message of messages) {
        if (message.role === 'system') continue;
        let role = message.role === 'assistant' ? 'assistant' : 'user';
        let content;
        if (message.role === 'tool') {
            const pictures = (Array.isArray(message.images) ? message.images : []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: imageMime(image), data: image } }));
            content = [{ type: 'tool_result', tool_use_id: waiting.shift() || `toolu_${++count}`, content: pictures.length > 0 ? [{ type: 'text', text: String(message.content ?? '') }, ...pictures] : String(message.content ?? '') }];
        } else if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            content = [...(message.content ? [{ type: 'text', text: String(message.content) }] : []), ...message.tool_calls.map((call) => {
                const id = `toolu_${++count}`;
                waiting.push(id);
                return { type: 'tool_use', id, name: call.function?.name, input: call.function?.arguments || {} };
            })];
        } else if (role === 'user' && Array.isArray(message.images) && message.images.length > 0) {
            content = [...message.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: imageMime(image), data: image } })), { type: 'text', text: String(message.content ?? '') }];
        } else {
            content = String(message.content ?? '') || '…';
        }
        const last = turns.at(-1);
        // Tool results that answer one reply go back together, in one turn.
        if (last && last.role === role && Array.isArray(last.content) && Array.isArray(content) && content[0]?.type === 'tool_result') last.content.push(...content);
        else turns.push({ role, content });
    }
    return { system, turns };
};
const claudeClient = (key) => new Anthropic({ apiKey: key, fetch: cloudFetch, maxRetries: 1 });
const claudeRequest = (request, known) => {
    const { system, turns } = toClaudeShape(request.messages);
    const cap = known.find((model) => model.name === request.model)?.maxOutput || 8192;
    return {
        model: request.model,
        max_tokens: Math.min(cap, request.stream ? 64000 : 16000),
        messages: turns,
        ...(system ? { system } : {}),
        // Streamed, each call is passed on as it is written instead of only once it is whole, so the person sees a long
        // call, such as a whole figure, take shape.
        ...(request.tools ? { tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters, ...(request.stream ? { eager_input_streaming: true } : {}) })) } : {})
    };
};
async function* claudeParts(stream, started) {
    let drafting = null;
    try {
        for await (const event of stream) {
            // The moment the model starts writing a call to a tool is passed on, so the person sees what it has turned to
            // while a long call, such as a whole figure, is still being written.
            if (event.type === 'content_block_start') drafting = event.content_block?.type === 'tool_use' ? { name: event.content_block.name, text: '' } : null;
            if (event.type === 'content_block_start' && drafting) yield { message: { tool_start: drafting.name } };
            if (event.type !== 'content_block_delta') continue;
            if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
                if (drafting) drafting.text += event.delta.partial_json;
                yield { message: { tool_draft: event.delta.partial_json } };
            }
            if (event.delta.type === 'thinking_delta' && event.delta.thinking) yield { message: { thinking: event.delta.thinking } };
            if (event.delta.type === 'text_delta' && event.delta.text) yield { message: { content: event.delta.text } };
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') yield { message: { content: 'This model declined to answer that request.' } };
        // A call cut off by the length limit or by a refusal is never run: it may be only part of what was meant.
        const calls = ['max_tokens', 'refusal'].includes(final.stop_reason) ? [] : final.content.filter((block) => block.type === 'tool_use');
        if (calls.length > 0) yield { message: { tool_calls: calls.map((block) => ({ function: { name: block.name, arguments: block.input || {} } })) } };
        if (final.stop_reason === 'max_tokens' && drafting) yield { message: { tool_cut: drafting } };
        const usage = final.usage || {};
        yield { done: true, done_reason: final.stop_reason === 'max_tokens' ? 'length' : 'stop', eval_count: usage.output_tokens || 0, prompt_eval_count: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), total_duration: (Date.now() - started) * 1e6 };
    } catch (error) {
        if (error?.name === 'AbortError' || error instanceof Anthropic.APIUserAbortError) throw error;
        // A call streamed as it was written may not be readable JSON; the chat asks the model once more.
        if (error instanceof SyntaxError) throw Object.assign(new Error(`The tool call could not be read: ${error.message}`), { error: 'tool call could not be read' });
        throw claudeFault(error);
    }
}

// Stands where the Ollama client stands, so the chat loop runs an online model without knowing the difference.
// "known" is the list of models read at the last check, used for what each model can take.
export const createCloudClient = (entry, key, known = []) => {
    const factsOf = (name) => known.find((model) => model.name === name) || null;
    const shown = (name) => ({
        capabilities: ['completion', 'tools', ...(factsOf(name)?.vision ? ['vision'] : [])],
        model_info: { 'cloud.context_length': factsOf(name)?.contextLength || CLOUD_CONTEXT }
    });
    const common = {
        host: entry.base,
        status: async () => ({ available: Boolean(key), version: null }),
        running: async () => ({ models: known.map((model) => ({ name: model.name })) }),
        show: async (name) => shown(name),
        load: async () => undefined,
        unload: async () => undefined,
        prove: async () => {
            if (!entry.proof) return;
            let response;
            try {
                response = await cloudFetch(`${entry.base}${entry.proof.path}`, {
                    method: entry.proof.method,
                    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                    ...(entry.proof.method === 'POST' ? { body: '{}' } : {}),
                    signal: AbortSignal.timeout(15000)
                });
            } catch {
                return;
            }
            if (response.status === 401 || response.status === 403) throw new OllamaError('KEY_REFUSED');
        }
    };

    if (entry.type === 'anthropic') {
        return {
            ...common,
            list: async () => {
                const models = [];
                try {
                    for await (const model of claudeClient(key).models.list({ limit: 1000 })) models.push(model);
                } catch (error) {
                    throw claudeFault(error);
                }
                return {
                    models: models.map((model) => ({
                        name: model.id,
                        size: 0,
                        details: {},
                        cloud: { title: model.display_name || null, contextLength: model.max_input_tokens || null, maxOutput: model.max_tokens || null, vision: Boolean(model.capabilities?.image_input?.supported ?? model.capabilities?.image_input) }
                    }))
                };
            },
            chat: async (request) => {
                const started = Date.now();
                if (!request.stream) {
                    try {
                        const answer = await claudeClient(key).messages.create(claudeRequest(request, known));
                        return { message: { content: answer.content.filter((block) => block.type === 'text').map((block) => block.text).join('') }, eval_count: answer.usage?.output_tokens || 0, prompt_eval_count: answer.usage?.input_tokens || 0 };
                    } catch (error) {
                        throw claudeFault(error);
                    }
                }
                const stream = claudeClient(key).messages.stream(claudeRequest(request, known));
                const parts = claudeParts(stream, started);
                parts.abort = () => stream.abort();
                return parts;
            }
        };
    }

    if (entry.type === 'ollama') {
        const raw = (signal) => new Ollama({ host: entry.base, fetch: signal ? stoppable(cloudFetch, signal) : cloudFetch, headers: { Authorization: `Bearer ${key}` } });
        const call = async (run, signal) => {
            try {
                return await run(raw(signal));
            } catch (error) {
                if (error instanceof OllamaError || error?.name === 'AbortError') throw error;
                throw new OllamaError(error?.status_code ? cloudFault(error.status_code, String(error.message || '')) : 'PROVIDER_DOWN', String(error?.message || '').slice(0, 300));
            }
        };
        return {
            ...common,
            list: async () => {
                const { models = [] } = await call((client) => client.list());
                return { models: models.filter((model) => !(model.capabilities || []).includes('embedding')).map((model) => ({ ...model, cloud: { contextLength: null, vision: (model.capabilities || []).includes('vision') } })) };
            },
            chat: (request, signal) => call((client) => client.chat({ model: request.model, messages: request.messages, stream: request.stream, ...(request.tools ? { tools: request.tools } : {}), ...(request.think === undefined ? {} : { think: request.think }) }), signal)
        };
    }

    return {
        ...common,
        list: async () => {
            const body = await (await askCloud(entry, key, '/models', { signal: AbortSignal.timeout(20000) })).json();
            const listed = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
            return {
                models: listed.filter((model) => model?.id && !NOT_FOR_CHAT.test(model.id)).map((model) => ({
                    name: String(model.id).replace(/^models\//, ''),
                    size: 0,
                    details: {},
                    cloud: {
                        title: [model.display_name, model.displayName, model.name].find((text) => typeof text === 'string' && text.trim() && text !== model.id) || null,
                        contextLength: model.context_length || model.context_window || model.max_input_tokens || model.max_context_length || null,
                        vision: Boolean(model.supports_image_in || model.capabilities?.vision || model.capabilities?.image_input || model.architecture?.input_modalities?.includes?.('image') || model.input_modalities?.includes?.('image'))
                    }
                }))
            };
        },
        chat: async (request, signal) => {
            const controller = new AbortController();
            if (signal?.aborted) controller.abort();
            signal?.addEventListener('abort', () => controller.abort(), { once: true });
            const started = Date.now();
            const options = request.options || {};
            const body = {
                model: request.model,
                messages: toSharedShape(request.messages),
                stream: Boolean(request.stream),
                ...(request.tools ? { tools: request.tools } : {}),
                ...(entry.bare ? {} : {
                    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
                    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
                    ...(typeof options.top_p === 'number' ? { top_p: options.top_p } : {}),
                    ...(Number.isInteger(options.seed) ? { seed: options.seed } : {})
                })
            };
            const response = await askCloud(entry, key, '/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
            if (!request.stream) {
                const answer = await response.json();
                return { message: { content: textOf(answer.choices?.[0]?.message?.content) }, eval_count: answer.usage?.completion_tokens || 0, prompt_eval_count: answer.usage?.prompt_tokens || 0 };
            }
            const parts = sharedParts(response, started);
            parts.abort = () => controller.abort();
            return parts;
        }
    };
};

// The models Ollama runs on its own computers. Ollama publishes the list to anyone, so it is read without a key and
// kept for an hour. It is a small part of the library: most models can only be downloaded.
const ONLINE_NAMES_MS = 60 * 60 * 1000;
let onlineNames = { at: 0, names: new Set() };
export const ollamaOnlineNames = async () => {
    if (Date.now() - onlineNames.at < ONLINE_NAMES_MS) return onlineNames.names;
    if (libraryFetch && cloudFetch === realCloudFetch) return new Set();
    try {
        const body = await (await cloudFetch('https://ollama.com/api/tags', { signal: AbortSignal.timeout(8000) })).json();
        onlineNames = { at: Date.now(), names: new Set((body.models || []).map((model) => model.name)) };
    } catch {
        onlineNames = { at: Date.now() - ONLINE_NAMES_MS + 5 * 60 * 1000, names: onlineNames.names };
    }
    return onlineNames.names;
};
// A library entry runs online when Ollama lists that exact size, or, for a model with no sizes to download, its name.
export const runsOnline = (entry, names) => names.has(entry.tag) || (Boolean(entry.cloudOnly) && [...names].some((name) => name.split(':')[0] === entry.tag));

// Rented graphics cards come from Hyperstack. One key, held only by this server, starts and deletes the machines.
// A machine gets a start-up script with its link to this server and the small program that keeps that link
// (templates/rented.computer.js); nothing can reach it from outside. Optional: without its settings nothing is rented.
const HYPERSTACK_API = 'https://infrahub-api.nexgencloud.com/v1';
const RENTAL_SETTINGS = ['HYPERSTACK_API_KEY', 'HYPERSTACK_ENVIRONMENT', 'HYPERSTACK_KEY_NAME', 'RENTAL_SERVER_URL', 'RENTAL_LABEL'];
const MACHINE_IMAGE = 'Ubuntu Server 24.04 LTS R570 CUDA 12.8';
const MACHINE_NODE = { version: 'v22.23.5', sha256: 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8' };
// Whether a machine is given a public address. None of its doors are open either way; the trial decides if it is needed.
const MACHINE_PUBLIC_ADDRESS = true;
const CARD_MEMORY_GB = [[/A4000/i, 16], [/A5000|4090|3090/i, 24], [/A6000|A40\b|L40/i, 48], [/A100|H100/i, 80], [/H200/i, 141]];
const CARDS_KEPT_MS = 60000;

let cardsKept = null;
let cardsSkipped = null;
export const skippedCards = () => cardsSkipped;
let hyperstackFetch = realFetch;
export const setHyperstackFetch = (replacement) => {
    hyperstackFetch = replacement || realFetch;
    cardsKept = null;
};
export const hyperstackReady = () => RENTAL_SETTINGS.every((name) => process.env[name]);
export const machinePrefix = () => `mollama-${String(process.env.RENTAL_LABEL || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}-`;

export class HyperstackError extends Error {
    constructor(status, message, reason = null) {
        super(message);
        this.name = 'HyperstackError';
        this.status = status;
        this.reason = reason;
    }
}

const askHyperstack = async (method, path, body) => {
    let response;
    try {
        response = await hyperstackFetch(`${HYPERSTACK_API}${path}`, {
            method,
            headers: { api_key: process.env.HYPERSTACK_API_KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000)
        });
    } catch {
        throw new HyperstackError(0, 'Hyperstack could not be reached');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status === false) {
        throw new HyperstackError(response.status, String(data?.message || `Hyperstack answered ${response.status}`).slice(0, 300), data?.error_reason || null);
    }
    return data;
};

export const machineScript = ({ socket, deviceId, key }) => {
    const program = readFileSync(new URL('../templates/rented.computer.js', import.meta.url), 'utf8');
    const node = `node-${MACHINE_NODE.version}-linux-x64`;
    return [
        '#!/bin/bash',
        'exec > /var/log/mollama-setup.log 2>&1',
        'export HOME=/root',
        'mkdir -p /opt/mollama && cd /opt/mollama || exit 1',
        'umask 077',
        "cat > link.json <<'MOLLAMA_LINK'",
        JSON.stringify({ socket, deviceId, key }),
        'MOLLAMA_LINK',
        "cat > computer.mjs <<'MOLLAMA_PROGRAM'",
        program.trimEnd(),
        'MOLLAMA_PROGRAM',
        'for attempt in 1 2 3 4 5; do curl -fsSL https://ollama.com/install.sh | sh && break; sleep 10; done',
        `for attempt in 1 2 3 4 5; do curl -fsSLO https://nodejs.org/dist/${MACHINE_NODE.version}/${node}.tar.xz && break; sleep 10; done`,
        `echo "${MACHINE_NODE.sha256}  ${node}.tar.xz" | sha256sum -c - || exit 1`,
        `tar -xJf ${node}.tar.xz && rm ${node}.tar.xz`,
        "cat > /etc/systemd/system/mollama.service <<'MOLLAMA_SERVICE'",
        '[Unit]',
        'Description=Mollama link',
        'After=network-online.target ollama.service',
        'Wants=network-online.target',
        '[Service]',
        `ExecStart=/opt/mollama/${node}/bin/node /opt/mollama/computer.mjs`,
        'Restart=always',
        'RestartSec=5',
        '[Install]',
        'WantedBy=multi-user.target',
        'MOLLAMA_SERVICE',
        'systemctl daemon-reload',
        'systemctl enable --now mollama.service',
        ''
    ].join('\n');
};

const centsOf = (dollars) => Number(dollars) * 100;

export const hyperstack = {
    // The cards that can be rented now where Mollama's machines live, each with what Hyperstack charges an hour (cents).
    async cards() {
        if (cardsKept && Date.now() - cardsKept.at < CARDS_KEPT_MS) return cardsKept.cards;
        const [environments, flavors, prices] = await Promise.all([
            askHyperstack('GET', '/core/environments?pageSize=100'),
            askHyperstack('GET', '/core/flavors'),
            askHyperstack('GET', '/pricebook')
        ]);
        const region = (environments.environments || []).find((entry) => entry.name === process.env.HYPERSTACK_ENVIRONMENT)?.region;
        if (!region) throw new HyperstackError(404, `Hyperstack has no environment named ${process.env.HYPERSTACK_ENVIRONMENT}`);
        const priceOf = new Map((Array.isArray(prices) ? prices : prices?.data || []).map((entry) => [entry.name, centsOf(entry.value)]));
        const address = MACHINE_PUBLIC_ADDRESS ? priceOf.get('PublicIP') || 0 : 0;
        const all = (flavors.data || []).flatMap((group) => (group.flavors || []).map((flavor) => ({ region_name: group.region_name, gpu: group.gpu, ...flavor })));
        // Why each machine type in the region was left out, for admins: Hyperstack's names are matched here by hand.
        const whyNot = (flavor) => [
            flavor.region_name !== region && 'other region',
            !(flavor.gpu && flavor.gpu_count > 0) && 'no graphics card',
            !flavor.stock_available && 'not in stock',
            !(priceOf.get(flavor.gpu) > 0) && 'no price found',
            /spot/i.test(flavor.name) && 'spot'
        ].filter(Boolean);
        cardsSkipped = {
            region,
            skipped: all.filter((flavor) => flavor.region_name === region && whyNot(flavor).length > 0)
                .map((flavor) => ({ flavor: flavor.name, gpu: flavor.gpu || null, why: whyNot(flavor) })),
            priceNames: [...priceOf.keys()].slice(0, 80)
        };
        const cards = all
            .filter((flavor) => whyNot(flavor).length === 0)
            .map((flavor) => ({
                flavor: flavor.name,
                gpu: flavor.gpu,
                count: flavor.gpu_count,
                memoryMb: (CARD_MEMORY_GB.find(([pattern]) => pattern.test(flavor.gpu))?.[1] || 0) * 1024 * flavor.gpu_count,
                cpu: flavor.cpu,
                ramGb: flavor.ram,
                diskGb: flavor.disk,
                region,
                cost: priceOf.get(flavor.gpu) * flavor.gpu_count + address
            }))
            .sort((a, b) => a.cost - b.cost);
        cardsKept = { at: Date.now(), cards };
        return cards;
    },

    // What Mollama itself has left at Hyperstack, in cents.
    async credit() {
        const { data } = await askHyperstack('GET', '/billing/user-credit/credit');
        return { credit: Math.floor(centsOf(data?.credit)), canCreate: data?.can_create_instance !== false };
    },

    async create({ name, flavor, script }) {
        const made = await askHyperstack('POST', '/core/virtual-machines', {
            name,
            environment_name: process.env.HYPERSTACK_ENVIRONMENT,
            image_name: MACHINE_IMAGE,
            flavor_name: flavor,
            key_name: process.env.HYPERSTACK_KEY_NAME,
            count: 1,
            assign_floating_ip: MACHINE_PUBLIC_ADDRESS,
            labels: ['mollama', machinePrefix().slice(0, -1)],
            user_data: script
        });
        const id = made.instances?.[0]?.id;
        if (!Number.isInteger(id)) throw new HyperstackError(502, 'Hyperstack did not say which machine it made');
        return id;
    },

    // ACTIVE, CREATING and so on, or GONE once Hyperstack no longer knows the machine.
    async state(id) {
        try {
            const { instance } = await askHyperstack('GET', `/core/virtual-machines/${id}`);
            const status = String(instance?.status || 'UNKNOWN').toUpperCase();
            return status === 'DELETED' ? 'GONE' : status;
        } catch (error) {
            if (error.status === 404) return 'GONE';
            throw error;
        }
    },

    async remove(id) {
        try {
            await askHyperstack('DELETE', `/core/virtual-machines/${id}`);
        } catch (error) {
            if (error.status !== 404) throw error;
        }
    },

    // Every machine that carries this server's name mark, whatever started it.
    async list() {
        const found = [];
        for (let page = 1; page <= 20; page += 1) {
            const data = await askHyperstack('GET', `/core/virtual-machines?page=${page}&pageSize=100&search=${encodeURIComponent(machinePrefix())}`);
            const instances = data.instances || [];
            found.push(...instances.filter((entry) => String(entry.name || '').startsWith(machinePrefix())).map((entry) => ({
                id: entry.id, name: entry.name, status: String(entry.status || '').toUpperCase(), createdAt: entry.created_at ? new Date(entry.created_at) : null
            })));
            if (instances.length < 100) break;
        }
        return found;
    },

    // What Hyperstack billed for one machine between two moments, in cents; null when it does not say.
    async billed(id, from, to) {
        const stamp = (date) => new Date(date).toISOString().slice(0, 19);
        try {
            const data = await askHyperstack('GET', `/billing/billing/history/virtual-machine/${id}?start_date=${stamp(from)}&end_date=${stamp(to)}`);
            const lines = data?.billing_history_vm_details?.billing_history || [];
            return Math.round(lines.reduce((sum, line) => sum + centsOf(line?.metrics?.incurred_bill || 0), 0));
        } catch {
            return null;
        }
    }
};
