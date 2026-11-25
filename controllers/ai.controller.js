import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import express from 'express';
import mongoose from 'mongoose';
import logger from '../utils/app.logger.js';
import { asyncHandler, getNotificationService } from '../middleware/app.middleware.js';
import { hasRight, RIGHTS } from '../config/rights.js';
import { SERVICE, Device, Setting, PersonalModel, Download, Chat, Prompt, Guide, GUIDE_STEPS, MANAGER_GUIDE_STEPS, chatSchemas, ToolServer, Provider, Skill, Training, Rental } from '../models/ai.model.js';
import {
    OllamaError, mapOllamaError, UNREADABLE_CALL, memoryNeededMb, createOllamaClient, libraryModels, libraryEntries, loadLibrarySizes, librarySizes, friendlyName, cloudTitle, computerName, detectHardware, appleGpus, readDisk, rankCatalogue, fitModel, fitNotes, fitPool, freeHardware, poolShareMb, poolSplit, GPU_HEADROOM_MB, RAM_RESERVE_MB,
    GenerationQueue, estimateTokens, extractText, createFilesClient, imageTypeOf, MAX_IMAGE_BYTES, MAX_CHAT_IMAGE_BYTES, runInSandbox, takeFromSandbox, letSandboxGo, sandboxReady, poolGroups, MAX_PROGRAM_SECONDS, MAX_ATTACHMENT_BYTES, fetchRemote, MAX_REMOTE_BYTES,
    searchReady, searchWeb, readPage, deviceGateway,
    CLOUD_PROVIDERS, PROVIDER_HEALTH, createCloudClient, ollamaOnlineNames, runsOnline,
    TOOL_HEALTH, TOOL_CATALOGUE, TOOL_LOCAL_CATALOGUE, toolKeyNeeded, listedTool, seal, unseal, accountKeeper, withToolServer, finishToolSignIn, readTools, toolFault, ToolSignInError,
    hyperstack, hyperstackReady, machinePrefix, machineScript, HyperstackError
} from '../middleware/ai.middleware.js';
import { billingOn, balanceOf, setAside, settle, money, BillingError } from './billing.controller.js';

const MB = 1024 * 1024;
// Models seen in the live list from ollama.com, remembered so installed models can show their description and size.
const knownModels = new Map();
const hostName = (address) => {
    try {
        return new URL(address).hostname.replace(/^www\./, '');
    } catch {
        return 'Source';
    }
};
const CATALOGUE_PAGE = 48;
const SAMPLE = { full: 6, mixed: 3, large: 3 };
const POPULAR_MODELS = 40;
const PICK_ORDER = { fast: 0, balanced: 1, best: 2, code: 3, reasoning: 3 };
const CLOUD_FIT = { verdict: 'cloud', label: 'Cloud only', fits: false, memoryNeededMb: 0, tokensPerSecond: null };
const SIZE_WORD = /^\d+(\.\d+)?[bm]$/;
const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
const closeTo = (a, b, most) => {
    if (Math.abs(a.length - b.length) > most) return false;
    let row = Array.from({ length: b.length + 1 }, (unused, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        row = next;
    }
    return row[b.length] <= most;
};
// How well a model answers the words searched for; 0 means it does not. Spaces, dots and hyphens in a name are
// ignored, a name counts for more than a description, and a loose search forgives a letter or two in a name.
const searchScore = (model, words, loose = false) => {
    const name = squash(model.name);
    const text = `${model.description} ${model.capabilities.join(' ')}`.toLowerCase();
    const parts = model.name.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=\d)/).filter(Boolean);
    let score = words.length > 1 && squash(words.join('')) === name ? 100 : 0;
    for (const word of words) {
        const plain = squash(word);
        let gained = 0;
        if (plain && name === plain) gained = 100;
        else if (plain && name.startsWith(plain)) gained = 40;
        else if (plain && name.includes(plain)) gained = 20;
        else if (text.includes(word)) gained = 5;
        else if (loose && plain.length >= 4 && parts.some((part) => closeTo(part, plain, plain.length >= 8 ? 2 : 1))) gained = 2;
        if (gained === 0) return 0;
        score += gained;
    }
    return score;
};

// The whole library, searched and ordered on the server and handed out a page at a time.
// Recommendations come only from the most downloaded models, so an obscure model is never the suggestion.
// With picks off the list is only the list: nothing in it is marked or moved to the front.
const liveCatalogue = async (query, hardware, { picks = true } = {}) => {
    const models = await libraryModels();
    const words = String(query?.q || '').toLowerCase().split(/[\s:]+/).filter(Boolean);
    // A word such as 7b asks for that size of a model, unless it is part of a model's name.
    const sizes = words.filter((word) => SIZE_WORD.test(word) && !models.some((model) => squash(model.name).includes(squash(word))));
    const terms = words.filter((word) => !sizes.includes(word));
    const purpose = query?.purpose || null;
    const can = String(query?.can || '').split(',').filter(Boolean);
    const fitting = Boolean(hardware) && (query?.fits === true || query?.fits === 'true');
    // Ranges: the size of the download, the memory the model needs to run, and its size in billions of parameters.
    const span = (low, high) => (query?.[low] === undefined && query?.[high] === undefined ? null : [Number(query?.[low]) || 0, query?.[high] === undefined ? Infinity : Number(query[high])]);
    const ranges = { size: span('minSizeMb', 'maxSizeMb'), memory: span('minMemoryMb', 'maxMemoryMb'), params: span('minParams', 'maxParams') };
    const ranged = Object.values(ranges).some(Boolean);
    const between = ([low, high], value) => value >= low && value <= high;
    // A model that runs only on Ollama's servers has no size here, so a range leaves it out.
    const inRange = (entry) => !ranged || (!entry.cloudOnly
        && (!ranges.size || between(ranges.size, entry.sizeMb))
        && (!ranges.memory || between(ranges.memory, entry.fit?.memoryNeededMb || memoryNeededMb(entry)))
        && (!ranges.params || between(ranges.params, entry.parameters)));
    const page = Number(query?.page) || 1;
    const size = Number(query?.size) || CATALOGUE_PAGE;
    // How the list under the recommendations is ordered; the recommendations themselves always come first.
    const ORDERS = {
        largest: (a, b) => (b.sizeMb || 0) - (a.sizeMb || 0),
        smallest: (a, b) => (a.sizeMb || 0) - (b.sizeMb || 0),
        popular: (a, b) => (b.pulls || 0) - (a.pulls || 0),
        name: (a, b) => String(a.tag).localeCompare(String(b.tag))
    };
    const chosenOrder = ORDERS[query?.sort] || null;
    const popular = new Set([...models].sort((a, b) => b.pulls - a.pulls).slice(0, POPULAR_MODELS).map((model) => model.name));
    const sized = models.filter((model) => sizes.every((size) => model.sizes.some((own) => own.toLowerCase() === size)));
    const scores = new Map();
    const score = (loose) => sized.filter((model) => {
        const gained = terms.length > 0 ? searchScore(model, terms, loose) : 1;
        if (gained > 0) scores.set(model.name, gained);
        return gained > 0;
    });
    let matching = score(false);
    // Nothing by that spelling: the closest names are shown instead, and the page says so.
    const near = matching.length === 0 && terms.length > 0;
    if (near) matching = score(true);
    const scoreOf = (entry) => scores.get(entry.tag.split(':')[0]) || 0;
    await loadLibrarySizes(matching.filter((model) => popular.has(model.name)).map((model) => model.name));

    const order = () => {
        const entries = libraryEntries(matching)
            .filter((entry) => sizes.length === 0 || entry.cloudOnly || sizes.includes(entry.tag.split(':')[1]?.toLowerCase()))
            .filter((entry) => !purpose || entry.goodFor.includes(purpose))
            .filter((entry) => can.every((ability) => entry.capabilities.includes(ability)));
        const isPopular = (entry) => !entry.cloudOnly && popular.has(entry.tag.split(':')[0]);
        const all = hardware
            ? [...rankCatalogue(entries.filter(isPopular), hardware), ...entries.filter((entry) => !isPopular(entry)).map((entry) => ({ ...entry, fit: entry.cloudOnly ? CLOUD_FIT : fitModel(entry, hardware), pick: null }))]
            : entries.map((entry) => ({ ...entry, fit: null, pick: null }));
        if (!picks) all.forEach((entry) => { entry.pick = null; delete entry.pickLabel; delete entry.pickWhy; });
        return all.filter((entry) => (!fitting || entry.fit.fits) && inRange(entry)).sort((a, b) => (PICK_ORDER[a.pick] ?? 9) - (PICK_ORDER[b.pick] ?? 9)
            || (chosenOrder ? chosenOrder(a, b) || a.parameters - b.parameters : 0)
            || (terms.length > 0 ? scoreOf(b) - scoreOf(a) : 0)
            || Number(a.cloudOnly) - Number(b.cloudOnly)
            || Number(b.fit?.fits ?? true) - Number(a.fit?.fits ?? true)
            || b.pulls - a.pulls
            || a.parameters - b.parameters);
    };
    const everything = query?.all === true || query?.all === 'true';
    // The public home page shows a taste of the list: models that run fully here, some that need help from system memory, and a few that are too large.
    const sampled = Boolean(hardware) && (query?.sample === true || query?.sample === 'true');
    const dice = Math.random();
    const sample = (all) => {
        const local = all.filter((entry) => !entry.cloudOnly);
        const large = local.filter((entry) => entry.fit.verdict === 'too_large');
        const start = Math.floor(dice * large.length);
        const step = Math.max(1, Math.floor(large.length / SAMPLE.large));
        const picked = [...new Set(Array.from({ length: Math.min(SAMPLE.large, large.length) }, (_, index) => large[(start + index * step) % large.length]))];
        return [
            ...local.filter((entry) => entry.fit.verdict === 'gpu' || entry.fit.verdict === 'cpu').slice(0, SAMPLE.full),
            ...local.filter((entry) => entry.fit.verdict === 'mixed').slice(0, SAMPLE.mixed),
            ...picked
        ];
    };
    // The recommended models lead the first page and are not counted in the number shown per page.
    const unpicked = (all) => all.filter((entry) => !entry.pick);
    const shown = (all) => (sampled ? sample(all) : everything ? all
        : [...(page === 1 ? all.filter((entry) => entry.pick) : []), ...unpicked(all).slice((page - 1) * size, page * size)]);

    // The page about to be shown gets its exact sizes, then the order is worked out again with them.
    await loadLibrarySizes(shown(order()).map((entry) => entry.tag.split(':')[0]));
    const all = order();
    const entries = shown(all);
    const online = await ollamaOnlineNames();
    entries.forEach((entry) => { entry.online = runsOnline(entry, online); });
    entries.forEach((entry) => knownModels.set(entry.tag, entry));
    loadLibrarySizes(models.map((model) => model.name)).catch(() => {});

    return {
        all,
        entries,
        query: words.join(' '),
        near: near && matching.length > 0,
        page,
        size,
        paged: unpicked(all).length,
        more: !everything && !sampled && page * size < unpicked(all).length,
        local: all.filter((entry) => !entry.cloudOnly),
        total: all.length,
        library: models.length,
        fitting: hardware ? all.filter((entry) => entry.fit.fits).length : null
    };
};

const canManage = (req) => hasRight(req.user.roles, RIGHTS.MANAGE_MODELS);

// Once a change has been answered successfully, the person's other open apps are told, so their pages bring themselves
// up to date. The first part of the path, when it is an id, says which chat or computer changed.
export const announceChanges = (type, quiet = []) => (req, res, next) => {
    // The path is read now: by the time the answer has gone out it no longer starts where this part of the router does.
    const path = req.path;
    res.on('finish', () => {
        if (req.method === 'GET' || res.statusCode >= 300 || !req.user?.id || quiet.includes(path)) return;
        const id = path.match(/^\/([0-9a-f]{24})(?:\/|$)/)?.[1] || null;
        const removed = req.method === 'DELETE' && /^\/[0-9a-f]{24}\/?$/.test(path);
        getNotificationService().sendToUser(String(req.user.id), { type, data: { id, removed } });
    });
    next();
};

const RESUME_WINDOW_MS = 30 * 60 * 1000;

const sendOllamaError = (res, error) => {
    if (!(error instanceof OllamaError)) throw error;
    if (error.code === 'FILES_DOWN') logger.warn('[Files] FilesystemOne could not be reached', { detail: String(error.detail || '').slice(0, 200), host: (() => { try { return new URL(process.env.FILESYSTEM_ONE_URL).host; } catch { return 'not set'; } })() });
    const body = { success: false, ...error.toJSON() };
    if (error.neededMb) {
        body.neededMb = error.neededMb;
        body.freeMb = error.freeMb;
        body.message = `This model needs about ${Math.ceil(error.neededMb / 1024)} GB and this device has ${Math.floor(error.freeMb / 1024)} GB free.`;
    }
    if (error.loaded) Object.assign(body, { loaded: error.loaded, fitsEmpty: error.fitsEmpty !== false });
    return res.status(error.status).json(body);
};

const getSettings = async () => {
    const existing = await Setting.findOne({ service: SERVICE });
    if (existing) return existing;
    try {
        return await Setting.create({});
    } catch (error) {
        if (error?.code === 11000) return Setting.findOne({ service: SERVICE });
        throw error;
    }
};

const resolveOllamaHost = async () => {
    const settings = await getSettings();
    return settings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL;
};

// Which device a request works on: the server's own computer, one of the person's linked computers, or none.
const deviceScope = new AsyncLocalStorage();
const LOCAL_TARGET = { kind: 'local', id: null };
const NO_TARGET = { kind: 'none', id: null };
const DEVICE_HOST = 'http://device.mollama';
// A Mollama server is never one of a person's computers, in development, staging or production: models run only on
// computers linked through the desktop app. Only the test suite can switch this on, to stand in for a computer with
// Ollama; no setting turns it on for a running server.
const localEnabled = () => process.env.NODE_ENV === 'test' && process.env.LOCAL_DEVICE === 'true';
const currentTarget = () => deviceScope.getStore() || (localEnabled() ? LOCAL_TARGET : NO_TARGET);
// Paused computers stay connected but are given no work. The set follows the saved flag each time a computer is looked up.
const pausedDevices = new Set();
const targetOf = (device) => {
    if (device.kind === 'pool') return { kind: 'pool', id: String(device.id) };
    if (device.kind !== 'companion') return LOCAL_TARGET;
    if (device.paused) pausedDevices.add(String(device.id));
    else pausedDevices.delete(String(device.id));
    return { kind: 'companion', id: String(device.id) };
};
const targetPaused = () => {
    const target = currentTarget();
    return target.kind === 'companion' && pausedDevices.has(target.id);
};

// Why the computer a request works on cannot take it: a pool that is not ready, a paused computer, or Ollama not answering.
const downCode = () => (currentTarget().kind === 'pool' ? 'POOL_NOT_READY' : targetPaused() ? 'DEVICE_PAUSED' : 'OLLAMA_DOWN');

const currentLane = () => {
    const target = currentTarget();
    return target.kind === 'companion' ? target.id : ['cloud', 'pool'].includes(target.kind) ? `${target.kind}:${target.id}` : target.kind;
};

const getOllama = async () => {
    const target = currentTarget();
    if (target.kind === 'cloud') {
        const provider = await Provider.findOne({ _id: target.id, service: SERVICE }).select('+sealed');
        const entry = CLOUD_PROVIDERS.find((one) => one.id === provider?.kind);
        const key = provider ? unseal(provider.sealed)?.key : null;
        if (!entry || !key) return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('KEY_REFUSED')));
        return createCloudClient(entry, key, provider.models);
    }
    if (target.kind === 'pool') return poolClient(target.id);
    if (target.kind === 'companion' && pausedDevices.has(target.id)) return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('DEVICE_PAUSED')));
    if (target.kind === 'companion') return createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(target.id));
    if (target.kind === 'none') return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('NO_DEVICE')));
    return createOllamaClient(await resolveOllamaHost());
};

// What a computer has free right now, less what it keeps back. The models listed are ones Ollama would unload.
const freeOf = async (deviceId, hardware, unloading = []) => {
    const said = await deviceGateway.ask(deviceId, 'memory').catch(() => null);
    const inGpu = unloading.reduce((sum, entry) => sum + (entry.size_vram || 0), 0) / MB;
    const whole = unloading.reduce((sum, entry) => sum + (entry.size || 0), 0) / MB;
    return freeHardware(hardware, {
        freeMb: Number(said?.freeMb) > 0 ? Number(said.freeMb) + (hardware.gpuShared ? whole : Math.max(0, whole - inGpu)) : null,
        gpuFreeMb: Number.isFinite(said?.gpuFreeMb) ? said.gpuFreeMb + inGpu : null
    });
};
// The pooled model a computer runs or lends memory to, if any, and whether a reply is using it.
const pooledOn = async (device) => {
    if (device?.kind !== 'companion' || !['main', 'lend'].includes(device.poolRole)) return null;
    const main = device.poolRole === 'main' ? device : (await ownDevices(device.registeredBy)).find((one) => one.poolRole === 'main' && deviceGateway.isOnline(one.id));
    const state = main && poolStateOf(main.id);
    const model = state?.running || state?.starting;
    if (!model) return null;
    const pool = await poolRecord(device.registeredBy);
    return { model, main: String(main.id), idle: !poolStarts.has(main.id) && !queue.busyIn(`pool:${pool.id}`) };
};
// A computer holds a pooled model or Ollama's, not both: each makes room for the other while no reply uses it.
const waitUntil = async (check, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
        if (await check()) return true;
    }
    return false;
};
const endPooled = async (pooled) => {
    deviceGateway.order(pooled.main, { type: 'pool', action: 'stop' });
    await waitUntil(() => !poolStateOf(pooled.main)?.running);
    await new Promise((resolve) => setTimeout(resolve, 1500));
};
const endLoaded = async (lane, ollama = createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(lane))) => {
    if (queue.busyIn(lane)) return false;
    const loaded = (await ollama.running().catch(() => ({ models: [] }))).models;
    if (loaded.length === 0) return true;
    await Promise.all(loaded.map((entry) => ollama.unload(entry.name).catch(() => {})));
    return waitUntil(() => ollama.running().then(({ models }) => models.length === 0, () => true));
};

// What loading a model would take from the computer it runs on. A model past the computer's memory makes the whole
// computer swap to disk and freeze, so it is never loaded ahead, and a message to it is only sent on the person's word.
// Null when the model is not loaded on a computer of theirs, or the computer's memory is not known. For a message
// ('sending'), an idle pooled model on the computer makes way first.
const loadCost = async (ollama, model, { sending = false, anyway = false } = {}) => {
    const target = currentTarget();
    if (!['companion', 'local', 'pool'].includes(target.kind)) return null;
    const [{ models: running }, { models: installed }] = await Promise.all([ollama.running(), ollama.list()]);
    if (running.some((entry) => entry.name === model)) return { loaded: true };
    const sizeMb = (installed.find((entry) => entry.name === model)?.size || 0) / MB;
    if (!sizeMb) return null;
    const entry = { sizeMb, parameters: 0 };

    if (target.kind === 'pool') {
        const parts = await poolTarget(target.id);
        // Replacing another pooled model, or one too large for the pool altogether, is for startPool to judge.
        if (!parts || running.length > 0) return null;
        const computers = parts.computers.map((one, at) => ({ ...one.hardware, runs: at === 0 }));
        if (!fitPool(entry, computers)?.fits) return null;
        const fit = fitPool(entry, (await poolNow(parts)).computers);
        return { loaded: false, ahead: false, tight: !fit.fits, neededMb: fit.memoryNeededMb, hasMb: fit.memoryMb, measured: true, fitsEmpty: true, name: parts.name };
    }

    const device = await getCurrentDevice();
    const whole = effectiveHardware(device);
    if (!whole.memoryMb) return null;
    let pooled = await pooledOn(device);
    if (sending && pooled?.idle && (anyway || fitModel(entry, whole).fits)) {
        await endPooled(pooled);
        pooled = null;
    }
    let hardware = target.kind === 'companion' ? await freeOf(target.id, whole, sending ? running : []) : whole;
    const measured = hardware !== whole;
    // Without a measure, a pooled model in use has the graphics memory.
    if (!measured && pooled) hardware = { ...whole, memoryMb: whole.memoryMb - (whole.gpuShared ? whole.gpuMemoryMb : 0), gpuMemoryMb: 0, gpuShared: false };
    const fit = fitModel(entry, hardware);
    const usableGpu = (mb) => Math.max(0, mb - GPU_HEADROOM_MB);
    const inGpu = running.reduce((sum, one) => sum + (one.size_vram || 0), 0) / MB;
    const light = (one) => one.verdict === 'gpu' || (one.verdict === 'cpu' && one.memoryNeededMb * 2 <= whole.memoryMb);
    const ahead = !pooled && light(fit) && (running.length === 0 || (fit.verdict === 'gpu' && inGpu + fit.memoryNeededMb <= usableGpu(whole.gpuMemoryMb)));
    // It would fit in place of what is loaded, which no reply may be using (endLoaded leaves one that is).
    const inPlace = !ahead && !pooled && running.length > 0 && light(fitModel(entry, target.kind === 'companion' ? await freeOf(target.id, whole, running) : whole));
    const hasMb = usableGpu(hardware.gpuMemoryMb) + Math.max(0, hardware.memoryMb - (hardware.gpuShared ? hardware.gpuMemoryMb : 0) - RAM_RESERVE_MB);
    return { loaded: false, ahead, inPlace, tight: !fit.fits, neededMb: fit.memoryNeededMb, hasMb, measured, fitsEmpty: fitModel(entry, whole).fits, pooled: pooled?.model || null, name: device ? shownName(device) : 'This computer' };
};
const memoryRefusal = (model, cost) => {
    const gb = (mb) => Math.round(mb / 1024);
    return new OllamaError('NOT_ENOUGH_MEMORY', `${model} needs about ${gb(cost.neededMb)} GB and ${cost.name} has about ${gb(cost.hasMb)} GB ${cost.measured ? 'free' : 'for models'}${cost.pooled ? `, with ${cost.pooled} running in your pool` : ''}. ${cost.fitsEmpty ? '' : 'It is larger than this computer can hold, even with nothing else in memory. '}Loading it could freeze the whole computer.`);
};

// When a model last did something for Mollama, so an idle one can say for how long.
const modelUse = new Map();
const useKey = (target, model) => `${target} ${model}`;
// Models being loaded ahead of a message, by the same key.
const loadingAhead = new Map();

// What one computer holds in memory right now: each model, what it takes, what it is doing and for how long it has not.
// What one model is doing: the reply it is writing, or when it was last used, and how its context is used.
const doing = async (where, model, fallback = null) => {
    const [chatId] = repliesOn(where, model);
    const live = chatId ? liveReplies.get(chatId) : null;
    const chat = chatId ? await Chat.findOne({ _id: chatId, service: SERVICE }).select('title') : null;
    const used = modelUse.get(useKey(where, model)) || fallback;
    const progress = live ? replyProgress(live) : null;
    return {
        state: live ? (progress.phase === 'waiting' ? 'waiting' : 'answering') : 'idle',
        chat: chat ? { id: chat.id, title: chat.title } : null,
        progress,
        use: live?.context ? { now: true, chat: null, ...presentContext(live.context) } : lastContext.has(useKey(where, model)) ? { now: false, chat: lastContext.get(useKey(where, model)).chat, ...lastContext.get(useKey(where, model)).context } : null,
        replies: repliesOn(where, model).length,
        usedAt: live ? null : used,
        idleMs: live || !used ? null : Math.max(0, Date.now() - used)
    };
};
// The online models answering now or used lately. They take no memory on a computer, and no service says what they
// take on its own.
const ONLINE_LATELY_MS = 15 * 60 * 1000;
const onlineInUse = async (userId) => {
    const providers = await Provider.find({ service: SERVICE, owner: userId }).sort({ name: 1 });
    const services = await Promise.all(providers.map(async (provider) => {
        const target = String(provider.id);
        const lately = [...modelUse].filter(([key, at]) => key.startsWith(`${target} `) && Date.now() - at < ONLINE_LATELY_MS).map(([key]) => key.slice(target.length + 1));
        const names = new Set([...[...liveReplies.values()].filter((live) => String(live.target) === target && live.model).map((live) => live.model), ...lately]);
        const models = await Promise.all([...names].map(async (name) => {
            const known = provider.models.find((one) => one.name === name);
            return { name, displayName: known?.title || name, source: 'online', sizeMb: null, gpuMb: null, ramMb: null, context: known?.contextLength || null, endsAt: null, helpers: [], ...await doing(target, name) };
        }));
        return { id: target, name: provider.name, models };
    }));
    return services.filter((one) => one.models.length > 0);
};
const memoryOf = async (device, names = new Map()) => {
    const local = device.kind === 'local';
    const id = String(device.id);
    const target = local ? null : id;
    const online = isOnline(device);
    const hardware = effectiveHardware(device);
    const role = local ? 'off' : device.poolRole || 'off';
    const about = {
        id, name: shownName(device), kind: device.kind, online, paused: Boolean(device.paused), role, gpuName: hardware.gpuName, gpuShared: hardware.gpuShared,
        memory: { totalMb: hardware.memoryMb, freeMb: null, gpuTotalMb: hardware.gpuMemoryMb || 0, gpuFreeMb: null }, models: [], answered: false, lending: null
    };
    if (!online || about.paused) return about;

    const client = local ? createOllamaClient(await resolveOllamaHost()) : createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(id));
    const quick = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 8000, null).unref?.())]).catch(() => null);
    const [running, said, settings] = await Promise.all([quick(client.running()), local ? null : quick(deviceGateway.ask(id, 'memory')), getSettings()]);
    about.answered = Boolean(running);
    about.memory.freeMb = Number(said?.freeMb) > 0 ? said.freeMb : null;
    about.memory.gpuFreeMb = Number.isFinite(said?.gpuFreeMb) ? said.gpuFreeMb : null;

    const now = Date.now();
    const keepMs = settings.keepAliveMinutes * 60 * 1000;
    const label = (name) => names.get(name) || knownModels.get(name)?.name || friendlyName(name);
    for (const entry of running?.models || []) {
        const ends = entry.expires_at ? new Date(entry.expires_at).getTime() : null;
        // Ollama keeps a model for the set time after its last use, so its end says when that was.
        const last = ends && ends - keepMs <= now && ends > now ? ends - keepMs : null;
        const busy = await doing(target, entry.name, last);
        const gpuMb = Math.round((entry.size_vram || 0) / MB);
        const sizeMb = Math.round((entry.size || 0) / MB);
        about.models.push({ name: entry.name, displayName: label(entry.name), source: 'ollama', sizeMb, gpuMb, ramMb: Math.max(0, sizeMb - gpuMb), context: entry.context_length || null, endsAt: busy.state === 'idle' ? ends : null, helpers: [], ...busy });
    }
    // A model on its way in: a reply is waiting for it, or it is being loaded ahead of one.
    const coming = new Set([...liveReplies.values()].filter((live) => String(live.target) === String(target) && live.model && !about.models.some((one) => one.name === live.model)).map((live) => live.model));
    for (const key of loadingAhead.keys()) if (key.startsWith(`${target} `)) coming.add(key.slice(`${target} `.length));
    for (const name of coming) {
        if (about.models.some((one) => one.name === name)) continue;
        about.models.push({ name, displayName: label(name), source: 'ollama', sizeMb: null, gpuMb: null, ramMb: null, context: null, endsAt: null, helpers: [], ...await doing(target, name), state: 'loading', usedAt: null, idleMs: null });
    }

    if (role !== 'off') {
        const main = role === 'main' ? device : (await ownDevices(device.registeredBy)).find((one) => one.poolRole === 'main' && isOnline(one));
        const state = main ? poolStateOf(main.id) : null;
        const model = state?.running || state?.starting || null;
        if (model && role === 'lend') about.lending = { model, displayName: label(model), main: shownName(main) };
        if (model && role === 'main') {
            const pool = await poolRecord(device.registeredBy);
            const busy = await doing(pool.id, model);
            const helpers = (await ownDevices(device.registeredBy)).filter((one) => one.poolRole === 'lend' && isOnline(one)).map(shownName);
            const starting = !state.running || poolStarts.has(main.id);
            const size = ((await quick(client.list()))?.models || []).find((one) => one.name === model)?.size || 0;
            about.models.push({
                name: model, displayName: label(model), source: 'pool', sizeMb: size ? Math.round(size / MB) : null, gpuMb: null, ramMb: null, context: poolRoomOf(device.id, model), helpers,
                ...busy, state: starting ? 'loading' : busy.state, endsAt: !starting && busy.usedAt ? busy.usedAt + POOL_IDLE_MS : null
            });
        }
    }
    return about;
};
// The models on the computers a refused message would have used, so the person can make room for it.
const inTheWay = async (asked) => {
    const target = currentTarget();
    const device = target.kind === 'pool' ? null : await getCurrentDevice();
    const parts = target.kind === 'pool' ? await poolTarget(target.id) : null;
    const devices = parts ? await Device.find({ _id: { $in: [parts.main, ...parts.lenders].map((one) => one.id) } }) : [device].filter(Boolean);
    const pooled = device ? await pooledOn(device) : null;
    if (pooled && pooled.main !== String(device.id)) devices.push(await Device.findById(pooled.main));
    const held = await Promise.all(devices.map((one) => memoryOf(one)));
    return held.flatMap((one) => one.models.filter((model) => !(model.name === asked && model.state === 'loading')).map((model) => ({ ...model, device: one.id, deviceName: one.name })));
};

export const listMemory = asyncHandler(async (req, res) => {
    const local = localEnabled() ? await getLocalDevice() : null;
    const devices = [...(local ? [local] : []), ...await ownDevices(req.user.id)];
    const { keepAliveMinutes } = await getSettings();
    const [computers, online] = await Promise.all([Promise.all(devices.map((device) => memoryOf(device))), onlineInUse(req.user.id)]);
    res.status(200).json({ success: true, at: Date.now(), keepAliveMinutes, poolIdleMinutes: POOL_IDLE_MS / 60000, computers, online });
});

// Takes one model out of a computer's memory. One that is answering is left alone unless its reply is to be stopped.
export const freeMemory = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    const { model, pooled = false, stop = false } = req.body;
    const local = device.kind === 'local';
    const id = String(device.id);
    if (!isOnline(device)) return sendOllamaError(res, new OllamaError('DEVICE_OFFLINE'));
    try {
        const where = pooled ? (await poolRecord(device.registeredBy)).id : local ? null : id;
        const replies = repliesOn(where, model);
        const working = replies.length > 0 || (pooled ? queue.busyIn(`pool:${where}`) : false);
        if (working && !stop) throw new OllamaError('MODEL_IN_USE');
        if (replies.length > 0) await endReplies(replies, { wait: 5000 });
        let removed;
        if (pooled) {
            deviceGateway.order(id, { type: 'pool', action: 'stop' });
            removed = await waitUntil(() => !poolStateOf(id)?.running, 8000);
        } else {
            const client = local ? createOllamaClient(await resolveOllamaHost()) : createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(id));
            await client.unload(model);
            removed = await waitUntil(async () => !(await client.running()).models.some((one) => one.name === model), 8000);
        }
        if (removed) modelUse.delete(useKey(where, model));
        if (removed) lastContext.delete(useKey(where, model));
        logger.info('[Memory] Model removed', { deviceId: id, model, pooled, removed, userId: req.user.id });
        getNotificationService().sendToUser(String(req.user.id), { type: 'models:changed', data: { id: null, removed: false } });
        res.status(200).json({ success: true, removed, computer: await memoryOf(device) });
    } catch (error) {
        sendOllamaError(res, mapOllamaError(error));
    }
});

const diskNow = async () => {
    const target = currentTarget();
    if (target.kind === 'local') return readDisk();
    const unknown = { diskFreeMb: null, diskTotalMb: null };
    if (target.kind === 'none') return unknown;
    return deviceGateway.ask(target.id, 'disk').then((disk) => ({ ...unknown, ...disk }), () => unknown);
};

const SAVE_EVERY_MS = 2000;
const EMIT_EVERY_MS = 400;
const OPEN_STATES = ['queued', 'downloading', 'paused'];
const FINAL_STATES = ['completed', 'failed', 'cancelled'];

const within = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('database did not answer in time')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const health = {
    databaseReady: () => mongoose.connection.readyState === 1
};

export const requireDatabase = (req, res, next) => {
    if (health.databaseReady()) return next();
    res.status(503).json({
        success: false,
        code: 'DATABASE_DOWN',
        message: 'Mollama cannot reach its database.',
        action: 'Check the internet connection. A download that is running carries on by itself.'
    });
};

class DownloadManager extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.diskProbe = diskNow;
        this.active = null;
        this.live = new Map();
        this.stallWarnMs = 20000;
        this.stallFailMs = 180000;
        this.retryMs = 5000;
        this.saveWaitMs = 3000;
    }

    setDiskProbe(probe) {
        this.diskProbe = probe || diskNow;
    }

    async freeMb() {
        try {
            return (await this.diskProbe()).diskFreeMb;
        } catch {
            return null;
        }
    }

    present(doc) {
        const live = this.live.get(doc.id) || {};
        const status = live.status ?? doc.status;
        const errorCode = live.errorCode !== undefined ? live.errorCode : doc.errorCode;
        const completedBytes = live.completedBytes ?? doc.completedBytes;
        const totalBytes = live.totalBytes ?? doc.totalBytes;
        const speedBps = status === 'downloading' ? live.speedBps || 0 : 0;

        return {
            id: doc.id,
            model: doc.model,
            status,
            stalled: status === 'downloading' && Boolean(live.stalled),
            completedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.min(100, Math.floor((completedBytes / totalBytes) * 100)) : 0,
            speedBps,
            etaSeconds: speedBps > 0 && totalBytes > completedBytes ? Math.ceil((totalBytes - completedBytes) / speedBps) : null,
            error: errorCode ? new OllamaError(errorCode).toJSON() : null,
            requestedBy: doc.requestedBy,
            device: doc.device ? String(doc.device) : null,
            createdAt: doc.createdAt,
            finishedAt: live.finishedAt !== undefined ? live.finishedAt : doc.finishedAt
        };
    }

    announce(doc) {
        this.emit('progress', this.present(doc));
    }

    async list() {
        const docs = await Download.find({ service: SERVICE, device: currentTarget().id }).sort({ createdAt: -1 }).limit(30);
        return docs.map((doc) => this.present(doc));
    }

    // A progress save is not waited for, so it can arrive after the save that ends the download. It must not undo that one.
    save(doc, fields, { final = false, attempt = 0 } = {}) {
        return within(Download.updateOne(final ? { _id: doc._id } : { _id: doc._id, status: { $nin: FINAL_STATES } }, fields), this.saveWaitMs)
            .then(() => {
                if (final) this.live.delete(doc.id);
            })
            .catch(() => {
                if (!final || attempt >= 240) return;
                setTimeout(() => this.save(doc, fields, { final, attempt: attempt + 1 }), this.retryMs).unref?.();
            });
    }

    async clearFailed(model, keepId) {
        try {
            const stale = await Download.find({ service: SERVICE, model, device: currentTarget().id, status: 'failed', _id: { $ne: keepId } });
            for (const doc of stale) {
                this.live.delete(doc.id);
                Object.assign(doc, { status: 'cancelled', finishedAt: new Date() });
                await doc.save();
                this.announce(doc);
            }
        } catch (error) {
            logger.warn('[Downloads] Old failed downloads could not be cleared', { model, message: error.message });
        }
    }

    async enqueue({ model, userId, sizeHintMb = null }) {
        if (sizeHintMb) {
            const freeMb = await this.freeMb();
            if (freeMb !== null && sizeHintMb > freeMb) {
                const error = new OllamaError('DISK_FULL');
                error.neededMb = sizeHintMb;
                error.freeMb = freeMb;
                throw error;
            }
        }

        const device = currentTarget().id;
        const open = await Download.find({ service: SERVICE, model, device, status: { $in: OPEN_STATES } });
        let doc = open.find((candidate) => !FINAL_STATES.includes(this.live.get(candidate.id)?.status)) || null;

        if (doc && this.active?.id !== doc.id && (this.live.get(doc.id)?.status ?? doc.status) === 'paused') {
            this.live.delete(doc.id);
            doc.status = 'queued';
            doc.errorCode = null;
            await doc.save();
        }
        if (!doc) {
            doc = await Download.findOne({ service: SERVICE, model, device, status: 'failed' }).sort({ createdAt: -1 });
            if (doc) {
                this.live.delete(doc.id);
                Object.assign(doc, { status: 'queued', errorCode: null, finishedAt: null, requestedBy: userId });
                await doc.save();
            }
        }
        if (!doc) doc = await Download.create({ model, requestedBy: userId, device });
        await this.clearFailed(model, doc.id);

        this.announce(doc);
        getNotificationService().broadcast('activity:changed');
        this.next();
        return this.present(doc);
    }

    async next() {
        if (this.active) return;
        let doc;
        try {
            doc = await Download.findOne({ service: SERVICE, status: 'queued' }).sort({ createdAt: 1 });
        } catch {
            setTimeout(() => this.next(), this.retryMs).unref?.();
            return;
        }
        if (!doc || this.active) return;
        this.active = { id: doc.id, stream: null, stopAs: null, stalledOut: false };
        const target = doc.device ? { kind: 'companion', id: String(doc.device) } : localEnabled() ? LOCAL_TARGET : NO_TARGET;
        deviceScope.run(target, () => this.run(doc)).catch((error) => {
            logger.error('[Downloads] Unexpected failure', { error: error.message });
            if (this.active?.id === doc.id) this.active = null;
            this.next();
        });
    }

    async run(doc) {
        const job = this.active;
        const layers = new Map();
        const state = {
            doc,
            status: 'downloading',
            errorCode: null,
            finishedAt: null,
            completedBytes: doc.completedBytes,
            totalBytes: doc.totalBytes,
            speedBps: 0,
            stalled: false
        };
        this.live.set(doc.id, state);

        let lastSave = 0;
        let lastEmit = 0;
        let lastBytes = state.completedBytes;
        let lastTick = Date.now();
        let lastAdvance = Date.now();
        let advanceMark = state.completedBytes;

        doc.status = 'downloading';
        doc.startedAt = doc.startedAt || new Date();
        doc.errorCode = null;
        await this.save(doc, { status: 'downloading', startedAt: doc.startedAt, errorCode: null });
        this.announce(doc);
        getNotificationService().broadcast('activity:changed');

        const watchdog = setInterval(() => {
            const waitingForBytes = state.totalBytes === 0 || state.completedBytes < state.totalBytes;
            const quietFor = Date.now() - lastAdvance;
            if (!waitingForBytes) return;
            if (quietFor >= this.stallFailMs) {
                job.stalledOut = true;
                job.stream?.abort?.();
            } else if (quietFor >= this.stallWarnMs && !state.stalled) {
                state.stalled = true;
                state.speedBps = 0;
                this.announce(doc);
            }
        }, Math.max(50, Math.min(2000, Math.floor(this.stallWarnMs / 4))));
        watchdog.unref?.();

        const freeAtStartMb = await this.freeMb();
        let hardware = null;
        // On the main computer of a pool, a model that fits the pool may be downloaded though it is too large alone.
        let poolHardware = null;
        try {
            const current = await getCurrentDevice();
            hardware = effectiveHardware(current);
            const pooled = current && doc.requestedBy ? await poolFor(doc.requestedBy, current.id) : null;
            if (pooled?.here) poolHardware = pooled.hardware;
        } catch {
            hardware = null;
        }
        let outcome = 'completed';
        let errorCode = null;

        try {
            const ollama = await getOllama();
            const stream = await ollama.pull(doc.model);
            job.stream = stream;
            if (job.stopAs || job.stalledOut) stream.abort?.();

            for await (const part of stream) {
                if (job.stopAs || job.stalledOut) break;
                if (part.error) throw mapOllamaError({ error: part.error });

                if (part.digest && part.total) {
                    layers.set(part.digest, { total: part.total, completed: part.completed || 0 });
                    let total = 0;
                    let completed = 0;
                    for (const layer of layers.values()) {
                        total += layer.total;
                        completed += layer.completed;
                    }
                    state.totalBytes = Math.max(state.totalBytes, total);
                    state.completedBytes = completed;

                    const sized = { sizeMb: state.totalBytes / MB, parameters: 0, moe: false };
                    if (hardware && !fitModel(sized, hardware).fits && !(poolHardware && fitPool(sized, poolHardware)?.fits)) {
                        throw new OllamaError('MODEL_TOO_LARGE');
                    }
                    if (freeAtStartMb !== null && (state.totalBytes - completed) / MB > freeAtStartMb) {
                        throw new OllamaError('DISK_FULL');
                    }
                }

                const now = Date.now();
                if (state.completedBytes !== advanceMark) {
                    advanceMark = state.completedBytes;
                    lastAdvance = now;
                    if (state.stalled) {
                        state.stalled = false;
                        this.announce(doc);
                    }
                }
                if (now - lastTick >= 1000) {
                    state.speedBps = Math.max(0, ((state.completedBytes - lastBytes) * 1000) / (now - lastTick));
                    lastBytes = state.completedBytes;
                    lastTick = now;
                }
                if (now - lastEmit >= EMIT_EVERY_MS) {
                    lastEmit = now;
                    this.announce(doc);
                }
                if (now - lastSave >= SAVE_EVERY_MS) {
                    lastSave = now;
                    this.save(doc, { completedBytes: state.completedBytes, totalBytes: state.totalBytes });
                }
            }
            if (job.stalledOut && !job.stopAs) throw new OllamaError('DOWNLOAD_INTERRUPTED');
            if (job.stopAs) outcome = job.stopAs;
        } catch (error) {
            if (job.stopAs) {
                outcome = job.stopAs;
            } else {
                outcome = 'failed';
                errorCode = job.stalledOut ? 'DOWNLOAD_INTERRUPTED' : mapOllamaError(error).code;
                if (errorCode === 'UNKNOWN') errorCode = 'DOWNLOAD_INTERRUPTED';
                if (errorCode === 'MODEL_MISSING') errorCode = 'MODEL_NOT_FOUND';
                logger.warn('[Downloads] Download failed', { model: doc.model, code: errorCode, stalled: job.stalledOut });
            }
        } finally {
            clearInterval(watchdog);
        }

        if (outcome === 'completed' && state.totalBytes > 0) state.completedBytes = state.totalBytes;

        const result = {
            status: outcome,
            completedBytes: state.completedBytes,
            totalBytes: state.totalBytes,
            errorCode,
            finishedAt: FINAL_STATES.includes(outcome) ? new Date() : null
        };
        Object.assign(doc, result);
        // The record is saved before the live state says finished, so no page reads "completed" ahead of the record.
        await this.save(doc, result, { final: true });
        Object.assign(state, { status: outcome, errorCode, finishedAt: result.finishedAt, stalled: false, speedBps: 0 });

        this.announce(doc);
        if (outcome === 'completed') await this.clearFailed(doc.model, doc.id);
        this.active = null;
        if (outcome === 'completed') {
            getNotificationService().broadcast('download:finished', { level: 'success', message: `${doc.model} has finished downloading.`, model: doc.model, id: doc.id }, [doc.requestedBy]);
        } else if (outcome === 'failed') {
            getNotificationService().notify(doc.requestedBy, 'download:failed', { level: 'error', message: `${doc.model} could not be downloaded. ${new OllamaError(errorCode).message}`, model: doc.model, id: doc.id });
        }
        getNotificationService().broadcast('activity:changed');
        this.emit('settled', this.present(doc));
        this.next();
    }

    async stop(id, action) {
        const outcome = action === 'pause' ? 'paused' : 'cancelled';

        if (this.active?.id === String(id)) {
            const state = this.live.get(String(id));
            const running = !state || state.status === 'downloading';
            if (running) {
                this.active.stopAs = outcome;
                this.active.stream?.abort?.();
            }
            await this.settled(String(id));
            if (running && state) return this.present(state.doc);
        }

        const doc = await Download.findOne({ _id: id, service: SERVICE });
        if (!doc) return null;
        const status = this.live.get(doc.id)?.status ?? doc.status;
        const dismissing = status === 'failed' && outcome === 'cancelled';
        if (!OPEN_STATES.includes(status) && !dismissing) return this.present(doc);
        this.live.delete(doc.id);

        doc.status = outcome;
        doc.finishedAt = outcome === 'cancelled' ? new Date() : null;
        await doc.save();
        this.announce(doc);
        getNotificationService().broadcast('activity:changed');
        return this.present(doc);
    }

    settled(id, timeoutMs = 10000) {
        return new Promise((resolve) => {
            if (this.active?.id !== id) return resolve();
            const done = () => {
                clearTimeout(timer);
                this.off('settled', onSettled);
                resolve();
            };
            const onSettled = (job) => {
                if (job.id === id) done();
            };
            const timer = setTimeout(done, timeoutMs);
            this.on('settled', onSettled);
        });
    }

    // A download that failed because its computer dropped off the connection is taken up again when that computer
    // returns. Ollama keeps what was already fetched, so it carries on from there.
    async resumeFor(deviceId) {
        const waiting = await Download.find({
            service: SERVICE,
            device: deviceId,
            status: 'failed',
            errorCode: { $in: ['DEVICE_OFFLINE', 'DOWNLOAD_INTERRUPTED'] },
            finishedAt: { $gte: new Date(Date.now() - RESUME_WINDOW_MS) }
        });
        if (waiting.length === 0) return 0;
        for (const doc of waiting) {
            this.live.delete(doc.id);
            doc.status = 'queued';
            doc.errorCode = null;
            doc.finishedAt = null;
            await doc.save();
            this.announce(doc);
        }
        logger.info(`[Downloads] Resuming ${waiting.length} download(s) on a computer that came back`, { deviceId: String(deviceId) });
        getNotificationService().broadcast('activity:changed');
        this.next();
        return waiting.length;
    }

    async recover() {
        const interrupted = await Download.updateMany(
            { service: SERVICE, status: 'downloading' },
            { status: 'queued' }
        );
        if (interrupted.modifiedCount > 0) {
            logger.info(`[Downloads] Resuming ${interrupted.modifiedCount} interrupted download(s)`);
        }
        this.next();
    }

    async idle(timeoutMs = 15000) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const open = await Download.countDocuments({ service: SERVICE, status: { $in: ['queued', 'downloading'] } });
            if (!this.active && open === 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
    }
}

export const downloads = new DownloadManager();


const presentSettings = (settings) => ({
    ollamaBaseUrl: settings.ollamaBaseUrl || process.env.OLLAMA_BASE_URL,
    ollamaBaseUrlIsDefault: !settings.ollamaBaseUrl,
    defaultModel: settings.defaultModel,
    maxConcurrentGenerations: settings.maxConcurrentGenerations,
    keepAliveMinutes: settings.keepAliveMinutes,
    updatedAt: settings.updatedAt
});

const getLocalDevice = async ({ redetect = false } = {}) => {
    const hostname = os.hostname();
    let device = await Device.findOne({ service: SERVICE, kind: 'local', hostname });
    const detected = !device || !device.hardware || redetect ? await detectHardware() : null;
    if (!device) {
        try {
            device = await Device.create({ name: hostname, kind: 'local', hostname, hardware: detected });
        } catch (error) {
            if (error?.code !== 11000) throw error;
            device = await Device.findOne({ service: SERVICE, kind: 'local', hostname });
        }
    } else if (detected) {
        device.hardware = detected;
    }
    device.lastSeenAt = new Date();
    await device.save();
    return device;
};

const getCurrentDevice = async () => {
    const target = currentTarget();
    if (target.kind === 'companion') return Device.findOne({ _id: target.id, service: SERVICE });
    if (target.kind === 'pool') {
        const parts = await poolTarget(target.id);
        return parts ? { id: target.id, kind: 'pool', paused: false, online: true, hardware: parts.hardware, overrides: {} } : null;
    }
    if (target.kind === 'none' || target.kind === 'cloud') return null;
    return getLocalDevice();
};

const effectiveHardware = (device) => {
    const detected = device?.hardware?.toObject?.() || device?.hardware || {};
    const overrides = device?.overrides || {};
    // A Mac read by an older desktop app has no graphics recorded. An Apple chip always has them, so they are worked out here.
    const appleChip = /^Apple /.test(detected.cpu || '') ? 'arm64' : '';
    const [apple] = detected.gpus?.length ? [] : appleGpus({ platform: detected.platform, arch: appleChip, cpu: detected.cpu, memoryMb: detected.memoryMb || 0 });
    const gpuName = overrides.gpuName || detected.gpus?.[0]?.name || apple?.name || null;
    const gpuMemoryMb = overrides.gpuMemoryMb ?? (detected.gpuMemoryMb || apple?.memoryMb || 0);

    return {
        memoryMb: overrides.memoryMb ?? detected.memoryMb ?? null,
        gpuName,
        gpuMemoryMb,
        hasGpu: gpuMemoryMb > 0,
        gpuShared: !overrides.gpuName && /built-in graphics$/.test(gpuName || ''),
        cpu: detected.cpu || null,
        cpuThreads: detected.cpuThreads || null,
        diskFreeMb: detected.diskFreeMb ?? null,
        diskTotalMb: detected.diskTotalMb ?? null,
        platform: detected.platform || null
    };
};

// Models that only make embeddings cannot hold a chat, so they are counted apart: a computer with only those is not ready to chat.
const embedsOnly = (model) => /bert/i.test(model.details?.family || '') || /embed/i.test(model.name || '');
const readOllama = async (client) => {
    const status = await client.status();
    if (!status.available) return { ...status, modelCount: 0, chatCount: 0 };
    try {
        const { models } = await client.list();
        return { ...status, modelCount: models.length, chatCount: models.filter((model) => !embedsOnly(model)).length };
    } catch {
        return { ...status, modelCount: 0, chatCount: 0 };
    }
};

const UNREACHED = { available: false, version: null, modelCount: 0, chatCount: 0 };
const isOnline = (device) => device.kind === 'local' || (device.kind === 'pool' ? device.online === true : deviceGateway.isOnline(device.id));
const ollamaOf = (device) => (device.paused
    ? { ...UNREACHED, paused: true }
    : isOnline(device) ? deviceScope.run(targetOf(device), async () => readOllama(await getOllama())) : UNREACHED);
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

const ownDevices = (userId) => Device.find({ service: SERVICE, kind: 'companion', registeredBy: userId }).sort({ lastSeenAt: -1 });

const allowedDevice = async (req, id) => {
    const device = await Device.findOne({ _id: id, service: SERVICE });
    if (!device) return null;
    if (device.kind === 'local') return localEnabled() && device.hostname === os.hostname() ? device : null;
    return String(device.registeredBy) === String(req.user.id) ? device : null;
};

// The computer or online service a request names, if it is one of the person's; null when it names none of theirs.
const namedTarget = async (userId, wanted) => {
    if (!wanted || !mongoose.isValidObjectId(wanted)) return null;
    const device = await Device.findOne({ _id: wanted, service: SERVICE });
    if (['companion', 'pool'].includes(device?.kind) && String(device.registeredBy) === String(userId)) return targetOf(device);
    if (device?.kind === 'local' && localEnabled()) return LOCAL_TARGET;
    if (!device && await Provider.exists({ _id: wanted, service: SERVICE, owner: userId })) return { kind: 'cloud', id: String(wanted) };
    return null;
};
const pickTarget = async (userId, wanted) => {
    const named = await namedTarget(userId, wanted);
    if (named) return named;
    if (localEnabled()) return LOCAL_TARGET;
    const own = await ownDevices(userId);
    const best = own.find((device) => deviceGateway.isOnline(device.id) && !device.paused) || own.find((device) => deviceGateway.isOnline(device.id)) || own[0];
    return best ? targetOf(best) : NO_TARGET;
};

export const useDevice = (req, res, next) => {
    pickTarget(req.user.id, req.get('X-Mollama-Device') || req.query?.device).then((target) => deviceScope.run(target, next), next);
};
// Removing or downloading a model happens only on the computer the person confirmed: a request that does not name one
// of theirs is refused, never sent to one picked here.
export const useNamedDevice = (req, res, next) => {
    namedTarget(req.user.id, req.get('X-Mollama-Device') || req.query?.device).then((target) => {
        if (!target) return res.status(400).json({ success: false, code: 'DEVICE_NOT_NAMED', message: 'Choose the computer first. Nothing was removed or downloaded.' });
        return deviceScope.run(target, next);
    }, next);
};

// A computer still called by its network name is shown with a readable one; a name the person gave is kept as it is.
const shownName = (device) => (device.kind === 'companion' && device.name === String(device.hostname || '').split(':').slice(1).join(':') ? computerName(device.name) : device.name);

const presentDevice = (device, ollama) => ({
    id: device.id,
    name: shownName(device),
    kind: device.kind,
    service: device.service,
    online: isOnline(device),
    lastSeenAt: device.lastSeenAt,
    hardware: effectiveHardware(device),
    detected: device.hardware,
    overrides: device.overrides,
    paused: Boolean(device.paused),
    rental: device.rental ? String(device.rental) : null,
    edited: Object.values(device.overrides?.toObject?.() || device.overrides || {}).some((value) => value !== null && value !== ''),
    ollama
});


export const listDevices = asyncHandler(async (req, res) => {
    const local = localEnabled() ? await getLocalDevice() : null;
    const devices = [...(local ? [local] : []), ...await ownDevices(req.user.id)];
    const target = currentTarget();

    res.status(200).json({
        success: true,
        devices: [
            ...await Promise.all(devices.map(async (device) => presentDevice(device, await ollamaOf(device)))),
            ...(req.query?.with === 'online' ? [await presentPool(req.user.id)].filter(Boolean) : []),
            ...(req.query?.with === 'online' ? (await Provider.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 })).map(presentOnlineDevice) : [])
        ],
        current: ['companion', 'cloud', 'pool'].includes(target.kind) ? target.id : local?.id ?? null,
        permissions: { manage: canManage(req) }
    });
});

export const getDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)), permissions: { manage: canManage(req) } });
});

export const updateDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }

    const { name, overrides } = req.body;
    if (name) device.name = name;
    if (overrides) {
        for (const key of ['memoryMb', 'gpuName', 'gpuMemoryMb']) {
            if (key in overrides) device.overrides[key] = overrides[key] === '' ? null : overrides[key];
        }
    }
    await device.save();
    logger.info('[Device] Device updated', { deviceId: device.id, userId: req.user.id });

    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});

export const detectDevice = asyncHandler(async (req, res) => {
    const found = await allowedDevice(req, req.params.id);
    if (!found) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    let device = found;
    if (found.kind === 'local') {
        device = await getLocalDevice({ redetect: true });
    } else {
        try {
            found.hardware = await deviceGateway.ask(found.id, 'hardware');
            await found.save();
        } catch (error) {
            return sendOllamaError(res, error);
        }
    }
    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});

export const linkDevice = asyncHandler(async (req, res) => {
    const { hostname, name, hardware } = req.body;
    const key = crypto.randomBytes(32).toString('hex');
    const device = await Device.findOneAndUpdate(
        { service: SERVICE, kind: 'companion', hostname: `${req.user.id}:${hostname}` },
        {
            $set: { keyHash: hashKey(key), registeredBy: req.user.id, lastSeenAt: new Date(), ...(hardware ? { hardware } : {}) },
            $setOnInsert: { name: name || hostname }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    // The computer's own name, when the desktop app sends one, replaces a name that is still only its network name.
    if (name && device.name === hostname && name !== hostname) {
        device.name = name;
        await device.save();
    }
    deviceGateway.disconnect(device.id);
    logger.info('[Device] Device linked', { deviceId: device.id, userId: req.user.id });

    res.status(201).json({ success: true, device: { id: device.id, name: shownName(device) }, key });
});

export const unlinkDevice = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device || device.kind !== 'companion') {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (device.rental) {
        const rental = await Rental.findOne({ _id: device.rental, service: SERVICE });
        if (rental) {
            await beginRentalEnd(rental, 'asked');
            return res.status(200).json({ success: true });
        }
    }
    await endReplies(repliesOn(device.id));
    await Device.deleteOne({ _id: device._id });
    deviceGateway.disconnect(device.id);
    await syncPools(req.user.id);
    getNotificationService().sendToUser(String(req.user.id), { type: 'device:changed', data: { deviceId: device.id, online: false } });
    logger.info('[Device] Device removed', { deviceId: device.id, userId: req.user.id });

    res.status(200).json({ success: true });
});

// Pausing keeps the computer connected but gives it no work, and takes its loaded models out of memory first.
const setPaused = (paused) => asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device || device.kind !== 'companion') {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (paused && !device.paused && deviceGateway.isOnline(device.id)) {
        await deviceScope.run(targetOf(device), async () => {
            const ollama = await getOllama();
            const { models } = await ollama.running();
            await Promise.all(models.map((model) => ollama.unload(model.name)));
        }).catch((error) => logger.warn('[Device] Models could not be unloaded before pausing', { deviceId: device.id, message: String(error?.message || '').slice(0, 200) }));
    }
    device.paused = paused;
    await device.save();
    targetOf(device);
    await syncPools(req.user.id);
    getNotificationService().sendToUser(String(req.user.id), { type: 'device:changed', data: { deviceId: device.id, online: deviceGateway.isOnline(device.id), paused } });
    logger.info(paused ? '[Device] Device paused' : '[Device] Device resumed', { deviceId: device.id, userId: req.user.id });

    res.status(200).json({ success: true, device: presentDevice(device, await ollamaOf(device)) });
});
// Which of a person's computers can pool, and why the others cannot. Each computer has a part: 'lend' lends its memory
// to the main computer, 'main' runs the pooled model, and a person has one main computer at a time. The server only
// says who pools with whom: a lending computer's gate is told the main computer's address and admits nothing else.
const POOL_SETUP = ['none', 'asking', 'downloading', 'ready', 'declined', 'failed', 'unsupported'];
const reaches = new Map();
const poolStateOf = (deviceId) => {
    const state = deviceGateway.poolState(deviceId);
    if (!state || typeof state !== 'object') return null;
    return {
        build: typeof state.build === 'string' ? state.build.slice(0, 20) : null,
        role: ['off', 'lend', 'main'].includes(state.role) ? state.role : 'off',
        setup: POOL_SETUP.includes(state.setup) ? state.setup : 'none',
        progress: Number.isFinite(state.progress) ? Math.max(0, Math.min(1, state.progress)) : null,
        lending: state.lending === true,
        address: typeof state.address === 'string' ? state.address.slice(0, 40) : null,
        port: Number.isInteger(state.port) ? state.port : null,
        allow: Array.isArray(state.allow) ? state.allow.map(String).slice(0, 8) : [],
        running: typeof state.running === 'string' ? state.running.slice(0, 200) : null,
        starting: typeof state.starting === 'string' ? state.starting.slice(0, 200) : null,
        detail: typeof state.detail === 'string' ? state.detail.slice(0, 300) : null
    };
};
const poolComputers = async (userId) => (await ownDevices(userId)).filter((device) => !device.rental).map((device) => ({
    id: device.id,
    name: shownName(device),
    online: isOnline(device),
    paused: Boolean(device.paused),
    publicAddress: deviceGateway.publicAddress(device.id),
    hardware: effectiveHardware(device) ? { ...effectiveHardware(device), network: device.hardware?.network } : device.hardware,
    role: device.poolRole || 'off',
    state: poolStateOf(device.id)
}));
const groupOf = (groups, one, other) => groups.find((group) => group.computers.some((entry) => entry.id === one) && group.computers.some((entry) => entry.id === other)) || null;
const addressIn = (group, id) => group?.computers.find((entry) => entry.id === id)?.address || null;

// What each computer should be doing now. A computer already doing it, or still setting up or waiting for its person
// to agree, is not told again.
const orderFor = (computer, main, groups) => {
    if (computer.role !== 'lend') return { role: computer.role };
    const group = main ? groupOf(groups, computer.id, main.id) : null;
    return { role: 'lend', bind: addressIn(group, computer.id), allow: group ? [addressIn(group, main.id)] : [] };
};
const settledOn = (state, order) => {
    if (!state) return order.role === 'off';
    if (state.role !== order.role) return false;
    if (['asking', 'downloading', 'declined', 'failed', 'unsupported'].includes(state.setup)) return true;
    if (order.role !== 'lend') return true;
    if (order.allow.length === 0) return !state.lending;
    return state.lending && state.address === order.bind && state.allow.join() === order.allow.join();
};
export const syncPools = async (userId) => {
    const computers = await poolComputers(userId);
    const { groups } = poolGroups(computers);
    const main = computers.find((one) => one.role === 'main' && one.online && !one.paused) || null;
    for (const computer of computers) {
        if (!computer.online) continue;
        const order = orderFor(computer, main, groups);
        if (!settledOn(computer.state, order)) deviceGateway.order(computer.id, { type: 'pool', action: 'apply', ...order });
    }
};
const syncPoolsOf = async (deviceId) => {
    try {
        const device = await Device.findOne({ _id: deviceId, service: SERVICE, kind: 'companion' });
        if (device?.registeredBy) await syncPools(device.registeredBy);
    } catch (error) {
        logger.warn('[Pool] Could not update the pool', { deviceId: String(deviceId), error: error.message });
    }
};

// Once a computer lends, its main computer checks that the gate lets it in; the answer is kept in memory only.
const checkReach = async (deviceId) => {
    const lender = await Device.findOne({ _id: deviceId, service: SERVICE, kind: 'companion' });
    const state = poolStateOf(deviceId);
    if (!lender?.registeredBy || !state?.lending || !state.address) return reaches.delete(String(deviceId));
    const main = (await ownDevices(lender.registeredBy)).find((one) => one.poolRole === 'main' && deviceGateway.isOnline(one.id));
    if (!main) return reaches.delete(String(deviceId));
    let answer = null;
    try {
        answer = await deviceGateway.probe(main.id, state.address, state.port);
    } catch {
        answer = null;
    }
    reaches.set(String(deviceId), {
        main: main.id,
        address: state.address,
        reachable: answer ? answer.reachable === true : null,
        detail: answer ? String(answer.detail || '').slice(0, 200) || null : 'The primary computer could not check it: update its desktop app.'
    });
    return undefined;
};

const presentPools = async (userId) => {
    const computers = await poolComputers(userId);
    const { groups, left } = poolGroups(computers);
    const byId = new Map(computers.map((one) => [one.id, one]));
    const main = computers.find((one) => one.role === 'main') || null;
    const part = (id) => {
        const computer = byId.get(id);
        const state = computer?.state || null;
        const reach = reaches.get(id);
        const fresh = reach && state?.lending && reach.address === state.address && reach.main === main?.id ? reach : null;
        const otherBuild = computer?.role === 'lend' && state?.build && main?.state?.build && state.build !== main.state.build;
        return {
            role: computer?.role || 'off',
            setup: state?.setup || null,
            progress: state?.progress ?? null,
            lending: Boolean(state?.lending),
            reachable: fresh ? fresh.reachable : null,
            detail: otherBuild ? 'Its desktop app pools a different way from the primary computer. Update the Mollama desktop app on both.' : fresh?.reachable === false ? fresh.detail : state?.detail || null,
            known: Boolean(state)
        };
    };
    return {
        groups: groups.map((group) => ({ ...group, computers: group.computers.map((one) => ({ ...one, ...part(one.id) })) })),
        left: left.map((one) => ({ ...one, role: byId.get(one.id)?.role || 'off' })),
        main: main?.id || null
    };
};

// A pooled model: the person's main computer runs it with the lending computers' memory. The pool is a record of its
// own, so a chat can choose it like a computer; who is in it is worked out each time from the computers' parts.
// How much a pooled model may read. It is started with this much room, and the chat is told it, so it folds older
// messages and puts away old tool results before it would overflow (llama.cpp refuses a prompt past its context). It
// gets the larger one when every computer says what is free and the pool has the memory the extra room takes.
const POOL_CONTEXT = 16384;
const POOL_CONTEXT_MORE = 32768;
const POOL_PLAN_MS = 60 * 1000;
// What each main computer's pooled model was, or is about to be, started with; and the starts that failed with more.
const poolRooms = new Map();
const poolNarrow = new Set();
const poolRoomOf = (main, model) => (poolRooms.get(String(main))?.model === model ? poolRooms.get(String(main)).ctx : POOL_CONTEXT);
// The memory a model's conversation takes for that many tokens, kept at 8 bits, or null when its facts do not say.
export const conversationMb = (info, tokens) => {
    const of = (name) => Number(info?.[`${info?.['general.architecture']}.${name}`]);
    const heads = of('attention.head_count');
    const each = of('embedding_length') / heads;
    const bytes = of('block_count') * (of('attention.head_count_kv') || heads) * ((of('attention.key_length') || each) + (of('attention.value_length') || each)) * 1.0625;
    return bytes > 0 ? Math.ceil((bytes * tokens) / MB) : null;
};
const planPoolRoom = async (parts, model, shown, client) => {
    const main = String(parts.main.id);
    const held = poolRooms.get(main);
    const own = contextLength(shown) || POOL_CONTEXT;
    if (poolStateOf(main)?.running === model || poolStarts.has(main)) return Math.min(own, poolRoomOf(main, model));
    if (held?.model === model && !held.started && Date.now() - held.at < POOL_PLAN_MS) return Math.min(own, held.ctx);
    const extra = own > POOL_CONTEXT && !poolNarrow.has(`${main} ${model}`) ? conversationMb(shown?.model_info, Math.min(own, POOL_CONTEXT_MORE) - POOL_CONTEXT) : null;
    let ctx = POOL_CONTEXT;
    if (extra) {
        const sizeMb = ((await client.list().catch(() => ({ models: [] }))).models.find((one) => one.name === model)?.size || 0) / MB;
        const now = sizeMb ? await poolNow(parts) : null;
        if (now?.measured && fitPool({ sizeMb: sizeMb + extra / 1.1, parameters: 0 }, now.computers)?.fits) ctx = Math.min(own, POOL_CONTEXT_MORE);
    }
    poolRooms.set(main, { model, ctx, extra: ctx > POOL_CONTEXT ? extra : 0, at: Date.now() });
    return Math.min(own, ctx);
};
// The pool's computers as they are right now, the models a pooled one would replace counted as gone.
const poolNow = async (parts) => {
    const whole = parts.computers.map((one, at) => ({ ...one.hardware, runs: at === 0 }));
    const computers = await Promise.all([parts.main, ...parts.lenders].map(async (one, at) => {
        const loaded = queue.busyIn(one.id) ? [] : (await createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(one.id)).running().catch(() => ({ models: [] }))).models;
        return freeOf(one.id, whole[at], loaded);
    }));
    return { computers, measured: computers.every((one, at) => one !== whole[at]) };
};
// The desktop app ends a pooled model idle this long (its own POOL_IDLE_MS).
const POOL_IDLE_MS = 15 * 60 * 1000;
const poolRecord = (userId) => Device.findOneAndUpdate(
    { service: SERVICE, kind: 'pool', hostname: `${userId}:pool` },
    { $setOnInsert: { name: 'Pool', registeredBy: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
);
// What a computer can give a pooled model, in MB: its graphics memory, or with none, its system memory, less its reserve.
// The main computer and the lending computers it reached, or null when no pool is ready.
const poolParts = async (userId) => {
    const computers = await poolComputers(userId);
    const { groups } = poolGroups(computers);
    const main = computers.find((one) => one.role === 'main' && one.online && !one.paused);
    if (!main) return null;
    const lenders = computers.filter((one) => one.role === 'lend' && one.state?.lending && reaches.get(one.id)?.reachable === true && reaches.get(one.id)?.main === main.id)
        .map((one) => ({ ...one, group: groupOf(groups, one.id, main.id) }))
        .filter((one) => one.group && one.state.build === main.state?.build);
    if (lenders.length === 0) return null;
    const mainHardware = effectiveHardware(await Device.findById(main.id));
    const lenderHardware = await Promise.all(lenders.map(async (one) => effectiveHardware(await Device.findById(one.id))));
    // llama.cpp lists the lending computers before the main computer's own graphics, so the split follows that order.
    const split = [...lenderHardware.map((hardware) => Math.max(1, Math.round(poolShareMb(hardware) / 1024))), ...(mainHardware.gpuMemoryMb > 0 ? [Math.max(1, Math.round(poolShareMb(mainHardware) / 1024))] : [])];
    return {
        main,
        lenders,
        devices: [...lenderHardware, ...(mainHardware.gpuMemoryMb > 0 ? [mainHardware] : [])],
        computers: [{ name: main.name, hardware: mainHardware }, ...lenders.map((one, at) => ({ name: one.name, hardware: lenderHardware[at] }))],
        helpers: lenders.map((one) => `${one.state.address}:${one.state.port}`),
        split,
        name: [main, ...lenders].map((one) => one.name).join(' + '),
        hardware: {
            memoryMb: [mainHardware, ...lenderHardware].reduce((sum, hardware) => sum + (hardware.memoryMb || 0), 0),
            gpuMemoryMb: [mainHardware, ...lenderHardware].reduce((sum, hardware) => sum + (hardware.gpuMemoryMb || 0), 0)
        }
    };
};
// Starts the model on the main computer unless it already runs there the same way. One start per pool at a time.
const poolStarts = new Map();
const startPool = async (parts, model) => {
    const state = poolStateOf(parts.main.id);
    if (state?.running === model) return;
    if (!poolStarts.has(parts.main.id)) {
        // The model's real size, from the main computer's Ollama, decides the split. Lean settings shrink the conversation's
        // working memory so a share near a computer's limit does not crash its helper. Drafting with a small model is not
        // sent: measured on 2026-11-21 between zero-pc and zero m3 it gained nothing (the desktop app still accepts one).
        let installed = [];
        try {
            installed = (await createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(parts.main.id)).list()).models || [];
        } catch {
            installed = [];
        }
        const size = installed.find((one) => one.name === model)?.size || 0;
        // A model the pool cannot hold with this main computer is not started: it would only fail after minutes of loading.
        const sized = { sizeMb: size / (1024 * 1024), parameters: 0 };
        const fitWith = (runs) => fitPool(sized, parts.computers.map((one, at) => ({ ...one.hardware, runs: at === runs })));
        const fit = size ? fitWith(0) : null;
        if (fit && !fit.fits) {
            const better = parts.computers.findIndex((one, at) => at > 0 && fitWith(at).fits);
            const gb = (mb) => Math.round(mb / 1024);
            throw new OllamaError('POOL_FAILED', `${model} needs about ${gb(fit.memoryNeededMb)} GB, and with ${parts.computers[0].name} as the primary computer the pool gives ${gb(fit.memoryMb)} GB. ${better > 0 ? `Make ${parts.computers[better].name} the primary computer, which has system memory to spare, and download the model there.` : 'Pick a smaller model.'}`);
        }
        const plan = poolRooms.get(String(parts.main.id));
        const ctx = poolRoomOf(parts.main.id, model);
        poolRooms.set(String(parts.main.id), { model, ctx, extra: ctx > POOL_CONTEXT ? plan.extra : 0, started: true, at: Date.now() });
        const split = size ? poolSplit(parts.devices, memoryNeededMb({ sizeMb: size / (1024 * 1024) }) + (ctx > POOL_CONTEXT ? plan.extra : 0)) : [];
        const order = { type: 'pool', action: 'run', model, helpers: parts.helpers, split, ctx, lean: true };
        const start = Promise.all([parts.main, ...parts.lenders].map((one) => endLoaded(one.id)))
            .then(() => deviceGateway.query(parts.main.id, order, 35 * 60 * 1000))
            .then((answer) => {
                if (answer?.ready) return;
                // It may be the extra room that did not fit: the next start asks for less.
                if (ctx > POOL_CONTEXT) {
                    poolNarrow.add(`${parts.main.id} ${model}`);
                    poolRooms.delete(String(parts.main.id));
                }
                throw new OllamaError('POOL_FAILED', `${String(answer?.error || '').slice(0, 300)}${ctx > POOL_CONTEXT ? ' Send your message again: it will start with less room.' : ''}`);
            }, (error) => {
                throw error instanceof OllamaError && error.code === 'DEVICE_OFFLINE' ? error : new OllamaError('POOL_FAILED', 'The primary computer did not answer: update its desktop app.');
            })
            .finally(() => poolStarts.delete(parts.main.id));
        poolStarts.set(parts.main.id, start);
    }
    await poolStarts.get(parts.main.id);
};
const poolTarget = async (poolId) => {
    const pool = await Device.findOne({ _id: poolId, service: SERVICE, kind: 'pool' });
    return pool ? poolParts(pool.registeredBy) : null;
};
// Stands where the Ollama client stands: the models and their facts come from the main computer's Ollama, and a chat
// goes to the pooled model, started first when it is not running yet.
const poolClient = async (poolId) => {
    const parts = await poolTarget(poolId);
    if (!parts) return createOllamaClient(DEVICE_HOST, () => Promise.reject(new OllamaError('POOL_NOT_READY')));
    const main = createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(parts.main.id));
    const runner = createCloudClient({ id: 'pool', type: 'openai', base: `${DEVICE_HOST}/v1`, fetch: deviceGateway.fetcher(parts.main.id, 'pool') }, 'pool');
    return {
        ...main,
        show: async (name) => {
            const shown = await main.show(name);
            const own = Object.fromEntries(Object.entries(shown?.model_info || {}).filter(([key]) => !key.endsWith('.context_length')));
            return { ...shown, model_info: { ...own, 'pool.context_length': await planPoolRoom(parts, name, shown, main) } };
        },
        running: async () => ({ models: poolStateOf(parts.main.id)?.running ? [{ name: poolStateOf(parts.main.id).running }] : [] }),
        load: async (model) => startPool(parts, model),
        unload: async () => { deviceGateway.order(parts.main.id, { type: 'pool', action: 'stop' }); },
        chat: async (request, signal) => {
            // Stop ends the wait at once while the model is still starting; the start itself carries on for the next message.
            const stopped = new Promise((resolve, reject) => {
                const quit = () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
                if (signal?.aborted) quit();
                signal?.addEventListener('abort', quit, { once: true });
            });
            stopped.catch(() => {});
            await Promise.race([startPool(parts, request.model), stopped]);
            return runner.chat(request, signal);
        }
    };
};
// The pool as the chat's computer picker shows it, when one is ready.
const presentPool = async (userId) => {
    const parts = await poolParts(userId);
    if (!parts) return null;
    const pool = await poolRecord(userId);
    const ollama = await readOllama(createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(parts.main.id)));
    return {
        id: pool.id, name: `Pool: ${parts.name}`, kind: 'pool', service: SERVICE, online: true, lastSeenAt: new Date(), hardware: parts.hardware, detected: null,
        overrides: {}, paused: false, edited: false, ollama
    };
};

export const listPools = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, ...await presentPools(req.user.id) });
});

// A network check on demand: every connected computer is read again (a laptop may have changed network or cable),
// each one is told its part again, and every lending computer is checked again by the one that runs the model.
export const checkPools = asyncHandler(async (req, res) => {
    const own = (await ownDevices(req.user.id)).filter((device) => deviceGateway.isOnline(device.id));
    await Promise.all(own.map(async (device) => {
        try {
            const hardware = await deviceGateway.ask(device.id, 'hardware');
            if (hardware && typeof hardware === 'object') await Device.updateOne({ _id: device.id, service: SERVICE, kind: 'companion' }, { hardware });
        } catch {
            // A computer that does not answer keeps the details it last gave.
        }
    }));
    await syncPools(req.user.id);
    await Promise.all(own.map((device) => checkReach(device.id).catch(() => undefined)));
    res.status(200).json({ success: true, checkedAt: new Date(), ...await presentPools(req.user.id) });
});

export const setPoolRole = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device || device.kind !== 'companion') {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    const { role } = req.body;
    if (device.rental && role !== 'off') {
        return res.status(400).json({ success: false, code: 'RENTED_NOT_POOLED', message: 'A rented computer cannot be part of a pool.' });
    }
    if (role === 'main') await Device.updateMany({ service: SERVICE, kind: 'companion', registeredBy: req.user.id, poolRole: 'main', _id: { $ne: device._id } }, { poolRole: 'off' });
    device.poolRole = role;
    await device.save();
    await syncPools(req.user.id);
    getNotificationService().sendToUser(String(req.user.id), { type: 'device:changed', data: { deviceId: device.id, online: deviceGateway.isOnline(device.id) } });
    logger.info('[Pool] Pooling part changed', { deviceId: device.id, userId: req.user.id, role });
    res.status(200).json({ success: true, ...await presentPools(req.user.id) });
});

export const pauseDevice = setPaused(true);
export const resumeDevice = setPaused(false);

export const connectDevice = (ws, req) => deviceGateway.handleConnection(ws, async (hello) => {
    if (!mongoose.isValidObjectId(hello.deviceId) || typeof hello.key !== 'string') return null;
    const device = await Device.findOne({ _id: hello.deviceId, service: SERVICE, kind: 'companion' }).select('+keyHash');
    if (!device?.keyHash) return null;
    const given = Buffer.from(hashKey(hello.key));
    const kept = Buffer.from(device.keyHash);
    if (given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) return null;
    device.lastSeenAt = new Date();
    await device.save();
    return device.id;
}, req);

const announceDevice = (online) => async (deviceId, hello, replaced = false) => {
    // A computer that reconnects while still counted as online has not changed, so nobody is told.
    if (replaced) return;
    try {
        const device = await Device.findOne({ _id: deviceId, service: SERVICE });
        if (!device?.registeredBy) return;
        if (!online) await Device.updateOne({ _id: deviceId }, { lastSeenAt: new Date() });
        getNotificationService().sendToUser(String(device.registeredBy), { type: 'device:changed', data: { deviceId: String(deviceId), online } });
    } catch (error) {
        logger.warn('[Device] Could not announce a device change', { deviceId, error: error.message });
    }
};
deviceGateway.on('online', announceDevice(true));
deviceGateway.on('online', (deviceId) => {
    downloads.resumeFor(deviceId).catch((error) => logger.warn('[Downloads] Could not resume downloads for a returning computer', { deviceId: String(deviceId), error: error.message }));
});
// A computer's details are read again whenever it connects: a laptop may have changed network since.
deviceGateway.on('online', async (deviceId, hello, replaced) => {
    if (replaced) return;
    try {
        const hardware = await deviceGateway.ask(deviceId, 'hardware');
        if (hardware && typeof hardware === 'object') await Device.updateOne({ _id: deviceId, service: SERVICE, kind: 'companion' }, { hardware });
    } catch {
        // An app that does not answer keeps the details it last gave.
    }
    await syncPoolsOf(deviceId);
});
deviceGateway.on('offline', announceDevice(false));
// Why each link closed, so a computer that keeps dropping can be explained.
deviceGateway.on('closed', (deviceId, about) => logger.info('[Device] A link closed', { deviceId: String(deviceId), ...about }));
// A computer whose link drops usually returns in seconds and keeps its part in a pool for two minutes (its desktop app
// does the same), so the others are only told it has gone if it is still away then.
const POOL_GRACE_MS = process.env.NODE_ENV === 'test' ? 0 : 2 * 60 * 1000;
deviceGateway.on('offline', (deviceId) => {
    reaches.delete(String(deviceId));
    if (POOL_GRACE_MS === 0) return syncPoolsOf(deviceId);
    setTimeout(() => { if (!deviceGateway.isOnline(deviceId)) syncPoolsOf(deviceId); }, POOL_GRACE_MS).unref();
    return undefined;
});
// A computer whose network changed (a cable in or out, another Wi-Fi) says so, and its pools are worked out again.
deviceGateway.on('network', async (deviceId, network) => {
    const clean = { addresses: network.addresses.filter((entry) => entry && typeof entry.address === 'string').map((entry) => ({
        address: String(entry.address).slice(0, 45), prefix: Number(entry.prefix) || 24, interface: String(entry.interface || '').slice(0, 60),
        wired: Boolean(entry.wired), ...(['public', 'private', 'domain'].includes(entry.category) ? { category: entry.category } : {})
    })) };
    await Device.updateOne({ _id: deviceId, service: SERVICE, kind: 'companion' }, { $set: { 'hardware.network': clean } }).catch(() => {});
    await syncPoolsOf(deviceId);
    announceDevice(true)(deviceId);
});
// Whatever a computer says about its part in a pool, and what its main computer found, is shown to its person at once.
deviceGateway.on('pool', async (deviceId, state) => {
    // An app that says another part than the one chosen has started again, perhaps before its old link was seen to
    // close, and has not been told: it is told now.
    const saved = await Device.findOne({ _id: deviceId, service: SERVICE, kind: 'companion' }).select('poolRole').catch(() => null);
    if (saved && state?.role && state.role !== (saved.poolRole || 'off')) await syncPoolsOf(deviceId);
    await checkReach(deviceId).catch((error) => logger.warn('[Pool] Could not check a lending computer', { deviceId: String(deviceId), error: error.message }));
    announceDevice(true)(deviceId);
});
// Signing out of the desktop app takes that computer off the account.
deviceGateway.on('goodbye', async (deviceId) => {
    try {
        await endReplies(repliesOn(deviceId));
        const device = await Device.findOneAndDelete({ _id: deviceId, service: SERVICE, kind: 'companion' });
        if (device?.registeredBy) getNotificationService().sendToUser(String(device.registeredBy), { type: 'device:changed', data: { deviceId: String(deviceId), online: false } });
    } catch (error) {
        logger.warn('[Device] Could not remove a device that signed out', { deviceId, error: error.message });
    }
});

export const readSettings = asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.status(200).json({ success: true, settings: presentSettings(settings), permissions: { manage: canManage(req) } });
});

export const updateSettings = asyncHandler(async (req, res) => {
    const settings = await getSettings();
    for (const key of ['ollamaBaseUrl', 'defaultModel']) {
        if (key in req.body) settings[key] = req.body[key] || null;
    }
    for (const key of ['maxConcurrentGenerations', 'keepAliveMinutes']) {
        if (key in req.body) settings[key] = req.body[key];
    }
    settings.updatedBy = req.user.id;
    await settings.save();
    logger.info('[Settings] Settings updated', { userId: req.user.id, fields: Object.keys(req.body) });

    res.status(200).json({ success: true, settings: presentSettings(settings) });
});

export const testConnection = asyncHandler(async (req, res) => {
    const status = await createOllamaClient(req.body.ollamaBaseUrl).status();
    if (!status.available) {
        return sendOllamaError(res, new OllamaError('OLLAMA_DOWN'));
    }
    res.status(200).json({ success: true, ollama: status });
});

export const getSetupStatus = asyncHandler(async (req, res) => {
    const target = currentTarget();
    // An online service is not a computer: it counts as ready, and its own state is shown on the Models page.
    if (target.kind === 'cloud') {
        return res.status(200).json({ success: true, ready: target.id, account: { available: true }, ollama: { available: true, version: null, modelCount: 0 }, device: null, steps: { ollama: true, device: true, model: true } });
    }
    const device = await getCurrentDevice();
    const reachable = Boolean(device) && isOnline(device);
    const ollama = reachable ? await readOllama(await getOllama()) : UNREACHED;
    const problem = !device ? 'NO_DEVICE' : device.paused ? 'DEVICE_PAUSED' : !reachable ? 'DEVICE_OFFLINE' : 'OLLAMA_DOWN';

    // Any of the person's computers will do, so the others are asked before anything is called a problem.
    let ready = ollama.available ? device.id : null;
    let count = device ? 1 : 0;
    if (!ready) {
        const local = localEnabled() ? await getLocalDevice() : null;
        const others = [...(local ? [local] : []), ...await ownDevices(req.user.id)].filter((other) => other.id !== device?.id);
        count += others.length;
        const answers = await Promise.all(others.map((other) => Promise.resolve(ollamaOf(other)).catch(() => UNREACHED)));
        ready = others[answers.findIndex((answer) => answer.available)]?.id || null;
    }

    res.status(200).json({
        success: true,
        ready,
        account: ready ? { available: true } : { available: false, ...new OllamaError(count > 1 ? 'NOTHING_READY' : problem).toJSON() },
        ollama: ollama.available
            ? ollama
            : { ...ollama, ...new OllamaError(problem).toJSON() },
        device: device ? { id: device.id, name: shownName(device), kind: target.kind, detected: Boolean(device.hardware) } : null,
        steps: {
            ollama: ollama.available,
            device: Boolean(device?.hardware),
            model: ollama.modelCount > 0
        }
    });
});

const contextLength = (shown) => {
    const info = shown?.model_info || {};
    const key = Object.keys(info).find((name) => name.endsWith('.context_length'));
    return key ? info[key] : null;
};

// A model's details only change when the model itself does, so they are asked for once per computer and version.
const shownModels = new Map();
const showOnce = async (ollama, model) => {
    const key = `${currentLane()}|${model.name}|${model.digest || model.modified_at || ''}`;
    if (shownModels.has(key)) return shownModels.get(key);
    const shown = await ollama.show(model.name);
    if (shownModels.size >= 500) shownModels.delete(shownModels.keys().next().value);
    shownModels.set(key, shown);
    return shown;
};

const describeInstalled = async (ollama, model, personalByName) => {
    let shown = null;
    try {
        shown = await showOnce(ollama, model);
    } catch {
        shown = null;
    }
    const known = knownModels.get(model.name);
    const friendly = friendlyName(model.name);
    const personal = personalByName.get(model.name) || personalByName.get(model.name.replace(/:latest$/, ''));

    return {
        name: model.name,
        displayName: personal?.displayName || known?.name || friendly,
        description: known?.description || null,
        sizeBytes: model.size || 0,
        family: model.details?.family || null,
        parameterSize: model.details?.parameter_size || null,
        quantization: model.details?.quantization_level || null,
        contextLength: contextLength(shown),
        capabilities: shown?.capabilities || known?.capabilities || [],
        modifiedAt: model.modified_at || null,
        personal: Boolean(personal),
        basedOn: personal?.from || null,
        system: personal ? personal.system || '' : null,
        parameters: personal ? personal.parameters || {} : null
    };
};

// The models of an online provider, in the same shape as the models on a computer so the picker needs no second path.
const listOnlineModels = async (req, res) => {
    const provider = await Provider.findOne({ _id: currentTarget().id, service: SERVICE });
    const models = (provider?.models || []).map((model) => ({
        name: model.name, displayName: model.title || knownModels.get(model.name.replace(/[-:]cloud$/i, ''))?.name || cloudTitle(model.name), description: '', sizeBytes: 0, family: null, parameterSize: null, quantization: null,
        contextLength: model.contextLength || null, capabilities: ['completion', 'tools', ...(model.vision ? ['vision'] : [])], modifiedAt: null, personal: false,
        fit: { verdict: 'cloud', label: 'Online', fits: true }, ready: true, canChat: true, usedBy: []
    }));
    res.status(200).json({ success: true, device: currentTarget().id || null, ollamaAvailable: provider?.health === 'healthy', ollamaVersion: null, webSearch: false, models, disk: { usedByModelsMb: 0, freeMb: 0, totalMb: 0 }, online: true, permissions: { manage: false } });
};

export const listModels = asyncHandler(async (req, res) => {
    if (currentTarget().kind === 'cloud') return listOnlineModels(req, res);
    const ollama = await getOllama();
    const status = await ollama.status();
    const disk = await diskNow();

    if (!status.available) {
        return res.status(200).json({
            success: true,
            device: currentTarget().id || null,
            ollamaAvailable: false,
            ollamaVersion: null,
            webSearch: webSearchReady(),
            models: [],
            disk: { usedByModelsMb: 0, freeMb: disk.diskFreeMb, totalMb: disk.diskTotalMb },
            permissions: { manage: canManage(req) }
        });
    }

    const { models: installed } = await ollama.list();
    const personal = await PersonalModel.find({ service: SERVICE });
    const personalByName = new Map(personal.map((entry) => [entry.name, entry]));

    const models = await Promise.all(installed.map((model) => describeInstalled(ollama, model, personalByName)));
    const hardware = effectiveHardware(await getCurrentDevice());
    let loaded = new Set();
    try {
        loaded = new Set((await ollama.running()).models.map((model) => model.name));
    } catch {
        loaded = new Set();
    }
    const pooledHere = currentTarget().id ? await poolFor(req.user.id, currentTarget().id) : null;
    for (const model of models) {
        const sized = knownModels.get(model.name) || { sizeMb: model.sizeBytes / MB, parameters: parseFloat(model.parameterSize) || 0 };
        const fit = fitModel(sized, hardware);
        model.fit = { verdict: fit.verdict, label: fit.label, fits: fit.fits, memoryNeededMb: fit.memoryNeededMb, place: fit.place };
        const together = pooledHere ? fitPool(sized, pooledHere.hardware) : null;
        if (together?.fits) model.pooled = { names: pooledHere.names, place: together.place };
        model.ready = loaded.has(model.name);
        model.canChat = !model.capabilities.includes('embedding') || model.capabilities.includes('completion');
        model.usedBy = personal.filter((entry) => entry.from === model.name).map((entry) => entry.displayName);
    }
    models.sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.status(200).json({
        success: true,
        device: currentTarget().id || null,
        ollamaAvailable: true,
        ollamaVersion: status.version,
        webSearch: webSearchReady(),
        models,
        disk: {
            usedByModelsMb: Math.round(models.reduce((sum, model) => sum + model.sizeBytes, 0) / MB),
            freeMb: disk.diskFreeMb,
            totalMb: disk.diskTotalMb
        },
        permissions: { manage: canManage(req) }
    });
});

export const listRunning = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        const { models } = await ollama.running();
        res.status(200).json({
            success: true,
            models: models.map((model) => {
                const size = model.size || 0;
                const onGpu = model.size_vram || 0;
                const gpuPercent = size > 0 ? Math.min(100, Math.round((onGpu / size) * 100)) : 0;
                return {
                    name: model.name,
                    displayName: knownModels.get(model.name)?.name || friendlyName(model.name),
                    sizeBytes: size,
                    gpuBytes: onGpu,
                    gpuPercent,
                    healthy: gpuPercent >= 100,
                    expiresAt: model.expires_at || null
                };
            }),
            permissions: { manage: canManage(req) }
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const showModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        const shown = await ollama.show(req.body.name);
        res.status(200).json({
            success: true,
            model: {
                name: req.body.name,
                definition: shown.modelfile || '',
                parameters: shown.parameters || '',
                template: shown.template || '',
                system: shown.system || '',
                capabilities: shown.capabilities || [],
                contextLength: contextLength(shown),
                details: shown.details || {}
            }
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const deleteModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        await endReplies(repliesOn(currentTarget()?.id, req.body.name), { wait: 3000 });
        await ollama.remove(req.body.name);
    } catch (error) {
        return sendOllamaError(res, error);
    }
    await PersonalModel.deleteOne({ service: SERVICE, name: req.body.name.replace(/:latest$/, '') });
    logger.info('[Models] Model deleted', { model: req.body.name, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Model removed from this device.' });
});

export const unloadModel = asyncHandler(async (req, res) => {
    const ollama = await getOllama();
    try {
        await ollama.unload(req.body.name);
    } catch (error) {
        return sendOllamaError(res, error);
    }
    logger.info('[Models] Model unloaded', { model: req.body.name, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Model removed from memory.' });
});

export const createModel = asyncHandler(async (req, res) => {
    const { name, displayName, from, system = '', template = '', parameters = {} } = req.body;
    const ollama = await getOllama();

    try {
        const { models: installed } = await ollama.list();
        const names = new Set(installed.flatMap((model) => [model.name, model.name.replace(/:latest$/, '')]));
        if (names.has(name)) {
            return res.status(409).json({ success: false, message: 'A model with this name already exists. Choose another name.' });
        }
        if (!names.has(from)) {
            return sendOllamaError(res, new OllamaError('MODEL_MISSING'));
        }

        const request = { model: name, from, stream: false };
        if (system) request.system = system;
        if (template) request.template = template;
        if (Object.keys(parameters).length > 0) request.parameters = parameters;
        await ollama.create(request);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    const record = await PersonalModel.findOneAndUpdate(
        { service: SERVICE, name },
        { displayName, from, system, parameters, createdBy: req.user.id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    logger.info('[Models] Personal model created', { model: name, from, userId: req.user.id });
    res.status(201).json({ success: true, model: { name: record.name, displayName: record.displayName, basedOn: record.from } });
});

export const updateModel = asyncHandler(async (req, res) => {
    const name = req.body.name.replace(/:latest$/, '');
    const record = await PersonalModel.findOne({ service: SERVICE, name });
    if (!record) return res.status(404).json({ success: false, message: 'This is not one of your own models.' });
    const displayName = req.body.displayName ?? record.displayName;
    const from = req.body.from ?? record.from;
    const system = req.body.system ?? record.system;
    const parameters = req.body.parameters ?? record.parameters ?? {};

    try {
        const ollama = await getOllama();
        const { models: installed } = await ollama.list();
        const names = new Set(installed.flatMap((model) => [model.name, model.name.replace(/:latest$/, '')]));
        if (!names.has(from) || from.replace(/:latest$/, '') === name) return sendOllamaError(res, new OllamaError('MODEL_MISSING'));
        const request = { model: name, from, stream: false };
        if (system) request.system = system;
        if (Object.keys(parameters).length > 0) request.parameters = parameters;
        await ollama.create(request);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    Object.assign(record, { displayName, from, system, parameters });
    record.markModified('parameters');
    await record.save();
    logger.info('[Models] Personal model updated', { model: name, from, userId: req.user.id });
    res.status(200).json({ success: true, model: { name: record.name, displayName, basedOn: from, system, parameters } });
});

// One model looked up in the library by its Ollama name, with its exact size, whether or not the list was opened first.
const findModel = async (tag) => {
    if (knownModels.has(tag)) return knownModels.get(tag);
    try {
        const base = String(tag).split(':')[0];
        const model = (await libraryModels()).find((entry) => entry.name === base);
        if (!model) return null;
        await loadLibrarySizes([base]);
        const found = libraryEntries([model]).find((entry) => entry.tag === tag && !entry.cloudOnly) || null;
        if (found) knownModels.set(tag, found);
        return found;
    } catch {
        return null;
    }
};

export const startDownload = asyncHandler(async (req, res) => {
    const known = await findModel(req.body.name);
    try {
        if (known) {
            const current = await getCurrentDevice();
            const hardware = effectiveHardware(current);
            const fit = fitModel(known, hardware);
            // Too large for this computer alone is still fine when it fits the pool this computer runs.
            const pooled = !fit.fits && current ? await poolFor(req.user.id, current.id) : null;
            const fitsPool = Boolean(pooled?.here && fitPool(known, pooled.hardware)?.fits);
            if (!fit.fits && !fitsPool) {
                const error = new OllamaError('MODEL_TOO_LARGE');
                error.detail = `${known.name} needs about ${Math.ceil(fit.memoryNeededMb / 1024)} GB of memory. This device has ${Math.floor((hardware.gpuMemoryMb || 0) / 1024)} GB of graphics memory and ${Math.floor((hardware.memoryMb || 0) / 1024)} GB of system memory.`;
                return res.status(error.status).json({ success: false, ...error.toJSON(), message: error.detail });
            }
        }
        const job = await downloads.enqueue({
            model: req.body.name,
            userId: req.user.id,
            sizeHintMb: known?.sizeMb || (await librarySizes(String(req.body.name).split(':')[0])).get(String(req.body.name).split(':')[1] || 'latest') || null
        });
        res.status(202).json({ success: true, download: job });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const listDownloads = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, downloads: await downloads.list(), permissions: { manage: canManage(req) } });
});

export const changeDownload = asyncHandler(async (req, res) => {
    const job = await downloads.stop(req.body.id, req.body.action);
    if (!job) return res.status(404).json({ success: false, message: 'Download not found' });
    res.status(200).json({ success: true, download: job });
});

export const streamDownloads = asyncHandler(async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', await downloads.list());

    const watched = currentTarget().id;
    const onProgress = (job) => { if (job.device === watched) send('progress', job); };
    downloads.on('progress', onProgress);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        downloads.off('progress', onProgress);
    });
});

const installedNames = async () => {
    try {
        const ollama = await getOllama();
        const { models } = await ollama.list();
        return new Set(models.map((model) => model.name));
    } catch {
        return new Set();
    }
};

export const getPublicCatalogue = asyncHandler(async (req, res) => {
    const { memoryMb, gpuMemoryMb } = req.query;
    const hasSpecs = memoryMb !== undefined;
    const hardware = { memoryMb: Number(memoryMb) || 0, gpuMemoryMb: Number(gpuMemoryMb) || 0, gpuShared: req.query.shared === true || req.query.shared === 'true' };
    let live;
    try {
        live = await liveCatalogue(req.query, hasSpecs ? hardware : null);
    } catch (error) {
        return sendOllamaError(res, error);
    }

    res.status(200).json({
        success: true,
        source: 'ollama.com',
        query: live.query,
        near: live.near,
        page: live.page,
        size: live.size,
        paged: live.paged,
        more: live.more,
        total: live.total,
        library: live.library,
        fitting: live.fitting,
        hardware: hasSpecs ? hardware : null,
        reserved: { gpuMemoryMb: GPU_HEADROOM_MB, memoryMb: RAM_RESERVE_MB },
        notes: hasSpecs ? fitNotes(live.local, hardware) : [],
        models: live.entries.map((entry) => {
            if (!hasSpecs || entry.fit?.fits !== false || entry.cloudOnly) return entry;
            const copies = [2, 3].find((count) => fitPool(entry, Array(count).fill(hardware))?.fits);
            return copies ? { ...entry, pool: { copies } } : entry;
        })
    });
});

// The computers a person could pool with this one: those sharing its network (or, when it shares none, the first group).
const poolFor = async (userId, deviceId) => {
    try {
        const computers = await poolComputers(userId);
        const { groups } = poolGroups(computers);
        // Only a pool this computer belongs to: one it is grouped in now, or one it has a part in while that pool is off.
        const group = groups.find((one) => one.computers.some((entry) => entry.id === String(deviceId)));
        if (!group) {
            const setUp = computers.filter((entry) => entry.role !== 'off');
            if (setUp.length < 2 || !setUp.some((entry) => entry.id === String(deviceId))) return null;
            const left = poolGroups(computers).left.filter((one) => setUp.some((entry) => entry.id === one.id));
            const hardware = await Promise.all(setUp.map(async (entry) => ({ ...effectiveHardware(await Device.findById(entry.id)), runs: entry.role === 'main' })));
            const main = setUp.find((entry) => entry.role === 'main') || null;
            return {
                names: setUp.map((entry) => entry.name).join(' + '),
                hardware,
                main: main?.name || null,
                here: main ? main.id === String(deviceId) : setUp.some((entry) => entry.id === String(deviceId)),
                off: left.map((one) => `${one.name}: ${one.message}`).join(' ') || 'Your pooling computers cannot reach each other right now.'
            };
        }
        // A pooled model runs from the file on the main computer, so that is where it is downloaded.
        const main = computers.find((entry) => entry.role === 'main' && group.computers.some((one) => one.id === entry.id)) || null;
        const hardware = await Promise.all(group.computers.map(async (entry) => ({ ...effectiveHardware(await Device.findById(entry.id)), runs: entry.id === main?.id })));
        return { names: group.computers.map((entry) => entry.name).join(' + '), hardware, main: main?.name || null, here: main ? main.id === String(deviceId) : group.computers.some((one) => one.id === String(deviceId)) };
    } catch {
        return null;
    }
};

// What a computer adds to each model of the list: whether it is there already, fits its disk and fits its pool.
const onDevice = async (req, device, entries) => {
    const installed = await installedNames();
    const disk = await diskNow();
    const pooled = await poolFor(req.user.id, device.id);
    return {
        freeDiskMb: disk.diskFreeMb,
        models: entries.map((entry) => ({
            ...entry,
            ...(pooled && !entry.cloudOnly && fitPool(entry, pooled.hardware)?.fits ? { pooled: { names: pooled.names, place: fitPool(entry, pooled.hardware).place } } : {}),
            ...(pooled && entry.fit?.fits === false && fitPool(entry, pooled.hardware)?.fits ? { pool: { names: pooled.names, memoryMb: fitPool(entry, pooled.hardware).memoryMb, main: pooled.main, here: pooled.here, ...(pooled.off ? { off: pooled.off } : {}) } } : {}),
            installed: installed.has(entry.tag),
            fitsDisk: disk.diskFreeMb === null ? true : entry.sizeMb <= disk.diskFreeMb
        }))
    };
};

// The few models recommended for a computer, chosen from the whole library: no search or filter changes them.
export const getDeviceRecommended = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    deviceScope.enterWith(targetOf(device));
    let live;
    try {
        live = await liveCatalogue({ size: 4 }, effectiveHardware(device));
    } catch (error) {
        return sendOllamaError(res, error);
    }
    const { models } = await onDevice(req, device, live.entries.filter((entry) => entry.pick));
    res.status(200).json({ success: true, models });
});

export const getDeviceCatalogue = asyncHandler(async (req, res) => {
    const device = await allowedDevice(req, req.params.id);
    if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    deviceScope.enterWith(targetOf(device));
    const hardware = effectiveHardware(device);
    let live;
    try {
        live = await liveCatalogue(req.query, hardware, { picks: false });
    } catch (error) {
        return sendOllamaError(res, error);
    }
    const { freeDiskMb, models } = await onDevice(req, device, live.entries);

    res.status(200).json({
        success: true,
        source: 'ollama.com',
        query: live.query,
        near: live.near,
        page: live.page,
        size: live.size,
        paged: live.paged,
        more: live.more,
        total: live.total,
        library: live.library,
        fitting: live.fitting,
        hardware,
        freeDiskMb,
        models,
        permissions: { manage: canManage(req) }
    });
});

// A reply that opens a skill, reads four of its files, builds and then mends what it built needs eight on its own.
// A reply has no limit on how many tools it uses or how long it runs: only Stop ends it early. A model that runs out
// of room is asked to go on from where it stopped.
const CARRY_ON = 'You ran out of room in the middle of your reply. Go on from exactly where you stopped, without repeating anything you already wrote.';
const SEARCH_CONTEXT = 16384;
const SEARCH_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web. Returns the title, address and text of the best matching pages. The user turned web search on for this chat: use it for facts, figures, sources and pictures in place of recalling them, and search again when the first results fall short.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Read one web page. Returns its text and the addresses of the links on it.',
            parameters: { type: 'object', properties: { url: { type: 'string', description: 'The https address of the page' } }, required: ['url'] }
        }
    }
];

export const webSearchReady = () => searchReady();

const toolInput = (name, raw) => {
    let args = raw;
    if (typeof raw === 'string') {
        try {
            args = JSON.parse(raw);
        } catch {
            args = {};
        }
    }
    return String((name === 'web_fetch' ? args?.url : args?.query) ?? '').trim().slice(0, 500);
};

const clip = (text, limit) => String(text ?? '').slice(0, limit);

// Some models write their calls as text instead of making them, or in marks of their own family that the program
// running them did not read. A call is read from the end of a reply in each of the common forms, only for a function
// the model was offered, and only with the input that function needs, so words about a function are never taken for one.
const CALL_MARKS = /<\/?(?:tool_calls?|function_calls?|tools?|function)>|```[\w-]*|\[\/?TOOL_CALLS\]|<\|[\w/]+\|>|<｜[^｜>]{1,40}｜>|[[\],;\s]/gi;
// The JSON value that starts at a place, and where it ends.
const jsonAt = (text, from) => {
    let start = from;
    while (/\s/.test(text[start] || '')) start += 1;
    if (!'{['.includes(text[start] || ' ')) return null;
    let depth = 0;
    let quoted = false;
    for (let at = start; at < text.length; at += 1) {
        const char = text[at];
        if (quoted) {
            if (char === '\\') at += 1;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if ('{['.includes(char)) depth += 1;
        else if ('}]'.includes(char) && --depth === 0) {
            try {
                return { value: JSON.parse(text.slice(start, at + 1)), start, end: at + 1 };
            } catch {
                return { value: undefined, start, end: at + 1 };
            }
        }
    }
    return null;
};
const pythonValue = (text) => {
    const raw = text.trim();
    if (/^(?:True|False|None)$/.test(raw)) return { True: true, False: false, None: null }[raw];
    const quoted = raw.match(/^("""|''')([\s\S]*)\1$/) || raw.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) return quoted[1].length === 3 ? quoted[2] : quoted[2].replace(/\\(n|t|r|["'\\])/g, (whole, one) => ({ n: '\n', t: '\t', r: '\r' }[one] ?? one));
    try {
        return JSON.parse(raw.replace(/'/g, '"'));
    } catch {
        return raw;
    }
};
export const readTextCalls = (text, tools) => {
    const source = String(text ?? '');
    const known = new Map((tools || []).map((tool) => [tool.function.name, tool.function]));
    const found = [];
    const add = (start, end, name, given, marked) => {
        const one = known.get(String(name ?? '').trim());
        let args = given;
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                return;
            }
        }
        if (!one || !args || typeof args !== 'object' || Array.isArray(args)) return;
        if ((one.parameters?.required || []).some((need) => args[need] === undefined)) return;
        found.push({ start, end, marked, call: { function: { name: one.name, arguments: args } } });
    };
    const typed = (name, key, raw) => {
        const type = known.get(name)?.parameters?.properties?.[key]?.type;
        if (!type || type === 'string') return raw;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    };
    const inner = (raw) => raw.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
    // Qwen Coder and others: <function=name><parameter=key>value</parameter></function>
    for (const one of source.matchAll(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g)) add(one.index, one.index + one[0].length, one[1], Object.fromEntries([...one[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)].map(([, key, raw]) => [key, typed(one[1], key, inner(raw))])), true);
    // GLM: <tool_call>name <arg_key>key</arg_key><arg_value>value</arg_value></tool_call>
    for (const one of source.matchAll(/<tool_call>\s*([\w.-]+)\s*((?:<arg_key>[\s\S]*?<\/arg_value>\s*)+)<\/tool_call>/g)) add(one.index, one.index + one[0].length, one[1], Object.fromEntries([...one[2].matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)].map(([, key, raw]) => [key.trim(), typed(one[1], key.trim(), inner(raw))])), true);
    // DeepSeek: <｜tool▁call▁begin｜>function<｜tool▁sep｜>name ```json {...} ``` and the newer name<｜tool▁sep｜>{...}
    for (const one of source.matchAll(/<｜tool▁call▁begin｜>(?:function)?(?:<｜tool▁sep｜>)?\s*([\w.-]+)\s*(?:<｜tool▁sep｜>)?\s*(?:```json)?\s*/g)) {
        const read = jsonAt(source, one.index + one[0].length);
        if (read) add(one.index, read.end, one[1], read.value, true);
    }
    // Mistral: [TOOL_CALLS]name[ARGS]{...}
    for (const one of source.matchAll(/\[TOOL_CALLS\]\s*([\w.-]+)(?:\[CALL_ID\]\w+)?\[ARGS\]/g)) {
        const read = jsonAt(source, one.index + one[0].length);
        if (read) add(one.index, read.end, one[1], read.value, true);
    }
    // JSON, alone or between any family's marks: {"name": ..., "arguments": {...}} and its variants.
    for (let at = 0; at < source.length; at += 1) {
        if (source[at] !== '{') continue;
        const read = jsonAt(source, at);
        if (!read) break;
        const value = read.value;
        const one = value && typeof value === 'object' ? (value.function && typeof value.function === 'object' ? value.function : value) : null;
        const name = one && (one.name ?? one.tool ?? one.tool_name ?? one.function_name ?? (typeof one.function === 'string' ? one.function : undefined));
        if (one && typeof name === 'string') {
            const before = source.slice(Math.max(0, read.start - 40), read.start);
            add(read.start, read.end, name, one.arguments ?? one.parameters ?? one.args ?? one.input ?? one.tool_input, /<tool_calls?>\s*\[?\s*$|\[TOOL_CALLS\]\s*\[?\s*$|<\|(?:python_tag|tool_call)\|>\s*\[?\s*$/i.test(before));
        }
        at = read.end - 1;
    }
    // Python: name(key="value"), as Llama 4 and Gemma write it, alone on the last lines.
    const tail = source.match(/(?:^|\n)\s*(?:```(?:tool_code|python)?\s*\n)?\s*\[?\s*([A-Za-z_]\w*)\(([\s\S]*)\)\s*\]?\s*(?:```)?\s*$/);
    if (tail && known.has(tail[1]) && !found.length) {
        const args = Object.fromEntries([...tail[2].matchAll(/(\w+)\s*=\s*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|\{[^}]*\}|[^,]+)(?:,|$)/g)].map(([, key, raw]) => [key, pythonValue(raw)]));
        add(tail.index, source.length, tail[1], args, false);
    }
    // The last of them decide: calls next to each other at the end, or one in marks with the model's own guess at what
    // came back written after it, which goes.
    const ordered = found.sort((x, y) => x.start - y.start || y.end - x.end).filter((one, at, all) => !all.some((other, place) => place !== at && other.start <= one.start && other.end >= one.end && (other.start < one.start || other.end > one.end || place < at)));
    const bare = (from, to) => source.slice(from, to).replace(CALL_MARKS, '') === '';
    if (ordered.length === 0) return { calls: [], text: source };
    let first;
    let last;
    if (bare(ordered.at(-1).end, source.length)) {
        last = ordered.length - 1;
        first = last;
        while (first > 0 && bare(ordered[first - 1].end, ordered[first].start)) first -= 1;
    } else {
        first = ordered.findIndex((one) => one.marked);
        if (first < 0) return { calls: [], text: source };
        last = first;
        while (last + 1 < ordered.length && bare(ordered[last].end, ordered[last + 1].start)) last += 1;
    }
    const before = source.slice(0, ordered[first].start).replace(/(?:\s|\[|<\/?(?:tool_calls?|function_calls?|tools?)>|```[\w-]*|\[TOOL_CALLS\]|<\|[\w/]+\|>|<｜[^｜>]{1,40}｜>)+$/i, '');
    return { calls: ordered.slice(first, last + 1).map((one) => one.call), text: before };
};
// The same, for the two search functions alone.
export const writtenToolCalls = (text) => readTextCalls(text, SEARCH_TOOLS);

// A model sometimes gets a function's name slightly wrong: open_skill_skill, openSkill, websearch.
const nearestFunction = (name, names) => {
    const plain = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
    const asked = plain(name);
    if (!asked) return null;
    return names.find((one) => plain(one) === asked)
        || [...names].sort((a, b) => b.length - a.length).find((one) => asked.startsWith(plain(one)))
        || names.find((one) => closeTo(plain(one), asked, 2))
        || null;
};
const runSearchTool = async (name, input) => {
    const text = (content) => ({ content, failed: null });
    try {
        if (!input) return text('The tool was called with nothing to look up.');
        if (name === 'web_search') {
            const results = (await searchWeb(input)).map((result) => ({ title: clip(result.title, 200), url: result.url, content: clip(result.content, 1500) }));
            return text(results.length > 0 ? JSON.stringify(results) : 'The search found nothing.');
        }
        if (name === 'web_fetch') {
            if (!/^https:\/\//i.test(input)) return text('web_fetch needs a full address that starts with https://');
            const page = await readPage(input);
            return text(JSON.stringify({ title: clip(page?.title, 200), content: clip(page?.content, 8000), links: (page?.links || []).slice(0, 80) }));
        }
        return text(`There is no tool called ${name}.`);
    } catch (error) {
        const failed = error?.code === 'SEARCH_REFUSED' ? 'refused' : error?.code === 'SEARCH_LIMITED' ? 'limited' : error?.code === 'REMOTE_BLOCKED' ? 'blocked' : 'unreachable';
        const detail = error?.detail ? ` (${String(error.detail).slice(0, 200)})` : '';
        logger.warn('[Chat] Web tool failed', { tool: name, code: error?.code || null, detail });
        return { content: `Error: ${String(error?.message || 'the request failed').slice(0, 300)}${detail}`, failed };
    }
};

const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_ATTACHMENT_CHARS = 2000000;
// What an image costs a model that can see, roughly: most count an image as several hundred to about a thousand tokens.
const IMAGE_TOKENS = 1000;
const AUTO_CONTEXT_LIMIT = 32768;
const CONTEXT_STEPS = [8192, 16384, AUTO_CONTEXT_LIMIT];
const REPLY_RESERVE = 1024;
const PROGRAM_ROOM = 8192;
// A model with less room than this is offered a skill's own functions and files only once it has opened that skill.
// It cannot use them before it has read the skill, and offered ahead they take over a third of a 16k room.
const LIGHT_ROOM = 32768;
// How long a reply waits for a computer whose link dropped, and how many times.
const RETURN_MS = process.env.NODE_ENV === 'test' ? 1500 : 2 * 60 * 1000;
const MAX_DROPS = 10;
const DRAFT_MS = 8000;
// A model that thinks before it answers spends room on the thinking too, often several thousand tokens of it.
const THINK_RESERVE = 6144;
const CONTEXT_WARN_PERCENT = 75;

export const queue = new GenerationQueue();
const busyChats = new Set();
const liveReplies = new Map();
const queuedTurns = new Map();
// The one way a reply is ended before it finishes. Stop, a chat being deleted, its computer or its model being
// removed, and the server closing all come here, so none of them can leave a model working for nobody. With `wait`
// it also gives the reply that long to save what it had written.
const endReplies = async (chatIds, { restarting = false, wait = 0, code = null, detail = null } = {}) => {
    const ids = [...chatIds].map(String);
    let ended = 0;
    for (const id of ids) {
        queuedTurns.delete(id);
        const live = liveReplies.get(id);
        if (!live) continue;
        if (restarting) live.restarting = true;
        if (code) live.ended = { code, detail };
        live.stopped = true;
        live.stop?.();
        ended += 1;
    }
    for (const until = Date.now() + wait; Date.now() < until && ids.some((id) => busyChats.has(id));) await new Promise((resolve) => setTimeout(resolve, 50));
    return ended;
};
// The chats whose reply is being written on one computer, or by one model on it.
const repliesOn = (targetId, model = null) => [...liveReplies].filter(([, live]) => String(live.target) === String(targetId) && (!model || live.model === model)).map(([id]) => id);
const MAX_QUEUED_TURNS = 5;

const applyQueueSettings = async () => {
    const settings = await getSettings();
    queue.maxConcurrent = settings.maxConcurrentGenerations;
    return settings;
};

const WORD_ROOM = 8192;
let wordRoom = WORD_ROOM;
// For tests of models that use no functions at all; null puts the usual room back.
export const setWordRoom = (tokens) => { wordRoom = tokens ?? WORD_ROOM; };
const modelFacts = async (ollama, name) => {
    const shown = await ollama.show(name);
    // A model's template is what its functions are written into. One with no place for them never sees them, whatever
    // Ollama lists, so they are put in words instead. A model with a renderer of its own has no template to read.
    const template = String(shown?.template || '');
    const listed = shown.capabilities || [];
    // A model that lists no functions is told of them in words too, when it has room for them and its work besides.
    const room = contextLength(shown) || 4096;
    const untold = listed.includes('completion') && !listed.includes('tools') && !listed.includes('embedding') && room >= wordRoom;
    const wordy = listed.includes('tools') && !shown?.renderer && template.length > 60 && /\{\{|\{%/.test(template) && !/\btools\b/i.test(template);
    return { contextLength: room, capabilities: untold ? [...listed, 'tools'] : listed, wordy: wordy || untold, online: Object.keys(shown?.model_info || {}).some((key) => key.startsWith('cloud.')) };
};

// How much a model may be given to read. A model on a computer is held to a limit that protects the computer's memory;
// an online model reads as much as its service says it can.
const capacityFor = (chat, facts) => {
    const chosen = Number(chat.options?.num_ctx) || 0;
    if (chosen > 0) return Math.min(chosen, facts.contextLength);
    return facts.online ? facts.contextLength : Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT);
};

// What the models are told lives in server/instructions/library, and all of it is skills a chat turns on or off: one
// folder for each project skills come from, and one for each of Mollama's own two (OWN_FOLDERS), components, which makes
// its viewers work, and skill-map, the map of what each skill is for. Nothing else is sent: no base instructions, no tool
// rules, no search rules. Credits and licences are in THIRD_PARTY.md.
const LIBRARY = path.join(import.meta.dirname, '..', 'instructions', 'library');
const OWN_FOLDERS = ['components', 'skill-map'];
const readGuide = (file) => {
    const text = fs.readFileSync(path.join(LIBRARY, file), 'utf8').replace(/\r\n/g, '\n');
    const head = text.match(/^---\n([\s\S]*?)\n---\n/);
    const facts = Object.fromEntries((head?.[1] || '').split('\n').map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
    const parts = `\n${text.slice(head?.[0].length || 0)}`.split(/\n=== ([A-Z ]+) ===\n/);
    return { facts, body: parts[0].trim(), part: (name) => (parts.includes(name) ? parts[parts.indexOf(name) + 1] : '').trim() };
};
// A skill may come with files of its own: the reference pages, examples and code its instructions name. They sit in a
// folder named after the skill, beside its page, exactly as their project ships them. Only text files are kept.
const SKILL_FILE_TYPES = /\.(md|txt|js|mjs|cjs|ts|tsx|jsx|json|html|css|svg|py|rb|sh|ya?ml|csv)$/i;
const MAX_SKILL_FILE_CHARS = 120000;
// The files a skill names by path (references/x.md, scripts/run.py and so on), to tell whether all of them are here.
const namedFiles = (text) => [...new Set([...String(text).matchAll(/\b((?:references?|resources?|assets|templates?|examples?|rules|docs|scripts)\/[\w./-]+\.\w+)/gi)].map((match) => match[1].replace(/[.,)]+$/, '')))];
// Tool servers a skill relies on, named in its own text (the GitHub MCP, mcp__context7 and so on). A skill counts as
// ready only when each is connected and ready on the person's account.
const SKILL_TOOL_SERVERS = [
    ['GitHub', /GitHub MCP|mcp__github/i], ['Stripe', /Stripe MCP|mcp__stripe/i], ['Context7', /Context7 MCP|mcp__context7/i],
    ['Playwright', /Playwright MCP|mcp__playwright/i], ['Notion', /Notion MCP|mcp__notion/i], ['Atlassian', /Atlassian MCP|Jira MCP|mcp__atlassian/i],
    ['Firecrawl', /Firecrawl MCP|mcp__firecrawl/i], ['Exa', /Exa MCP|mcp__exa/i], ['Slack', /Slack MCP|mcp__slack/i], ['Linear', /Linear MCP|mcp__linear/i]
];
const toolServersOf = (text) => SKILL_TOOL_SERVERS.filter(([, pattern]) => pattern.test(String(text))).map(([name]) => name);
const skillFilesIn = (folder, base = '') => (fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.isDirectory()) return skillFilesIn(path.join(folder, entry.name), `${base}${entry.name}/`);
    return SKILL_FILE_TYPES.test(entry.name) ? [{ path: `${base}${entry.name}`, bytes: fs.statSync(path.join(folder, entry.name)).size }] : [];
}) : []);
// An own skill's page is named after its folder. Its other files are the ones in folders beside the page: the pages
// beside the Components page are opened by open_component instead.
const OWN_SKILLS = OWN_FOLDERS.map((id) => {
    const guide = readGuide(path.join(id, `${id}.md`));
    const folder = path.join(LIBRARY, id);
    return {
        folder,
        files: skillFilesIn(folder).filter((file) => file.path.includes('/')),
        id,
        name: guide.facts.name || id,
        description: guide.facts.description || '',
        default: guide.facts.default === 'true',
        order: Number(guide.facts.order) || 99,
        credit: guide.facts.credit || null,
        source: 'mollama',
        needs: [],
        text: guide.body,
        remember: guide.part('REMEMBER')
    };
}).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

// The projects the library's skills come from, in the order they are listed.
export const SKILL_SOURCES = {
    mollama: { name: 'Mollama', repo: null },
    mine: { name: 'My skills', repo: null },
    anthropic: { name: 'Anthropic', repo: 'anthropics/skills' },
    engineering: { name: 'Engineering (Matt Pocock)', repo: 'mattpocock/skills' },
    marketing: { name: 'Marketing (Corey Haines)', repo: 'coreyhaines31/marketingskills' },
    medical: { name: 'Medical (Open Medica)', repo: 'Open-Medica/open-medical-skills' },
    dex: { name: 'Chief of staff (Dex)', repo: 'davekilleen/dex' },
    search: { name: 'Web search (Perplexica, Morphic)', repo: 'ItzCrazyKns/Perplexica, miurla/morphic' },
    last30days: { name: 'Last 30 days', repo: 'mvanhorn/last30days-skill' },
    anatomy: { name: 'Anatomy', repo: 'wheresryan22/anatomy' },
    hairline: { name: 'Hairline', repo: 'lucasmarkes/hairline' },
    taste: { name: 'Taste (Leonxlnx)', repo: 'Leonxlnx/taste-skill' },
    richmd: { name: 'Rich Markdown First', repo: 'xronocode/rich-md-skill' },
    explainer: { name: 'Visual Explainer', repo: 'nicobailon/visual-explainer' },
    cadsmith: { name: 'CadSmith (Jonathan Fermin)', repo: 'JonFermin/cadsmith' }
};
// The text of one of a skill's files, or null when the skill has no such file. Only a path from the skill's own list
// is ever read, so nothing outside its folder can be reached.
export const skillFileText = (skill, wanted) => {
    const asked = String(wanted ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    const file = (skill?.files || []).find((one) => one.path === asked) || (skill?.files || []).find((one) => one.path.toLowerCase() === asked.toLowerCase());
    return file ? fs.readFileSync(path.join(skill.folder, file.path), 'utf8').replace(/\r\n/g, '\n').slice(0, MAX_SKILL_FILE_CHARS) : null;
};
// What a skill asks for that a chat may not have: commands to run, and files of its own to open. A line that only
// installs the skill itself is not a command the model has to run, and a program's name in a sentence is not one
// either: a command counts when it is written as code.
const INSTALL_LINE = /^.*(?:\bnpx (?:-y )?skills add\b|\bgit clone \S+ && cp -r\b|\/plugin (?:marketplace add|install)\b).*$/gim;
const COMMAND = /^\s*\$?\s*(?:python3?|pip3?|npx|npm|node|uv|docker|brew|bash|sh)\s+[\w./@-]/im;
const skillNeeds = (body) => {
    const text = String(body).replace(INSTALL_LINE, '');
    const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
    const spans = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
    const shell = [...text.matchAll(/```(?:bash|sh|shell|zsh)\n([\s\S]*?)```/gi)].some((match) => match[1].split('\n').some((line) => line.trim() && !line.trim().startsWith('#')));
    return [
        (shell || /(?:^|[\s`"'(])scripts\/[\w.-]+/.test(text) || [...fenced, ...spans].some((piece) => COMMAND.test(piece))) && 'commands',
        /\b(references?|resources?|assets|templates?|examples?|rules|docs)\/[\w./-]+\.\w+|\]\((?!https?:|#)[^)]+\.(md|txt|json|ya?ml|py|sh|js|ts)\)/i.test(text) && 'files'
    ].filter(Boolean);
};
// What a person needs on their own computer to run a skill's commands themselves, without any service of Mollama's:
// where the skill comes from, the line its author gives for installing it, the programs its commands call and the
// Python libraries it installs. All of it is read from the skill's own page.
const SETUP_PROGRAMS = [
    ['python', /(?:^|[\s$`(])(?:python3?|pip3?)\s/m, false],
    ['node', /(?:^|[\s$`(])(?:node|npm|npx)\s/m, false],
    ['uv', /(?:^|[\s$`(])uvx?\s/m, false],
    ['docker', /(?:^|[\s$`(])docker\s/m, false],
    ['brew', /(?:^|[\s$`(])brew\s/m, false],
    ['git', /(?:^|[\s$`(])git\s+(?:clone|pull)\b/m, false],
    ['libreoffice', /\bsoffice\b|libreoffice/i, true],
    ['poppler', /\bpdftoppm\b|\bpdftotext\b|\bpoppler\b/i, true],
    // A shell block counts only when it holds a command, not when all it held was the line that installs the skill.
    ['shell', /```(?:bash|sh|shell|zsh)\n(?:[ \t]*(?:#[^\n]*)?\n)*[ \t]*[^\s#`]/i, true]
];
const INSTALL_COMMAND = /(?:npx (?:-y )?skills add|git clone \S+ && cp -r|\/plugin (?:marketplace add|install))[^`\n]*/gi;
const skillSetup = (skill) => {
    const whole = String(skill.text || '');
    const install = [...new Set((whole.match(INSTALL_COMMAND) || []).map((line) => line.trim().replace(/[.,;:)]+$/, '')))];
    // The line that installs a skill is not one of its commands, so it is set aside before they are read.
    const body = whole.replace(new RegExp(INSTALL_LINE.source, 'gim'), '');
    const code = [...[...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]), ...[...body.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1])].join('\n');
    const libraries = [...code.matchAll(/\bpip3? install ([^\n|&;#]+)/g)].flatMap((match) => match[1].trim().split(/\s+/)).filter((word) => /^[A-Za-z][\w.-]*(?:\[[\w,-]+\])?(?:[=<>~!]=?[\w.*]+)?$/.test(word));
    return {
        repos: skill.source === 'mine' ? [] : String(SKILL_SOURCES[skill.source]?.repo || '').split(',').map((repo) => repo.trim()).filter(Boolean),
        address: skill.source === 'mine' ? skill.credit : null,
        install,
        runs: skillNeeds(whole).includes('commands'),
        programs: [...new Set([...SETUP_PROGRAMS.filter(([, test, anywhere]) => test.test(anywhere ? body : code)).map(([id]) => id), ...(install.some((line) => line.startsWith('npx')) ? ['node'] : []), ...(install.some((line) => line.startsWith('git')) ? ['git'] : [])])],
        libraries: [...new Set(libraries)].slice(0, 40)
    };
};
// Library skills that are on in a chat until the person chooses its skills. 'tools' means only for a model that can
// use tools: such a model is shown just the skill's name and description and opens it when a request fits, where a
// model that cannot use tools would be sent the whole skill with every message.
export const DEFAULT_LIBRARY_SKILLS = { 'richmd-rich-md-first': 'tools', 'explainer-visual-explainer': 'tools' };
const LIBRARY_SKILLS = Object.keys(SKILL_SOURCES).filter((source) => fs.existsSync(path.join(LIBRARY, source))).flatMap((source) => fs.readdirSync(path.join(LIBRARY, source)).filter((file) => file.endsWith('.md')).sort().map((file) => {
    const text = fs.readFileSync(path.join(LIBRARY, source, file), 'utf8').replace(/\r\n/g, '\n');
    const head = text.match(/^---\n([\s\S]*?)\n---\n/);
    const facts = Object.fromEntries((head?.[1] || '').split('\n').map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
    const files = skillFilesIn(path.join(LIBRARY, source, file.slice(0, -3)));
    // The mark a skill was given when it was taken in is kept only where it still holds: its files may be here now.
    const asks = skillNeeds(text.slice(head?.[0].length || 0));
    // A named file counts as missing only where the skill ships that folder: a path in another folder is usually the
    // person's own project (docs/..., scripts/... of theirs), not a file of the skill's.
    const shipped = new Set(files.map((one) => one.path.split('/')[0].toLowerCase()));
    const missing = namedFiles(text).filter((named) => shipped.has(named.split('/')[0].toLowerCase()) && !files.some((one) => one.path === named || one.path.endsWith(`/${named}`)));
    const needs = (facts.needs || '').split(',').filter((need) => asks.includes(need) && !(need === 'files' && files.length > 0 && missing.length === 0));
    const name = facts.name || file.slice(0, -3);
    return {
        id: file.slice(0, -3),
        name,
        description: facts.description || '',
        default: DEFAULT_LIBRARY_SKILLS[file.slice(0, -3)] || false,
        order: 100,
        credit: `${SKILL_SOURCES[source].repo} (${facts.licence})`,
        source,
        needs,
        folder: path.join(LIBRARY, source, file.slice(0, -3)),
        files,
        text: `SKILL: ${name}\n\n${text.slice(head?.[0].length || 0).trim()}`,
        remember: ''
    };
}));
export const SKILLS = [...OWN_SKILLS, ...LIBRARY_SKILLS];
// Which skills go together, read from what the skills themselves say, the way notes link by naming each other: no
// model is asked and nothing is downloaded. A skill counts as named when it is written as one: `slug`, a /slug
// command, "the Copywriting skill", or a longer name in a list of skills. A one-word name is also an ordinary word,
// so it needs one of the first three forms, and a name of three letters or fewer one of the first two. The skill
// map's combining guide adds the pairs it names. Each skill keeps its strongest links.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SKILL_LINK_LIMIT = 6;
export const skillLinks = (all, guide = '') => {
    const slugOf = (skill) => (skill.source && skill.id.startsWith(`${skill.source}-`) ? skill.id.slice(skill.source.length + 1) : skill.id);
    const finders = all.map((skill) => {
        const slug = slugOf(skill);
        const names = [...new Set([skill.name, slug, slug.replace(/-/g, ' ')].filter((word) => word.length >= 4))].map(escapeRe);
        const res = [new RegExp(`\`/?${escapeRe(slug)}\``, 'i'), new RegExp(`(?<![\\w/.:-])/${escapeRe(slug)}(?=[\\s.,;:)]|$)`, 'i')];
        if (names.length > 0) {
            const either = `(?:${names.join('|')})`;
            res.push(new RegExp(`(?<![\\w-])${either}(?![\\w-])[\`*"'’”]?\\s+skill\\b`, 'i'));
            if (/[\s-]/.test(skill.name) || slug.includes('-')) res.push(new RegExp(`\\bskills?\\b[^.\\n]{0,60}?(?<![\\w-])${either}(?![\\w-])`, 'i'));
        }
        return { skill, res };
    });
    const links = new Map(all.map((skill) => [skill.id, new Map()]));
    const nameOf = new Map(all.map((skill) => [skill.id, skill.name.toLowerCase()]));
    const add = (a, b, weight = 1) => {
        if (a === b || nameOf.get(a) === nameOf.get(b)) return;
        links.get(a).set(b, (links.get(a).get(b) || 0) + weight);
        links.get(b).set(a, (links.get(b).get(a) || 0) + weight);
    };
    for (const skill of all) {
        const prose = String(skill.text || '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/```[\s\S]*?```/g, ' ');
        for (const { skill: other, res } of finders) if (other.id !== skill.id && res.some((re) => re.test(prose))) add(skill.id, other.id);
    }
    // The guide is Mollama's own, so a name written with its capitals is meant: every pair in a paragraph is linked.
    for (const paragraph of String(guide).split(/\n\s*\n/)) {
        const named = all.filter((skill) => skill.name.length >= 6 && new RegExp(`(?<![\\w-])${escapeRe(skill.name)}(?![\\w-])`).test(paragraph));
        named.forEach((one, at) => named.slice(at + 1).forEach((other) => add(one.id, other.id, 2)));
    }
    const sourceOf = new Map(all.map((skill) => [skill.id, skill.source]));
    const same = (id, other) => (sourceOf.get(other) === sourceOf.get(id) ? 1 : 0);
    return new Map([...links].map(([id, found]) => [id, [...found].sort((x, y) => y[1] - x[1] || same(id, y[0]) - same(id, x[0])).slice(0, SKILL_LINK_LIMIT).map(([other]) => other)]));
};
const COMBINING_GUIDE = (() => {
    try {
        return fs.readFileSync(path.join(LIBRARY, 'skill-map', 'examples', 'combining.md'), 'utf8').replace(/\r\n/g, '\n');
    } catch {
        return '';
    }
})();
const SKILL_LINKS = skillLinks(LIBRARY_SKILLS, COMBINING_GUIDE);
// A skill is one to eight thousand tokens of instructions, so a chat holds only a few at once.
export const MAX_CHAT_SKILLS = 8;
// Short skills that need no commands or files and work as a conversation, so a small model can follow them.
export const SUGGESTED_SKILLS = ['engineering-grilling', 'dex-brainstorming', 'engineering-to-questionnaire', 'engineering-writing-shape', 'dex-decision-log', 'dex-weekly-reflection', 'dex-delegate-check'];

// The skills a person added by address are kept with their account. They are read once and remembered for a minute,
// so building a chat's instructions does not wait on the database.
export const MAX_OWN_SKILLS = 50;
const MAX_SKILL_BYTES = 120 * 1024;
const ownSkillCache = new Map();
const ownSkill = (doc) => {
    const needs = skillNeeds(doc.text);
    return {
        id: `mine-${doc.id}`, name: doc.name, description: doc.description || '', default: false, order: 200, credit: doc.address, source: 'mine', needs,
        text: `SKILL: ${doc.name}\n\n${doc.text}`, remember: ''
    };
};
const ownSkillsOf = async (userId) => {
    const key = String(userId);
    const kept = ownSkillCache.get(key);
    if (kept && Date.now() - kept.at < 60000) return kept.skills;
    const skills = (await Skill.find({ service: SERVICE, owner: userId }).sort({ name: 1 })).map(ownSkill);
    if (ownSkillCache.size >= 2000) ownSkillCache.delete(ownSkillCache.keys().next().value);
    ownSkillCache.set(key, { at: Date.now(), skills });
    return skills;
};
const skillsFor = (ownerId) => [...SKILLS, ...(ownSkillCache.get(String(ownerId))?.skills || [])];
const skillsOf = (chat) => skillsFor(chat.owner).filter((skill) => (Array.isArray(chat.skills) ? chat.skills.includes(skill.id) : skill.default));
// A model that can use tools is sent only the name and description of each skill its chat has on, inside one function,
// and opens a skill with that function when a request fits it. A skill opened earlier in the chat is sent in full from
// then on, and so is Mollama's own. A model that cannot use tools is sent every skill in full.
const SKILL_STEP = 'Skill';
// A skill that would take more than a sixth of what the model can read is opened in parts, word for word: its start and
// the first sections that fit, then the rest by their headings, each opened when it is needed. A model with a large
// room is given every skill whole.
// The page a skill says to read before anything is built with it, given with the skill when it fits: a small model opens
// the skill and goes straight to building. One too long for the room is named instead.
const FIRST_PAGES = {
    'hairline-hairline-create': [{ file: 'kernel.js', until: 'var HL' }],
    'cadsmith-make-model': [{ file: 'references/build123d-guide.md' }],
    'cadsmith-make-mechanism': [{ file: 'references/mech-api.md' }],
    'anatomy-anatomy': [{ file: 'examples/dial-indicator/build.mjs' }]
};
const firstPages = (skill, capacity, kept) => {
    const lines = [];
    for (const { file, until } of FIRST_PAGES[skill.id] || []) {
        const key = `file:${skill.id}/${file}`;
        const whole = skillFileText(skill, file);
        if (!whole || kept?.has(key)) continue;
        const end = until ? whole.indexOf(until) : -1;
        const text = (end > 0 ? whole.slice(0, end) : whole).trim();
        if (estimateTokens(text) > skillRoom(capacity)) {
            lines.push(`${file} (about ${estimateTokens(text).toLocaleString('en-GB')} tokens): read it with open_skill_file before you build.`);
            continue;
        }
        kept?.set(key, until ? true : 'given');
        lines.push(`${file}:\n\n${text}`);
    }
    return lines.length > 0 ? `\n\nREAD BEFORE YOU BUILD\n${lines.join('\n\n')}` : '';
};
const skillRoom = (capacity) => Math.max(1500, Math.floor(capacity / 6));
export const skillParts = (text) => {
    const parts = [];
    let start = [];
    let into = start;
    let fenced = false;
    for (const line of String(text || '').split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (!fenced && /^## /.test(line)) {
            into = [];
            parts.push({ title: line.replace(/^##\s+/, '').trim(), lines: into });
        }
        into.push(line);
    }
    return { start: start.join('\n').trim(), parts: parts.map((part) => ({ title: part.title, text: part.lines.join('\n').trim() })) };
};
const isLong = (skill, capacity) => estimateTokens(skill.text) > skillRoom(capacity) && skillParts(skill.text).parts.length > 1;
export const skillInParts = (skill, capacity, wanted = '') => {
    const { start, parts } = skillParts(skill.text);
    const asked = String(wanted ?? '').trim().toLowerCase();
    const about = (at) => `- ${at + 1}. ${parts[at].title} (about ${estimateTokens(parts[at].text).toLocaleString('en-GB')} tokens)`;
    if (asked) {
        const numbers = (asked.match(/\d+/g) || []).map(Number).filter((number) => number >= 1 && number <= parts.length);
        const named = parts.findIndex((part) => part.title.toLowerCase() === asked || part.title.toLowerCase().includes(asked));
        const chosen = named >= 0 && !/^[0-9, ]+$/.test(asked) ? [named] : [...new Set(numbers)].map((number) => number - 1);
        if (chosen.length === 0) return { content: `${skill.name} has no such part. Its parts are:\n${parts.map((part, at) => about(at)).join('\n')}`, failed: 'failed' };
        return { content: chosen.map((at) => `${skill.name}, part ${at + 1} of ${parts.length}\n\n${parts[at].text}`).join('\n\n') };
    }
    const given = [];
    let room = skillRoom(capacity) - estimateTokens(start);
    for (const [at, part] of parts.entries()) {
        room -= estimateTokens(part.text);
        if (room < 0) break;
        given.push(at);
    }
    const rest = parts.map((part, at) => at).slice(given.length);
    return {
        content: [start, ...given.map((at) => parts[at].text), `This skill is long, so it comes in parts. Above ${given.length === 0 ? 'is its start' : given.length === 1 ? 'are its start and part 1' : `are its start and parts 1 to ${given.length}`}. Not read yet:\n${rest.map(about).join('\n')}\nOpen each one that bears on what you are doing before you do it: call open_skill with the same skill and part set to its number.`].filter(Boolean).join('\n\n')
    };
};
const openedNames = (chat) => new Set(chat.messages.flatMap((message) => (message.steps || []).filter((step) => step.tool === SKILL_STEP && !step.failed).map((step) => String(step.input).replace(/, part .*$/, ''))));
const sortSkills = (chat, listing, capacity = Infinity) => {
    const active = skillsOf(chat);
    if (!listing) return { full: active.filter((skill) => Array.isArray(chat.skills) || skill.default !== 'tools'), listed: [] };
    const opened = openedNames(chat);
    const full = active.filter((skill) => skill.source === 'mollama' || (opened.has(skill.name) && !isLong(skill, capacity)));
    return { full, listed: active.filter((skill) => !full.includes(skill)) };
};
// The skills an opened skill goes with, so a model knows its companions without searching for them.
const SKILL_BY_ID = new Map(SKILLS.map((skill) => [skill.id, skill]));
const companionsOf = (skill, others) => {
    const off = new Set(others.map((one) => one.id));
    const linked = (SKILL_LINKS.get(skill.id) || []).map((id) => SKILL_BY_ID.get(id)).filter(Boolean);
    if (linked.length === 0) return '';
    const on = linked.filter((one) => !off.has(one.id)).map((one) => one.name);
    const away = linked.filter((one) => off.has(one.id)).map((one) => one.name);
    return [
        `\n\nGOES WITH`,
        ...(on.length > 0 ? [`On in this chat, open with open_skill when the request needs it: ${on.join(', ')}.`] : []),
        ...(away.length > 0 ? [`In the library, not on: ${away.join(', ')}. When one would help, tell the user its name; they turn it on under Skills.`] : [])
    ].join('\n');
};
const openSkillTool = (listed, others = [], capacity = Infinity, light = false) => {
    const find = (input) => {
        const wanted = String(input?.skill ?? '').trim().toLowerCase();
        return listed.find((skill) => skill.name.toLowerCase() === wanted || skill.id === wanted);
    };
    return {
        fn: 'open_skill',
        label: SKILL_STEP,
        changes: false,
        shown: (input) => `${find(input)?.name || clip(String(input?.skill ?? ''), 80)}${find(input) && String(input?.part ?? '').trim() ? `, part ${clip(String(input.part).trim(), 30)}` : ''}`,
        knows: (name) => Boolean(find({ skill: String(name).replace(/[_-]+/g, ' ') })),
        slip: (name) => ({ skill: String(name).replace(/[_-]+/g, ' ') }),
        definition: {
            type: 'function',
            function: {
                name: 'open_skill',
                description: `Open one of this chat's skills and get its full instructions. The user turned these skills on, so the list itself says what kind of help they expect: before you answer, weigh every skill on it against the request and open each one that bears on it, not only the first that fits. The instructions are written for you and the user does not see them: do what they say in your reply, and do not repeat them back.${light ? ' A skill\'s own functions and files are given to you when you open it.' : ''}\n${listed.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`,
                parameters: { type: 'object', properties: { skill: { type: 'string', enum: listed.map((skill) => skill.name), description: 'The name of the skill to open' }, part: { type: 'string', description: 'Only for a long skill you have opened: the number of one of its parts' } }, required: ['skill'] }
            }
        },
        run: async (input, { kept } = {}) => {
            const skill = find(input);
            if (skill && isLong(skill, capacity)) {
                const answer = skillInParts(skill, capacity, input?.part);
                return String(input?.part ?? '').trim() ? answer : { ...answer, content: `${answer.content}${firstPages(skill, capacity, kept)}${companionsOf(skill, others)}` };
            }
            return skill ? { content: `${skill.text}${firstPages(skill, capacity, kept)}${companionsOf(skill, others)}` } : { content: `There is no skill by that name in this chat. The skills are: ${listed.map((one) => one.name).join(', ')}.`, failed: 'failed' };
        }
    };
};
// The files of the skills a chat has on are read one at a time, when the skill's instructions send the model to one.
// What the person is told a model is doing while it writes a call to a tool and while that tool runs.
// Within one reply, a tool result the model has moved past is put away to save room: one from PUT_AWAY_AFTER steps
// back or more, or any older than the last step once the prompt is past half the model's room. Pages that tell the
// model how to work (skills, their files, component pages) stay. Calling the same function again with the same input
// gives the whole result back.
const KEPT_RESULTS = new Set(['open_skill', 'open_skill_file', 'open_component', 'find_skill', 'ask_user', 'save_note']);
const PUT_AWAY_AFTER = 3;
const PUT_AWAY_MIN_CHARS = 600;
// A note the model keeps for the rest of the chat: shown with every message after this one, so it outlasts the memory
// folding and results put away.
// A model may free its own room in the middle of a reply: it writes down what it still needs, and what it has read is put
// away. The loop does the putting away, as it holds the messages.
const ALREADY_GIVEN = 'You already have ';
const COMPRESS_STEP = 'Make room';
const compressTool = () => ({
    fn: 'compress_context',
    label: COMPRESS_STEP,
    doing: 'Making room…',
    changes: false,
    shown: (input) => clip(String(input?.keep ?? ''), 300),
    definition: {
        type: 'function',
        function: {
            name: 'compress_context',
            description: 'Frees room in your context in the middle of your work: everything you have read and sent in this reply so far (skill pages, files, results, earlier versions) is put away, and only what you write in keep stays. Use it before writing something long when you are told little room is left. In keep put all you still need: the exact names and arguments of the functions you will call, sizes, the plan, what is done and what is next. Anything put away can be read again with the same call.',
            parameters: { type: 'object', properties: { keep: { type: 'string', description: 'What you still need, in full. It is all that stays.' } }, required: ['keep'] }
        }
    },
    run: async (input) => {
        const keep = String(input?.keep ?? '').trim();
        if (keep.length < 20) return { content: 'Nothing was put away. Write in keep what you still need: it is all that stays.', failed: 'failed' };
        return { content: 'Put away.', compress: true };
    }
});
const MAX_NOTES = 40;
const NOTE_STEP = 'Note';
const noteTool = (chat) => ({
    fn: 'save_note',
    label: NOTE_STEP,
    doing: 'Keeping a note…',
    changes: false,
    shown: (input) => clip(String(input?.key ?? ''), 60),
    definition: {
        type: 'function',
        function: {
            name: 'save_note',
            description: 'Keep a note in this chat: a fact, a number, a decision, a source or a step you will need later. Notes are shown to you with every message of this chat from now on, even after older messages are folded into a memory and tool results you have read are put away. A note with a key already used replaces it; empty text removes it.',
            parameters: { type: 'object', properties: { key: { type: 'string', description: 'A short name for the note, such as battery-capacity' }, text: { type: 'string', description: 'What to keep, in a sentence or a few short lines. Empty to remove the note.' } }, required: ['key', 'text'] }
        }
    },
    run: async (input) => {
        const key = clip(String(input?.key ?? '').replace(/\s+/g, ' ').trim(), 60);
        const text = clip(String(input?.text ?? '').trim(), 2000);
        if (!key) return { content: 'Nothing was kept. Give the note a short key.', failed: 'failed' };
        const others = (chat.notes || []).filter((note) => note.key !== key);
        if (!text) {
            chat.notes = others;
            return { content: `Removed the note "${key}".` };
        }
        if (others.length >= MAX_NOTES) return { content: `Nothing was kept: this chat already has ${MAX_NOTES} notes. Remove one by saving it with empty text.`, failed: 'failed' };
        chat.notes = [...others, { key, text, updatedAt: new Date() }];
        return { content: `Kept the note "${key}". It is shown to you with every message of this chat from now on.` };
    }
});
// Saves something a model made, or a file it found at a web address, to the person's FilesystemOne. It writes to
// their files, so it asks first.
// Looking through the person's files and reading one only reads, so neither asks: FilesystemOne itself decides what
// their sign-in may see. A path not found as given is tried again inside their own folder.
const FILE_TEXT_CHARS = 40000;
const fileTool = (fn, label, doing, description, properties, run) => ({
    fn,
    label,
    doing,
    shown: (input) => clip(String(input?.path ?? input?.folder ?? '/'), 160),
    definition: { type: 'function', function: { name: fn, description, parameters: { type: 'object', properties } } },
    run: async (input) => {
        try {
            return await run(personFiles(), input);
        } catch (error) {
            const failure = error instanceof OllamaError ? error : new OllamaError('FILE_NOT_FOUND', error.message);
            return { content: `Nothing was read: ${failure.toJSON().message}`, failed: 'failed' };
        }
    }
});
const homeFirst = async (given, read) => {
    const asked = `/${String(given || '').split('/').filter((part) => part && part !== '.' && part !== '..').join('/')}`;
    const inside = inHome(asked);
    try {
        return await read(asked === '/' ? inside : asked);
    } catch (error) {
        if (inside === asked) throw error;
        return read(inside);
    }
};
const listFilesTool = () => fileTool('list_my_files', 'List files', 'Looking in your files…',
    "List what is in a folder of the user's FilesystemOne files: each folder and file with its full path and size. Left out, the user's own top folder.",
    { folder: { type: 'string', description: 'The folder, such as /Drawings' } },
    async (files, input) => {
        const first = await homeFirst(input?.folder, (folder) => files.browse(folder));
        const inside = inHome(input?.folder || '/');
        const entries = first.length === 0 && inside !== `/${String(input?.folder || '').split('/').filter(Boolean).join('/')}` ? await files.browse(inside).catch(() => first) : first;
        if (entries.length === 0) return { content: 'That folder is empty.' };
        return { content: clip(entries.map((entry) => `${entry.type} ${entry.path}${entry.type === 'file' ? ` (${Math.max(1, Math.round(entry.size / 1024))} KB)` : ''}`).join('\n'), 8000) };
    });
const readFileTool = () => fileTool('read_my_file', 'Read a file', 'Reading your file…',
    "Read one of the user's FilesystemOne files as text: documents, PDFs, Word files, spreadsheets as text, code and notes. Give its full path; list_my_files shows the paths.",
    { path: { type: 'string', description: 'The file, such as /Notes/plan.md' } },
    async (files, input) => {
        if (!String(input?.path ?? '').trim()) return { content: 'Nothing was read. Give the path of a file, such as /Notes/plan.md.', failed: 'failed' };
        const file = await homeFirst(input.path, (path) => files.text(path));
        return { content: `${file.name}:\n\n${clip(file.text, FILE_TEXT_CHARS)}` };
    });
const SAVE_STEP = 'Save to files';
const saveToFilesTool = () => ({
    fn: 'save_to_files',
    label: SAVE_STEP,
    doing: 'Saving to your files…',
    changes: false,
    shown: (input) => clip(`${inHome(input?.folder)}/${String(input?.name ?? '')}`, 160),
    definition: {
        type: 'function',
        function: {
            name: 'save_to_files',
            description: "Save a file to the user's FilesystemOne: a page, a figure, a diagram's text, a table as CSV, code or notes you made (give content), or a picture, video or document you found on the web (give address). The user is asked whether to save it, without holding you up. A name already taken in that folder is not overwritten; the file is given a new name.",
            parameters: { type: 'object', properties: { folder: { type: 'string', description: "The folder, such as /Drawings. It is put inside the user's own folder; the result says the full path to tell them." }, name: { type: 'string', description: 'The file name with its extension, such as engine.html' }, content: { type: 'string', description: 'The whole text of the file, when you made it' }, address: { type: 'string', description: 'The https address of a file on the web, when you found it' } }, required: ['folder', 'name'] }
        }
    },
    run: async (input, context = {}) => {
        const name = String(input?.name ?? '').trim();
        const content = typeof input?.content === 'string' ? input.content : '';
        const address = String(input?.address ?? '').trim();
        if (!String(input?.folder ?? '').trim() || !name || /[\\/\0]/.test(name)) return { content: 'Nothing was saved. Give a folder such as /Drawings and a file name with no slashes.', failed: 'failed' };
        if (!content && !address) return { content: 'Nothing was saved. Give the content of the file, or the address of a file on the web.', failed: 'failed' };
        const folder = inHome(input.folder);
        const files = personFiles();
        try {
            if (context.offer && !(context.chat?.allowedTools || []).includes('save_to_files')) {
                const made = [{ path: name, buffer: address ? await readAddress(address) : Buffer.from(content) }];
                await saveOrOffer({ fn: 'save_to_files', folder, made, context });
                return { content: `${folder}/${name} is ready. The user is being asked whether to save it; you need not wait. Go on, and do not say it is saved.` };
            }
            if (address) {
                await files.upload(folder, [{ path: name, buffer: await readAddress(address) }]);
                return { content: `Saved the file from ${clip(address, 200)} to ${folder}/${name}. If that name was taken, it was given a new one.` };
            }
            const saved = await files.save(folder, name, content);
            return { content: `Saved to ${saved.path}.` };
        } catch (error) {
            const failure = error instanceof OllamaError ? error : new OllamaError('FILE_NOT_SAVED', error.message);
            return { content: `Nothing was saved: ${failure.toJSON().message}`, failed: 'failed' };
        }
    }
});
// A question for the person, shown with choices they can press. Asking ends the reply: their answer is the next message.
const ASK_STEP = 'Question';
const askUserTool = () => ({
    fn: 'ask_user',
    label: ASK_STEP,
    doing: 'Asking you a question…',
    changes: false,
    shown: (input) => clip(String(input?.question ?? ''), 120),
    definition: {
        type: 'function',
        function: {
            name: 'ask_user',
            description: 'Ask the user one question and end your reply, when the request leaves open something that would change the answer and a wrong guess would waste it: which of several meanings, what it is for, how far to go. The question is shown with your choices as buttons, and their answer arrives as the next message. Do not ask what you can settle yourself, look up, or reasonably assume, and do not ask more than once in a reply.',
            parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question, in one sentence' }, choices: { type: 'array', items: { type: 'string' }, description: 'Two to four short answers the user can pick with one press' } }, required: ['question'] }
        }
    },
    run: (input, { show }) => {
        const plain = (text, most) => clip(String(text ?? '').replace(/[`<>"]/g, '').replace(/\s+/g, ' ').trim(), most);
        const question = plain(input?.question, 300);
        if (!question) return { content: 'Nothing was asked. Give the question.', failed: 'failed' };
        const given = Array.isArray(input?.choices) ? input.choices : String(input?.choices ?? '').split(/\n|;|\|/);
        const choices = [...new Set(given.map((choice) => plain(choice, 60)).filter(Boolean))].slice(0, 4);
        show([question, ...(choices.length > 0 ? ['', '```component', '<ButtonGroup>', ...choices.map((choice) => `<Button send="${choice}" size="sm">${choice}</Button>`), '</ButtonGroup>', '```'] : [])].join('\n'));
        return { content: 'The question is now shown to the user. Your reply ends here; their answer will be the next message.', ends: true };
    }
});
const DOING = {
    web_search: 'Searching the web…',
    web_fetch: 'Reading a web page…',
    read_web_page: 'Reading a web page…',
    open_skill: 'Opening a skill…',
    open_skill_file: "Reading one of a skill's files…",
    save_note: 'Keeping a note…',
    compress_context: 'Making room…',
    save_to_files: 'Saving to your files…',
    open_component: 'Reading how to draw a component…',
    find_skill: 'Looking in the skill library…',
    calculator: 'Working out a sum…',
    date_time: 'Checking the date and time…'
};
const doingOf = (name, tools = []) => {
    const tool = tools.find((one) => one.fn === name);
    return tool?.doing || DOING[name] || `Using ${tool?.label || name}…`;
};
const SKILL_FILE_STEP = 'Skill file';
const SKILL_FILE_ROOM = 12000;
const skillFileTool = (withFiles) => {
    const find = (input) => {
        const wanted = String(input?.skill ?? '').trim().toLowerCase();
        return withFiles.find((skill) => skill.id === wanted || skill.name.toLowerCase() === wanted) || (withFiles.length === 1 ? withFiles[0] : null);
    };
    return {
        fn: 'open_skill_file',
        label: SKILL_FILE_STEP,
        changes: false,
        shown: (input) => `${clip(String(input?.file ?? ''), 80)} (${find(input)?.name || clip(String(input?.skill ?? ''), 60)})`,
        definition: {
            type: 'function',
            function: {
                name: 'open_skill_file',
                description: `Read one of the files that belong to a skill of this chat, such as a rules page, an example or the code its instructions name. Read a file when the skill's instructions tell you to.\n${withFiles.map((skill) => `- ${skill.id}: ${skill.files.map((file) => file.path).filter((file) => !/\.test\.[a-z]+$/.test(file)).join(', ')}`).join('\n')}`,
                parameters: { type: 'object', properties: { skill: { type: 'string', enum: withFiles.map((skill) => skill.id), description: 'The skill the file belongs to' }, file: { type: 'string', description: 'The path of the file, as listed' }, until: { type: 'string', description: 'Optional. Read only the start of the file, up to the first line that contains this text. Use it when the instructions say to read only the top of a file.' } }, required: ['skill', 'file'] }
            }
        },
        run: async (input, { kept } = {}) => {
            const skill = find(input);
            const whole = skill ? skillFileText(skill, input?.file) : null;
            const stop = typeof input?.until === 'string' && input.until.trim() ? input.until.trim() : null;
            const lines = whole === null ? [] : whole.split('\n');
            const end = stop ? lines.findIndex((line) => line.includes(stop)) : -1;
            const text = whole !== null && end > 0 ? lines.slice(0, end).join('\n') : whole;
            const fileKey = skill ? `file:${skill.id}/${String(input?.file ?? '').trim().replace(/^\.?\//, '')}` : '';
            // It came with the skill in this reply and is still there to read: giving it again would only take room.
            if (text !== null && kept?.get(fileKey) === 'given') return { content: `${ALREADY_GIVEN}${String(input.file).trim()}: it came with open_skill above, under READ BEFORE YOU BUILD.` };
            if (text !== null) kept?.set(fileKey, true);
            if (text !== null) return { content: text };
            return { content: skill ? `That skill has no file by that name. Its files are: ${skill.files.map((file) => file.path).join(', ')}.` : `There is no skill by that name with files in this chat. The skills with files are: ${withFiles.map((one) => one.id).join(', ')}.`, failed: 'failed' };
        }
    };
};
// What a skill's instructions ask an agent to do with a command, Mollama does itself where it can: one function for
// one command, offered while the skill is on, doing exactly what that command does and nothing more. No script of a
// skill is run on the server.
// What `node validate.mjs` checks in a Hairline figure, done here so no one has to run it. The checks between the two
// marks are the Hairline kit's own (validate.mjs, MIT, Copyright (c) 2026 Lucas Marques), word for word. Its checks of
// the kernel and the bench are left out, since the page is put together here, and where it runs Node to see whether
// the figure loads, the figure is compiled here without being run.
const hairlineFaults = (() => {
    const LIMIT = 200;
    /* ---- from validate.mjs ---- */
    /**
     * A figure's source without its comments, so its prose is never read as code.
     * It is read the way JavaScript reads it, so a `//` inside a string, a template
     * or a regex is not taken for a comment, and what follows it is still checked.
     * With `words` false the strings are emptied too, for a check that must not
     * read a string's words as code.
     */
    function bare(src, words = true) {
      let out = "", i = 0, prev = "", depth = 0;
      const open = []; // for each `${` still open, the brace depth it opened at
      /** Reads from just past an opening quote to its close, or, in a template, to a `${`. */
      const quoted = (q) => {
        const from = i;
        while (i < src.length && src[i] !== q && (q === "`" ? !(src[i] === "$" && src[i + 1] === "{") : src[i] !== "\n")) {
          i += src[i] === "\\" ? 2 : 1;
        }
        if (words) out += src.slice(from, i);
        if (q === "`" && src[i] === "$") { out += "${"; i += 2; open.push(depth++); prev = "{"; return; }
        out += src[i] ?? ""; i++; prev = q;
      };
      while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; }
        else if (c === "/" && d === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; out += " "; }
        else if (c === "/" && /^(?:|[(,=:[!&|?{};+\-*%<>~^])$/.test(prev)) {
          // A regex: a slash where a value starts. A quote or a `//` inside it is the regex's own.
          let j = i + 1, cls = false;
          for (; j < src.length && src[j] !== "\n"; j++) {
            if (src[j] === "\\") j++;
            else if (src[j] === "[") cls = true;
            else if (src[j] === "]") cls = false;
            else if (src[j] === "/" && !cls) break;
          }
          out += src.slice(i, j + 1); i = j + 1; prev = ")";
        } else if (c === '"' || c === "'" || c === "`") { out += c; i++; quoted(c); }
        else if (c === "}" && open.length && depth - 1 === open[open.length - 1]) { depth--; open.pop(); out += c; i++; quoted("`"); }
        else {
          if (c === "{") depth++;
          else if (c === "}") depth--;
          out += c; i++;
          if (!/\s/.test(c)) prev = c;
        }
      }
      return out;
    }

    /**
     * What a figure must not contain: a pattern read in the code with its strings,
     * and, for an import, one read with its strings emptied, so the word in a
     * string is not taken for the statement.
     */
    const BAD = [
      ["text", /<\s*(?:text|tspan|textPath|foreignObject)\b|["'`](?:text|tspan|textPath|foreignObject)["'`]|\b(?:innerHTML|outerHTML|insertAdjacentHTML|innerText)\b/,
        "rule 10. No words inside the figure, and no markup written as a string. Say it with geometry (a punch, a dot code, a bright edge); names go to read.textContent."],
      ["paint", /stroke-width|strokeWidth|stroke-dasharray|-opacity|(?:fill|stroke)Opacity|["'`](?:fill|stroke|filter|style|color|stop-color|opacity)["'`]|\b(?:fill|stroke|filter|style|opacity)\s*:|\.style\b|(["'`])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\1|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(|drop-shadow|box-shadow|feDropShadow|feGaussianBlur|[Ll]inearGradient|[Rr]adialGradient|(?:linear|radial|conic)-gradient/,
        "rule 04. The figure sets a stroke width, colour, fill, opacity, filter, gradient or shadow of its own. Use the kernel's classes and nothing else: sil, hi, lo, nf, fo, dash, dot, dot m, dot off."],
      ["outside", /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\/|\burl\(|<\/?script|<(?:link|img|iframe|style)\b|new\s+Image\b|createElement|\beval\s*\(|new\s+Function\b|localStorage|sessionStorage|\.cookie\b/,
        "the figure reaches outside the file or makes nodes by hand. One self-contained file: no fetch, import, URL, script tag or storage, and every node comes from HL.mk.",
        // The keyword ends where the binding starts, so `important` or `imported` is a name, not an import.
        // `import.meta` is left alone on purpose: by itself it reaches nothing outside the file.
        /\bimport(?:\s*["'`({*]|\s+[\w$]+\s*(?:,|from\b))/],
      ["clock", /\bsetInterval\b|\bsetTimeout\b|\brequestAnimationFrame\b|\.animate\s*\(|<animate|["'`]animate(?:Transform|Motion)?["'`]|IntersectionObserver|\bmatchMedia\b/,
        "rule 07. The figure runs a clock of its own. Move inside HL.register(stage, tick), with springs (stepS) or tweens (tset, tval); a delay is a tween's delay. The loop sleeps offscreen and honours reduced motion for you."],
      ["hit", /getBoundingClientRect|elementFromPoint|elementsFromPoint|:hover|(?:addEventListener|\.on)\s*\(\s*(?:\w+\s*,\s*)?["'`](?:mouse|pointer|touch|click)|\bon(?:mouse|pointer|touch|click)\w*\s*=/,
        "rule 01. The figure listens to the pointer itself or measures what is on screen. Take the pointer from HL.pointer(stage, { move, leave }) and test it against the rest or target pose, in world units."],
    ];

    /**
     * What a figure must contain. The handle's keys may be written `set(v)`, `set: f`
     * or, shorthand, `{ set, destroy }`. A call on something else, such as
     * `map.set(k, v)`, is not the handle's `set`.
     */
    const NEED = [
      ["clock", /\bregister\s*\(/, "rule 07. The figure never joins the kernel's loop. Draw inside HL.register(stage, tick), and give its unregister to destroy."],
      ["hit", /\bpointer\s*\(/, "the figure never listens to the pointer. Call HL.pointer(stage, { move, leave }) and answer it."],
      ["readout", /\bread\.textContent\s*=/, 'the figure never writes the read-out. Set read.textContent to what is under the pointer, and to "rest" when nothing is.'],
      ["handle", /(?<![.\w$])set\s*[:(,}]/, "mount must return { set(value), destroy() }, and set is missing. It takes the slider's number."],
      ["handle", /(?<![.\w$])destroy\s*[:(,}]/, "mount must return { set(value), destroy() }, and destroy is missing. It undoes everything mount did: bag.dispose."],
    ];

    /**
     * Each `tset` given fewer than its four values. Without its delay a tween
     * starts at no time at all: its value is NaN, and so is every path drawn from it.
     */
    function tweens(shape) {
      const out = [];
      for (const m of shape.matchAll(/(?<![\w$])tset\s*\(/g)) {
        let i = m.index + m[0].length, depth = 1, given = 1;
        for (; i < shape.length && depth; i++) {
          const c = shape[i];
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) depth--;
          else if (c === "," && depth === 1) given++;
        }
        const call = shape.slice(m.index, i).replace(/\s+/g, " ");
        if (given < 4 && !call.includes("...")) {
          out.push(`tween: \`${call}\` is given ${given} of tset's four values: tset(tw, to, now, delay). Without the delay the tween's value is NaN and nothing is drawn. Give it 0 to start at once.`);
        }
      }
      return out;
    }

    /** The declaration at the end of the file, read as text. */
    function declared(code) {
      const say = (what) => `declare: the file must end with hairline({ name, means, rules, range, tour, mount }). ${what}`;
      const m = /\bhairline\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/.exec(code.trimEnd());
      if (!m) return [say("That call is missing, or is not the last statement.")];
      const d = m[1], wrong = [];
      const list = (key) => {
        const a = new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`).exec(d);
        return a ? a[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number) : null;
      };
      if (!/\bname:\s*(["'`])[a-z][a-z0-9-]{1,30}\1/.test(d)) wrong.push("name (lowercase letters, digits and hyphens)");
      if (!/\bmeans:\s*(["'`])(?:(?!\1).){1,140}\1/.test(d)) wrong.push("means (one sentence, at most 140 characters)");
      const rules = list("rules"), range = list("range");
      if (!rules || !rules.length || rules.some((r) => !Number.isInteger(r) || r < 1 || r > 10)) wrong.push("rules (the numbers, 1 to 10, of the rules it leans on)");
      const oneWay = range && range.length === 3 && range.every(Number.isFinite) && range[0] !== range[2] && (range[1] - range[0]) * (range[2] - range[1]) >= 0;
      if (!oneWay) wrong.push("range (three numbers that move one way: the figure's value at intensity 0, 0.5 and 1)");
      if (!/\bmount\b/.test(d)) wrong.push("mount");
      return wrong.length ? [say(`Wrong or missing: ${wrong.join("; ")}.`)] : [];
    }

    /**
     * The tour: three to six stops in the hairline() call, each a literal [x, y]
     * inside the viewBox or null, at least one a point. The figure's own code never
     * calls HL.tour; the bench and the package do.
     */
    function toured(code, shape) {
      const out = [];
      if (/\bHL\.tour\s*\(/.test(shape)) out.push("tour: the figure calls HL.tour itself. Declare tour in hairline() and let the bench play it.");
      const call = /\bhairline\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/.exec(code);
      if (!call) return out;                                   // declare already said so
      const body = call[1];
      const open = /\btour:\s*\[/.exec(body);
      if (!open) { out.push("tour: the call gives no tour. Add tour: [[x, y], ..., null], three to six stops that walk the figure through its answer."); return out; }
      let depth = 0, end = -1;
      for (let i = open.index + open[0].length - 1; i < body.length; i++) {
        if (body[i] === "[") depth++;
        else if (body[i] === "]" && --depth === 0) { end = i; break; }
      }
      if (end < 0) { out.push("tour: the tour's brackets do not close."); return out; }
      const inner = body.slice(open.index + open[0].length, end);
      const items = inner.match(/\[\s*([^\[\]]*)\]|null|[^\s,\[\]]+/g) ?? [];
      const bad = [];
      let points = 0;
      for (const item of items) {
        if (item === "null") continue;
        const m = /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(item);
        const x = m && Number(m[1]), y = m && Number(m[2]);
        if (!m || x < 0 || x > 400 || y < 0 || y > 320) { bad.push(item.replace(/\s+/g, " ")); continue; }
        points++;
      }
      if (bad.length) out.push(`tour: each stop is a literal [x, y] with x in 0..400 and y in 0..320, or null. Not: ${bad.join(", ")}.`);
      if (items.length < 3 || items.length > 6) out.push(`tour: ${items.length} stop${items.length === 1 ? "" : "s"}. A tour has three to six: enough to show the answer, few enough to stay a sentence.`);
      if (!bad.length && !points) out.push("tour: every stop is null. At least one stop is a point on the figure.");
      return out;
    }
    /**
     * The figure's own controls, read from the hairline() call as text: at most
     * four literal objects, each with an id and a kind the bench draws, and a
     * figure that gives any answers them through input(id, value).
     */
    const KINDS = ["switch", "select", "button", "slider"];
    const WORD = /^[a-z][a-z0-9 -]{0,15}$/;
    function controlled(code) {
      const out = [];
      const call = /\bhairline\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/.exec(code);
      if (!call) return out;
      const body = call[1];
      const label = /(?:^|[,{\s])label:\s*(["'`])([^"'`]*)\1/.exec(body.replace(/\bcontrols:\s*\[[\s\S]*$/, ""));
      if (label && !WORD.test(label[2])) out.push(`controls: label "${label[2]}" names the main slider in one to sixteen lowercase letters, digits, spaces or hyphens.`);
      const feel = /\bphysics:\s*\{([^{}]*)\}/.exec(body);
      if (feel) {
        for (const [key, lo] of [["stiffness", 0.2], ["damping", 0.2], ["speed", 0.1]]) {
          const n = new RegExp(`\\b${key}:\\s*([^,\\s}]+)`).exec(feel[1])?.[1];
          if (n !== undefined && !(Number(n) >= lo && Number(n) <= 4)) out.push(`controls: physics ${key} is ${n}; give a number from ${lo} to 4, or leave it out for 1.`);
        }
        const other = feel[1].split(",").map((s) => s.split(":")[0].trim()).filter((k) => k && !["stiffness", "damping", "speed"].includes(k));
        if (other.length) out.push(`controls: physics takes stiffness, damping and speed, not ${other.join(", ")}.`);
      }
      const open = /\bcontrols:\s*\[/.exec(body);
      if (!open) return out;
      let depth = 0, end = -1;
      for (let i = open.index + open[0].length - 1; i < body.length; i++) {
        if (body[i] === "[") depth++;
        else if (body[i] === "]" && --depth === 0) { end = i; break; }
      }
      if (end < 0) return [...out, "controls: the controls' brackets do not close."];
      const items = [];
      const inner = body.slice(open.index + open[0].length, end);
      for (let i = 0, from = -1, d = 0; i < inner.length; i++) {
        if (inner[i] === "{" && d++ === 0) from = i;
        else if (inner[i] === "}" && --d === 0) items.push(inner.slice(from, i + 1));
      }
      if (!items.length) out.push("controls: give each control as a literal { id, kind, label }, or leave controls out.");
      if (items.length > 4) out.push(`controls: ${items.length} controls. A figure has at most four: one idea, a few ways into it.`);
      for (const item of items) {
        const id = /\bid:\s*(["'`])([a-z][a-z0-9-]{0,23})\1/.exec(item)?.[2];
        const kind = /\bkind:\s*(["'`])(\w+)\1/.exec(item)?.[2];
        const said = /\blabel:\s*(["'`])([^"'`]*)\1/.exec(item)?.[2];
        const name = id || item.replace(/\s+/g, " ").slice(0, 40);
        if (!id) out.push(`controls: ${name} needs an id: lowercase letters, digits and hyphens.`);
        if (!KINDS.includes(kind)) out.push(`controls: ${name} needs kind "switch", "select", "button" or "slider".`);
        if (said !== undefined && !WORD.test(said)) out.push(`controls: ${name}'s label is one to sixteen lowercase letters, digits, spaces or hyphens.`);
        if (kind === "select") {
          const options = /\boptions:\s*\[([^\]]*)\]/.exec(item)?.[1];
          const count = options ? options.split(",").map((s) => s.trim()).filter(Boolean).length : 0;
          if (count < 2 || count > 8) out.push(`controls: ${name} is a select with ${count} option${count === 1 ? "" : "s"}; give it two to eight.`);
        }
      }
      if (!/(?<![.\w$])input\s*[:(,}]/.test(code)) out.push("controls: the figure gives controls but mount returns no input(id, value). Answer each control there.");
      return out;
    }
    /* ---- end of validate.mjs ---- */
    return (figure) => {
        const src = String(figure ?? '').replace(/\r\n/g, '\n');
        const code = bare(src);
        const shape = bare(src, false);
        const out = [];
        try {
            // eslint-disable-next-line no-new-func
            Function(`"use strict";\n${src}`);
        } catch (error) {
            if (!/import\.meta|await/.test(String(error?.message))) out.push(`parse: the figure does not load: ${error.name}: ${error.message}. The browser stops there and draws nothing. Fix it in the figure and build again.`);
        }
        for (const [id, re, say, empty] of BAD) if (re.test(code) || empty?.test(shape)) out.push(`${id}: ${say}`);
        for (const [id, re, say] of NEED) if (!re.test(code)) out.push(`${id}: ${say}`);
        out.push(...tweens(shape), ...declared(code), ...toured(code, shape), ...controlled(code));
        const lines = src.split('\n').length;
        if (lines > LIMIT) out.push(`length: the figure is ${lines} lines and the limit is ${LIMIT}. A figure this long is usually two ideas: cut the concept down to one.`);
        return out;
    };
})();
// A figure or page follows the theme the person picks only by the app's variables: a model is never told a colour of the
// theme, and one it writes itself stays the same in every theme.
const APP_COLOURS = 'Write no colour of your own (no #hex, rgb(), hsl() or colour names, in styles, in fill and stroke or anywhere else): use only the app\'s variables, so it follows whichever theme the user picks: var(--app-background), var(--app-surface), var(--app-text), var(--app-border), var(--app-primary), var(--app-secondary), var(--app-tertiary), var(--app-neutral), var(--app-success), var(--app-warning), var(--app-error) and var(--app-contrast) for text on a filled colour. A softer one is color-mix(in srgb, var(--app-text) 30%, transparent). Only a colour that is itself the subject (a flag, a wire that is red) may be fixed.';
const COLOUR_NAMES = 'white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|navy|teal|maroon|olive|cyan|magenta|crimson|steelblue|lightgray|lightgrey|darkgray|darkgrey|whitesmoke|tomato|coral|royalblue|dodgerblue|slategray|dimgray';
export const fixedColours = (page) => {
    const text = String(page ?? '').replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//gi, ' ').replace(/url\([^)]*\)|href="[^"]*"|var\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, ' ');
    const found = [
        ...[...text.matchAll(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|(?:rgb|hsl)a?\([^)]*\)/gi)].map((one) => one[0]).filter((one) => !/^rgba?\(\s*0[\s,]+0[\s,]+0[\s,/]+0?\.\d+\s*\)$/i.test(one)),
        ...[...text.matchAll(new RegExp(`\\b(?:fill|stroke|color|background|background-color|border-color|stop-color)\\s*(?:=\\s*["']|:\\s*)(${COLOUR_NAMES})\\b`, 'gi'))].map((one) => one[1])
    ].map((one) => one.toLowerCase());
    // An id such as href="#base" is not a colour; three or four letters that are one word of hex still may be, so only
    // what stands where a value stands is kept above.
    return { count: found.length, colours: [...new Set(found)] };
};
// One or two fixed colours may be the subject's own; more are a page that does not follow the theme.
const colourFaults = (page) => {
    const { count, colours } = fixedColours(page);
    return count > 2 ? [`colours: ${count} fixed ${colours.length === 1 ? 'uses of one colour' : 'colours'} (${colours.slice(0, 8).join(', ')}${colours.length > 8 ? `, and ${colours.length - 8} more` : ''}) stay the same in every theme. Replace each with one of the app's variables, such as var(--app-primary) or color-mix(in srgb, var(--app-text) 40%, var(--app-surface)); a change with all set replaces every place a colour occurs.`] : [];
};
// Long figures and scripts may be sent in parts: what there is so far is kept, and a change adds to it.
const PART_ADD = { type: 'string', description: 'Text put after the last line, to go on with one that is not finished' };
const PART_UNFINISHED = { type: 'boolean', description: 'True when more is still to come, so what there is is kept and nothing is built yet' };
const CHANGES = { type: 'array', items: { type: 'object', properties: { find: { type: 'string', description: 'Text in it, copied exactly, that occurs once' }, replace: { type: 'string', description: 'What takes its place' }, all: { type: 'boolean', description: 'True to replace every place it occurs, such as a colour' } }, required: ['find', 'replace'] }, description: 'The pieces to replace, in order' };
const CAD_NAME = { type: 'string', description: 'A short file name for it without an ending, in lower case, such as bracket' };
const CAD_SAVE = { type: 'string', description: 'The FilesystemOne folder for the files it makes. Left out, a CadSmith folder in the user\'s own folder.' };
const CAD_BUILD = {
    name: 'cad_build',
    label: 'CadSmith build',
    doing: 'Building the model…',
    ready: () => sandboxReady(),
    description: 'Does what `python ./output/<name>.py` does in the CadSmith skills, then shows the model to the user in the chat\'s 3D viewer. Your build123d or CadQuery script is saved as output/<name>.py on this chat\'s computer and run there; what it exported is measured (separate bodies, size, volume, whether it is watertight), and the .py, .step and .stl files are offered to the user to save. The script must export to ./output/<name>.step and ./output/<name>.stl. Give the whole script. The viewer in the chat takes the place of the skill\'s Three.js previewer, its manifest and its reviewer, none of which can run here, so judge the model by the measurements. When it returns things to fix, mend them with cad_change. Use this for a model instead of run_program.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'The whole script as you would save it in output/<name>.py' }, unfinished: PART_UNFINISHED, name: CAD_NAME, save_to: CAD_SAVE }, required: ['code', 'name'] },
    run: async (input, context) => (input?.unfinished === true ? keepPart('cad', input.code, { name: cadName(input?.name, 'model'), mode: 'model', folder: inHome(String(input?.save_to ?? '').trim() || 'CadSmith') }, context, 'cad_change') : buildCad(String(input?.code ?? ''), input, context, 'model'))
};
const MECH_RUN = {
    name: 'mech_run',
    label: 'CadSmith mechanism',
    doing: 'Running the mechanism…',
    ready: () => sandboxReady(),
    description: 'Does what `uv run mech run output/<name>.py` does in CadSmith Make Mechanism, then shows the mechanism at its home pose in the chat\'s 3D viewer, each part in its own colour. Your script is saved as output/<name>.py on this chat\'s computer, the full analysis is run, and its summary comes back to you word for word: PASS, WARN, FAIL or INVALID with every issue line, and Δprev against the run before. Give the whole script, ending with run(build()). Then change one thing at a time with cad_change, as the skill says. `mech shot` and the skill\'s own viewer cannot run here.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'The whole script as you would save it in output/<name>.py' }, unfinished: PART_UNFINISHED, name: CAD_NAME, params: { type: 'string', description: 'Parameters to try without editing, as after -p, such as crank=35 gap=0.4' }, save_to: CAD_SAVE }, required: ['code', 'name'] },
    run: async (input, context) => (input?.unfinished === true ? keepPart('cad', input.code, { name: cadName(input?.name, 'mechanism'), mode: 'mechanism', folder: inHome(String(input?.save_to ?? '').trim() || 'CadSmith') }, context, 'cad_change') : buildCad(String(input?.code ?? ''), input, context, 'mechanism'))
};
const CAD_CHANGE = {
    name: 'cad_change',
    label: 'CadSmith build',
    doing: 'Mending the model…',
    ready: () => sandboxReady(),
    description: 'Changes the last script given to cad_build or mech_run in this chat, then runs, measures and shows it as they do. Use it to mend or alter a model instead of sending the whole script again: give only the pieces that change.',
    parameters: { type: 'object', properties: { change: CHANGES, add: PART_ADD, unfinished: PART_UNFINISHED, show: { type: 'string', description: 'Lines of the script to read, such as 40-80. Nothing is run.' }, params: { type: 'string', description: 'For a mechanism: parameters to try without editing, such as crank=35' } } },
    run: async (input, context) => {
        const held = chatFigures.get(programKey(context.userId, context.chat))?.cad;
        if (!held) return { content: 'There is no script in this chat to change. Build one with cad_build or mech_run.', failed: 'failed' };
        if (String(input?.show ?? '').trim()) return { content: shownLines(held.code, input.show) };
        const edited = editHeld(held.code, input, Boolean(String(input?.params ?? '').trim()));
        if (edited.problem) return { content: `Nothing was changed or run. ${edited.problem}`, failed: 'failed' };
        if (input?.unfinished === true) return keepPart('cad', edited.code, held, context, 'cad_change');
        return buildCad(edited.code, { ...input, name: held.name, save_to: held.folder }, context, held.mode);
    }
};
const CAD_EXPORT = {
    name: 'cad_export',
    label: 'CadSmith export',
    doing: 'Exporting the model…',
    ready: () => sandboxReady(),
    description: 'Does what the CadSmith export pipeline does for a model built in this chat, without Blender: turns output/<name>.stl, or its .step, into another kind of file and offers it to the user to save. A glb or gltf file is turned so that Y is up, as those files expect.',
    parameters: { type: 'object', properties: { name: CAD_NAME, format: { type: 'string', enum: ['stl', 'obj', 'glb', 'ply', '3mf', 'off'], description: 'The kind of file wanted' }, save_to: CAD_SAVE }, required: ['name', 'format'] },
    run: async (input, context) => exportCad(input, context)
};
const keepPart = (kind, code, extra, { userId, chat }, change) => {
    const text = String(code ?? '').replace(/\r\n/g, '\n');
    if (!text.trim() || text.startsWith(PROGRAM_AWAY)) return { content: 'Nothing was kept. Give the part you have.', failed: 'failed' };
    keepFigure(userId, chat, extra ? { ...extra, code: text } : text, kind);
    return { content: `Kept, not built yet: ${linesOf(text).length} lines so far. Go on with add in ${change}, and leave unfinished out with the last part.` };
};
const editHeld = (code, input, otherwise = false) => {
    const changes = Array.isArray(input?.change) ? input.change : input?.change ? [input.change] : [];
    const add = typeof input?.add === 'string' && input.add.trim() ? input.add.replace(/\r\n/g, '\n') : '';
    if (changes.length === 0 && !add) return { code, problem: otherwise ? null : 'Give the pieces to change.' };
    const edited = changes.length > 0 ? applyChanges(code, changes) : { code };
    if (edited.problem) return edited;
    return { code: add ? `${edited.code.replace(/\s+$/, '')}\n${add.replace(/^\n+/, '')}` : edited.code };
};
const ART_CONTROLS = { type: 'array', items: { type: 'object', properties: { name: { type: 'string', description: 'The key in params it changes, such as particleCount, or colorPalette.0 for the first of a list' }, label: { type: 'string', description: 'What it is called on the page' }, type: { type: 'string', enum: ['slider', 'color'] }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' } }, required: ['name', 'label', 'type'] }, description: 'The sliders and colour pickers of the Parameters and Colors sections' };
const ART_FUNCTIONS = [{
    name: 'art_build',
    label: 'Algorithmic Art build',
    doing: 'Building the artwork…',
    description: 'Makes the single page the Algorithmic Art skill asks for from templates/viewer.html and shows it to the user in the chat. The template is filled in for you: its seed section, its buttons, the sliders and colour pickers you list, updateParam, updateColor, resetParameters and p5.js itself are all put in, so send none of them and no HTML. Give only the sketch: let params = { seed: 12345, ... }, function setup() with createCanvas and initializeSystem(), function initializeSystem() that makes everything anew from params, function draw(), and any classes. Every control changes params and then runs initializeSystem() again. Randomness is seeded from params.seed before each run. For colours that follow the user\'s theme call appColor(\'primary\') (or background, surface, text, border, secondary, tertiary, neutral, success, warning, error) when you draw; a palette that is the artwork\'s own subject goes in params with a colour control. The page has no network and no other library. When it returns things to fix, mend them with art_change.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'The name of the artwork' }, subtitle: { type: 'string', description: 'One short line under it' }, code: { type: 'string', description: 'The whole p5.js sketch' }, unfinished: PART_UNFINISHED, controls: ART_CONTROLS }, required: ['title', 'code', 'controls'] },
    run: async (input, context) => (input?.unfinished === true ? keepPart('art', input.code, { title: input?.title || 'Algorithmic art', subtitle: input?.subtitle || '', controls: input?.controls || [] }, context, 'art_change') : buildArt({ title: input?.title, subtitle: input?.subtitle, controls: input?.controls, code: String(input?.code ?? '') }, context))
}, {
    name: 'art_change',
    label: 'Algorithmic Art build',
    doing: 'Mending the artwork…',
    description: 'Changes the last sketch given to art_build in this chat, then checks and shows it as art_build does. Use it to mend or improve an artwork instead of sending the whole sketch again: give only the pieces that change, and the controls or title only when they change.',
    parameters: { type: 'object', properties: { change: CHANGES, add: PART_ADD, unfinished: PART_UNFINISHED, controls: ART_CONTROLS, title: { type: 'string' }, subtitle: { type: 'string' }, show: { type: 'string', description: 'Lines of the sketch to read, such as 40-80. Nothing is built.' } } },
    run: async (input, context) => {
        const held = chatFigures.get(programKey(context.userId, context.chat))?.art;
        if (!held) return { content: 'There is no artwork in this chat to change. Build one with art_build.', failed: 'failed' };
        if (String(input?.show ?? '').trim()) return { content: shownLines(held.code, input.show) };
        const edited = editHeld(held.code, input, Boolean(input?.controls || input?.title || input?.subtitle));
        if (edited.problem) return { content: `Nothing was changed or built. ${edited.problem}`, failed: 'failed' };
        if (input?.unfinished === true) return keepPart('art', edited.code, held, context, 'art_change');
        return buildArt({ title: input?.title ?? held.title, subtitle: input?.subtitle ?? held.subtitle, controls: input?.controls ?? held.controls, code: edited.code }, context);
    }
}];
// Public medical records, read by this server for the skills that ask for them, so no program needs the network. Each is
// a fixed address of a public service that takes no key; only the words being looked up are sent.
const MEDICAL_KEPT = new Map();
let pubmedNext = 0;
const medicalText = async (address) => {
    const held = MEDICAL_KEPT.get(address);
    if (held && Date.now() - held.at < 10 * 60 * 1000) return held.text;
    if (address.startsWith('https://eutils.ncbi.nlm.nih.gov/')) {
        // PubMed allows three requests a second.
        const wait = Math.max(0, pubmedNext - Date.now());
        pubmedNext = Math.max(pubmedNext, Date.now()) + 400;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const { content } = await readPage(address);
    MEDICAL_KEPT.delete(address);
    MEDICAL_KEPT.set(address, { text: content, at: Date.now() });
    if (MEDICAL_KEPT.size > 100) MEDICAL_KEPT.delete(MEDICAL_KEPT.keys().next().value);
    return content;
};
const medicalJson = async (address) => JSON.parse(await medicalText(address));
const medicalTerm = (value, limit = 200) => String(value ?? '').replace(/["\\:()[\]{}<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const medicalCount = (value, most, usual) => Math.min(Math.max(Math.round(Number(value)) || usual, 1), most);
// A service that answers "not found" has nothing on the words; any other failure is said as it is.
const medicalRun = (source, work) => async (input) => {
    try {
        return await work(input || {});
    } catch (error) {
        if (error?.code === 'REMOTE_NOT_FOUND') return { content: `${source} has nothing on that. Try other words, such as the generic name.` };
        return { content: `${source} could not be read just now (${error?.code === 'REMOTE_BUSY' ? 'it is busy' : 'it did not answer as expected'}). Say so; do not answer from memory as if it had been read.`, failed: 'failed' };
    }
};
const xmlText = (text) => String(text ?? '').replace(/<[^>]+>/g, '').replace(/&#x([\da-f]+);/gi, (whole, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (whole, number) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_SEARCH = {
    name: 'pubmed_search',
    label: 'PubMed',
    doing: 'Searching PubMed…',
    description: 'Searches PubMed, the US National Library of Medicine\'s index of medical papers, and returns each paper\'s title, authors, journal, year, kind, abstract, PMID and DOI. Use it for any claim about what studies found, and cite the PMID. Give pmids instead of query to read those papers\' whole abstracts.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The words to search, in English, such as semaglutide heart failure' },
            kind: { type: 'string', enum: ['any', 'review', 'systematic review', 'meta-analysis', 'randomized controlled trial', 'clinical trial', 'practice guideline'], description: 'Only papers of this kind' },
            from_year: { type: 'integer', description: 'Only papers from this year on' },
            sort: { type: 'string', enum: ['relevance', 'newest'] },
            max: { type: 'integer', minimum: 1, maximum: 15, description: 'How many papers. Six when left out.' },
            pmids: { type: 'array', items: { type: 'string' }, description: 'PMIDs of papers to read in full abstract, at most five' }
        }
    },
    run: medicalRun('PubMed', async (input) => {
        const wanted = (Array.isArray(input.pmids) ? input.pmids : []).map((one) => String(one).replace(/\D/g, '')).filter(Boolean).slice(0, 5);
        let ids = wanted;
        let total = null;
        if (ids.length === 0) {
            const words = medicalTerm(input.query);
            if (!words) return { content: 'Nothing was searched. Give query.', failed: 'failed' };
            const year = Number(input.from_year);
            const term = [`(${words})`, input.kind && input.kind !== 'any' && `"${medicalTerm(input.kind)}"[Publication Type]`, year > 1800 && year < 2200 && `${Math.round(year)}:3000[dp]`].filter(Boolean).join(' AND ');
            const found = (await medicalJson(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${medicalCount(input.max, 15, 6)}&sort=${input.sort === 'newest' ? 'pub_date' : 'relevance'}&term=${encodeURIComponent(term)}`)).esearchresult || {};
            ids = (found.idlist || []).map(String);
            total = Number(found.count) || 0;
            if (ids.length === 0) return { content: 'PubMed has no papers on those words. Try fewer or other words.' };
        }
        const xml = await medicalText(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(',')}`);
        const one = (text, tag) => xmlText(text.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]);
        const papers = [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, text]) => {
            const article = text.match(/<Article\b[\s\S]*?<\/Article>/)?.[0] || text;
            const authors = [...article.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)].map(([, author]) => one(author, 'CollectiveName') || [one(author, 'LastName'), one(author, 'Initials')].filter(Boolean).join(' ')).filter(Boolean);
            const abstract = [...article.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, given, part]) => { const label = given.match(/Label="([^"]*)"/)?.[1]; return `${label ? `${xmlText(label)}: ` : ''}${xmlText(part)}`; }).join(' ');
            const kinds = [...article.matchAll(/<PublicationType\b[^>]*>([^<]*)</g)].map(([, kind]) => xmlText(kind)).filter((kind) => !/^Journal Article$|Research Support/.test(kind));
            const date = article.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] || '';
            const doi = article.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([^<]*)</)?.[1];
            const pmid = text.match(/<PMID\b[^>]*>(\d+)</)?.[1];
            return [`${one(article, 'ArticleTitle')}`, `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} ${one(article, 'Title')}, ${one(date, 'Year') || one(date, 'MedlineDate')}.${kinds.length > 0 ? ` ${kinds.join(', ')}.` : ''}`,
                `PMID ${pmid}, https://pubmed.ncbi.nlm.nih.gov/${pmid}/${doi ? `, doi ${xmlText(doi)}` : ''}`, abstract ? clip(abstract, wanted.length > 0 ? 4000 : 900) : 'No abstract.'].join('\n');
        });
        return { content: [total === null ? '' : `${total.toLocaleString('en-GB')} papers match; these are the first ${papers.length}.`, ...papers].filter(Boolean).join('\n\n') };
    })
};
const TRIALS_SEARCH = {
    name: 'trials_search',
    label: 'Clinical trials',
    doing: 'Searching ClinicalTrials.gov…',
    description: 'Searches ClinicalTrials.gov, the US registry of clinical studies around the world: each study\'s number, title, status, phase, size, sponsor, dates, treatments and countries. Give nct_id instead to read one study with who may join and what is measured.',
    parameters: {
        type: 'object',
        properties: {
            condition: { type: 'string', description: 'The disease or condition' },
            treatment: { type: 'string', description: 'The drug, device or other treatment' },
            status: { type: 'string', enum: ['any', 'recruiting', 'active', 'completed', 'not yet recruiting', 'terminated'] },
            phase: { type: 'string', enum: ['any', '1', '2', '3', '4'] },
            country: { type: 'string' },
            max: { type: 'integer', minimum: 1, maximum: 15, description: 'How many studies. Six when left out.' },
            nct_id: { type: 'string', description: 'One study, such as NCT06732414' }
        }
    },
    run: medicalRun('ClinicalTrials.gov', async (input) => {
        const api = 'https://clinicaltrials.gov/api/v2/studies';
        const line = (study, whole) => {
            const part = study.protocolSection || {};
            const id = part.identificationModule || {};
            const status = part.statusModule || {};
            const places = part.contactsLocationsModule?.locations || [];
            const countries = [...new Set(places.map((place) => place.country).filter(Boolean))];
            const treatments = (part.armsInterventionsModule?.interventions || []).map((one) => one.name).filter(Boolean);
            const outcomes = (part.outcomesModule?.primaryOutcomes || []).map((one) => `${one.measure}${one.timeFrame ? ` (${one.timeFrame})` : ''}`);
            return [`${id.nctId}: ${id.briefTitle}, https://clinicaltrials.gov/study/${id.nctId}`,
                [String(status.overallStatus || '').toLowerCase().replace(/_/g, ' '), (part.designModule?.phases || []).join(', ').replace(/PHASE/g, 'phase '), part.designModule?.enrollmentInfo?.count && `${part.designModule.enrollmentInfo.count} people`, part.sponsorCollaboratorsModule?.leadSponsor?.name, status.startDateStruct?.date && `from ${status.startDateStruct.date}`, status.primaryCompletionDateStruct?.date && `main results due ${status.primaryCompletionDateStruct.date}`, study.hasResults && 'results posted'].filter(Boolean).join('; '),
                treatments.length > 0 && `Treatments: ${clip(treatments.join(', '), 300)}`, countries.length > 0 && `Where: ${clip(countries.join(', '), 200)}`,
                clip(String(part.descriptionModule?.briefSummary || '').replace(/\s+/g, ' '), whole ? 2500 : 350),
                whole && outcomes.length > 0 && `Measured: ${clip(outcomes.join('; '), 1200)}`, whole && part.eligibilityModule?.eligibilityCriteria && `Who may join: ${clip(part.eligibilityModule.eligibilityCriteria, 3500)}`].filter(Boolean).join('\n');
        };
        const number = String(input.nct_id ?? '').toUpperCase().match(/NCT\d{8}/)?.[0];
        if (number) return { content: line(await medicalJson(`${api}/${number}?format=json`), true) };
        const condition = medicalTerm(input.condition);
        const treatment = medicalTerm(input.treatment);
        if (!condition && !treatment) return { content: 'Nothing was searched. Give condition, treatment or nct_id.', failed: 'failed' };
        const states = { recruiting: 'RECRUITING', active: 'ACTIVE_NOT_RECRUITING', completed: 'COMPLETED', 'not yet recruiting': 'NOT_YET_RECRUITING', terminated: 'TERMINATED' };
        const query = new URLSearchParams({ format: 'json', countTotal: 'true', pageSize: String(medicalCount(input.max, 15, 6)) });
        if (condition) query.set('query.cond', condition);
        if (treatment) query.set('query.intr', treatment);
        if (medicalTerm(input.country)) query.set('query.locn', medicalTerm(input.country));
        if (states[input.status]) query.set('filter.overallStatus', states[input.status]);
        if (/^[1-4]$/.test(String(input.phase ?? ''))) query.set('filter.advanced', `AREA[Phase]PHASE${input.phase}`);
        const found = await medicalJson(`${api}?${query}`);
        const studies = found.studies || [];
        if (studies.length === 0) return { content: 'ClinicalTrials.gov has no studies on those words.' };
        return { content: [`${Number(found.totalCount || studies.length).toLocaleString('en-GB')} studies match; these are the first ${studies.length}.`, ...studies.map((study) => line(study, false))].join('\n\n') };
    })
};
const LABEL_PARTS = {
    uses: ['indications_and_usage'], dosage: ['dosage_and_administration', 'dosage_forms_and_strengths'], warnings: ['boxed_warning', 'contraindications', 'warnings_and_cautions', 'warnings'],
    interactions: ['drug_interactions', 'drug_interactions_table'], side_effects: ['adverse_reactions'], special_groups: ['pregnancy', 'pediatric_use', 'geriatric_use', 'use_in_specific_populations'], ingredients: ['active_ingredient', 'description', 'inactive_ingredient', 'spl_unclassified_section']
};
const DRUG_FACTS = {
    name: 'drug_facts',
    label: 'FDA drug data',
    doing: 'Reading FDA drug data…',
    description: 'Reads openFDA, the US Food and Drug Administration\'s public data on one drug: its official label (uses, dosage, warnings, interactions, side_effects, special_groups, ingredients), reports of side effects (reports), recalls, shortages, and approval. Give a generic or brand name. It is for the US, and openFDA says its data is not checked for use in care.',
    parameters: { type: 'object', properties: { drug: { type: 'string', description: 'Generic or brand name' }, about: { type: 'string', enum: [...Object.keys(LABEL_PARTS), 'reports', 'recalls', 'shortages', 'approval'], description: 'What to read' } }, required: ['drug', 'about'] },
    run: medicalRun('openFDA', async (input) => {
        const drug = medicalTerm(input.drug, 80);
        if (!drug) return { content: 'Nothing was read. Give drug.', failed: 'failed' };
        const named = (prefix = '') => encodeURIComponent(`(${prefix}openfda.generic_name:"${drug}" OR ${prefix}openfda.brand_name:"${drug}")`);
        const api = 'https://api.fda.gov/drug';
        const note = 'From openFDA, whose data is not checked for use in care: say so, and that a pharmacist or doctor decides. Other forms and strengths of a drug have labels of their own.';
        const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
        if (input.about === 'reports') {
            const found = (await medicalJson(`${api}/event.json?search=${named('patient.drug.')}&count=patient.reaction.reactionmeddrapt.exact&limit=20`)).results || [];
            return { content: `Reactions most often reported with ${drug} (a report does not show that the drug caused it, and the counts are not rates):\n${found.map((one) => `- ${one.term.toLowerCase()}: ${Number(one.count).toLocaleString('en-GB')}`).join('\n')}\n\n${note}` };
        }
        if (input.about === 'recalls') {
            const found = (await medicalJson(`${api}/enforcement.json?search=${named()}&limit=8&sort=report_date:desc`)).results || [];
            return { content: `The newest recalls of ${drug}:\n${found.map((one) => `- ${one.report_date}: ${one.classification}, ${one.status}. ${one.recalling_firm}. ${clip(one.reason_for_recall, 300)} ${clip(one.product_description, 160)}`).join('\n')}\n\n${note}` };
        }
        if (input.about === 'shortages') {
            const found = (await medicalJson(`${api}/shortages.json?search=${encodeURIComponent(`(generic_name:"${drug}" OR openfda.brand_name:"${drug}")`)}&limit=10`)).results || [];
            return { content: `Shortage records of ${drug}:\n${found.map((one) => `- ${one.generic_name}, ${one.company_name}: ${one.status}${one.availability ? `, ${one.availability}` : ''}${one.shortage_reason ? `, ${one.shortage_reason}` : ''} (updated ${one.update_date})`).join('\n')}\n\n${note}` };
        }
        if (input.about === 'approval') {
            const found = (await medicalJson(`${api}/drugsfda.json?search=${named()}&limit=5`)).results || [];
            return { content: `FDA applications for ${drug}:\n${found.map((one) => {
                const first = list(one.submissions).find((submission) => submission.submission_type === 'ORIG');
                const product = list(one.products)[0] || {};
                return `- ${one.application_number}, ${one.sponsor_name}: ${product.brand_name || ''} ${list(product.active_ingredients).map((part) => `${part.name} ${part.strength || ''}`).join(', ')}, ${product.dosage_form || ''}, ${product.marketing_status || ''}${first ? `, first approved ${first.submission_status_date}` : ''}`;
            }).join('\n')}\n\n${note}` };
        }
        const about = LABEL_PARTS[input.about] ? input.about : 'uses';
        // Many labels hold a name: metformin is also in a dozen combinations, whose doses are not its own. The drug by
        // itself is found first, and a combination is read only when there is nothing else, and then said to be one.
        const names = ((await medicalJson(`${api}/label.json?search=${named()}&count=openfda.generic_name.exact&limit=100`)).results || []).map((one) => String(one.term)).filter((name) => !name.includes('"'));
        const mixed = (name) => /,|;|\/|\band\b|\bwith\b/i.test(name);
        const holds = (name) => name.toLowerCase().includes(drug.toLowerCase());
        const generic = names.some(holds) ? names.find((name) => holds(name) && !mixed(name)) || names.find(holds) : names.find((name) => !mixed(name)) || names[0];
        if (!generic) return { content: `openFDA has no label for ${drug}.` };
        const label = ((await medicalJson(`${api}/label.json?search=${named()}${encodeURIComponent(` AND openfda.generic_name.exact:"${generic}"`)}&limit=1`)).results || [])[0];
        if (!label) return { content: `openFDA has no label for ${drug}.` };
        const others = names.filter((name) => name !== generic && mixed(name)).length;
        const which = mixed(generic) && !holds(generic) ? `${drug} is a combination: ${generic.toLowerCase()}.` : mixed(generic) && !/ and |,|;|\//i.test(drug) ? `This is the label of a combination (${generic.toLowerCase()}), not of ${drug} alone: its doses are not ${drug}'s.` : others > 0 && holds(generic) ? `Combinations with ${drug} have labels of their own, which this is not.` : '';
        const parts = LABEL_PARTS[about].flatMap((key) => list(label[key]).map((text) => `${key.replace(/_/g, ' ').toUpperCase()}\n${clip(String(text).replace(/\s+/g, ' '), 3500)}`));
        const titles = [list(label.openfda?.brand_name)[0], list(label.openfda?.generic_name)[0], list(label.openfda?.manufacturer_name)[0]].filter(Boolean).join(', ');
        return { content: [`The label of ${titles || drug}, effective ${label.effective_time || 'unknown'}:`, which, parts.length > 0 ? clip(parts.join('\n\n'), 9000) : `This label has no section on ${about.replace(/_/g, ' ')}.`, note].filter(Boolean).join('\n\n') };
    })
};
const ICD10_LOOKUP = {
    name: 'icd10_lookup',
    label: 'ICD-10 codes',
    doing: 'Looking up ICD-10 codes…',
    description: 'Looks up ICD-10-CM diagnosis codes in the US National Library of Medicine\'s tables, by words (such as type 2 diabetes neuropathy) or by a code or the start of one (such as E11.4). Use it for every code you give, instead of remembering it.',
    parameters: { type: 'object', properties: { terms: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 40, description: 'How many codes. Fifteen when left out.' } }, required: ['terms'] },
    run: medicalRun('The ICD-10 table', async (input) => {
        const terms = medicalTerm(input.terms, 120);
        if (!terms) return { content: 'Nothing was looked up. Give terms.', failed: 'failed' };
        const [total, , , rows] = await medicalJson(`https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code,name&df=code,name&maxList=${medicalCount(input.max, 40, 15)}&terms=${encodeURIComponent(terms)}`);
        if (!Array.isArray(rows) || rows.length === 0) return { content: 'No ICD-10-CM code matches. Try fewer words.' };
        return { content: `${Number(total).toLocaleString('en-GB')} codes match; these are the first ${rows.length}.\n${rows.map(([code, name]) => `- ${code}: ${name}`).join('\n')}` };
    })
};
const CMS_DATASETS = { part_d: '7e0b4365-fd63-4a29-8f5e-e0ac9f66a81b', part_b: '76a714ad-3a2c-43ac-b76d-9dadf8f7d890', medicaid: 'be64fce3-e835-4589-b46b-024198e524a6' };
const MEDICARE_SPENDING = {
    name: 'medicare_drug_spending',
    label: 'Medicare drug spending',
    doing: 'Reading Medicare drug spending…',
    description: 'Reads the US Centers for Medicare and Medicaid Services\' yearly figures on one drug: total spending, claims, people and average cost, over five years, in Medicare Part D (drugs from a pharmacy), Part B (drugs given in a clinic) or Medicaid.',
    parameters: { type: 'object', properties: { drug: { type: 'string', description: 'Brand or generic name' }, program: { type: 'string', enum: Object.keys(CMS_DATASETS), description: 'part_d when left out' } }, required: ['drug'] },
    run: medicalRun('The CMS data', async (input) => {
        const drug = medicalTerm(input.drug, 80);
        if (!drug) return { content: 'Nothing was read. Give drug.', failed: 'failed' };
        const program = CMS_DATASETS[input.program] ? input.program : 'part_d';
        const rows = await medicalJson(`https://data.cms.gov/data-api/v1/dataset/${CMS_DATASETS[program]}/data?size=40&keyword=${encodeURIComponent(drug)}`);
        const mine = (Array.isArray(rows) ? rows : []).filter((row) => !row.Mftr_Name || row.Mftr_Name === 'Overall').slice(0, 6);
        if (mine.length === 0) return { content: `The ${program.replace('_', ' ')} figures have nothing on ${drug}.` };
        const money = (value) => (Number.isFinite(Number(value)) && value !== '' ? `$${Math.round(Number(value)).toLocaleString('en-US')}` : 'not given');
        const count = (value) => (Number.isFinite(Number(value)) && value !== '' ? Number(value).toLocaleString('en-US') : 'not given');
        return { content: mine.map((row) => {
            const years = [...new Set(Object.keys(row).map((key) => key.match(/^Tot_Spndng_(\d{4})$/)?.[1]).filter(Boolean))].sort();
            return `${row.Brnd_Name} (${row.Gnrc_Name})${row.HCPCS_Cd ? `, ${row.HCPCS_Cd}` : ''}, ${program.replace('_', ' ')}:\n${years.map((year) => `- ${year}: ${money(row[`Tot_Spndng_${year}`])} in all, ${count(row[`Tot_Clms_${year}`])} claims${row[`Tot_Benes_${year}`] ? `, ${count(row[`Tot_Benes_${year}`])} people` : ''}, ${money(row[`Avg_Spnd_Per_Clm_${year}`] ?? row[`Avg_Spndng_Per_Clm_${year}`])} a claim`).join('\n')}`;
        }).join('\n\n') + '\n\nFrom CMS. Spending is before rebates from makers.' };
    })
};
const SKILL_FUNCTIONS = {
    'medical-pubmed-literature-search': [PUBMED_SEARCH],
    'medical-evidence-synthesis-ai': [PUBMED_SEARCH, TRIALS_SEARCH],
    'medical-systematic-review-assistant': [PUBMED_SEARCH, TRIALS_SEARCH],
    'medical-clinical-guideline-navigator': [PUBMED_SEARCH],
    'medical-precision-medicine-therapeutics': [PUBMED_SEARCH, TRIALS_SEARCH, DRUG_FACTS],
    'medical-clinical-trials-search': [TRIALS_SEARCH],
    'medical-fda-drug-information': [DRUG_FACTS],
    'medical-drug-interaction-checker': [DRUG_FACTS],
    'medical-supplement-drug-interactions': [DRUG_FACTS, PUBMED_SEARCH],
    'medical-medication-administration-safety': [DRUG_FACTS],
    'medical-pediatric-drug-dosing': [DRUG_FACTS],
    'medical-icd10-code-lookup': [ICD10_LOOKUP],
    'medical-raf-score-calculator': [ICD10_LOOKUP],
    'medical-prior-authorization-review': [ICD10_LOOKUP, DRUG_FACTS],
    'medical-medicare-drug-stats': [MEDICARE_SPENDING],
    'anthropic-algorithmic-art': ART_FUNCTIONS,
    'cadsmith-make-model': [CAD_BUILD, CAD_CHANGE, CAD_EXPORT],
    'cadsmith-edit-model': [CAD_BUILD, CAD_CHANGE, CAD_EXPORT],
    'cadsmith-make-mechanism': [MECH_RUN, CAD_CHANGE],
    'cadsmith-export-model': [CAD_EXPORT],
    'hairline-hairline-create': [{
        name: 'hairline_build',
        label: 'Hairline build',
        doing: 'Building the figure…',
        description: 'Does what `node build.mjs <name>.js` and `node validate.mjs` do in the Hairline skill, without Node: makes the checks validate.mjs makes on your figure and returns what it would print, then puts the figure on the bench (bench.html with kernel.js and the figure in their two slots, nothing else changed) and shows the finished page to the user in the chat. Give the whole figure file. When it returns things to fix, mend them with hairline_change. Use this instead of asking the user to run anything. The look (look.mjs) needs a browser, which you do not have here: when you are done, say in one sentence that you have not seen the figure drawn.',
        parameters: { type: 'object', properties: { code: { type: 'string', description: 'The whole figure file as you would save it in <name>.js, ending with its hairline({ ... }) call' }, unfinished: PART_UNFINISHED }, required: ['code'] },
        run: async (input, context) => (input?.unfinished === true ? keepPart('hairline', input.code, null, context, 'hairline_change') : buildFigure(String(input?.code ?? ''), context))
    }, {
        name: 'hairline_change',
        label: 'Hairline build',
        doing: 'Mending the figure…',
        description: 'Changes the last figure given to hairline_build in this chat, then checks and shows it as hairline_build does. Use it to mend or improve a figure instead of sending the whole of it again: give only the pieces that change.',
        parameters: { type: 'object', properties: { change: CHANGES, add: PART_ADD, unfinished: PART_UNFINISHED, show: { type: 'string', description: 'Lines of the figure to read, such as 40-80. Nothing is built.' } } },
        run: async (input, context) => {
            const key = programKey(context.userId, context.chat);
            const code = chatFigures.get(key)?.hairline;
            if (!code) return { content: 'There is no figure in this chat to change. Build one with hairline_build.', failed: 'failed' };
            if (String(input?.show ?? '').trim()) return { content: shownLines(code, input.show) };
            const edited = editHeld(code, input);
            if (edited.problem) return { content: `Nothing was changed or built. ${edited.problem}`, failed: 'failed' };
            if (input?.unfinished === true) return keepPart('hairline', edited.code, null, context, 'hairline_change');
            return buildFigure(edited.code, context);
        }
    }, {
        name: 'hairline_read',
        label: 'Hairline read',
        doing: 'Reading the drawing…',
        ready: () => sandboxReady(),
        changes: (input) => Boolean(String(input?.file ?? '').trim()),
        description: 'Does what `node read.mjs <file.svg>` does in step 0 of the Hairline skill, for a figure made from a drawing the user already has (an icon, a logo, an illustration): it draws the SVG and returns the card of what it measured, which source.md says how to read. Give the SVG as text, or the path of an .svg file in the user\'s FilesystemOne. A model that can see is given the picture too.',
        parameters: { type: 'object', properties: { svg: { type: 'string', description: 'The whole SVG, as text' }, file: { type: 'string', description: 'Or the FilesystemOne path of the .svg file, such as /docs/logo.svg' } } },
        run: async (input) => readDrawing(input)
    }],
    'anatomy-anatomy': [{
        name: 'anatomy_build',
        label: 'Anatomy build',
        doing: 'Building the figure…',
        ready: () => sandboxReady(),
        description: 'Does what `node examples/<name>/build.mjs` does in the Anatomy skill, then shows the page to the user in the chat. Your build script is run in the skill\'s own folder as examples/figure/build.mjs, so it imports the kit as the examples do ("../../kit/iso-kit.mjs", "../../scripts/inline-kit.mjs"), and it must write one .html page next to itself. The page is then opened in a browser with the pointer moved across it, and the skill\'s line check (scripts/lines.mjs) is run on it. Give the whole build script. When it returns things to fix, mend them with anatomy_change. The page is shown in the app\'s colours, light or dark, so --light is not needed; the kit\'s tones (hi, mid, lo, faint, lit) are all the colour a figure needs, and a colour of your own does not follow the theme. Use this for an Anatomy figure instead of run_program or a page of your own. You cannot see the page from here.',
        parameters: { type: 'object', properties: { code: { type: 'string', description: 'The whole build script as you would save it in examples/<name>/build.mjs' }, unfinished: PART_UNFINISHED }, required: ['code'] },
        run: async (input, context) => (input?.unfinished === true ? keepPart('anatomy', input.code, null, context, 'anatomy_change') : buildAnatomy(String(input?.code ?? ''), context))
    }, {
        name: 'anatomy_change',
        label: 'Anatomy build',
        doing: 'Mending the figure…',
        ready: () => sandboxReady(),
        description: 'Changes the last build script given to anatomy_build in this chat, then builds, checks and shows it as anatomy_build does. Use it to mend or add to a figure instead of sending the whole script again: give only the pieces that change.',
        parameters: { type: 'object', properties: { change: CHANGES, add: PART_ADD, unfinished: PART_UNFINISHED, show: { type: 'string', description: 'Lines of the build script to read, such as 40-80. Nothing is built.' } } },
        run: async (input, context) => {
            const code = chatFigures.get(programKey(context.userId, context.chat))?.anatomy;
            if (!code) return { content: 'There is no build script in this chat to change. Build one with anatomy_build.', failed: 'failed' };
            if (String(input?.show ?? '').trim()) return { content: shownLines(code, input.show) };
            const edited = editHeld(code, input);
            if (edited.problem) return { content: `Nothing was changed or built. ${edited.problem}`, failed: 'failed' };
            if (input?.unfinished === true) return keepPart('anatomy', edited.code, null, context, 'anatomy_change');
            return buildAnatomy(edited.code, context);
        }
    }],
    'explainer-visual-explainer': [{
        name: 'visual_explainer_render',
        label: 'Visual Explainer render',
        doing: 'Rendering the page…',
        ready: () => sandboxReady(),
        description: 'Does what `node kit/render.mjs <name>.src.html` does in the Visual Explainer skill, then shows the page to the user in the chat: it renders your page source with the skill\'s kit, looks at it in a browser, and gives you the report. Give the whole source page as you would write <name>.src.html, linking the kit with <link rel="stylesheet" data-ve-kit>. Every <svg> needs an aria-label saying what it shows (aria-hidden="true" when it is decoration). The page is shown in the app\'s own theme, which takes the place of the kit\'s colours and fonts, so pick no register or palette and add no theme picker. ' + APP_COLOURS + ' The kit\'s own variables (var(--bg), var(--surface), var(--border), var(--text), var(--text-dim), var(--accent), var(--success), var(--warn), var(--risk), var(--info)) follow the theme too. When the report lists a ✗, mend it with visual_explainer_change. Nothing is saved to the user\'s files.',
        parameters: { type: 'object', properties: { page: { type: 'string', description: 'The whole page source, as <name>.src.html' }, unfinished: PART_UNFINISHED, title: { type: 'string', description: 'A few words naming the page' } }, required: ['page'] },
        run: async (input, context) => (input?.unfinished === true ? keepPart('visual_explainer', input.page, { title: input?.title }, context, 'visual_explainer_change') : buildExplainer(String(input?.page ?? ''), input?.title, context))
    }, {
        name: 'visual_explainer_change',
        label: 'Visual Explainer render',
        doing: 'Mending the page…',
        ready: () => sandboxReady(),
        description: 'Changes the last page given to visual_explainer_render in this chat, then renders, checks and shows it as visual_explainer_render does. Use it to mend or improve a page instead of sending the whole of it again: give only the pieces that change.',
        parameters: { type: 'object', properties: { change: CHANGES, add: PART_ADD, unfinished: PART_UNFINISHED, title: { type: 'string', description: 'A new title, only when it changes' }, show: { type: 'string', description: 'Lines of the page to read, such as 120-150. Nothing is rendered.' } } },
        run: async (input, context) => {
            const held = chatFigures.get(programKey(context.userId, context.chat))?.visual_explainer;
            if (!held) return { content: 'There is no page in this chat to change. Render one with visual_explainer_render.', failed: 'failed' };
            if (String(input?.show ?? '').trim()) return { content: shownLines(held.code, input.show) };
            const edited = editHeld(held.code, input);
            if (edited.problem) return { content: `Nothing was changed or rendered. ${edited.problem}`, failed: 'failed' };
            if (input?.unfinished === true) return keepPart('visual_explainer', edited.code, held, context, 'visual_explainer_change');
            return buildExplainer(edited.code, input?.title ?? held.title, context);
        }
    }]
};
// What the Hairline kit's own validate.mjs says of a figure. With sandboxes set up, the kit's two commands run in one as
// the skill writes them: build.mjs puts the figure on the bench and validate.mjs checks that page. A figure should not
// wait long on a sandbox starting, so when sandboxes are not set up, the job takes longer than HAIRLINE_WAIT or it fails,
// the checks kept here (hairlineFaults) are made instead.
const HAIRLINE_WAIT = 75000;
// A figure that passes the checks may still not run, so the page is opened in the sandbox's browser as well: errors are
// collected while the pointer is taken across the stage and the slider is moved, and what was drawn is counted.
export const FIGURE_PROBE = String.raw`
const errors = [];
const say = (text) => { const line = String(text || '').split('\n')[0].slice(0, 200); if (line && !errors.includes(line)) errors.push(line); };
addEventListener('error', (event) => say(event.message));
addEventListener('unhandledrejection', (event) => say(event.reason && event.reason.message || event.reason));
addEventListener('load', async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  await wait(900);
  const stage = document.getElementById('stage') || document.querySelector('.iso-stage') || document.body;
  const shapes = [...stage.querySelectorAll('path,circle,ellipse,line,rect,polygon,polyline')];
  const drawn = shapes.filter((one) => one.tagName !== 'path' || (one.getAttribute('d') || '').length > 4).length;
  // Only what is drawn is read for bad values: a page's scripts may hold those words and be right.
  const lost = [];
  let bad = 0;
  for (const one of stage.querySelectorAll('svg, svg *')) {
    for (const given of one.attributes) {
      if (/^(aria-|class$|id$|data-)/.test(given.name) || !/NaN|undefined|Infinity/.test(given.value)) continue;
      bad += 1;
      const part = one.closest('[data-part]');
      if (lost.length < 3) lost.push('<' + one.tagName + (one.getAttribute('class') ? ' class="' + one.getAttribute('class') + '"' : '') + ' ' + given.name + '="' + given.value.slice(0, 70) + '">' + (part ? ' in part ' + part.getAttribute('data-part') : ''));
    }
  }
  const box = stage.getBoundingClientRect();
  for (let y = 1; y < 8; y += 1) {
    for (let x = 1; x < 8; x += 1) {
      const target = stage.querySelector('svg') || stage;
      target.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', pointerId: 1, bubbles: true, clientX: box.left + box.width * x / 8, clientY: box.top + box.height * y / 8 }));
    }
    await wait(60);
  }
  stage.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', pointerId: 1, bubbles: true }));
  await wait(900);
  const slider = document.getElementById('intensity');
  if (slider) {
    slider.value = '1';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);
  }
  const shown = document.getElementById('error');
  if (shown && !shown.hidden) say(shown.textContent);
  const out = document.createElement('pre');
  out.id = 'figure-probe';
  out.textContent = JSON.stringify({ errors: errors.slice(0, 4), drawn, bad, lost });
  document.body.append(out);
});
`;
const HAIRLINE_JOB = String.raw`node /root/skills/hairline-create/build.mjs figure.js page.html >/dev/null 2>&1 || exit 3
node /root/skills/hairline-create/validate.mjs page.html
said=$?
node -e 'const fs=require("fs");const p=fs.readFileSync("page.html","utf8");fs.writeFileSync("check.html",p.replace("<script id=\"hl-kernel\">",()=>"<script>"+fs.readFileSync("probe.js","utf8")+"</script><script id=\"hl-kernel\">"))'
timeout 40 chromium --headless --no-sandbox --disable-gpu --window-size=900,900 --virtual-time-budget=9000 --dump-dom "file://$PWD/check.html" 2>/dev/null | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>{const m=t.match(/<pre id="figure-probe">([^<]*)<\/pre>/);console.log("PROBE "+(m?m[1].replace(/&quot;/g,"\"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"):"none"))})'
rm -f probe.js check.html page.html
exit $said`;
// What the browser found wrong, in the words the model is told.
export const probeFaults = (probe) => {
    if (!probe) return [];
    if (probe.errors?.length > 0) return [`run: the figure fails when it is opened in a browser: ${probe.errors.join('; ')}`];
    if (probe.drawn < 3) return ['run: the figure draws nothing on the stage when it is opened in a browser.'];
    return probe.bad ? [`run: ${Number(probe.bad) > 1 ? `${probe.bad} things are` : 'something is'} drawn at NaN, undefined or Infinity${(probe.lost || []).length > 0 ? `: ${probe.lost.join('; ')}` : ''}.`] : [];
};
const cannotShow = (faults) => faults.some((fault) => /^run: the figure (fails|draws nothing)/.test(fault));
let hairlineWait = HAIRLINE_WAIT;
export const setHairlineWait = (ms) => {
    hairlineWait = ms ?? HAIRLINE_WAIT;
};
const hairlineChecks = async (code) => {
    const local = () => ({ faults: hairlineFaults(code), ran: false });
    if (!sandboxReady()) return local();
    try {
        const job = runInSandbox({ language: 'bash', seconds: 90, files: [{ path: 'figure.js', buffer: Buffer.from(`${code}\n`) }, { path: 'probe.js', buffer: Buffer.from(FIGURE_PROBE) }], code: HAIRLINE_JOB });
        job.catch(() => {});
        const checked = await Promise.race([job, new Promise((resolve) => { setTimeout(() => resolve(null), hairlineWait).unref?.(); })]);
        if (!checked || checked.timedOut || ![0, 1].includes(checked.exitCode)) return local();
        // It prints one line for each thing to fix and then a count, as errors, or a single line starting "ok".
        const lines = `${checked.stderr || ''}\n${checked.stdout || ''}`.split('\n').map((line) => line.trim()).filter(Boolean);
        let probe = null;
        try {
            probe = JSON.parse(lines.find((line) => line.startsWith('PROBE {'))?.slice(6) || 'null');
        } catch {
            probe = null;
        }
        const said = lines.filter((line) => !line.startsWith('PROBE ') && !/^\d+ to fix in /.test(line));
        if (checked.exitCode === 1 && said.length === 0) return local();
        return { faults: [...probeFaults(probe), ...(checked.exitCode === 0 ? [] : said)], ran: Boolean(probe) };
    } catch {
        return local();
    }
};

// The last figure of each chat, so it is mended without being written again.
const chatFigures = new Map();
const keepFigure = (userId, chat, code, kind = 'hairline') => {
    const key = programKey(userId, chat);
    const held = { ...chatFigures.get(key), [kind]: code };
    chatFigures.delete(key);
    chatFigures.set(key, held);
    if (chatFigures.size > MAX_KEPT_PROGRAMS) chatFigures.delete(chatFigures.keys().next().value);
};
// What a figure may call, for a model that got its figure wrong without having read it.
const kernelIndex = (kept) => {
    if (kept?.has('file:hairline-hairline-create/kernel.js')) return '';
    const text = skillFileText(SKILL_BY_ID.get('hairline-hairline-create'), 'kernel.js') || '';
    const end = text.indexOf('var HL');
    if (end < 0) return '';
    kept?.set('file:hairline-hairline-create/kernel.js', true);
    return `\n\nWhat a figure may call, from kernel.js (nothing else exists):\n${text.slice(0, end).trim()}`;
};
// What a Hairline figure took from HL that HL does not have, with the nearest real name and how it is called.
export const kernelHelp = (code) => {
    const text = skillFileText(SKILL_BY_ID.get('hairline-hairline-create'), 'kernel.js') || '';
    const end = text.indexOf('var HL');
    const index = new Map([...(end > 0 ? text.slice(0, end) : '').matchAll(/^ \*   ([A-Za-z_$][\w$]*)(\([^)]*\))?\s{2,}(.+)$/gm)].map((found) => [found[1], `${found[1]}${found[2] || ''}: ${found[3].trim()}`]));
    if (index.size === 0) return '';
    const taken = [...code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*HL\b/g)].flatMap((found) => found[1].split(',').map((one) => one.split(':')[0].trim()).filter(Boolean));
    const called = [...code.matchAll(/\bHL\.([A-Za-z_$][\w$]*)/g)].map((found) => found[1]);
    const lines = [];
    for (const name of new Set([...taken, ...called])) {
        if (index.has(name)) continue;
        const mine = pairsOf(name);
        const near = [...index.keys()].map((one) => ({ one, share: 2 * [...pairsOf(one)].filter((pair) => mine.has(pair)).length / Math.max(1, mine.size + pairsOf(one).size) })).filter((one) => one.share >= 0.4).sort((a, b) => b.share - a.share).slice(0, 2).map((one) => one.one);
        lines.push(`${name} is not in HL.${near.length > 0 ? ` The nearest ${near.length === 1 ? 'is' : 'are'}:\n${near.map((one) => `- ${index.get(one)}`).join('\n')}` : ''}`);
    }
    return lines.length > 0 ? `\n\n${lines.slice(0, 8).join('\n')}` : '';
};
const buildFigure = async (given, { show, kept, chat, userId }) => {
    const code = given.replace(/\r\n/g, '\n').trim();
    const call = [...code.matchAll(/\bhairline\s*\(\s*\{/g)].at(-1);
    if (code.startsWith(PROGRAM_AWAY)) return { content: 'Nothing was built. Give the whole figure, or mend the last one with hairline_change.', failed: 'failed' };
    if (!call) return { content: 'Nothing was built. A figure file ends with hairline({ name, means, rules, range, tour, mount }).', failed: 'failed' };
    if (code.includes('```')) return { content: 'Nothing was built. The figure must not contain three backticks in a row.', failed: 'failed' };
    if (code.length > MAX_PROGRAM_CHARS) return { content: 'Nothing was built. The figure is too long.', failed: 'failed' };
    const name = /\bname:\s*["'`]([a-z][a-z0-9-]*)["'`]/.exec(code.slice(call.index))?.[1] || 'figure';
    keepFigure(userId, chat, code);
    // A figure with something to fix is sent back once before it is shown, as the skill has it fixed before the
    // look. A second build is shown whatever is left, so the person is never left with nothing; one that does not run
    // or draws nothing is never shown.
    const { faults, ran } = await hairlineChecks(code);
    const before = kept?.get('hairline_build') || 0;
    kept?.set('hairline_build', before + 1);
    const block = ['```component', `<Frame template="hairline-hairline-create/bench.html" height="640px" title="Hairline ${name}" palette="ground:background, ink:text, muted:text 65%, line:border, hairline-plate:background, hairline-hi:text, hairline-edge:text 55%, hairline-mid:text 32%, hairline-lo:border">`, '<Part name="KERNEL" file="hairline-hairline-create/kernel.js" />', '<Part name="FIGURE">', code, '</Part>', '</Frame>', '```'].join('\n');
    const broken = cannotShow(faults);
    const showing = `Hairline ${name}`;
    if (faults.length > 0 && (before === 0 || broken)) {
        kept?.set('unshown', broken ? { block: `_The figure “${name}” is not shown: it did not work when it was opened._`, key: showing } : { block, key: showing });
        return { content: [`Not shown yet. ${faults.length} to fix in hairline-${name}.html:`, ...faults, `Mend these with hairline_change, sending only the lines that change.${kernelHelp(code)}${kernelIndex(kept)}`].join('\n'), failed: 'failed' };
    }
    kept?.delete('unshown');
    show(block, showing);
    const seen = ran ? 'It was opened in a browser, the pointer and the slider were moved, and it ran without errors.' : 'It was not opened in a browser here.';
    return { content: faults.length > 0
        ? [`Built hairline-${name}.html and showed it to the user in the chat, with ${faults.length} still to fix:`, ...faults, `Tell the user what is still wrong, or mend it with hairline_change. You cannot see the page from here.${kernelIndex(kept)}`].join('\n')
        : `Built hairline-${name}.html and showed it to the user in the chat. validate: ok, the figure passes the static checks. ${seen} You cannot see the page from here, so the look has not been done.` };
};

// The Hairline skill's own reading of a drawing the person has, run from the skill's folder in a sandbox.
const readDrawing = async (input) => {
    const nothing = (why) => ({ content: `Nothing was read. ${why}`, failed: 'failed' });
    let svg = String(input?.svg ?? '').trim();
    const file = String(input?.file ?? '').trim();
    if (!svg && file) {
        try {
            svg = (await readPersonFiles(personFiles(), [file]))[0].buffer.toString('utf8').trim();
        } catch {
            return nothing(`${file} could not be read from the user's FilesystemOne. Check the path with them.`);
        }
    }
    if (!/<svg[\s>]/i.test(svg)) return nothing('Give the SVG as text in svg, or the path of an .svg file in file.');
    if (svg.length > 400000) return nothing('The SVG is too long.');
    let answer;
    try {
        answer = await runInSandbox({ language: 'bash', seconds: 120, files: [{ path: 'source.svg', buffer: Buffer.from(svg) }], code: 'node /root/skills/hairline-create/read.mjs source.svg --name source 2>&1' });
    } catch (error) {
        return nothing(error.message);
    }
    const said = String(answer.stdout || '').replace(/\/root\/work\//g, '').trim();
    if (answer.exitCode !== 0 || !said) return { content: `The drawing could not be read.\n${clip(said || answer.stderr, 3000)}`, failed: 'failed' };
    const picture = (answer.files || []).find((one) => /-source\.png$/.test(one.path) && one.buffer.length <= MAX_LOOK_BYTES);
    return { content: `${clip(said, 6000)}\n\n${picture ? 'The picture of the drawing is attached.' : 'No picture is attached.'} source.md says how to read the card.`, ...(picture ? { images: [picture.buffer.toString('base64')] } : {}) };
};

// An Anatomy figure is a build script the model writes, run as the skill's examples are: in the skill's own folder in a
// sandbox, beside the kit it imports. The page it writes is opened in the sandbox's browser as a Hairline figure is, and
// the skill's own line check is run on it. Nothing is run on this server, so without sandboxes there is no such function.
const ANATOMY_JOB = String.raw`home=/root/skills/anatomy
there=$home/examples/figure
work=$PWD
rm -rf $there && mkdir -p $there && cp build.mjs $there/build.mjs && ln -s ../../kit $there/kit && ln -s ../../scripts $there/scripts
cd $there
timeout 150 node build.mjs > $work/build.txt 2>&1
built=$?
page=$(ls -t *.html 2>/dev/null | head -1)
cd $work
rm -f build.mjs
if [ $built -ne 0 ] || [ -z "$page" ]; then echo "BUILD $built"; tail -c 3000 build.txt; rm -f build.txt probe.js; exit 3; fi
cp "$there/$page" page.html
echo "PAGE $page"
# A value that is not a number is found where it is drawn: the kit of this computer, which is thrown away, is made to
# stop at the first one, and the script is run once more to see its line.
if node -e 'const t=require("fs").readFileSync("page.html","utf8").replace(/<(script|style)[\s\S]*?<\/\1>/g,"");process.exit(/(NaN|Infinity)/.test((t.match(/ (d|cx|cy|x|y|points|transform)="[^"]*"/g)||[]).join(" "))?0:1)'; then
  sed -i 's/^const tenth = (value) => {/&if (!Number.isFinite(value)) throw new Error("drawn at " + value);/' $home/kit/iso-kit.mjs
  (cd $there && timeout 60 node build.mjs 2>&1) | grep -v "const tenth" | grep -E "drawn at|build\.mjs:[0-9]+" | sed -E 's#(file://)?/root/skills/anatomy/(examples/figure/)?##g' | head -6 | tr '\n' ' ' | sed 's/^/WHERE /'
  echo
fi
node -e 'const fs=require("fs");const p=fs.readFileSync("page.html","utf8");fs.writeFileSync("check.html",p.replace("</head>",()=>"<script>"+fs.readFileSync("probe.js","utf8")+"</script></head>"))'
timeout 40 chromium --headless --no-sandbox --disable-gpu --window-size=1000,900 --virtual-time-budget=9000 --dump-dom "file://$PWD/check.html" 2>/dev/null | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>{const m=t.match(/<pre id="figure-probe">([^<]*)<\/pre>/);console.log("PROBE "+(m?m[1].replace(/&quot;/g,"\"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"):"none"))})'
CHROME_PATH=$(command -v chromium) timeout 90 node $home/scripts/lines.mjs page.html 2>&1 | grep -A 8 "^line ends:"
rm -f probe.js check.html build.txt
exit 0`;
// The page is drawn in the app's colours: the kit's tones are worked out from the theme's surface and text, light or
// dark as the app is, and are the kit's own wherever the page is opened outside the app.
const ANATOMY_THEME = (() => {
    const surface = 'var(--app-surface,light-dark(#fbfbfa,#131313))';
    const text = 'var(--app-text,light-dark(#18181a,#e6e6e6))';
    const to = (colour, share) => `color-mix(in srgb,${colour} ${share}%,${surface})`;
    const tone = (light, dark) => `light-dark(${light},${dark})`;
    const tones = {
        page: 'var(--app-background,light-dark(#f2f2ef,#0b0b0b))', card: surface, paper: surface, strong: text, text: to(text, 70), muted: to(text, 46),
        face: tone(to('#fff', 80), to('#fff', 4)), top: tone(to('#fff', 80), to('#fff', 4.5)),
        'shade-0': tone(to('#000', 12), to('#000', 22)), 'shade-1': tone(to('#000', 9), to('#000', 6)), 'shade-2': tone(to('#000', 6), to('#fff', 1)), 'shade-3': tone(to('#000', 3), to('#fff', 2.5)),
        'lit-top': tone('#fff', to('#fff', 9)), 'lit-shade': tone(to('#000', 5), to('#fff', 5)),
        hi: to(text, 92), mid: to(text, 45), lo: to(text, 24), faint: to(text, 13), lit: tone('#000', '#fff'), dot: to(text, 95),
        halo: tone(to('#000', 16), to('#000', 75)), red: tone('#e5484d', '#ff6b6b'), green: tone('#30a46c', '#6be0a0'), blue: tone('#3e63dd', '#6b9bff')
    };
    return `<style>@supports (color:light-dark(#000,#fff)){.iso,.iso[data-theme]{${Object.entries(tones).map(([name, value]) => `--anatomy-${name}:${value};`).join('')}}}.iso-page{margin:0 auto;padding:20px 0 24px}</style>`;
})();
const MAX_SHOWN_PAGE = 1500000;
// What the kit gives, read from its own files: each export with its arguments, as references/kit.md writes them where it
// does, and what that page says the function is for.
const KIT_MODULES = ['iso-kit', 'lathe', 'tube', 'audit', 'gl', 'turn-build'];
let kitRead = null;
const anatomyKit = () => {
    if (kitRead) return kitRead;
    const skill = SKILL_BY_ID.get('anatomy-anatomy');
    const pageRows = new Map();
    for (const row of (skillFileText(skill, 'references/kit.md') || '').split(/\r?\n/)) {
        const cells = row.startsWith('|') ? row.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim()) : [];
        if (cells.length < 4) continue;
        const about = cells[2].replace(/`/g, '').match(/^[\s\S]{0,180}?(?:[.:](?=\s|$)|$)/)?.[0] || '';
        for (const [, name, args] of cells[1].matchAll(/`([A-Za-z_$][\w$]*)(\([^`]*\))`/g)) {
            if (!pageRows.has(name)) pageRows.set(name, { call: `${name}${args}`, about });
        }
    }
    kitRead = new Map();
    for (const part of KIT_MODULES) {
        const text = (skillFileText(skill, `kit/${part}.mjs`) || '').replace(/\r\n/g, '\n');
        const names = new Map();
        for (const found of text.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
            const open = text.slice(found.index + found[0].length).match(/^\s*(?:=\s*)?\(/);
            let call = found[1];
            if (open) {
                const start = found.index + found[0].length + open[0].length;
                let end = start;
                for (let deep = 1; end < text.length && deep > 0; end += 1) deep += '([{'.includes(text[end]) ? 1 : ')]}'.includes(text[end]) ? -1 : 0;
                call = `${found[1]}(${text.slice(start, end - 1).replace(/\s+/g, ' ')})`;
            }
            names.set(found[1], { call, about: '', ...(open ? pageRows.get(found[1]) : {}) });
        }
        if (names.size > 0) kitRead.set(part, names);
    }
    return kitRead;
};
// What a made-up name most often stands for; the rest are matched by how alike the names are.
const KIT_MEANT = [
    [/box|cube|cuboid|prism|block|plate|slab|rect|panel|base/i, ['slabOf', 'extrude']],
    [/cyl|disc|disk|circle|round|post|knob/i, ['cylinder', 'circleRing']],
    [/poly|shape|outline/i, ['extrude', 'planOutline']],
    [/build|render|page|html|export|save|write|create|main|scene|live/i, ['pageHtml', 'plateHtml', 'figureSvg']],
    [/svg|figure|canvas|card/i, ['figureSvg', 'plateHtml']],
    [/solid|draw|fill|mesh/i, ['solidSvg']],
    [/text|label/i, ['faceTextSvg']],
    [/line|stroke|path/i, ['lineSvg', 'segment', 'lineOnTop']],
    [/tick|ruler|scale|gauge/i, ['topTicks', 'radialTicks']],
    [/camera|project|view|fit/i, ['fitProjection']],
    [/move|translate|shift/i, ['translateAlong', 'groupSvg']],
    [/spring/i, ['coil']],
    [/screw|dot|bolt|rivet/i, ['dotsSvg', 'pointsAt']],
    [/wire|cable|connect/i, ['wireSvg']],
    [/group|layer/i, ['groupSvg']]
];
const pairsOf = (word) => new Set([...word.toLowerCase()].slice(0, -1).map((letter, at) => letter + word.toLowerCase()[at + 1]));
const kitMeant = (name, part) => {
    const mine = pairsOf(name);
    const alike = [...anatomyKit().get(part)].filter(([, { call }]) => call.includes('(')).map(([one]) => one).map((one) => {
        const theirs = pairsOf(one);
        return { one, share: 2 * [...mine].filter((pair) => theirs.has(pair)).length / Math.max(1, mine.size + theirs.size) };
    }).filter((one) => one.share >= 0.5).sort((a, b) => b.share - a.share).map((one) => one.one);
    const meant = part === 'iso-kit' ? KIT_MEANT.filter(([words]) => words.test(name)).flatMap(([, ones]) => ones) : [];
    return [...new Set(meant.length > 0 ? meant : alike)].slice(0, 3);
};
// For a script that failed: every name in it the kit does not have, what was probably meant, and how to call that and
// the kit functions on the line that failed. The script is read for them, so all of them come back at once.
export const kitHelp = (code, said = '', kept = null) => {
    const kit = anatomyKit();
    if (!kit.has('iso-kit')) return '';
    const lines = [];
    const uses = new Set();
    const aliases = new Map();
    const bare = new Map();
    let wrong = false;
    const missing = (shown, name, part) => {
        wrong = true;
        const other = ['lathe', 'tube', 'gl'].find((one) => one !== part && kit.get(one)?.has(name));
        const meant = other ? [] : kitMeant(name, part);
        meant.forEach((one) => uses.add(`${part}/${one}`));
        if (other) uses.add(`${other}/${name}`);
        lines.push(`${shown} does not exist.${other ? ` ${name} is in kit/${other}.mjs.` : meant.length > 0 ? ` Use ${meant.join(' or ')}.` : ''}`);
    };
    const script = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const [, what, part] of script.matchAll(/\bimport\s+([^;'"]+?)\s+from\s*["'][^"']*\/kit\/([\w-]+)\.mjs["']/g)) {
        if (!kit.has(part)) continue;
        const all = what.match(/\*\s*as\s+([\w$]+)/);
        if (all) aliases.set(all[1], part);
        for (const one of (what.match(/\{([\s\S]*)\}/)?.[1] || '').split(',').map((each) => each.trim()).filter(Boolean)) {
            const [name, as] = one.split(/\s+as\s+/);
            if (kit.get(part).has(name)) bare.set(as || name, [part, name]);
            else missing(name, name, part);
        }
    }
    const seen = new Set();
    for (const [, owner, name] of [...script.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g), ...said.matchAll(/TypeError: ([\w$]+)\.([\w$]+) is not a function/g)]) {
        if (seen.has(`${owner}.${name}`)) continue;
        seen.add(`${owner}.${name}`);
        if (aliases.has(owner)) {
            if (!kit.get(aliases.get(owner)).has(name)) missing(`${owner}.${name}`, name, aliases.get(owner));
        } else if (bare.has(owner) && said.includes(`${owner}.${name} is not a function`)) {
            missing(`${owner}.${name}`, name, bare.get(owner)[0]);
            lines.push(`${owner} is one function of the kit, not the kit: import it whole with import * as k from "../../kit/${bare.get(owner)[0]}.mjs".`);
        }
    }
    const unknown = said.match(/ReferenceError: ([A-Za-z_$][\w$]*) is not defined/)?.[1];
    const holder = unknown && [...kit].find(([, names]) => names.has(unknown))?.[0];
    if (holder) {
        uses.add(`${holder}/${unknown}`);
        const alias = [...aliases].find(([, part]) => part === holder)?.[0];
        lines.push(`${unknown} is in kit/${holder}.mjs: ${alias ? `write ${alias}.${unknown}` : 'import it'}.`);
    }
    // What was called where it failed: on the lines of the script that are named, and the kit's own functions on the way.
    const whole = code.split('\n');
    for (const [, at] of said.matchAll(/(?<![\w/])build\.mjs:(\d+)/g)) {
        for (const [, owner, name] of (whole[Number(at) - 1] || '').matchAll(/(?:(?<![\w$.])([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
            if (owner ? aliases.has(owner) && kit.get(aliases.get(owner)).has(name) : bare.has(name)) uses.add(owner ? `${aliases.get(owner)}/${name}` : bare.get(name).join('/'));
        }
    }
    for (const [, name, part] of said.matchAll(/at (?:Module\.|Object\.)?([\w$]+) \((?:file:\/\/)?(?:\S*\/)?kit\/([\w-]+)\.mjs:/g)) {
        if (kit.get(part)?.has(name)) uses.add(`${part}/${name}`);
    }
    const out = [];
    if (lines.length > 0) out.push([...new Set(lines)].slice(0, 12).join('\n'));
    if (uses.size > 0) {
        out.push(`How to call ${uses.size === 1 ? 'it' : 'them'}:\n${[...uses].slice(0, 10).map((one) => {
            const [part, name] = one.split('/');
            const { call, about } = kit.get(part).get(name);
            return `- ${part === 'iso-kit' ? '' : `(kit/${part}.mjs) `}${call}${about ? `: ${about}` : ''}`;
        }).join('\n')}\nA plan is { x, y, w, d, r }, a point is [x, y, z], a floor point is [x, y] and P is what fitProjection returns.`);
    }
    if (wrong && !kept?.has('anatomy:kit')) {
        kept?.set('anatomy:kit', true);
        out.push('A solid is drawn in two steps, k.solidSvg(k.slabOf(plan, 0, 12, P)), with P = k.fitProjection(k.boxCorners(plan, 0, 12), 650, 420). The page is k.pageHtml({ title, body: k.plateHtml({ fig: "Fig 1", title, hint, body: k.figureSvg({ width: 650, height: 420, label, body }) }) }), written beside the script with writeFileSync.');
        for (const part of new Set(['iso-kit', ...aliases.values(), ...[...bare.values()].map(([one]) => one)])) {
            out.push(`All that kit/${part}.mjs exports (nothing else is in it): ${[...kit.get(part)].map(([name, { call }]) => (part === 'iso-kit' ? call : name)).join('; ')}`);
        }
    }
    return out.length > 0 ? `\n\n${out.join('\n\n')}` : '';
};
// A page that fails in the browser fails in the script the build writes into it, which is another place from the build
// script. What each mistake of that kind means, in the kit's own terms.
const pageHelp = (code, said) => {
    const kit = anatomyKit().get('iso-kit');
    if (!kit || !said) return '';
    const out = [];
    for (const [, name] of said.matchAll(/Identifier '([\w$]+)' has already been declared/g)) {
        out.push(kit.has(name) && /kitScript\s*\(/.test(code)
            ? `${name} is one of the kit's functions, and kitScript() already puts every one of them into the page under its own name. Take your own ${name} out of the page's script and call the kit's.`
            : `${name} is written twice in the page's script, perhaps once as a function and once as a const. Give one of them another name.`);
    }
    for (const [, name] of said.matchAll(/\b([\w$]+) is not defined/g)) {
        if (name === 'k') out.push('The page has no k. With kitScript() the kit\'s functions are in the page under their own names: write slabOf(...) there, not k.slabOf(...).');
        else if (kit.has(name)) out.push(`${name} is a kit function. The page has it only when its script begins with kitScript(), as in pageHtml({ script: kitScript() + live }).`);
        else if (new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)) out.push(`${name} is written in the build script, which has finished before the page opens, so the page cannot call it. The page can use only what is inside its own script and the kit's functions. Either write ${name} inside the page's script, or draw that part once in the build script inside <g id="..."> and move it in the page with translateAlong.`);
    }
    for (const [, name, method] of said.matchAll(/\b([\w$]+)\(\.\.\.\)\.([\w$]+) is not a function/g)) {
        if (kit.has(name)) out.push(`${kit.get(name).call} does not return a list, so .${method}() fails on it.${/^(slabOf|cylinder|extrude)$/.test(name) ? ' It returns the paths of a solid: solidSvg(...) turns them into markup.' : ''}`);
    }
    return out.length > 0 ? `\n\n${[...new Set(out)].join('\n')}` : '';
};
const buildAnatomy = async (given, { show, kept, chat, userId }) => {
    const code = given.replace(/\r\n/g, '\n').trim();
    const nothing = (why) => ({ content: `Nothing was built. ${why}`, failed: 'failed' });
    if (code.startsWith(PROGRAM_AWAY)) return nothing('Give the whole build script, or mend the last one with anatomy_change.');
    if (!/kit\/iso-kit\.mjs/.test(code)) return nothing('An Anatomy figure is drawn with the skill\'s kit. The build script imports it as examples/dial-indicator/build.mjs does, with import * as k from "../../kit/iso-kit.mjs", and writes its page with k.pageHtml.');
    if (code.includes('```')) return nothing('The build script must not contain three backticks in a row.');
    if (code.length > MAX_PROGRAM_CHARS) return nothing('The build script is too long.');
    keepFigure(userId, chat, code, 'anatomy');
    let answer;
    try {
        answer = await runInSandbox({ language: 'bash', seconds: 300, files: [{ path: 'build.mjs', buffer: Buffer.from(`${code}\n`) }, { path: 'probe.js', buffer: Buffer.from(FIGURE_PROBE) }], code: ANATOMY_JOB });
    } catch (error) {
        return nothing(error.message);
    }
    const lines = String(answer.stdout || '').replace(/\r/g, '').split('\n');
    const built = (answer.files || []).find((one) => one.path === 'page.html');
    const mend = 'Mend it with anatomy_change, sending only the lines that change.';
    if (answer.timedOut || !built) {
        const said = lines.filter((line) => !/^(BUILD|PAGE|PROBE|WHERE) |^\s+at .*\(?node:internal|^\s+at (async )?ModuleJob|^Node\.js v/.test(line)).join('\n').replace(/(file:\/\/)?\/root\/skills\/anatomy\/(examples\/figure\/)?/g, '').trim();
        const why = answer.timedOut || lines.includes('BUILD 124') ? 'the build script ran for too long'
            : lines.includes('BUILD 0') ? 'the build script wrote no page. It must write one .html file next to itself, as the examples do with writeFileSync and k.pageHtml'
                : 'the build script failed';
        return { content: `Nothing was shown: ${why}.${said ? `\n${clip(said, 3000)}` : ''}\n${mend}${kitHelp(code, said, kept)}`, failed: 'failed' };
    }
    const name = (lines.find((line) => line.startsWith('PAGE ')) || '').slice(5).replace(/\.html$/, '').replace(/[^\w -]/g, '').slice(0, 60) || 'figure';
    const page = built.buffer.toString('utf8');
    let probe = null;
    try {
        probe = JSON.parse(lines.find((line) => line.startsWith('PROBE {'))?.slice(6) || 'null');
    } catch {
        probe = null;
    }
    const where = clip((lines.find((line) => line.startsWith('WHERE ')) || '').slice(6).replace(/\s+/g, ' ').trim(), 500);
    const at = lines.findIndex((line) => /^line ends: \d+/.test(line));
    const floating = at < 0 ? null : Number(lines[at].match(/\d+/)[0]);
    const solids = (page.match(/class="iso-solid/g) || []).length;
    const strokes = (page.match(/class="iso-line/g) || []).length;
    const faults = [
        ...probeFaults(probe),
        ...(where ? [`where: ${where}`] : []),
        ...colourFaults(page.replace(/<style\b[\s\S]*?<\/style>/gi, '')),
        ...(page.length > MAX_SHOWN_PAGE || page.includes('```') ? [`run: the figure fails to fit in the chat: its page is ${page.length.toLocaleString('en-GB')} characters${page.includes('```') ? ' and holds three backticks in a row' : ''}.`] : []),
        ...(solids < 3 ? ['kit: the page draws no solids with the kit (k.solidSvg of k.slabOf, k.cylinder or k.extrude), so it is a flat drawing.'] : []),
        ...(floating > 0 ? [`lines: ${[lines[at], ...lines.slice(at + 1, at + 8).filter((line) => /^\s+\S/.test(line))].join('\n')}\nEvery line ends on a stroke, a dot or an outline, or is marked free, as scripts/lines.mjs says.`] : [])
    ];
    const before = kept?.get('anatomy_build') || 0;
    kept?.set('anatomy_build', before + 1);
    const showing = `Anatomy ${name}`;
    const block = ['```component', `<Frame height="560px" title="${showing}">`, page.replace(/<\/head>/i, () => `${ANATOMY_THEME}</head>`), '</Frame>', '```'].join('\n');
    const broken = cannotShow(faults);
    const counts = `It draws ${solids} solids and ${strokes} lines.`;
    // As with a Hairline figure: one with something to fix goes back once, a second build is shown whatever is left, and
    // one that does not run or draws nothing is never shown.
    if (faults.length > 0 && (before === 0 || broken)) {
        kept?.set('unshown', broken ? { block: `_The figure “${name}” is not shown: it did not work when it was opened._`, key: showing } : { block, key: showing });
        return { content: `${[`Not shown yet. ${faults.length} to fix in ${name}.html:`, ...faults, mend].join('\n')}${kitHelp(code, where, kept)}${pageHelp(code, faults.join('\n'))}`, failed: 'failed' };
    }
    kept?.delete('unshown');
    show(block, showing);
    const seen = probe ? 'It was opened in a browser, the pointer was moved across it, and it ran without errors.' : 'It was not opened in a browser here.';
    const ends = floating === 0 ? ' The line check found no floating ends.' : floating === null ? ' The line check did not run.' : '';
    return { content: faults.length > 0
        ? [`Built ${name}.html and showed it to the user in the chat, with ${faults.length} still to fix:`, ...faults, `Tell the user what is still wrong, or mend it with anatomy_change. ${counts} You cannot see the page from here.`].join('\n')
        : `Built ${name}.html and showed it to the user in the chat, in the app's colours. ${counts} ${seen}${ends} You cannot see the page from here, so the close-ups the skill asks for have not been done.` };
};

// An Algorithmic Art page is the skill's viewer template with its variable parts filled: the model gives the sketch and a
// list of controls, and what the template says to always keep is taken from it word for word. The page names p5.js at
// the template's own address; the chat puts its local copy there, since a sealed page has no network.
const ART = 'anthropic-algorithmic-art';
const ART_STYLE = '<style>body{background:var(--app-background,#faf9f5)!important}.container{min-height:0!important}.sidebar{width:260px;box-shadow:none!important;background:var(--app-surface,#fff)!important;border:1px solid var(--anthropic-light-gray)}.seed-input,.seed-input:focus{background:var(--anthropic-light)!important;color:var(--anthropic-dark)}#canvas-container{background:var(--app-surface,#fff)!important;box-shadow:none!important}@media (max-width:820px){.container{flex-direction:column-reverse}.canvas-area{padding:0!important}.sidebar{width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 24px}.sidebar h1,.sidebar .subtitle{grid-column:1/-1}.sidebar .subtitle{margin-bottom:20px}}</style>';
const ART_PALETTE = 'anthropic-dark:text, anthropic-light:background, anthropic-mid-gray:text 60%, anthropic-light-gray:border, anthropic-orange:primary, anthropic-blue:secondary, anthropic-green:tertiary';
const ART_HELP = String.raw`
// A colour of the app's theme, as it is now.
function appColor(name) {
  const kit = { background: 'anthropic-light', text: 'anthropic-dark', border: 'anthropic-light-gray', primary: 'anthropic-orange', secondary: 'anthropic-blue', tertiary: 'anthropic-green' };
  const style = getComputedStyle(document.documentElement);
  return (style.getPropertyValue('--app-' + name) || style.getPropertyValue('--' + (kit[name] || 'anthropic-mid-gray'))).trim() || '#888888';
}
// Controls: every slider and colour picker changes params and makes the artwork anew.
const artControls = __CONTROLS__;
const artDefaults = JSON.parse(JSON.stringify(params));
const artGet = (name) => name.split('.').reduce((at, key) => (at === undefined || at === null ? undefined : at[key]), params);
const artMake = initializeSystem;
initializeSystem = function () {
  randomSeed(params.seed);
  noiseSeed(params.seed);
  artMake();
  if (!isLooping()) redraw();
};
function artSet(name, value) {
  const keys = name.split('.');
  const last = keys.pop();
  keys.reduce((at, key) => at[key], params)[last] = value;
}
function artShow() {
  for (const one of artControls) {
    const value = artGet(one.name);
    const input = document.getElementById(one.name);
    if (value === undefined || !input) continue;
    input.value = value;
    document.getElementById(one.name + '-value').textContent = value;
  }
  updateSeedDisplay();
}
function updateParam(name, value) {
  artSet(name, Number(value));
  artShow();
  initializeSystem();
}
function updateColor(name, value) {
  artSet(name, value);
  artShow();
  initializeSystem();
}
function resetParameters() {
  Object.assign(params, JSON.parse(JSON.stringify(artDefaults)));
  artShow();
  initializeSystem();
}
window.addEventListener('load', function () {
  const loading = document.querySelector('.loading');
  if (loading) loading.style.display = 'none';
  const canvas = document.querySelector('canvas.p5Canvas');
  const holder = document.getElementById('canvas-container');
  if (canvas && !holder.contains(canvas)) holder.append(canvas);
  artShow();
  const missing = artControls.filter((one) => artGet(one.name) === undefined).map((one) => one.name);
  if (missing.length > 0) throw new Error('params has no ' + missing.join(', ') + ', which a control changes');
});
`;
const ART_PROBE = String.raw`
const errors = [];
const say = (text) => { const line = String(text || '').split('\n')[0].slice(0, 200); if (line && !errors.includes(line)) errors.push(line); };
addEventListener('error', (event) => say(event.message));
addEventListener('unhandledrejection', (event) => say(event.reason && event.reason.message || event.reason));
addEventListener('load', async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const colours = () => {
    const canvas = document.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return 0;
    const small = document.createElement('canvas');
    small.width = small.height = 96;
    const pen = small.getContext('2d');
    pen.drawImage(canvas, 0, 0, 96, 96);
    const data = pen.getImageData(0, 0, 96, 96).data;
    const seen = new Set();
    for (let at = 0; at < data.length; at += 4) seen.add((data[at] >> 2) + ',' + (data[at + 1] >> 2) + ',' + (data[at + 2] >> 2) + ',' + (data[at + 3] >> 2));
    return seen.size;
  };
  // Frames are asked for here: a browser with no screen may not run any by itself.
  const frames = (count) => {
    const until = Date.now() + 4000;
    try { for (let at = 0; at < count && Date.now() < until; at += 1) redraw(); } catch (error) { say(error.message); }
  };
  await wait(1500);
  frames(40);
  let most = colours();
  for (const input of document.querySelectorAll('.sidebar input[type="range"], .sidebar input[type="color"]')) {
    input.value = input.type === 'color' ? '#336699' : input.max;
    input.dispatchEvent(new Event(input.type === 'color' ? 'change' : 'input', { bubbles: true }));
    frames(2);
    await wait(150);
  }
  for (const button of document.querySelectorAll('.sidebar button')) {
    button.click();
    frames(2);
    await wait(150);
  }
  frames(20);
  most = Math.max(most, colours());
  const out = document.createElement('pre');
  out.id = 'figure-probe';
  out.textContent = JSON.stringify({ errors: errors.slice(0, 4), colours: most, canvas: Boolean(document.querySelector('canvas')) });
  document.body.append(out);
});
`;
const ART_JOB = String.raw`p5=/root/node/node_modules/p5/lib/p5.min.js
if [ ! -f "$p5" ]; then echo NOP5; exit 0; fi
P5="$p5" node -e 'const fs=require("fs");const p=fs.readFileSync("page.html","utf8");const lib=fs.readFileSync(process.env.P5,"utf8");fs.writeFileSync("check.html",p.replace(/<script\b[^>]*\bp5(?:\.min)?\.js["\x27][^>]*>\s*<\/script>/i,()=>"<script>"+fs.readFileSync("probe.js","utf8")+"</script><script>"+lib+"</script>"))'
timeout 70 chromium --headless --no-sandbox --disable-gpu --enable-unsafe-swiftshader --window-size=1000,900 --virtual-time-budget=12000 --dump-dom "file://$PWD/check.html" 2>/dev/null | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>{const m=t.match(/<pre id="figure-probe">([^<]*)<\/pre>/);console.log("PROBE "+(m?m[1].replace(/&quot;/g,"\"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"):"none"))})'
rm -f probe.js check.html page.html`;
const inHtml = (text) => String(text ?? '').replace(/[&<>"]/g, (one) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[one]));
const artControls = (given) => (Array.isArray(given) ? given : []).filter((one) => one && /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(String(one.name ?? ''))).slice(0, 16).map((one) => {
    const number = (value, otherwise) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : otherwise);
    const color = one.type === 'color';
    return { name: String(one.name), label: clip(String(one.label || one.name), 60), type: color ? 'color' : 'slider', ...(color ? {} : { min: number(one.min, 0), max: number(one.max, 100), step: number(one.step, 1) }) };
});
const artPage = ({ title, subtitle, controls, code }) => {
    const template = skillFileText(SKILL_BY_ID.get(ART), 'templates/viewer.html');
    if (!template) return null;
    const between = (text, from, to) => { const start = text.indexOf(from); const end = text.indexOf(to, start + from.length); return start < 0 || end < 0 ? null : [start, end]; };
    const keep = between(template, 'function updateSeedDisplay()', 'function resetParameters()');
    const sides = between(template, '<!-- Parameters Section', '<!-- Actions Section');
    const script = between(template, '<script>\n', '</script>\n</body>');
    if (!keep || !sides || !script) return null;
    const row = (one) => (one.type === 'color'
        ? `<div class="color-group"><label>${inHtml(one.label)}</label><div class="color-picker-container"><input type="color" id="${one.name}" onchange="updateColor('${one.name}', this.value)"><span class="color-value" id="${one.name}-value"></span></div></div>`
        : `<div class="control-group"><label>${inHtml(one.label)}</label><div class="slider-container"><input type="range" id="${one.name}" min="${one.min}" max="${one.max}" step="${one.step}" oninput="updateParam('${one.name}', this.value)"><span class="value-display" id="${one.name}-value"></span></div></div>`);
    const section = (name, rows) => (rows.length > 0 ? `<div class="control-section">\n<h3>${name}</h3>\n${rows.map(row).join('\n')}\n</div>\n` : '');
    const body = `${code}\n\n${template.slice(...keep).trim()}\n${ART_HELP.replace('__CONTROLS__', () => JSON.stringify(controls.map(({ name }) => ({ name }))))}`;
    const page = template.slice(0, sides[0]) + section('Parameters', controls.filter((one) => one.type === 'slider')) + section('Colors', controls.filter((one) => one.type === 'color'))
        + template.slice(sides[1], script[0]) + `<script>\n${body}\n` + template.slice(script[1]);
    return {
        body,
        page: page.replace(/<!--[\s\S]*?-->\s*/g, '').replace(/<link\b[^>]*>\s*/g, '').replace(/<title>[^<]*<\/title>/, () => `<title>${inHtml(title)}</title>`)
            .replace('<h1>TITLE - EDIT</h1>', () => `<h1>${inHtml(title)}</h1>`).replace('<div class="subtitle">SUBHEADER - EDIT</div>', () => `<div class="subtitle">${inHtml(subtitle)}</div>`)
            .replace('</head>', () => `${ART_STYLE}\n</head>`)
    };
};
const artFaults = (probe) => {
    if (!probe) return [];
    if (probe.errors?.length > 0) return [`run: the figure fails when it is opened in a browser: ${probe.errors.join('; ')}`];
    if (!probe.canvas) return ['run: the figure draws nothing: setup() made no canvas.'];
    return probe.colours < 2 ? ['run: the figure draws nothing: its canvas is one flat colour after forty frames.'] : [];
};
const buildArt = async (given, { show, kept, chat, userId }) => {
    const code = given.code.replace(/\r\n/g, '\n').trim();
    const title = clip(String(given.title || 'Algorithmic art').replace(/["<>]/g, ''), 80);
    const subtitle = clip(String(given.subtitle || ''), 160);
    const nothing = (why) => ({ content: `Nothing was built. ${why}`, failed: 'failed' });
    if (code.startsWith(PROGRAM_AWAY)) return nothing('Give the whole sketch, or mend the last one with art_change.');
    if (code.includes('```') || /<\/script/i.test(code)) return nothing('The sketch must not contain three backticks in a row or a closing script tag. Send only JavaScript, no HTML.');
    if (code.length > MAX_PROGRAM_CHARS) return nothing('The sketch is too long.');
    const lacks = [[/\b(?:let|var|const)\s+params\s*=/, 'let params = { seed: 12345, ... }'], [/\bfunction\s+setup\s*\(/, 'function setup()'], [/\bfunction\s+initializeSystem\s*\(/, 'function initializeSystem()'], [/\bfunction\s+draw\s*\(/, 'function draw()']].filter(([pattern]) => !pattern.test(code)).map(([, name]) => name);
    if (lacks.length > 0) return nothing(`The sketch has no ${lacks.join(', no ')}. Each is needed, written just so.`);
    const controls = artControls(given.controls);
    const made = artPage({ title, subtitle, controls, code });
    if (!made) return nothing('The skill\'s viewer template could not be read.');
    keepFigure(userId, chat, { code, title, subtitle, controls }, 'art');
    const faults = [];
    let probe = null;
    try {
        // Only read through for mistakes in the writing: nothing of it is run on this server.
        new vm.Script(made.body, { filename: 'sketch.js' });
    } catch (error) {
        faults.push(`run: the figure fails when it is opened in a browser: ${error.message} (${String(error.stack || '').split('\n')[0]})`);
    }
    if (faults.length === 0 && sandboxReady()) {
        try {
            const answer = await runInSandbox({ language: 'bash', seconds: 120, files: [{ path: 'page.html', buffer: Buffer.from(made.page) }, { path: 'probe.js', buffer: Buffer.from(ART_PROBE) }], code: ART_JOB });
            probe = JSON.parse(String(answer.stdout || '').split('\n').find((line) => line.startsWith('PROBE {'))?.slice(6) || 'null');
        } catch {
            probe = null;
        }
        faults.push(...artFaults(probe));
    }
    const showing = `Artwork ${title}`;
    const block = ['```component', `<Frame height="640px" title="${title}" palette="${ART_PALETTE}">`, made.page, '</Frame>', '```'].join('\n');
    if (faults.length > 0) {
        kept?.set('unshown', { block: `_The artwork “${title}” is not shown: it did not work when it was opened._`, key: showing });
        return { content: [`Not shown yet. ${faults.length} to fix in the sketch:`, ...faults, 'Mend it with art_change, sending only the lines that change.'].join('\n'), failed: 'failed' };
    }
    kept?.delete('unshown');
    show(block, showing);
    return { content: `Built "${title}" from the skill's viewer template and showed it to the user in the chat, with ${controls.length} ${controls.length === 1 ? 'control' : 'controls'}. ${probe ? 'It was opened in a browser, every control and button was used, and it ran without errors.' : 'It was not opened in a browser here.'} You cannot see the page from here. The page cannot download files; the user saves it with "Save to my files".` };
};

// A CadSmith model or mechanism is a Python script the model writes, run on the chat's own computer as the skill has it
// run: saved in output/, with what it exports left there for the next call. This goes with it and does what the skill's
// previewer and reviewer would: it measures what was exported and writes a light copy the chat's 3D viewer can draw
// (from the STEP file when there is one, so a curved part is not sent as a hundred thousand triangles).
const CAD_DRIVER = String.raw`import glob, json, os, runpy, shutil, subprocess, sys, time
NAME = __NAME__
MODE = __MODE__
PARAMS = __PARAMS__
RUN = ['uv', 'run', 'mech', 'run']
LIMIT = 900000
os.makedirs('output', exist_ok=True)
src = os.path.join('output', NAME + '.py')
if os.path.exists(NAME + '.py'):
    shutil.copyfile(NAME + '.py', src)
    os.remove(NAME + '.py')
began = time.time() - 2

def fresh(*patterns):
    found = []
    for pattern in patterns:
        found += [f for f in glob.glob(pattern, recursive=True) if os.path.getmtime(f) >= began]
    return sorted(set(found))

status = None
if MODE == 'mechanism':
    done = subprocess.run(RUN + [src, '--output-dir', 'output', '--step'] + (['-p'] + PARAMS if PARAMS else []), capture_output=True, text=True)
    sys.stdout.write(done.stdout)
    sys.stderr.write(done.stderr[-4000:])
    status = done.returncode
else:
    sys.argv = [src]
    try:
        runpy.run_path(src, run_name='__main__')
    except SystemExit as stop:
        if stop.code not in (None, 0):
            print('The script ended itself with', stop.code, file=sys.stderr)
            sys.exit(1)
    except BaseException:
        kind, error, trace = sys.exc_info()
        own = trace
        while own is not None and os.path.abspath(own.tb_frame.f_code.co_filename) != os.path.abspath(src):
            own = own.tb_next
        sys.argv = [src]
        sys.excepthook(kind, error.with_traceback(own or trace), own or trace)
        sys.exit(1)
sys.stdout.flush()

facts = {'status': status, 'models': [], 'parts': 0, 'preview': None, 'note': ''}
PALETTE = [(0.74, 0.76, 0.80), (0.36, 0.55, 0.82), (0.86, 0.56, 0.30), (0.42, 0.72, 0.52), (0.80, 0.42, 0.45), (0.62, 0.52, 0.80), (0.82, 0.74, 0.38), (0.35, 0.70, 0.74)]
try:
    import trimesh
    coarse = []
    if MODE == 'mechanism':
        stls = fresh('output/*.mech/parts/*.stl')
        facts['parts'] = len(stls)
        shown = stls[:80]
    else:
        stls = fresh('output/**/*.stl')
        steps = fresh('output/**/*.step', 'output/**/*.stp')
        try:
            if steps:
                from build123d import import_step, export_stl
            for step in steps[:3]:
                shape = import_step(step)
                size = shape.bounding_box().size
                light = step + '.light.stl'
                export_stl(shape, light, tolerance=max(size.X, size.Y, size.Z, 1e-6) / 300, angular_tolerance=0.4)
                coarse.append(light)
                fine = os.path.splitext(step)[0] + '.stl'
                if not os.path.exists(fine):
                    export_stl(shape, fine)
                    stls.append(fine)
        except Exception as problem:
            facts['note'] = 'The STEP file could not be read back (%s). ' % str(problem)[:160]
        shown = coarse or stls[:3]

    def bodies(mesh):
        if len(mesh.faces) > 400000:
            return [mesh]
        split = list(mesh.split(only_watertight=False))
        return split or [mesh]

    if MODE != 'mechanism':
        for stl in stls[:4]:
            mesh = trimesh.load(stl, force='mesh')
            facts['models'].append({
                'file': os.path.relpath(stl, 'output').replace(os.sep, '/'), 'triangles': int(len(mesh.faces)), 'bodies': len(bodies(mesh)),
                'size': [round(float(side), 3) for side in mesh.extents] if len(mesh.faces) else [0, 0, 0],
                'watertight': bool(mesh.is_watertight), 'volume': round(abs(float(mesh.volume)), 3) if mesh.is_watertight else None
            })
    pieces = []
    for stl in shown:
        mesh = trimesh.load(stl, force='mesh')
        pieces += [mesh] if MODE == 'mechanism' else bodies(mesh)[:24]
    lines, offset = [], 0
    for index, mesh in enumerate(pieces):
        tint = ' %.2f %.2f %.2f' % PALETTE[index % len(PALETTE)] if len(pieces) > 1 else ''
        lines += ['v %.3f %.3f %.3f%s' % (v[0], v[1], v[2], tint) for v in mesh.vertices]
        lines += ['f %d %d %d' % (f[0] + offset + 1, f[1] + offset + 1, f[2] + offset + 1) for f in mesh.faces]
        offset += len(mesh.vertices)
    text = '\n'.join(lines)
    if not lines:
        pass
    elif len(text) > LIMIT:
        facts['note'] += 'It is too detailed to draw in the chat (%d triangles). ' % sum(len(mesh.faces) for mesh in pieces)
    else:
        with open('cad-preview.obj', 'w') as out:
            out.write(text)
        facts['preview'] = 'cad-preview.obj'
    for light in coarse:
        os.remove(light)
except Exception as problem:
    facts['note'] += 'It could not be measured (%s: %s). ' % (type(problem).__name__, str(problem)[:200])
print('CAD ' + json.dumps(facts))
`;
const CAD_EXPORTER = String.raw`import os, runpy, sys
NAME = __NAME__
FORMAT = __FORMAT__
stl = os.path.join('output', NAME + '.stl')
step = os.path.join('output', NAME + '.step')
src = os.path.join('output', NAME + '.py')
if os.path.exists(NAME + '.py'):
    os.makedirs('output', exist_ok=True)
    if not os.path.exists(src):
        os.replace(NAME + '.py', src)
    else:
        os.remove(NAME + '.py')
if not os.path.exists(stl) and not os.path.exists(step) and os.path.exists(src):
    sys.argv = [src]
    runpy.run_path(src, run_name='__main__')
if not os.path.exists(stl) and os.path.exists(step):
    from build123d import import_step, export_stl
    export_stl(import_step(step), stl)
if not os.path.exists(stl):
    print('NOTHING')
    sys.exit(0)
import numpy, trimesh
mesh = trimesh.load(stl, force='mesh')
if FORMAT in ('glb', 'gltf'):
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-numpy.pi / 2, [1, 0, 0]))
out = os.path.join('output', NAME + '.' + FORMAT)
mesh.export(out)
os.utime(out, None)
print('EXPORTED %s %d %d' % (out, os.path.getsize(out), len(mesh.faces)))
`;
const cadName = (given, fallback) => String(given ?? '').trim().toLowerCase().replace(/\.py$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
const MAX_CAD_BLOCK = 950000;
const buildCad = async (given, input, context, mode) => {
    const { show, kept, chat, userId } = context;
    const code = given.replace(/\r\n/g, '\n').trim();
    const change = 'cad_change';
    const nothing = (why) => ({ content: `Nothing was run. ${why}`, failed: 'failed' });
    if (!code || code.startsWith(PROGRAM_AWAY)) return nothing(`Give the whole script, or mend the last one with ${change}.`);
    if (code.length > MAX_PROGRAM_CHARS) return nothing('The script is too long.');
    if (mode === 'model' && !/\b(build123d|cadquery)\b/.test(code)) return nothing('A CadSmith model is a build123d or CadQuery script, as references/build123d-guide.md shows: it starts with from build123d import * and ends by exporting to ./output/<name>.step and ./output/<name>.stl.');
    if (mode === 'mechanism' && !/\bmech\b/.test(code)) return nothing('A CadSmith mechanism is written with the skill\'s mech library, as its examples are: def build(...) -> Assembly, ending with run(build()).');
    const name = cadName(input?.name, mode === 'model' ? 'model' : 'mechanism');
    const folder = inHome(String(input?.save_to ?? '').trim() || 'CadSmith');
    keepFigure(userId, chat, { code, name, mode, folder }, 'cad');
    const params = String(input?.params ?? '').split(/[\s,]+/).filter((one) => /^[\w.]+=[\w.:+-]+$/.test(one)).slice(0, 12);
    const driver = CAD_DRIVER.replace('__NAME__', () => JSON.stringify(name)).replace('__MODE__', () => JSON.stringify(mode)).replace('__PARAMS__', () => JSON.stringify(params));
    let answer;
    try {
        answer = await runInSandbox({ language: 'python', code: driver, files: [{ path: `${name}.py`, buffer: Buffer.from(`${code}\n`) }], seconds: 600, keep: chat ? `${userId}:${chat.id}` : null });
    } catch (error) {
        return nothing(error.message);
    }
    const lines = String(answer.stdout || '').replace(/\r/g, '').split('\n');
    let facts = null;
    try {
        facts = JSON.parse(lines.find((line) => line.startsWith('CAD {'))?.slice(4) || 'null');
    } catch {
        facts = null;
    }
    // The summary's last line points at the skill's own viewer and `mech shot`, which are not here.
    const printed = lines.filter((line) => !line.startsWith('CAD {') && !(mode === 'mechanism' && /^view\b/.test(line))).join('\n').trim();
    const mend = `The script is kept. Mend it with ${change}, sending only the lines that change.`;
    if (answer.timedOut || answer.killed || (answer.exitCode !== 0 && !facts)) {
        const why = answer.killed ? 'the script was ended by the computer it ran on, most likely for using too much memory' : answer.timedOut ? 'the script ran for longer than ten minutes' : 'the script failed';
        return { content: [`Nothing was shown: ${why}.`, answer.stderr && `Errors:\n${bothEnds(answer.stderr, 3500)}`, printed && `It printed:\n${bothEnds(printed, 2500)}`, `${mend}${guideLine(chat, code, answer.stderr, kept)}`].filter(Boolean).join('\n\n'), failed: 'failed' };
    }
    const preview = (answer.files || []).find((file) => file.path === 'cad-preview.obj');
    const made = (answer.files || []).filter((file) => /^output\//.test(file.path) && /\.(py|step|stp|stl)$/i.test(file.path) && (mode === 'model' || !/\/parts\//.test(file.path)))
        .map((file) => ({ path: file.path.replace(/^output\//, ''), buffer: file.buffer }));
    const invalid = mode === 'mechanism' && facts?.status === 3;
    if (!preview && (invalid || (facts?.models || []).length === 0) && !(facts?.note || '').includes('too detailed')) {
        const why = mode === 'mechanism' ? 'the mechanism is not valid or its analysis failed, so there is nothing to draw'
            : `the script ran but exported no model. End it with export_step(result, "./output/${name}.step") and export_stl(result, "./output/${name}.stl")`;
        return { content: [`Nothing was shown: ${why}.`, printed && (mode === 'mechanism' ? printed : `It printed:\n${bothEnds(printed, 2500)}`), answer.stderr && `Errors:\n${bothEnds(answer.stderr, 2500)}`, facts?.note, mend].filter(Boolean).join('\n\n'), failed: 'failed' };
    }
    const number = (value) => Number(value).toLocaleString('en-GB', { maximumFractionDigits: 2 });
    const measured = (facts?.models || []).map((one) => `${one.file}: ${one.bodies === 1 ? '1 body' : `${one.bodies} separate bodies`}, ${one.size.map(number).join(' × ')} (x × y × z), ${one.volume === null ? 'no volume, because it is NOT watertight' : `volume ${number(one.volume)}, watertight`}, ${number(one.triangles)} triangles.`);
    const faults = (facts?.models || []).flatMap((one) => [
        one.triangles === 0 && `${one.file} is empty: nothing was exported into it.`,
        one.triangles > 0 && !one.watertight && `${one.file} is not watertight: it has open edges, so it cannot be printed or measured. A fillet or a cut that failed, or faces that only touch, leave it so.`,
        one.triangles > 0 && one.watertight && one.volume === 0 && `${one.file} has no volume: it is a flat face, not a solid.`
    ].filter(Boolean));
    const before = kept?.get('cad_build') || 0;
    kept?.set('cad_build', before + 1);
    const showing = `Model ${name}`;
    const text = preview ? preview.buffer.toString('utf8') : '';
    const block = text && text.length <= MAX_CAD_BLOCK ? ['```component', `<Model3D format="obj" fileName="${name}.obj">`, text, '</Model3D>', '```'].join('\n') : null;
    if (faults.length > 0 && before === 0) {
        if (block) kept?.set('unshown', { block, key: showing });
        return { content: [`Not shown yet. ${faults.length} to fix in ${name}:`, ...faults, ...measured, mend].join('\n'), failed: 'failed' };
    }
    kept?.delete('unshown');
    if (block) show(block, showing);
    const saved = await saveOrOffer({ fn: mode === 'model' ? 'cad_build' : 'mech_run', folder, made, context });
    const drawn = block ? `showed it to the user in the chat's 3D viewer${mode === 'mechanism' ? `, ${facts.parts} parts at the home pose` : ''}` : 'could not draw it in the chat';
    const head = mode === 'mechanism' ? `Ran ${name} and ${drawn}. The summary:` : `Built ${name} and ${drawn}${faults.length > 0 ? `, with ${faults.length} still to fix` : ''}.`;
    return { content: [head, mode === 'mechanism' ? printed : [...faults, ...measured].join('\n'), mode === 'model' && printed && `It printed:\n${bothEnds(printed, 2000)}`, mode === 'mechanism' && answer.stderr && `Errors:\n${bothEnds(answer.stderr, 2000)}`, facts?.note, saved, 'You cannot see the viewer from here.'].filter(Boolean).join('\n\n') };
};
const exportCad = async (input, context) => {
    const { chat, userId } = context;
    const held = chatFigures.get(programKey(userId, chat))?.cad;
    const name = cadName(input?.name, held?.name || 'model');
    const format = ['stl', 'obj', 'glb', 'ply', '3mf', 'off'].includes(input?.format) ? input.format : null;
    if (!format) return { content: 'Nothing was exported. Say which kind of file: stl, obj, glb, ply, 3mf or off.', failed: 'failed' };
    const script = held?.name === name && held.mode === 'model' ? [{ path: `${name}.py`, buffer: Buffer.from(`${held.code}\n`) }] : [];
    let answer;
    try {
        answer = await runInSandbox({ language: 'python', code: CAD_EXPORTER.replace('__NAME__', () => JSON.stringify(name)).replace('__FORMAT__', () => JSON.stringify(format)), files: script, seconds: 600, keep: chat ? `${userId}:${chat.id}` : null });
    } catch (error) {
        return { content: `Nothing was exported. ${error.message}`, failed: 'failed' };
    }
    const done = String(answer.stdout || '').match(/^EXPORTED (\S+) (\d+) (\d+)$/m);
    const file = done && (answer.files || []).find((one) => one.path === done[1]);
    if (!file) {
        const why = /^NOTHING$/m.test(answer.stdout || '') ? `there is no output/${name}.stl or output/${name}.step on this chat's computer. Build the model first with cad_build` : 'the export failed';
        return { content: [`Nothing was exported: ${why}.`, answer.stderr && `Errors:\n${bothEnds(answer.stderr, 2500)}`].filter(Boolean).join('\n\n'), failed: 'failed' };
    }
    const folder = inHome(String(input?.save_to ?? '').trim() || held?.folder || 'CadSmith');
    const saved = await saveOrOffer({ fn: 'cad_export', folder, made: [{ path: file.path.replace(/^output\//, ''), buffer: file.buffer }], context });
    return { content: `Exported ${name}.${format}: ${Number(done[3]).toLocaleString('en-GB')} triangles, ${Number(done[2]).toLocaleString('en-GB')} bytes.\n\n${saved}` };
};

// The render refuses a page for small things that were only left out, and a page takes a small model many minutes to
// write: the kit's link and a label on a drawing are put in for it, and it is told, so it can say them better.
const tidyExplainer = (given, title) => {
    const added = [];
    let page = given;
    if (!/data-ve-kit/.test(page)) {
        const link = '<link rel="stylesheet" href="kit.css" data-ve-kit>';
        page = /<head\b[^>]*>/i.test(page) ? page.replace(/<head\b[^>]*>/i, (head) => `${head}\n${link}`) : /<html\b[^>]*>/i.test(page) ? page.replace(/<html\b[^>]*>/i, (root) => `${root}\n<head>${link}</head>`) : `<!doctype html>\n<html lang="en">\n<head><title>${inHtml(title)}</title>${link}</head>\n<body><main>\n${page}\n</main></body>\n</html>`;
        added.push('the kit\'s link in <head>');
    }
    const heads = page.match(/<link\b[^>]*data-ve-kit[^>]*>/gi) || [];
    if (heads.length > 1) {
        let kept = false;
        page = page.replace(/<link\b[^>]*data-ve-kit[^>]*>/gi, (link) => { if (kept) return ''; kept = true; return link; });
    }
    let labels = 0;
    // Scripts are left as they are: what looks like a drawing in one is text.
    page = page.split(/(<script\b[\s\S]*?<\/script>)/i).map((part) => (/^<script\b/i.test(part) ? part : part.replace(/<(svg|pre)\b([^>]*)>(?=([\s\S]{0,400}))/gi, (tag, name, attributes, after) => {
        if (/^pre$/i.test(name) && !/\bmermaid\b/i.test(attributes)) return tag;
        if (/\baria-(label|labelledby|hidden)\b/i.test(attributes) || /^\s*<title\b/i.test(after)) return tag;
        labels += 1;
        const closed = /\/\s*$/.test(attributes);
        return `<${name}${attributes.replace(/\/\s*$/, '')} aria-label="${inHtml(title)}"${closed ? ' /' : ''}>`;
    }))).join('');
    if (labels > 0) added.push(`aria-label="${title}" on ${labels === 1 ? 'a drawing' : `${labels} drawings`} that had none`);
    return { page, added };
};
// The report says a label is too small and not how much larger it must be: a model that guesses asks again and again.
const labelSizes = (report) => {
    const least = new Map();
    for (const [, size, label] of report.matchAll(/label renders at ([0-9.]+)px at [0-9]+px \("([^"]*)"\)/g)) least.set(label, Math.min(least.get(label) ?? Infinity, Number(size)));
    const lines = [...least].filter(([, size]) => size > 0).map(([label, size]) => `“${label}”: make its font-size ${(Math.ceil((12.2 / size) * 100) / 100).toFixed(2)} times what it is`);
    return lines.length > 0 ? `\nEnough, in one change: ${lines.join('; ')}, for every label of that size, and move any that would then lie on the drawing.` : '';
};
const buildExplainer = async (given, named, { show, kept, chat, userId }) => {
    const title = clip(String(named || 'Visual explainer').replace(/["<>]/g, ''), 80);
    const source = given.replace(/\r\n/g, '\n').trim();
    if (!source || source.startsWith(PROGRAM_AWAY)) return { content: 'Nothing was rendered. Give the whole page, or mend the last one with visual_explainer_change.', failed: 'failed' };
    if (source.length > MAX_PROGRAM_CHARS) return { content: `Nothing was rendered. A page may be at most ${MAX_PROGRAM_CHARS.toLocaleString('en-GB')} characters.`, failed: 'failed' };
    const { page, added } = tidyExplainer(source, title);
    keepFigure(userId, chat, { code: page, title }, 'visual_explainer');
    const put = added.length > 0 ? `\nPut in for you: ${added.join('; ')}. Say it better with visual_explainer_change if the drawing needs it.` : '';
    const mend = 'Mend it with visual_explainer_change, sending only the lines that change.';
    let answer;
    try {
        // The rendered page asks Google for its fonts, and the check in the browser waits for the page to load, so
        // this one job may reach those two addresses and nothing else.
        answer = await runInSandbox({ language: 'bash', seconds: 120, allow: ['fonts.googleapis.com', 'fonts.gstatic.com'], files: [{ path: 'page.src.html', buffer: Buffer.from(page) }], code: 'node /root/skills/visual-explainer/kit/render.mjs page.src.html -o page.html 2>&1' });
    } catch (error) {
        return { content: `Nothing was rendered. ${error.message} The page is kept: visual_explainer_change renders it again.`, failed: 'failed' };
    }
    const report = String(answer.stdout || '').replace(/\/root\/work\//g, '').trim();
    const built = (answer.files || []).find((one) => one.path === 'page.html');
    if (!built) return { content: `Nothing was shown: the render wrote no page.\n${clip(report || answer.stderr, 4000)}${put}\n${mend}`, failed: 'failed' };
    const tinted = colourFaults(page);
    const problems = answer.exitCode !== 0 || tinted.length > 0;
    const colourLine = tinted.length > 0 ? `\n✗ ${tinted[0]}` : '';
    // A page with something to fix goes back once before it is shown, as the skill has it fixed first; a second
    // render is shown whatever is left, so the person is never left with nothing.
    const before = kept?.get('visual_explainer_render') || 0;
    kept?.set('visual_explainer_render', before + 1);
    const block = explainerBlock(built.buffer.toString('utf8'), title);
    const showing = `Visual explainer ${title}`;
    if (problems && before === 0) {
        kept?.set('unshown', { block, key: showing });
        return { content: `Not shown yet. The render found something to fix:\n${clip(report, 4000)}${colourLine}${labelSizes(report)}${put}\n${mend}`, failed: 'failed' };
    }
    kept?.delete('unshown');
    show(block, showing);
    return { content: `Rendered and showed "${title}" to the user in the chat, in the app's theme.${problems ? ' Still to fix:' : ' Report:'}\n${clip(report, 3000)}${colourLine}${problems ? labelSizes(report) : ''}${put}\n${problems ? 'The user has the page. Mend it once with visual_explainer_change if it is worth it, then go on. ' : ''}You cannot see the page from here.` };
};

// A built Visual Explainer page holds the kit's styles and scripts word for word. In the reply they are named, as Parts
// the chat fills from the skill's own files, so the chat keeps only the page's own text. A page whose kit does not
// match the files here is kept whole. The kit's colours and fonts give way to the app's theme.
const EXPLAINER = 'explainer-visual-explainer';
const EXPLAINER_PALETTE = 'bg:background, surface:surface, node-top:surface, border:border, border-bright:text 45%, text:text, text-dim:text 65%, accent:primary, accent-dim:primary 14%, ok:success, warn:warning, risk:error, info:secondary';
const explainerKit = (page) => {
    const skill = SKILLS.find((one) => one.id === EXPLAINER);
    const read = (name) => skillFileText(skill, `kit/${name}`);
    const parts = [];
    let text = page;
    const swapBlock = (tag, choices, join, prefix) => {
        const found = text.match(new RegExp(`(<${tag} data-ve-kit[^>]*>)([\\s\\S]*?)(</${tag}>)`));
        if (!found) return;
        for (const names of choices) {
            const files = names.map(read);
            if (files.some((one) => one === null)) continue;
            const whole = join(files);
            if (found[2].replace(/\r\n/g, '\n').trim() !== whole.trim()) continue;
            const markers = names.map((name, at) => `/*${prefix}_${at + 1}*/`).join('');
            names.forEach((name, at) => parts.push(`<Part name="${prefix}_${at + 1}" file="${EXPLAINER}/kit/${name}" />`));
            text = text.replace(found[0], () => `${found[1]}${markers}${found[3]}`);
            return;
        }
    };
    swapBlock('style', [['kit.css'], ['kit.css', 'ask.css'], ['kit.css', 'mermaid.css'], ['kit.css', 'ask.css', 'mermaid.css']], (files) => files.join(''), 'VE_CSS');
    swapBlock('script', [['reply.js', 'kit.js'], ['reply.js', 'ask.js', 'kit.js']], (files) => files.join('\n').replace(/<\/script/gi, '<\\/script'), 'VE_JS');
    return { text, parts };
};
const explainerBlock = (page, title) => {
    const { text, parts } = explainerKit(page);
    return ['```component', `<Frame height="720px" title="${title}" palette="${EXPLAINER_PALETTE}">`, text, ...parts, '</Frame>', '```'].join('\n');
};

// The skills whose own files are in the sandbox snapshot, by their folder there (/root/skills/<folder>). With sandboxes
// set up, these lack nothing: their commands run, as programs a model writes, beside their files.
const SANDBOX_SKILLS = { 'anthropic-docx': 'docx', 'anthropic-pptx': 'pptx', 'anthropic-xlsx': 'xlsx', 'anthropic-pdf': 'pdf', 'hairline-hairline-create': 'hairline-create', 'marketing-conversion-tracking': 'conversion-tracking', 'taste-taste-skill': 'taste', 'anatomy-anatomy': 'anatomy', 'explainer-visual-explainer': 'visual-explainer', 'cadsmith-make-model': 'cadsmith', 'cadsmith-make-mechanism': 'cadsmith', 'cadsmith-edit-model': 'cadsmith', 'cadsmith-export-model': 'cadsmith', 'anthropic-canvas-design': 'canvas-design', 'anthropic-slack-gif-creator': 'slack-gif-creator' };
// Whose files a reply may reach: the sign-in of the person who sent the message, and their home folder.
const filesScope = new AsyncLocalStorage();
const personFiles = () => createFilesClient({ baseUrl: process.env.FILESYSTEM_ONE_URL, accessToken: filesScope.getStore()?.token });
// A person's files live in /<username>; a folder made anywhere else is one they never see. A folder a model names is put
// inside their home folder unless it is already there or holds one of the files it was given (such as a shared one).
const inHome = (folder, given = []) => {
    const home = filesScope.getStore()?.home;
    const clean = `/${String(folder || '').split('/').filter((part) => part && part !== '.' && part !== '..').join('/')}`;
    if (!home || clean === home || clean.startsWith(`${home}/`)) return clean;
    if (given.some((one) => path.posix.dirname(String(one)) === clean)) return clean;
    return clean === '/' ? home : `${home}${clean}`;
};
const readPersonFiles = async (files, paths) => {
    const read = [];
    for (const one of paths) {
        const file = await files.bytes(one);
        read.push({ path: file.name, buffer: file.buffer });
    }
    return read;
};
// What a script or program made is saved beside the person's files, never over one of them.
// Files a model made and wants saved wait here for the person, who is asked without the reply being held up. They are
// kept in memory for two hours, up to SAVES_BYTES in all.
const SAVES_MS = 2 * 60 * 60 * 1000;
const SAVES_BYTES = 300 * 1024 * 1024;
const pendingSaves = new Map();
const tidySaves = () => {
    for (const [id, one] of pendingSaves) if (Date.now() - one.at > SAVES_MS) pendingSaves.delete(id);
    let bytes = [...pendingSaves.values()].reduce((sum, one) => sum + one.bytes, 0);
    for (const [id, one] of pendingSaves) {
        if (bytes <= SAVES_BYTES) break;
        bytes -= one.bytes;
        pendingSaves.delete(id);
    }
};
// What has the person's word already in this chat is saved at once; the rest is offered to them on the step.
const saveOrOffer = async ({ fn, folder, made, context }) => {
    const { chat, userId, offer } = context;
    if (made.length === 0) return '';
    if (!folder || !chat || !offer || (chat.allowedTools || []).includes(fn)) return savePersonFiles(personFiles(), folder, made);
    const id = crypto.randomBytes(8).toString('hex');
    const save = { id, folder, names: made.map((file) => file.path).slice(0, 40), state: 'waiting' };
    pendingSaves.set(id, { userId: String(userId), chatId: String(chat.id), chat, fn, folder, files: made, at: Date.now(), bytes: made.reduce((sum, file) => sum + file.buffer.length, 0), step: offer(save) });
    tidySaves();
    return `It made ${made.map((file) => file.path).join(', ')}. The user is being asked whether to save them in ${folder}; you need not wait. Go on, and do not say they are saved.`;
};
export const answerSave = asyncHandler(async (req, res) => {
    const chat = await Chat.exists({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    const held = pendingSaves.get(req.params.saveId);
    if (!chat || !held || held.chatId !== req.params.id || held.userId !== String(req.user.id)) return res.status(404).json({ success: false, message: 'These files are no longer kept. Ask for them again.' });
    const { answer } = req.body;
    let message = 'Not saved.';
    if (answer !== 'no') {
        try {
            await createFilesClient({ baseUrl: process.env.FILESYSTEM_ONE_URL, accessToken: req.cookies?.accessToken }).upload(held.folder, held.files);
        } catch (error) {
            return sendOllamaError(res, error instanceof OllamaError ? error : new OllamaError('FILE_NOT_SAVED', error.message));
        }
        message = `Saved in ${held.folder}.`;
    }
    const state = answer === 'no' ? 'dropped' : 'saved';
    pendingSaves.delete(req.params.saveId);
    if (held.step?.save) held.step.save.state = state;
    const allow = answer === 'always' ? (PROGRAM_CALLS.has(held.fn) ? [...PROGRAM_CALLS] : [held.fn]) : [];
    if (allow.length > 0) held.chat.allowedTools = [...new Set([...(held.chat.allowedTools || []), ...allow])];
    await Chat.updateOne({ _id: req.params.id }, {
        $set: { 'messages.$[message].steps.$[step].save.state': state },
        ...(allow.length > 0 ? { $addToSet: { allowedTools: { $each: allow } } } : {})
    }, { arrayFilters: [{ 'message.steps.save.id': req.params.saveId }, { 'step.save.id': req.params.saveId }] });
    getNotificationService().sendToUser(String(req.user.id), { type: 'chat:changed', data: { id: req.params.id, removed: false } });
    res.status(200).json({ success: true, state, message });
});
const savePersonFiles = async (files, folder, made) => {
    if (made.length === 0) return '';
    const names = made.map((file) => file.path).join(', ');
    if (!folder || folder === '/') return `It made ${names}, but nothing was saved. To save any of it, call change_program with save listing the files and save_to, a folder in the user's FilesystemOne: nothing is run again.`;
    try {
        await files.upload(folder, made);
        return `Saved in ${folder}: ${names}. A name already taken there was not overwritten; that file was given a new name.`;
    } catch {
        return `It made ${names}, but they could not be saved in ${folder}.`;
    }
};
// What a program printed, kept to a length with its start and its end: the end is where an error says what it is.
const bothEnds = (text, limit) => (text.length <= limit ? text : `${text.slice(0, Math.floor(limit / 3))}\n[... ${(text.length - limit).toLocaleString('en-GB')} characters left out ...]\n${text.slice(text.length - Math.ceil((limit * 2) / 3))}`);
const reportRun = (title, answer, saved) => {
    const ended = answer.killed ? `was ended by the computer it ran on after ${Math.round(answer.ranMs / 1000)} seconds, most likely for using too much memory`
        : answer.timedOut ? `was stopped because it ran longer than ${answer.seconds ? `${answer.seconds} seconds` : 'it may'}. Errors shows where it was, when that is known` : `finished with exit code ${answer.exitCode}`;
    const left = (answer.skipped || []).length > 0 ? `Not returned, being past the limit on files: ${answer.skipped.join(', ')}.` : '';
    const content = [`${title} ${ended}.`, answer.stdout && `It printed:\n${bothEnds(answer.stdout, 6000)}`, answer.stderr && `Errors:\n${bothEnds(answer.stderr, 3500)}`, saved, left].filter(Boolean).join('\n\n');
    return { content, ...(answer.timedOut || answer.exitCode !== 0 ? { failed: 'failed' } : {}) };
};
// A call touches the person's files only when it names files to send or a folder to save into: with neither, nothing
// of theirs is read and what it makes is not saved, so it runs without asking.
const saveFolder = (input, paths) => {
    const named = String(input?.save_to ?? '').trim();
    if (named) return inHome(named, paths);
    return paths[0] ? path.posix.dirname(paths[0]) : '';
};
// Only reading the person's files needs their word before a program runs; what it makes is offered to them afterwards.
const touchesFiles = (input) => Array.isArray(input?.files) && input.files.some((one) => String(one).trim());
const filesParameter = { type: 'array', items: { type: 'string' }, description: 'FilesystemOne paths of the files it works on, such as /docs/report.docx' };
const saveParameter = { type: 'string', description: 'The FilesystemOne folder for the files it makes. Left out, the folder of the first file.' };
// A program the model writes, run in a sandbox: what most skills' commands come to, and what a skill that has the model
// write its own build or check needs. One that reads or writes the person's files asks first.
const MAX_PROGRAM_CHARS = 100000;
const LOOK_TYPES = /\.(png|jpe?g|webp|gif)$/i;
const MAX_LOOKS = 6;
const MAX_LOOK_BYTES = 3 * 1024 * 1024;
const programFunction = () => ({
    name: 'run_program',
    label: 'Program',
    doing: 'Running the program…',
    changes: touchesFiles,
    description: `Runs a program you write in a computer of its own that has no network, and saves the files it makes to the user's FilesystemOne. It has Python 3 with python-docx, python-pptx, openpyxl, pandas, markitdown, pypdf, pdfplumber, pdf2image, pytesseract, reportlab, imageio and Pillow; Node with docx, pptxgenjs, react, react-dom, react-icons and sharp; and soffice (LibreOffice), chromium, pdftoppm, qpdf, pandoc and tesseract. A skill's own files are there: ${Object.entries(SANDBOX_SKILLS).map(([id, folder]) => `${SKILLS.find((skill) => skill.id === id)?.name || id} in /root/skills/${folder}`).join(', ')}. The program starts in an empty folder holding the files named in files, each under its own file name. Every file it makes or changes in that folder can be saved to save_to, or beside the first file. The user is asked first only when it is given files to read; what it makes is offered to the user to save, without holding you up. To see what you built, have the program take screenshots (chromium --headless --screenshot, or Playwright) and name them in look: they come back to you as pictures. The computer is kept for this chat between calls for ten minutes, so files a run leaves in its folder are there for the next run (you are told when a run had to start on a fresh one); only files made or changed in a run are saved or returned. A program runs for up to five minutes, or up to thirty when you set minutes.`,
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', enum: ['python', 'node', 'bash'], description: 'What the program is written in' },
            code: { type: 'string', description: 'The whole program, or its first part when unfinished is set' },
            unfinished: { type: 'boolean', description: 'True when change_program will add the rest of a long program, so it is kept and not run yet' },
            files: filesParameter,
            save_to: saveParameter,
            minutes: { type: 'integer', minimum: 1, maximum: 30, description: 'How long the program may run, in minutes. Five when left out.' },
            look: { type: 'array', items: { type: 'string' }, description: 'Pictures the program makes that you want to see, as paths in its folder, such as shots/front.png. They come back to you as images and are not saved to the user\'s files.' }
        },
        required: ['language', 'code']
    },
    run: async (input, { chat, userId, kept, offer } = {}) => {
        const language = languageOf(input);
        const code = String(input?.code ?? '');
        if (!language) return { content: 'Nothing was run. Say what the program is written in: python, node or bash.', failed: 'failed' };
        if (!code.trim() || code.startsWith(PROGRAM_AWAY)) return { content: 'Nothing was run. Give the whole program in code.', failed: 'failed' };
        if (code.length > MAX_PROGRAM_CHARS) return { content: TOO_LONG, failed: 'failed' };
        keepProgram(userId, chat, { language, code });
        if (input?.unfinished === true) return { content: keptSoFar(code) };
        return runProgram({ fn: 'run_program', language, code, input, context: { chat, userId, kept, offer } });
    }
});
const keptSoFar = (code) => `Kept, not run yet. The program has ${linesOf(code).length} lines so far. Go on with add in change_program, and leave unfinished out with the last part.`;
const languageOf = (input) => (['python', 'node', 'bash'].includes(input?.language) ? input.language : null);
const TOO_LONG = `Nothing was run. A program may be at most ${MAX_PROGRAM_CHARS.toLocaleString('en-GB')} characters.`;
const PROGRAM_AWAY = '[An earlier version of this program';
// The libraries a failed program was using: the ones its error passed through, or else the ones it asks for.
const librariesOf = (code, errors) => {
    const through = [...String(errors || '').matchAll(/(?:site-packages|node_modules)\/([A-Za-z][\w.-]*)/g)].map((match) => match[1].replace(/\.py$/, ''));
    const asked = [...String(code || '').matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)|require\(['"]([\w@/.-]+)['"]\)|from\s+['"]([\w@/.-]+)['"]/gm)].map((match) => match[1] || match[2] || match[3]);
    return [...new Set(through.length > 0 ? through : asked)].filter((name) => name.length > 3);
};
// A skill's own page about a library the program failed in, when the model has not read it in this reply.
const guideLine = (chat, code, errors, kept) => {
    const pages = skillsOf(chat).flatMap((skill) => (skill.files || []).filter((file) => /\.md$/i.test(file.path) && !kept?.has(`file:${skill.id}/${file.path}`)).map((file) => ({ skill, path: file.path })));
    const found = librariesOf(code, errors).flatMap((library) => pages.map((page) => {
        const named = page.path.toLowerCase().includes(library.toLowerCase());
        const mentions = (skillFileText(page.skill, page.path) || '').split(library).length - 1;
        return { ...page, library, score: (named ? 100 : 0) + mentions };
    })).filter((page) => page.score >= 5).sort((a, b) => b.score - a.score)[0];
    return found ? ` The skill ${found.skill.name} has a page on ${found.library} that you have not read in this reply: call open_skill_file with skill "${found.skill.id}" and file "${found.path}" before trying again.` : '';
};
// A Word, PowerPoint or Excel file a program made is checked at once with its skill's own script, on the same computer,
// when that skill is on: the skills say to run it after every build, and a small model seldom does. Excel's also
// works the formulas out, so the file that is saved holds their values. A Word or PowerPoint file is compared with an
// empty one from python-docx or python-pptx, whose own templates have a fault or two that no program made.
const OFFICE_CHECKS = [
    { ending: /\.(docx|docm|dotx)$/i, skill: 'anthropic-docx', script: 'scripts/office/validate.py', run: (file) => `python /root/skills/docx/scripts/office/validate.py ${file} --original /tmp/blank.docx` },
    { ending: /\.(pptx|pptm|potx)$/i, skill: 'anthropic-pptx', script: 'scripts/office/validate.py', run: (file) => `python /root/skills/pptx/scripts/office/validate.py ${file} --original /tmp/blank.pptx` },
    { ending: /\.(xlsx|xlsm|xltx)$/i, skill: 'anthropic-xlsx', script: 'scripts/recalc.py', run: (file) => `python /root/skills/xlsx/scripts/recalc.py ${file} 60` }
];
const checkOffice = async (chat, userId, made) => {
    if (!chat) return null;
    const on = new Set(skillsOf(chat).map((skill) => skill.id));
    const found = made.map((file) => ({ file, check: OFFICE_CHECKS.find((one) => one.ending.test(file.path) && on.has(one.skill)) })).filter((one) => one.check).slice(0, 3);
    if (found.length === 0) return null;
    const quoted = (text) => `'${String(text).replace(/'/g, '\'\\\'\'')}'`;
    const blanks = `python -c "import docx; docx.Document().save('/tmp/blank.docx')" 2>/dev/null; python -c "import pptx; pptx.Presentation().save('/tmp/blank.pptx')" 2>/dev/null\n`;
    const code = blanks + found.map(({ file, check }, at) => `out=$(${check.run(quoted(file.path))} 2>&1); echo "=== ${at} $?"; echo "$out" | tail -c 2500`).join('\n');
    let answer;
    try {
        answer = await runInSandbox({ language: 'bash', code, seconds: 240, keep: `${userId}:${chat.id}` });
    } catch {
        return null;
    }
    if (answer.fresh || answer.timedOut) return null;
    const parts = String(answer.stdout || '').split(/^=== (\d+) (\d+)$/m);
    const lines = [];
    let failed = false;
    for (let at = 1; at < parts.length; at += 3) {
        const one = found[Number(parts[at])];
        if (!one) continue;
        const said = (parts[at + 2] || '').trim();
        const wrong = parts[at + 1] !== '0' || /"status":\s*"errors_found"/.test(said);
        failed = failed || wrong;
        lines.push(`${one.file.path}, checked with ${SKILL_BY_ID.get(one.check.skill)?.name || one.check.skill}'s ${one.check.script}:${wrong ? ' it has faults to fix.' : ''}\n${said || 'It printed nothing.'}`);
        // A check that changed the file (Excel's values) is what gets saved.
        const changed = (answer.files || []).find((file) => file.path === one.file.path);
        if (changed) one.file.buffer = changed.buffer;
    }
    return lines.length > 0 ? { text: lines.join('\n\n'), failed } : null;
};
const runProgram = async ({ fn, language, code, input, context }) => {
    const { chat, userId, kept } = context;
    const minutes = Number.isFinite(Number(input?.minutes)) ? Math.min(Math.max(Math.round(Number(input.minutes)), 1), MAX_PROGRAM_SECONDS / 60) : 5;
    const paths = (Array.isArray(input?.files) ? input.files.map(String) : []).slice(0, 10);
    const folder = saveFolder(input, paths);
    const files = personFiles();
    let given;
    try {
        given = await readPersonFiles(files, paths);
    } catch {
        return { content: `Nothing was run. A file could not be read from the user's FilesystemOne: ${paths.join(', ')}. Check the path with them.`, failed: 'failed' };
    }
    let answer;
    try {
        answer = await runInSandbox({ language, code, files: given, seconds: minutes * 60, keep: chat ? `${userId}:${chat.id}` : null });
    } catch (error) {
        return { content: `Nothing was run. ${error.message}`, failed: 'failed' };
    }
    // Pictures named in look come back to the model to see; the rest is saved as usual.
    const look = (Array.isArray(input?.look) ? input.look.map((one) => String(one).trim().replace(/^\.?\//, '')) : []).filter(Boolean);
    const shots = (answer.files || []).filter((file) => look.includes(file.path) && LOOK_TYPES.test(file.path) && file.buffer.length <= MAX_LOOK_BYTES).slice(0, MAX_LOOKS);
    const toSave = (answer.files || []).filter((file) => !look.includes(file.path));
    const checked = !answer.timedOut && answer.exitCode === 0 ? await checkOffice(chat, userId, toSave) : null;
    const report = reportRun(`The ${language} program`, answer, await (paths.length > 0 ? savePersonFiles(files, folder, toSave) : saveOrOffer({ fn, folder, made: toSave, context })));
    if (checked) {
        report.content += `\n\n${checked.text}`;
        if (checked.failed) report.failed = 'failed';
    }
    if (answer.fresh) report.content = `This run started on a fresh computer: the files earlier runs left are gone.\n\n${report.content}`;
    if (report.failed && chat) report.content += `\n\nThe program is kept. To mend it, send only what changes with change_program.${guideLine(chat, code, answer.stderr, kept)}`;
    if (look.length === 0) return report;
    const missing = look.filter((one) => !shots.some((file) => file.path === one));
    const seen = [shots.length > 0 && `The pictures you asked to see are attached: ${shots.map((file) => file.path).join(', ')}.`, missing.length > 0 && `Not attached (not made, not a PNG, JPEG, WebP or GIF picture, over ${MAX_LOOK_BYTES / 1024 / 1024} MB, or past ${MAX_LOOKS} pictures): ${missing.join(', ')}.`].filter(Boolean).join(' ');
    return { ...report, content: `${report.content}\n\n${seen}`, ...(shots.length > 0 ? { images: shots.map((file) => file.buffer.toString('base64')) } : {}) };
};
// The last program of each chat, kept in memory, so a model mends or continues it without writing it all again. One
// that ran out of room in the middle of a program goes on from what is kept here.
const MAX_KEPT_PROGRAMS = 300;
const chatPrograms = new Map();
const programKey = (userId, chat) => `${userId}:${chat?.id}`;
const keepProgram = (userId, chat, program) => {
    if (!chat) return;
    chatPrograms.delete(programKey(userId, chat));
    chatPrograms.set(programKey(userId, chat), program);
    if (chatPrograms.size > MAX_KEPT_PROGRAMS) chatPrograms.delete(chatPrograms.keys().next().value);
};
const linesOf = (code) => code.replace(/\n$/, '').split('\n');
const SHOWN_LINES = 120;
const shownLines = (code, wanted) => {
    const lines = linesOf(code);
    const [first, last = first] = String(wanted).match(/\d+/g)?.map(Number) || [1, SHOWN_LINES];
    const from = Math.min(Math.max(first, 1), lines.length);
    const to = Math.min(Math.max(last, from), from + SHOWN_LINES - 1, lines.length);
    return `Lines ${from} to ${to} of ${lines.length}:\n${lines.slice(from - 1, to).join('\n')}`;
};
// What a script that failed is told besides the error, whatever skill it is for: the lines the error names and the lines
// that hold a name it complains of. A model's own script is put away to save room, and without this it asks for it back
// piece by piece.
const NAMED_FAULTS = /Identifier '([\w$]+)' has already been declared|\b([\w$]+) is not defined|\b([\w$.]+)(\(\.\.\.\))?(?:\.[\w$]+)? is not a (?:function|constructor)|NameError: name '([\w$]+)'|Cannot access '([\w$]+)' before initialization/g;
export const scriptHelp = (code, said) => {
    const lines = String(code || '').split('\n');
    const text = String(said || '');
    if (lines.length < 3 || !text) return '';
    const shown = new Set();
    // A Python error names every file it passed through: only the lines of the model's own file are its lines.
    const own = text.replace(/File "([^"]+)", line \d+/g, (frame, file) => (/(^|\/)main\.py$|\/output\/[^/]+\.py$|^[\w.-]+\.py$/.test(file) ? frame : ''));
    for (const found of [...own.matchAll(/(?:\b[\w-]+\.(?:mjs|js|py):|\bline )(\d+)\b/g)].slice(0, 3)) {
        const at = Number(found[1]);
        if (at >= 1 && at <= lines.length) for (let line = Math.max(1, at - 2); line <= Math.min(lines.length, at + 2); line += 1) shown.add(line);
    }
    const absent = [];
    const names = new Set([...text.matchAll(NAMED_FAULTS)].map((found) => (found[1] || found[2] || (found[3] || '').split('.').filter(Boolean).pop() || found[5] || found[6] || '')).filter((name) => name.length > 1));
    for (const name of [...names].slice(0, 3)) {
        const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
        const held = lines.flatMap((line, at) => (word.test(line) ? [at + 1] : []));
        if (held.length === 0) absent.push(name);
        held.slice(0, 8).forEach((line) => shown.add(line));
    }
    const out = [];
    let last = 0;
    for (const line of [...shown].sort((a, b) => a - b).slice(0, 26)) {
        if (last && line > last + 1) out.push('   …');
        out.push(`${String(line).padStart(4)}: ${clip(lines[line - 1], 170)}`);
        last = line;
    }
    return `${out.length > 0 ? `\n\nWhere that is in what you sent (line: text):\n${out.join('\n')}` : ''}${absent.length > 0 ? `\n\n${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} nowhere in what you sent.` : ''}`;
};
// The lines nearest a find text that was not found, so the right text can be copied without asking for it.
const nearLines = (code, find) => {
    const lines = code.split('\n');
    const wanted = find.split('\n').map((line) => line.trim()).filter(Boolean);
    if (wanted.length === 0 || lines.length < 2) return '';
    const words = (line) => new Set(line.match(/[\w$]+/g) || []);
    const mine = words(wanted[0]);
    let at = lines.findIndex((line) => line.trim() === wanted[0]);
    if (at < 0 && mine.size > 0) {
        const scored = lines.map((line, index) => ({ index, share: [...words(line)].filter((word) => mine.has(word)).length / Math.max(mine.size, words(line).size) })).sort((a, b) => b.share - a.share)[0];
        at = scored.share >= 0.5 ? scored.index : -1;
    }
    if (at < 0) return ' Nothing like its first line is there.';
    const from = Math.max(0, at - 1);
    const to = Math.min(lines.length, at + Math.min(wanted.length, 6) + 1);
    return `\nThe nearest lines are ${from + 1} to ${to}:\n${lines.slice(from, to).map((line) => clip(line, 200)).join('\n')}`;
};
const applyChanges = (given, change) => {
    let code = given;
    const edits = (Array.isArray(change) ? change : change ? [change] : []).filter((one) => one && typeof one === 'object');
    for (const [at, one] of edits.entries()) {
        const find = String(one.find ?? '');
        const times = find ? code.split(find).length - 1 : 0;
        if (one.all === true && times > 0) {
            code = code.split(find).join(String(one.replace ?? ''));
            continue;
        }
        if (times !== 1) return { problem: times === 0 ? `The find text of change ${at + 1} is not in it. Copy it exactly; show returns its lines.${nearLines(code, find)}` : `The find text of change ${at + 1} occurs ${times} times. Give more of the lines around it, so it occurs once.` };
        code = code.replace(find, () => String(one.replace ?? ''));
    }
    return { code };
};
const changeFunction = () => ({
    name: 'change_program',
    label: 'Program',
    doing: 'Changing the program…',
    changes: touchesFiles,
    description: 'Changes the last program of this chat and runs it again, in the same computer as run_program. Use it to mend or improve a program instead of sending the whole of it again, and to write a long program in parts: each call sends only what is new. change replaces pieces of it, add puts text after its last line, show returns lines of it, and save keeps files an earlier run made, both without running it.',
    parameters: {
        type: 'object',
        properties: {
            change: CHANGES,
            add: { type: 'string', description: 'Text put after the last line of the program' },
            unfinished: { type: 'boolean', description: 'True when more is still to come, so the program is kept and not run yet' },
            show: { type: 'string', description: 'Lines to read, such as 150-190. Nothing is run.' },
            save: { type: 'array', items: { type: 'string' }, description: 'Files an earlier run made, to save in save_to. Nothing is run.' },
            language: { type: 'string', enum: ['python', 'node', 'bash'], description: 'Only when the program was cut off before it said' },
            files: filesParameter,
            save_to: saveParameter,
            minutes: { type: 'integer', minimum: 1, maximum: 30, description: 'How long the program may run, in minutes. Five when left out.' },
            look: { type: 'array', items: { type: 'string' }, description: 'Pictures the program makes that you want to see, as in run_program' }
        }
    },
    run: async (input, { chat, userId, kept, offer } = {}) => {
        const wanted = (Array.isArray(input?.save) ? input.save : []).map((one) => String(one).trim().replace(/^(\.\/|\/root\/work\/)/, '')).filter((one) => one && !one.startsWith('/') && !one.split('/').includes('..')).slice(0, 40);
        if (wanted.length > 0) {
            const folder = String(input?.save_to ?? '').trim();
            if (!folder) return { content: 'Nothing was saved. Say which folder of the user\'s FilesystemOne in save_to.', failed: 'failed' };
            const taken = await takeFromSandbox(programKey(userId, chat), wanted);
            if (!taken) return { content: 'Nothing was saved: the computer those files were on is gone. Run the program again with save_to.', failed: 'failed' };
            const saved = await saveOrOffer({ fn: 'change_program', folder: inHome(folder), made: taken.files, context: { chat, userId, offer } });
            const lost = taken.missing.length > 0 ? `Not there: ${taken.missing.join(', ')}.` : '';
            return { content: [saved, lost].filter(Boolean).join(' '), ...(taken.files.length === 0 ? { failed: 'failed' } : {}) };
        }
        const program = chatPrograms.get(programKey(userId, chat));
        if (!program) return { content: 'There is no program in this chat to change. Write one with run_program.', failed: 'failed' };
        let { code } = program;
        if (String(input?.show ?? '').trim()) return { content: shownLines(code, input.show) };
        const edited = applyChanges(code, input?.change);
        if (edited.problem) return { content: `Nothing was changed or run. ${edited.problem}`, failed: 'failed' };
        code = edited.code;
        const add = String(input?.add ?? '');
        if (add.trim()) code = `${code}${!code || code.endsWith('\n') ? '' : '\n'}${add}`;
        if (code.length > MAX_PROGRAM_CHARS) return { content: TOO_LONG, failed: 'failed' };
        const language = languageOf(input) || program.language;
        keepProgram(userId, chat, { language, code });
        if (input?.unfinished === true) return { content: keptSoFar(code) };
        if (!language) return { content: 'The change is kept, and nothing was run. Say what the program is written in: call change_program with language.', failed: 'failed' };
        if (!code.trim()) return { content: 'Nothing was run: the program is empty.', failed: 'failed' };
        return runProgram({ fn: 'change_program', language, code, input, context: { chat, userId, kept, offer } });
    }
});
// The text of one input of a call that was cut off before its end, as far as it got.
export const cutInput = (text, name) => {
    const found = String(text ?? '').match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)`));
    if (!found) return null;
    const whole = found[1].replace(/(^|[^\\])((?:\\\\)*)\\u[0-9a-fA-F]{0,3}$/, '$1$2').replace(/[\u0000-\u001f]/g, (char) => JSON.stringify(char).slice(1, -1));
    try {
        return JSON.parse(`"${whole}"`);
    } catch {
        return null;
    }
};
const PROGRAM_CALLS = new Set(['run_program', 'change_program']);
const FIGURE_KINDS = { hairline_build: 'hairline', hairline_change: 'hairline', anatomy_build: 'anatomy', anatomy_change: 'anatomy', cad_build: 'cad', mech_run: 'cad', cad_change: 'cad', art_build: 'art', art_change: 'art', visual_explainer_render: 'visual_explainer', visual_explainer_change: 'visual_explainer' };
const FIGURE_CALLS = new Set(Object.keys(FIGURE_KINDS));
// The functions that are sent a whole figure, page or script, with what else is kept of it.
const FIGURE_BUILDS = {
    hairline_build: { field: 'code' }, anatomy_build: { field: 'code' }, visual_explainer_render: { field: 'page', extra: (text) => ({ title: cutInput(text, 'title') || undefined }) },
    art_build: { field: 'code', extra: (text) => ({ title: cutInput(text, 'title') || 'Algorithmic art', subtitle: cutInput(text, 'subtitle') || '', controls: [] }) },
    cad_build: { field: 'code', extra: (text) => ({ name: cadName(cutInput(text, 'name'), 'model'), mode: 'model', folder: inHome('CadSmith') }) },
    mech_run: { field: 'code', extra: (text) => ({ name: cadName(cutInput(text, 'name'), 'mechanism'), mode: 'mechanism', folder: inHome('CadSmith') }) }
};
// The text of the last figure or script of a kind kept for a chat.
const keptFigure = (userId, chat, kind) => {
    const held = chatFigures.get(programKey(userId, chat))?.[kind];
    return typeof held === 'string' ? held : held?.code ?? '';
};
// A call cut off before its end was not run. What there is of a program is kept, up to its last whole line, and the
// model is told where to go on; any other call has to be written again, shorter.
const keepCut = (cut, { chat, userId, ranOut }) => {
    const what = `Your call to ${clip(cut.name, 60)} was ${ranOut ? 'cut off because you ran out of room' : 'not complete, so it could not be read'}, and it was not run.`;
    const part = !ranOut ? null : cut.name === 'run_program' ? cutInput(cut.text, 'code') : cut.name === 'change_program' ? cutInput(cut.text, 'add') : null;
    const whole = part?.includes('\n') ? part.slice(0, part.lastIndexOf('\n') + 1) : '';
    if (whole.trim() && !whole.startsWith(PROGRAM_AWAY)) {
        const before = cut.name === 'change_program' ? chatPrograms.get(programKey(userId, chat)) : null;
        // Changes sent with a cut-off add were not made, so nothing of that call is kept.
        if (cut.name === 'run_program' || (before && !/"change"\s*:/.test(cut.text))) {
            const code = before ? `${before.code}${before.code.endsWith('\n') ? '' : '\n'}${whole}` : whole;
            const language = before?.language || languageOf({ language: cutInput(cut.text, 'language') });
            keepProgram(userId, chat, { language, code });
            const lines = linesOf(code);
            return {
                kept: lines.length,
                note: `${what} The program is kept as far as you got: ${lines.length} lines, ending with\n\n${lines.slice(-6).join('\n')}\n\nDo not write it again. Go on with change_program: put only the lines after these in add${language ? '' : ', and say its language'}. Send at most about 60 lines in one call, with unfinished set to true while more is to come.`
            };
        }
    }
    // A figure, page or script cut off is kept as far as its last whole line, like a program.
    const build = FIGURE_BUILDS[cut.name];
    const kind = FIGURE_KINDS[cut.name];
    const written = !ranOut ? null : build ? cutInput(cut.text, build.field) : kind && /_change$/.test(cut.name) && !/"change"\s*:/.test(cut.text) ? cutInput(cut.text, 'add') : null;
    const wholeLines = written?.includes('\n') ? written.slice(0, written.lastIndexOf('\n') + 1) : '';
    if (wholeLines.trim() && !wholeLines.startsWith(PROGRAM_AWAY)) {
        const earlier = build ? null : chatFigures.get(programKey(userId, chat))?.[kind];
        if (build || earlier) {
            const before = typeof earlier === 'string' ? earlier : earlier?.code;
            const code = before ? `${before.replace(/\s+$/, '')}\n${wholeLines}` : wholeLines;
            const extra = build?.extra ? build.extra(cut.text) : earlier && typeof earlier !== 'string' ? earlier : null;
            keepFigure(userId, chat, extra ? { ...extra, code } : code, kind);
            const lines = linesOf(code);
            return { kept: lines.length, note: `${what} It is kept as far as you got: ${lines.length} lines, ending with\n\n${lines.slice(-6).join('\n')}\n\nDo not write it again. Go on with ${kind}_change: put what comes next in add, with unfinished set until the last part.` };
        }
    }
    const advice = cut.name === 'run_program' ? 'Write the program in parts: the first part with run_program, then change_program with add.' : cut.name === 'change_program' ? 'Send less in one call.' : 'Call it again with less in it, or leave out what it can do without.';
    return { kept: 0, note: `${what} ${advice}` };
};
// Functions in words: how a model whose template has no place for functions is told of them, calls them, and is given
// back what they returned. What a call sends is written between marks as it is, because a small model seldom writes a
// long program as valid JSON.
const learnedWordy = new Set();
export const forgetWordy = () => learnedWordy.clear();
const functionWords = (tools) => ['FUNCTIONS', 'You can call the functions listed below. To call one, write it exactly like this and then stop; what it returns is given to you in the next message:',
    '<call name="open_skill">\n<arg name="skill">Anatomy</arg>\n</call>',
    'What is between the arg marks is taken as it is: write code and text there without quoting or escaping. A list of changes is written as <arg name="change"><change><find>old text</find><replace>new text</replace></change></arg>; any other list or object as JSON. Never write what a function returns yourself. Do not describe a call: make it.',
    ...tools.map(({ function: one }) => {
        const given = one.parameters?.properties || {};
        const needed = new Set(one.parameters?.required || []);
        return `- ${one.name}(${Object.entries(given).map(([name, part]) => `${name}${needed.has(name) ? '' : '?'}${part.enum ? `: ${clip(part.enum.join(' | '), 400)}` : part.type && part.type !== 'string' ? `: ${part.type}` : ''}${part.description ? ` (${clip(part.description, 140)})` : ''}`).join(', ')}): ${one.description}`;
    })].join('\n');
const callWords = (call) => {
    const given = toolArguments(call.function?.arguments) || {};
    const value = (name, one) => (name === 'change' && Array.isArray(one) ? one.map((part) => `<change><find>${part?.find ?? ''}</find><replace>${part?.replace ?? ''}</replace></change>`).join('\n') : typeof one === 'string' ? one : JSON.stringify(one));
    return `<call name="${call.function?.name}">\n${Object.entries(given).map(([name, one]) => `<arg name="${name}">${value(name, one)}</arg>`).join('\n')}\n</call>`;
};
// Where a reply in words has to stop: after its first whole call, or where the model begins to write a result itself.
// Nothing else would stop it, and a model left to go on makes up what came back, or copies out the page it was given.
export const wordCallEnd = (text, tools) => {
    const source = String(text ?? '');
    const whole = source.match(/<call\s+name=["']?([\w.-]+)["']?\s*>[\s\S]*?<\/call>/i);
    const names = (tools || []).map((tool) => tool.function.name.replace(/[^\w]/g, '\\$&')).join('|');
    const guessed = names ? source.match(new RegExp(`(?:^|\\n)\\s*(?:\\[Result of |Result of )?(?:${names})(?: returned:|\\])`)) : null;
    const ends = [whole && whole.index + whole[0].length, guessed && guessed.index].filter((one) => Number.isInteger(one));
    return ends.length > 0 ? Math.min(...ends) : -1;
};
// A result reaches such a model as a message like the person's own, so it says what it is, and the last one ends with
// what was asked: a model given a page of instructions last explains the page instead of doing the work.
const GUIDE_CALLS = new Set(['open_skill', 'open_skill_file', 'open_component']);
export const wordShape = (messages, tools, asked = '') => {
    const out = [];
    for (const message of messages) {
        if (message.role === 'assistant' && message.tool_calls?.length > 0) out.push({ role: 'assistant', content: [message.content, ...message.tool_calls.map(callWords)].filter(Boolean).join('\n') });
        else if (message.role === 'tool') {
            const text = `[Result of ${message.tool_name || 'the function'}${GUIDE_CALLS.has(message.tool_name) ? ': instructions for you to work by. The user did not write them, does not see them and does not want them explained' : ''}]\n${message.content}\n[End of the result. Go on with the request: do not write the result out again.]`;
            const last = out.at(-1);
            if (last?.returned) last.content += `\n\n${text}`;
            else out.push({ role: 'user', content: text, returned: true });
            if (message.images?.length > 0) out.at(-1).images = [...(out.at(-1).images || []), ...message.images];
        } else out.push({ ...message });
    }
    if (asked && out.at(-1)?.returned) out.at(-1).content += `\n\nThe user's request, which you are still working on:\n${clip(asked, 2000)}\n\nDo the next step of it now: call the function that does it, or answer.`;
    if (out[0]?.role === 'system') out[0].content = `${out[0].content}\n\n${functionWords(tools)}`;
    else out.unshift({ role: 'system', content: functionWords(tools) });
    return out.map(({ returned, ...message }) => message);
};
// The calls a reply ends with, what was said before them, and a call cut off before its end. What a model writes after
// a call is its own guess at what came back, and goes.
export const readWordCalls = (text, tools, ranOut = false) => {
    const source = String(text ?? '');
    const first = source.search(/<call\s+name=/i);
    if (first < 0) return { calls: [], text: source, cut: null };
    const calls = [];
    let cut = null;
    let end = first;
    for (const found of source.slice(first).matchAll(/<call\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)(<\/call>|$)/gi)) {
        const start = first + found.index;
        if (calls.length > 0 && source.slice(end, start).replace(/```\w*/g, '').trim()) break;
        const name = found[1];
        const given = tools.find((tool) => tool.function.name === name)?.function.parameters?.properties || {};
        const args = {};
        let open = null;
        for (const [, key, inner, close] of found[2].matchAll(/<arg\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)(<\/arg>|$)/gi)) {
            let value = inner.replace(/^\r?\n/, '').replace(/\s+$/, '');
            const fenced = value.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
            if (fenced) value = fenced[1];
            if (!close) open = { key, value };
            if (/<find>/i.test(value) && key === 'change') args[key] = [...value.matchAll(/<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>/gi)].map(([, find, replace]) => ({ find: find.replace(/^\r?\n|\r?\n$/g, ''), replace: replace.replace(/^\r?\n|\r?\n$/g, '') }));
            else if (given[key]?.type && given[key].type !== 'string') {
                try {
                    args[key] = JSON.parse(value);
                } catch {
                    args[key] = given[key].type === 'array' ? value.split(/\r?\n|,\s*/).map((one) => one.trim()).filter(Boolean) : value;
                }
            } else args[key] = value;
        }
        if (!found[3] && ranOut) {
            cut = { name, text: open ? `{${JSON.stringify(open.key)}:${JSON.stringify(open.value).slice(0, -1)}` : '{' };
            break;
        }
        calls.push({ function: { name, arguments: args } });
        end = start + found[0].length;
    }
    return { calls, cut, text: source.slice(0, first).replace(/(?:\s|```\w*)+$/, '') };
};
const asChatTool = (entry, shown) => ({
    fn: entry.name,
    label: entry.label,
    doing: entry.doing,
    changes: typeof entry.changes === 'function' ? entry.changes : Boolean(entry.changes),
    shown,
    definition: { type: 'function', function: { name: entry.name, description: entry.description, parameters: entry.parameters } },
    run: async (input, context) => entry.run(input, context)
});
// The skills each function belongs to, for a model that is offered a skill's functions only once it has opened it.
// A skill with functions of its own is given those; run_program goes with the skills that have none.
const skillOwners = (chat, withFiles) => {
    const owners = new Map();
    const add = (fn, id) => owners.set(fn, [...(owners.get(fn) || []), id]);
    for (const skill of skillsOf(chat)) {
        const own = (SKILL_FUNCTIONS[skill.id] || []).filter((entry) => !entry.ready || entry.ready());
        own.forEach((entry) => add(entry.name, skill.id));
        if (own.length === 0 && (SANDBOX_SKILLS[skill.id] || (skill.needs || []).includes('commands'))) [...PROGRAM_CALLS].forEach((fn) => add(fn, skill.id));
    }
    withFiles.forEach((skill) => add('open_skill_file', skill.id));
    // With no such skill on, programs are not offered: they still run if one is called.
    for (const fn of PROGRAM_CALLS) if (!owners.has(fn)) owners.set(fn, []);
    return owners;
};
const skillFunctionsFor = (chat) => {
    const active = skillsOf(chat);
    // Skills of one project share functions, and a chat is offered each once.
    const own = active.flatMap((skill) => [...(SKILL_FUNCTIONS[skill.id] || []).filter((entry) => !entry.ready || entry.ready())].map((entry) => asChatTool(entry, () => skill.name)))
        .filter((tool, at, all) => all.findIndex((one) => one.fn === tool.fn) === at);
    const writes = sandboxReady() && active.some((skill) => SANDBOX_SKILLS[skill.id] || (skill.needs || []).includes('commands'));
    return writes ? [...own, asChatTool(programFunction(), (input) => `${languageOf(input) || 'A'} program`), asChatTool(changeFunction(), (input) => (Array.isArray(input?.save) && input.save.length > 0 ? 'saving what it made' : input?.show ? `lines ${clip(input.show, 20)} of the program` : 'a change to the program'))] : own;
};
// The level above a chat's own skills is the whole library, searched by a few words. A model cannot turn a skill on:
// it names the one that would help, and the person turns it on.
const LIBRARY_STEP = 'Skill library';
// Whole words are matched, so "app" does not find "Apple"; a longer word also finds its other endings ("planning", "plans").
const FILLER_WORDS = new Set(['the', 'and', 'for', 'with', 'new', 'how', 'can', 'you', 'your', 'help', 'make', 'need', 'want', 'about', 'that', 'this']);
const wordIn = (text, word) => {
    const stem = word.replace(/(ing|ed|es|s)$/, '');
    return new RegExp(stem.length < 5 ? `\\b${stem}(s|es)?\\b` : `\\b${stem}`, 'i').test(text);
};
export const rankSkills = (skills, query) => {
    const words = (String(query ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((word) => !FILLER_WORDS.has(word));
    return skills
        .map((skill) => ({ skill, score: words.reduce((sum, word) => sum + (wordIn(skill.name, word) ? 4 : 0) + (wordIn(skill.description, word) ? 1 : 0), 0) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((hit) => hit.skill);
};
const findSkillTool = (others) => ({
    fn: 'find_skill',
    label: LIBRARY_STEP,
    changes: false,
    shown: (input) => clip(String(input?.query ?? ''), 80),
    definition: {
        type: 'function',
        function: {
            name: 'find_skill',
            description: `Search the library of ${others.length} skills for one that is not turned on in this chat. A skill is a set of expert instructions for one kind of work, such as writing a cold email, reviewing a contract or planning a launch. Returns matching skills by name and description. You cannot turn a skill on yourself: when one would help, tell the user its name and that they can turn it on under Skills.`,
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'A few words for the kind of work' } }, required: ['query'] }
        }
    },
    run: async (input) => {
        const found = rankSkills(others, input?.query);
        // What a skill cannot do, a tool the person connects may: the ones made by the app's own maker are named as well.
        const words = [...new Set(String(input?.query ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((word) => !FILLER_WORDS.has(word));
        const tools = TOOL_CATALOGUE.map((entry) => ({ entry, hits: words.filter((word) => wordIn(`${entry.name} ${entry.does}`, word)).length })).filter((one) => one.hits > 0 && one.hits * 2 >= words.length).sort((a, b) => b.hits - a.hits).slice(0, 2).map((one) => one.entry);
        const connect = tools.length > 0 ? [`Tools the user can connect on the Tools page, if they have not yet: ${tools.map((entry) => `${entry.name} (${entry.does.charAt(0).toLowerCase()}${entry.does.slice(1)})`).join('; ')}.`] : [];
        if (found.length === 0) return { content: ['No skill in the library matches. Answer without one.', ...connect].join('\n') };
        // The skills the best matches go with come too, one step out, as a note-taking app shows a page's links.
        const offered = new Set(others.map((skill) => skill.id));
        const shown = new Set(found.map((skill) => skill.id));
        const along = [];
        for (const skill of found.slice(0, 2)) {
            for (const id of SKILL_LINKS.get(skill.id) || []) {
                if (along.length >= 3 || shown.has(id) || !offered.has(id)) continue;
                shown.add(id);
                along.push({ skill: SKILL_BY_ID.get(id), with: skill.name });
            }
        }
        const line = (skill) => `- ${skill.name} (${SKILL_SOURCES[skill.source]?.name || skill.source}): ${skill.description}`;
        const lines = [...found.map(line), ...along.map((one) => `${line(one.skill)} Goes with ${one.with}.`)];
        return { content: ['These skills are not turned on in this chat. Tell the user by name which one would help and that they can turn it on under Skills, then answer as well as you can without it.', ...lines, ...connect].join('\n') };
    }
});
// A skill may end with a reminder, which is put last so it is the last thing the model reads.
const closingOf = (chat) => {
    const reminders = skillsOf(chat).map((skill) => skill.remember).filter(Boolean);
    return reminders.length > 0 ? ['REMEMBER', ...reminders].join('\n') : '';
};

// Each component the chat can draw has its own page in library/components, beside the Components skill's: every attribute, every value and what
// each does on screen. The Components skill is only the index. A model that can use tools opens the page of the
// component it is about to write, and the page is gone again once that reply is written: no page is ever sent ahead of
// need, and none is carried into the next message. A model that cannot use tools has the index alone.
export const COMPONENT_PAGES = fs.readdirSync(path.join(LIBRARY, 'components')).filter((file) => file.endsWith('.md') && file !== 'components.md').sort().map((file) => ({
    name: file.slice(0, -3),
    text: fs.readFileSync(path.join(LIBRARY, 'components', file), 'utf8').replace(/\r\n/g, '\n').trim()
}));
// A reply's components are checked by rule before the reply is finished, with no model involved: which tags exist and
// which attributes each must have are read from the index, so the check and the instructions cannot drift apart. When
// something cannot be drawn, the model that wrote it is told why, given the pages of the components it used, and
// writes the reply once more.
const COMPONENT_RULES = (() => {
    const index = SKILLS.find((skill) => skill.id === 'components').text;
    const required = (list) => String(list || '').split(',').map((word) => word.trim()).filter((word) => word.endsWith('*')).map((word) => word.slice(0, -1));
    const tags = {};
    for (const line of index.split('\n').filter((one) => one.startsWith('- '))) {
        tags[line.slice(2).split(':')[0]] = required(line.match(/Attributes: ([^.]*)\./)?.[1]);
        for (const inner of line.matchAll(/([A-Z][A-Za-z]*) tags \(([^)]*)\)/g)) tags[inner[1]] = required(inner[2]);
    }
    return tags;
})();
// Which values an attribute takes is read from the tables on each component's page: a cell that is a plain list of
// words is the whole set of values, and one that asks for a number takes only a number. Anything a page describes in
// words (text, an address, a length) is left alone, and so is a list the page says is open to other names.
const COMPONENT_VALUES = (() => {
    const word = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    const tags = {};
    for (const page of COMPONENT_PAGES) {
        let tag = page.name;
        let reading = false;
        for (const line of page.text.split('\n')) {
            if (/^#+\s/.test(line)) {
                const inner = line.match(/^###\s+([A-Z][A-Za-z0-9]*):/);
                tag = inner ? inner[1] : /^###/.test(line) ? null : tag;
                reading = false;
                continue;
            }
            if (!line.startsWith('|')) {
                reading = false;
                continue;
            }
            const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
            if (cells[0] === 'Attribute' && cells[1] === 'Values') {
                reading = true;
                continue;
            }
            if (!reading || !tag || /^-+$/.test(cells[0]) || /\bany other\b/i.test(cells[2] || '')) continue;
            const listed = cells[1].replace(/\([^)]*\)/g, '').split(',').map((one) => one.trim().replace(/ \d+(px)?$/, ''));
            const rule = listed.length >= 2 && listed.every((one) => word.test(one)) ? { values: listed }
                : /^(a number|numbers? of pixels)/.test(cells[1]) ? { number: true } : null;
            if (!rule) continue;
            tags[tag] = tags[tag] || {};
            for (const attribute of cells[0].split(',').map((one) => one.trim())) tags[tag][attribute] = tags[tag][attribute] || rule;
        }
    }
    return tags;
})();
// A model that cannot use tools cannot open a component's page, so it is given one compact page instead: the values
// each attribute takes, read from the same tables the drawing check reads. An attribute that many components share
// is listed once. It goes after the Components skill, and only to a model that has no way to ask for a page.
export const COMPONENT_VALUES_PAGE = (() => {
    const say = (rule) => (rule.values ? rule.values.join(', ') : 'a number');
    const shared = {};
    for (const attributes of Object.values(COMPONENT_VALUES)) for (const [attribute, rule] of Object.entries(attributes)) (shared[`${attribute} = ${say(rule)}`] ||= []).push(attribute);
    const common = Object.entries(shared).filter(([, uses]) => uses.length >= 4).map(([line]) => line);
    const lines = Object.entries(COMPONENT_VALUES).map(([tag, attributes]) => {
        const own = Object.entries(attributes).map(([attribute, rule]) => `${attribute} = ${say(rule)}`).filter((line) => !common.includes(line));
        return own.length > 0 ? `- ${tag}: ${own.join('; ')}` : null;
    }).filter(Boolean);
    return [
        'COMPONENT VALUES',
        'The values each attribute takes. An attribute that is not listed here takes what its name says: text, a length with its unit, a number or an address. Any other value is not drawn.',
        `On every component that has the attribute: ${common.join('; ')}`,
        ...lines
    ].join('\n');
})();
const WHOLE_TEXT_TAGS = ['Frame', 'Editor', 'Image', 'Model3D'];
const FILE_TAGS = ['Video', 'Audio', 'PdfViewer', 'Model3D', 'Editor', 'Data', 'Image'];
const TOP_COMPONENTS = COMPONENT_PAGES.map((page) => page.name);
const BARE_COMPONENT = new RegExp(`^[ \\t]*<(${TOP_COMPONENTS.join('|')})[\\s>/]`, 'm');
// The parts of a reply the chat would try to draw: fenced component blocks, and components written with no fence.
const componentBlocks = (text) => {
    const pieces = String(text ?? '').split(/(```[\s\S]*?(?:```|$))/);
    return pieces.flatMap((piece, position) => {
        if (position % 2 === 1) return /^```component\b/.test(piece) ? [piece.replace(/^```component[^\n]*\n?/, '').replace(/```\s*$/, '')] : [];
        const at = piece.search(BARE_COMPONENT);
        return at === -1 ? [] : [piece.slice(at)];
    });
};
export const componentFaults = (text) => {
    const faults = [];
    const wrongValues = new Set();
    const used = new Set();
    const known = Object.keys(COMPONENT_RULES);
    const exact = new Map(known.map((name) => [name.toLowerCase(), name]));
    // Tags written as plain text, outside any fence, are shown as text and drawn as nothing.
    const outside = String(text).replace(/```[\s\S]*?(```|$)/g, '');
    const bare = outside.match(new RegExp(`^\\s*<(${TOP_COMPONENTS.join('|')})\\b`, 'm'));
    if (bare) faults.push(`<${bare[1]}> is written as plain text, so it shows as text and is not drawn. Put component tags inside a code fence that starts with \`\`\`component.`);
    for (const block of componentBlocks(text)) {
        // Some models put program code or their own words in a component block, which draws nothing.
        if (!/^\s*<[A-Za-z]/.test(block)) {
            faults.push('A component block holds only component tags, and one of yours holds something else. Program code goes in an ordinary code fence, and words go outside the block.');
            continue;
        }
        // An Image is a still picture, so a script in one never runs.
        if (/<Image\b[^>]*>[\s\S]*?<script\b[\s\S]*?<\/Image\s*>/i.test(block)) faults.push('An Image is a still picture: the script in it never runs. Put a figure that moves in a Frame, as a whole web page, or build it with the function of a skill that draws figures.');
        // What is written inside these is their own text (a page, code, a drawing), not tags of the chat's.
        const tagsOnly = WHOLE_TEXT_TAGS.reduce((kept, name) => kept.replace(new RegExp(`(<${name}\\b[^>]*>)[\\s\\S]*?(</${name}\\s*>)`, 'gi'), '$1$2'), block);
        for (const match of tagsOnly.matchAll(/<([A-Za-z][\w]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
            const name = exact.get(match[1].toLowerCase());
            if (!name) {
                faults.push(`"${match[1]}" is not a component. The components are: ${TOP_COMPONENTS.join(', ')}.`);
                continue;
            }
            if (TOP_COMPONENTS.includes(name)) used.add(name);
            if (name === 'Button' && /\/\s*$/.test(match[2])) faults.push('A Button holds its label as text between its tags, like <Button send="Show the wiring">Show the wiring</Button>; yours has none.');
            const attributes = new Map([...match[2].matchAll(/([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g)].map((found) => [found[1], found[2] ?? found[3] ?? found[4] ?? true]));
            for (const need of COMPONENT_RULES[name]) {
                if (!attributes.has(need) || attributes.get(need) === '') faults.push(`${name} needs the attribute "${need}".`);
            }
            for (const [attribute, value] of attributes) {
                const rule = COMPONENT_VALUES[name]?.[attribute];
                if (!rule || typeof value !== 'string' || value.trim() === '') continue;
                const wrong = rule.values && !rule.values.includes(value.trim()) ? `${name}: ${attribute}="${clip(value, 30)}" is not a value it takes. ${attribute} takes: ${rule.values.join(', ')}.`
                    : rule.number && !Number.isFinite(Number(value)) ? `${name}: ${attribute}="${clip(value, 30)}" must be a number with no unit.` : null;
                if (!wrong) continue;
                faults.push(wrong);
                wrongValues.add(wrong);
            }
            const address = attributes.get('src');
            if (FILE_TAGS.includes(name) && typeof address === 'string' && address && !/^https:\/\//i.test(address)) faults.push(`${name}: src must be a full https address of a real file, not "${clip(address, 60)}". Do not make an address up.`);
        }
    }
    const kept = [...new Set(faults)].slice(0, 8);
    // When every fault is a wrong value, the fault itself says which values there are, and that is all the model needs.
    return { faults: kept, used: [...used], valuesOnly: kept.length > 0 && kept.every((fault) => wrongValues.has(fault)) };
};
const CHECK_STEP = 'Drawing check';
// The pages sent with a correction are kept to a size a small model still has room for.
const CORRECTION_PAGE_CHARS = 9000;
const correctionFor = ({ faults, used, valuesOnly }) => {
    // A small model handed a whole page for one wrong word tends to copy the page's example in place of its own work.
    if (valuesOnly) return ['The chat could not draw part of your reply as you meant it:', ...faults.map((fault) => `- ${fault}`), '\nWrite your whole reply again with only this put right, keeping everything else as you wrote it. Do not mention this correction.'].join('\n');
    const pages = [];
    let size = 0;
    for (const page of COMPONENT_PAGES.filter((one) => used.includes(one.name)).sort((a, b) => a.text.length - b.text.length)) {
        if (size + page.text.length > CORRECTION_PAGE_CHARS) break;
        pages.push(page);
        size += page.text.length;
    }
    return [
        'The chat could not draw part of your reply:',
        ...faults.map((fault) => `- ${fault}`),
        ...pages.map((page) => `\n${page.text}`),
        '\nWrite your whole reply again with this put right. Do not mention this correction.'
    ].join('\n');
};
const COMPONENT_STEP = 'Component';
// Room kept for the pages of the few components one reply draws.
const COMPONENT_ROOM = 5000;
const namesIn = (text) => String(text ?? '').split(/[\s,]+/).filter(Boolean);
const drawsComponents = (chat) => skillsOf(chat).some((skill) => skill.id === 'components');
const openComponentTool = () => {
    const find = (input) => namesIn(input?.component).map((name) => COMPONENT_PAGES.find((page) => page.name.toLowerCase() === name.toLowerCase()));
    return {
        fn: 'open_component',
        label: COMPONENT_STEP,
        changes: false,
        shown: (input) => find(input).filter(Boolean).map((page) => page.name).join(', ') || clip(String(input?.component ?? ''), 80),
        knows: (name) => COMPONENT_PAGES.some((page) => page.name.toLowerCase() === String(name).toLowerCase()),
        slip: (name) => ({ component: name }),
        definition: {
            type: 'function',
            function: {
                name: 'open_component',
                description: "Get the page for a component: every attribute it takes, every value, and what each does on screen. Open a component's page before you write that component. This function only returns the page and draws nothing: a component is drawn by writing its tags in your reply, inside a ```component fence.",
                parameters: { type: 'object', properties: { component: { type: 'string', description: 'The name of the component, or several names separated by commas, such as Card, Badge' } }, required: ['component'] }
            }
        },
        run: async (input) => {
            const found = find(input);
            if (found.length === 0 || found.some((page) => !page)) return { content: `There is no component by that name. The components are: ${COMPONENT_PAGES.map((page) => page.name).join(', ')}.`, failed: 'failed' };
            return { content: found.map((page) => page.text).join('\n\n') };
        }
    };
};

// A skill with functions of Mollama's own has its commands: they do what its scripts do.
const presentSkill = ({ id, name, description, default: on, credit, source, needs, text, files = [] }, servers = []) => ({ id, name, description, default: on, credit, source,
    toolServers: toolServersOf(text).map((tool) => ({ name: tool, ready: servers.some((server) => server.health === 'healthy' && server.name.toLowerCase().includes(tool.toLowerCase())) })),
    needs: needs.filter((need) => !(SANDBOX_SKILLS[id] && sandboxReady()) && (need !== 'commands' || !(SKILL_FUNCTIONS[id] || []).some((entry) => !entry.ready || entry.ready()))), tokens: estimateTokens(text), suggested: SUGGESTED_SKILLS.includes(id), files: files.map((file) => file.path) });
export const listSkills = asyncHandler(async (req, res) => {
    const servers = await ToolServer.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 });
    const all = [...SKILLS, ...await ownSkillsOf(req.user.id)];
    res.status(200).json({
        success: true,
        webSearch: webSearchReady(),
        skills: all.map((skill) => presentSkill(skill, servers)),
        sources: Object.entries(SKILL_SOURCES).map(([id, source]) => ({ id, name: source.name, repo: source.repo, count: all.filter((skill) => skill.source === id).length })).filter((source) => source.count > 0),
        maxSkills: MAX_CHAT_SKILLS,
        maxOwnSkills: MAX_OWN_SKILLS,
        tools: [
            ...BUILTIN_TOOLS.map(({ id, name, description }) => ({ id, name, description, kind: 'builtin', ready: true, count: 1 })),
            ...servers.map((server) => ({ id: server.id, name: server.name, description: null, kind: server.kind, ready: server.health === 'healthy', state: TOOL_HEALTH[server.health].label, count: server.tools.length }))
        ]
    });
});

// The whole text of one skill, for reading before it is turned on.
export const readSkill = asyncHandler(async (req, res) => {
    const skill = [...SKILLS, ...await ownSkillsOf(req.user.id)].find((one) => one.id === req.params.id);
    if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
    const servers = await ToolServer.find({ service: SERVICE, owner: req.user.id });
    return res.status(200).json({ success: true, skill: { ...presentSkill(skill, servers), text: skill.text, setup: skillSetup(skill) } });
});

// One of a skill's own files, for the page that shows what a model built with them.
export const readSkillFile = asyncHandler(async (req, res) => {
    const skill = SKILLS.find((one) => one.id === req.params.id);
    const text = skill ? skillFileText(skill, req.query.path) : null;
    if (text === null) return res.status(404).json({ success: false, message: 'This skill has no such file.' });
    return res.status(200).json({ success: true, skill: skill.id, path: String(req.query.path), text });
});

// A skill's own header: its name and description, including a description folded over several lines.
const skillHeader = (text) => {
    const head = text.match(/^---\n([\s\S]*?)\n---\n?/);
    const lines = (head?.[1] || '').split('\n');
    const facts = {};
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^([\w-]+):\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (/^[>|][-+]?$/.test(value) || value === '') {
            const more = [];
            while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) more.push(lines[++index].trim());
            value = more.join(' ');
        }
        facts[match[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ').trim();
    }
    return { facts, body: text.slice(head?.[0].length || 0).trim() };
};
// Where a skill's file is read from: a GitHub page address is turned into the address of the file itself.
export const skillFileAddress = (address) => {
    const url = new URL(address);
    if (url.hostname !== 'github.com') return url.href;
    const [owner, repo, kind, branch, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return url.href;
    const file = rest.join('/');
    const path = kind === 'blob' ? file : [file, 'SKILL.md'].filter(Boolean).join('/');
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${['blob', 'tree'].includes(kind) && branch ? branch : 'HEAD'}/${path}`;
};

// Adds a skill from its address, or reads it again when the person already has it.
export const addSkill = asyncHandler(async (req, res) => {
    const address = req.body.address;
    const existing = await Skill.findOne({ service: SERVICE, owner: req.user.id, address });
    if (!existing && await Skill.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_OWN_SKILLS) {
        return res.status(422).json({ success: false, message: `You have ${MAX_OWN_SKILLS} skills of your own, which is the limit.`, action: 'Remove one you no longer use.' });
    }
    let text = '';
    try {
        const { stream } = await fetchRemote(skillFileAddress(address));
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > MAX_SKILL_BYTES) {
                stream.destroy?.();
                return res.status(422).json({ success: false, message: 'That skill is larger than 120 KB, which is more than a chat can hold.', action: 'Add a shorter skill.' });
            }
            chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    } catch (error) {
        return sendOllamaError(res, error);
    }
    const { facts, body } = skillHeader(text);
    if (!body || /^\s*<(!doctype|html)/i.test(text) || text.includes('\u0000')) {
        return res.status(422).json({ success: false, message: 'That address is not a skill file.', action: 'Paste the address of a SKILL.md file, or of the folder on GitHub that holds one.' });
    }
    const folder = new URL(skillFileAddress(address)).pathname.split('/').filter(Boolean).slice(-2, -1)[0] || 'Skill';
    const fields = {
        name: String(facts.name || folder).replace(/[-_]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase()).slice(0, 120),
        description: String(facts.description || body.split('\n').find((line) => line.trim() && !line.startsWith('#')) || '').slice(0, 400),
        text: body,
        checkedAt: new Date()
    };
    const skill = existing ? Object.assign(existing, fields) : new Skill({ owner: req.user.id, address, ...fields });
    await skill.save();
    ownSkillCache.delete(String(req.user.id));
    logger.info('[Skills] Skill added', { skillId: skill.id, userId: req.user.id });
    return res.status(existing ? 200 : 201).json({ success: true, skill: presentSkill(ownSkill(skill)) });
});

export const removeSkill = asyncHandler(async (req, res) => {
    const id = req.params.id.replace(/^mine-/, '');
    const skill = mongoose.isValidObjectId(id) ? await Skill.findOneAndDelete({ _id: id, service: SERVICE, owner: req.user.id }) : null;
    if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
    ownSkillCache.delete(String(req.user.id));
    return res.status(200).json({ success: true, message: 'Skill removed.' });
});

const MAX_PROMPTS = 100;

const cleanInstruction = (item) => ({
    name: item.name,
    text: item.text,
    source: item.source === 'fs-one' ? 'fs-one' : SERVICE,
    path: item.source === 'fs-one' ? item.path || null : null
});

const instructionsOf = (chat) => {
    if (chat.instructions?.length > 0) return chat.instructions.map(cleanInstruction);
    if (!chat.system) return [];
    return [{ name: 'Instructions', text: chat.system, source: chat.systemSource ? 'fs-one' : SERVICE, path: chat.systemSource || null }];
};

const systemText = (chat) => {
    const items = instructionsOf(chat);
    if (items.length <= 1) return items[0]?.text || '';
    return items.map((item) => `# ${item.name}\n\n${item.text}`).join('\n\n');
};

// Models do not know the date; without it they guess a year from their training. It changes once a day, so the
// prompt a computer has already read stays good for the rest of that day.
export const todayLine = () => `Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} (UTC).`;

// A page a reply showed earlier is long, and the model needs only to know it was shown: it is sent back as one line.
const LONG_PAGE = 6000;
const shortenPages = (text) => String(text).replace(/```component\n(<(Frame|Model3D)\b[^>]*>)[\s\S]*?```/g, (block, opening, tag) => {
    if (block.length <= LONG_PAGE) return block;
    const title = (opening.match(/\b(?:title|fileName)="([^"]*)"/) || [])[1] || 'a page';
    return `[Shown here: "${title}", a ${tag === 'Frame' ? 'page' : '3D model'} of ${block.length.toLocaleString('en-GB')} characters, not repeated.]`;
});
// Rolling memory: once a chat uses more than ROLL_PERCENT of its context, its older messages are folded into a memory
// after a reply, by the chat's own model, in the background. The last KEEP_MESSAGES are always sent word for word.
// The person still sees every message; only what the model is sent is shorter.
const ROLL_PERCENT = 60;
const KEEP_MESSAGES = 6;
const memoryStart = (chat) => (chat.memory && chat.memoryThrough > 0 && chat.memoryThrough <= chat.messages.length ? chat.memoryThrough : 0);
const notesText = (chat) => ((chat.notes || []).length > 0 ? `Notes saved in this chat with save_note:\n${chat.notes.map((note) => `- ${note.key}: ${note.text}`).join('\n')}` : '');
const buildMessages = (chat, listing = false, seeing = false, capacity = Infinity) => {
    const out = [];
    const active = sortSkills(chat, listing, capacity).full;
    const through = memoryStart(chat);
    const system = [...active.map((skill) => (skill.id === 'components' && !listing ? `${skill.text}\n\n${COMPONENT_VALUES_PAGE}` : skill.text)), systemText(chat), chat.summary && `Summary of the earlier conversation:\n${chat.summary}`, through > 0 && `Memory of the earlier part of this conversation (those messages are not repeated below):\n${chat.memory}`, notesText(chat), todayLine(), closingOf(chat)].filter(Boolean).join('\n\n');
    if (system) out.push({ role: 'system', content: system });
    for (const message of chat.messages.slice(through)) {
        if (!message.content) continue;
        let content = message.role === 'assistant' ? shortenPages(message.content) : message.content;
        let images = [];
        if (message.role === 'user' && message.attachmentIds.length > 0) {
            const attached = message.attachmentIds.map((id) => chat.attachments.id(id)).filter(Boolean);
            const documents = attached.filter((attachment) => !attachment.image).map((attachment) => `Document "${attachment.name}":\n${attachment.text}`);
            if (documents.length > 0) content = `${documents.join('\n\n')}\n\n${content}`;
            if (seeing) images = attached.filter((attachment) => attachment.image).map((attachment) => attachment.image);
        }
        out.push({ role: message.role, content, ...(images.length > 0 ? { images } : {}) });
    }
    return out;
};

// What a model wrote in a call is read again with every later step, so it counts too.
const callTokens = (message) => (message.tool_calls || []).reduce((sum, call) => sum + estimateTokens(JSON.stringify(call.function || {})), 0);
const promptTokens = (messages) => messages.reduce((sum, message) => sum + estimateTokens(message.content) + callTokens(message) + 4, 0);

// How the model's room is used by the request being answered: what each part of it takes. Estimates, set right by the
// service's own count once it has given one. `start` is how many of the messages are the conversation itself.
const contextParts = (messages, { start, tools, marks }) => {
    const size = (list) => list.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
    const conversation = messages.slice(0, start);
    const reply = messages.slice(start);
    const from = new Map(marks.map((mark) => [mark.index, mark]));
    const result = (page) => reply.filter((message, at) => message.role === 'tool' && KEPT_RESULTS.has(from.get(start + at)?.fn) === page);
    return {
        instructions: size(conversation.filter((message) => message.role === 'system')),
        functions: tools?.length ? estimateTokens(JSON.stringify(tools)) : 0,
        conversation: size(conversation.filter((message) => message.role !== 'system')),
        pages: size(result(true)),
        results: size(result(false)),
        calls: reply.reduce((sum, message) => sum + callTokens(message), 0),
        reply: size(reply.filter((message) => message.role !== 'tool'))
    };
};
const presentContext = (held) => {
    if (!held) return null;
    const parts = Object.fromEntries(Object.entries(held.parts).map(([id, tokens]) => [id, Math.round(tokens * (held.scale || 1))]));
    const used = Math.min(held.total, Object.values(parts).reduce((sum, tokens) => sum + tokens, 0) + held.writing);
    return { total: held.total, room: held.room, used, left: Math.max(0, held.total - used), percent: Math.min(100, Math.round((used / held.total) * 100)), parts: { ...parts, writing: held.writing }, keptFree: held.keptFree, putAway: held.putAway, steps: held.steps };
};
// What each model in memory was last asked with, kept while nothing is being answered.
const lastContext = new Map();

const contextUse = (chat, facts) => {
    if (!facts) return null;
    const capacity = capacityFor(chat, facts);
    const pending = chat.attachments.filter((attachment) => !attachment.sent).reduce((sum, attachment) => sum + attachment.tokens, 0);
    const last = [...chat.messages].reverse().find((message) => message.role === 'assistant' && message.stats?.promptEvalCount);
    // Of a reply, only its text is carried on: what the model thought, and the calls it wrote on the way, are not.
    const measured = last ? last.stats.promptEvalCount + Math.min(last.stats.evalCount || 0, estimateTokens(last.content)) : 0;
    const used = Math.max(promptTokens(buildMessages(chat, facts.capabilities.includes('tools'), false, capacity)), measured) + pending;
    const percent = Math.min(100, Math.round((used / capacity) * 100));
    return { usedTokens: used, capacityTokens: capacity, percent, warn: percent >= CONTEXT_WARN_PERCENT };
};

const presentAttachment = (attachment) => ({
    id: attachment.id,
    name: attachment.name,
    source: attachment.source,
    path: attachment.path,
    chars: attachment.chars,
    tokens: attachment.tokens,
    image: Boolean(attachment.image)
});

const presentMessage = (chat, message, index) => ({
    id: message.id,
    index,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    model: message.model,
    stats: message.stats?.evalCount ? message.stats : null,
    error: message.errorCode ? new OllamaError(message.errorCode, message.errorDetail).toJSON() : null,
    stopped: message.stopped,
    steps: (message.steps || []).map((step) => ({ tool: step.tool, input: step.input, failed: step.failed || null, ...(step.sent ? { sent: step.sent } : {}), ...(step.save?.id ? { save: { id: step.save.id, folder: step.save.folder, names: step.save.names, state: step.save.state === 'waiting' && !pendingSaves.has(step.save.id) ? 'gone' : step.save.state } } : {}), ...(step.answer != null ? { answer: step.answer } : {}) })),
    unverified: message.unverified || [],
    attachments: message.attachmentIds.map((id) => chat.attachments.id(id)).filter(Boolean).map(presentAttachment),
    createdAt: message.createdAt
});

const presentChat = (chat, facts = null) => ({
    id: chat.id,
    title: chat.title,
    model: chat.model,
    device: chat.device ? String(chat.device) : null,
    system: systemText(chat),
    systemSource: chat.systemSource,
    instructions: instructionsOf(chat),
    skills: skillsOf(chat).map((skill) => skill.id),
    tools: chat.tools || [],
    summary: chat.summary,
    memoryThrough: memoryStart(chat),
    memory: memoryStart(chat) > 0 ? chat.memory : '',
    notes: (chat.notes || []).map((note) => ({ key: note.key, text: note.text, updatedAt: note.updatedAt })),
    continuedFrom: chat.continuedFrom,
    options: chat.options || {},
    messages: chat.messages.map((message, index) => presentMessage(chat, message, index)),
    pendingAttachments: chat.attachments.filter((attachment) => !attachment.sent).map(presentAttachment),
    context: contextUse(chat, facts),
    replying: liveReplies.has(chat.id),
    queued: [...(queuedTurns.get(chat.id) || [])],
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
});

const factsOrNull = async (chat) => {
    if (!chat.model) return null;
    try {
        return await modelFacts(await getOllama(), chat.model);
    } catch {
        return null;
    }
};

const findChat = async (req, res) => {
    await ownSkillsOf(req.user.id);
    const chat = await Chat.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    if (!chat) res.status(404).json({ success: false, message: 'Chat not found' });
    return chat;
};

const titleFrom = (content) => {
    const line = String(content).replace(/\s+/g, ' ').trim();
    if (line.length <= 60) return line || 'New chat';
    const cut = line.slice(0, 60);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
};

const chooseModel = async (ollama, userId) => {
    const { models } = await ollama.list();
    if (models.length === 0) throw new OllamaError('NO_MODELS');
    const names = new Set(models.map((model) => model.name));
    const settings = await getSettings();
    if (settings.defaultModel && names.has(settings.defaultModel)) return settings.defaultModel;

    const recent = await Chat.findOne({ service: SERVICE, owner: userId, model: { $ne: null } }).sort({ updatedAt: -1 }).select('model');
    if (recent && names.has(recent.model)) return recent.model;

    const hardware = effectiveHardware(await getCurrentDevice());
    const usable = models.filter((model) => !/embed/i.test(model.name));
    const sized = (usable.length > 0 ? usable : models)
        .map((model) => ({ name: model.name, size: model.size || 0, fit: fitModel({ sizeMb: (model.size || 0) / MB, parameters: 0 }, hardware) }))
        .sort((a, b) => b.size - a.size);
    return (sized.find((model) => model.fit.verdict === 'gpu' || model.fit.verdict === 'cpu') || sized[sized.length - 1]).name;
};

const applyChatFields = (chat, body) => {
    for (const key of ['title', 'model', 'system', 'options']) {
        if (key in body) chat[key] = body[key];
    }
    if ('skills' in body) chat.skills = body.skills ? skillsFor(chat.owner).filter((skill) => body.skills.includes(skill.id)).map((skill) => skill.id).slice(0, MAX_CHAT_SKILLS) : undefined;
    if ('tools' in body) {
        chat.tools = body.tools?.length ? [...new Set(body.tools)] : undefined;
        chat.allowedTools = undefined;
    }
    if ('system' in body) chat.instructions = [];
    if ('instructions' in body) {
        chat.instructions = body.instructions.map(cleanInstruction);
        chat.system = '';
        chat.systemSource = null;
    }
    if ('title' in body) chat.titled = true;
    if ('system' in body) chat.systemSource = body.systemSource || null;
    if ('options' in body) chat.markModified('options');
};

export const listChats = asyncHandler(async (req, res) => {
    const filter = { service: SERVICE, owner: req.user.id };
    const search = String(req.query.search || '').trim();
    if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const chats = await Chat.find(filter).sort({ updatedAt: -1 }).limit(200).select('title model updatedAt createdAt');
    res.status(200).json({
        success: true,
        chats: chats.map((chat) => ({ id: chat.id, title: chat.title, model: chat.model, updatedAt: chat.updatedAt, createdAt: chat.createdAt }))
    });
});

// A chat runs on the computer it was given; without one it follows the request, and remembers a linked computer.
const chatTarget = async (req, chat) => {
    const device = chat.device ? await allowedDevice(req, chat.device) : null;
    if (!device && chat.device && await Provider.exists({ _id: chat.device, service: SERVICE, owner: req.user.id })) return { kind: 'cloud', id: String(chat.device) };
    return device ? targetOf(device) : currentTarget();
};

// False when the request names a computer this person may not use.
const setChatDevice = async (req, chat) => {
    if (!('device' in (req.body || {}))) return true;
    const device = req.body.device ? await allowedDevice(req, req.body.device) : null;
    const online = req.body.device && !device ? await Provider.exists({ _id: req.body.device, service: SERVICE, owner: req.user.id }) : null;
    if (req.body.device && !device && !online) return false;
    chat.device = device ? device._id : online ? online._id : null;
    return true;
};

export const createChat = asyncHandler(async (req, res) => {
    await ownSkillsOf(req.user.id);
    const chat = new Chat({ owner: req.user.id });
    applyChatFields(chat, req.body || {});
    if (!(await setChatDevice(req, chat))) return res.status(404).json({ success: false, message: 'Device not found' });
    deviceScope.enterWith(await chatTarget(req, chat));
    await chat.save();
    res.status(201).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const getChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    deviceScope.enterWith(await chatTarget(req, chat));
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const updateChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    applyChatFields(chat, req.body);
    if (!(await setChatDevice(req, chat))) return res.status(404).json({ success: false, message: 'Device not found' });
    deviceScope.enterWith(await chatTarget(req, chat));
    await chat.save();
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const deleteChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    await endReplies([chat.id], { wait: 5000 });
    await letSandboxGo(`${req.user.id}:${chat.id}`);
    chatPrograms.delete(programKey(req.user.id, chat));
    chatFigures.delete(programKey(req.user.id, chat));
    for (const [saveId, held] of pendingSaves) if (held.chatId === String(chat.id)) pendingSaves.delete(saveId);
    for (const [key, held] of lastContext) if (held.chat.id === chat.id) lastContext.delete(key);
    await chat.deleteOne();
    logger.info('[Chat] Chat deleted', { chatId: chat.id, userId: req.user.id });
    res.status(200).json({ success: true, message: 'Chat deleted.' });
});

// An edit or a fresh answer that reaches back into the messages a memory covers makes that memory wrong, so it goes.
const keepMemoryValid = (chat) => {
    if (chat.memoryThrough > 0 && chat.memoryThrough >= chat.messages.length) {
        chat.memory = '';
        chat.memoryThrough = 0;
    }
};
const prepareTurn = (chat, body) => {
    const problem = changeTurn(chat, body);
    keepMemoryValid(chat);
    return problem;
};
const changeTurn = (chat, body) => {
    if (body.regenerate) {
        while (chat.messages.length > 0 && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
        return chat.messages.length > 0 ? null : 'There is no message to answer again.';
    }
    if (body.editIndex !== undefined) {
        const target = chat.messages[body.editIndex];
        if (!target || target.role !== 'user') return 'Only one of your own messages can be edited.';
        const attachmentIds = [...target.attachmentIds];
        chat.messages.splice(body.editIndex);
        chat.messages.push({ role: 'user', content: body.content, attachmentIds });
        return null;
    }
    const waiting = chat.attachments.filter((attachment) => !attachment.sent);
    waiting.forEach((attachment) => {
        attachment.sent = true;
    });
    chat.messages.push({ role: 'user', content: body.content, attachmentIds: waiting.map((attachment) => attachment._id) });
    return null;
};

const runTurn = async ({ chat, body, userId, res, live }) => {
    if (!body.regenerate && body.editIndex === undefined && chat.messages.length >= MAX_CHAT_MESSAGES) {
        if (res) sendOllamaError(res, new OllamaError('CHAT_FULL'));
        return;
    }

    const problem = prepareTurn(chat, body);
    if (problem) {
        if (res) res.status(400).json({ success: false, message: problem });
        return;
    }
    if (!chat.titled && chat.messages.filter((message) => message.role === 'user').length === 1) {
        chat.title = titleFrom(chat.messages[0].content);
    }

    let ollama;
    let facts;
    let settings;
    let prompt;
    try {
        settings = await applyQueueSettings();
        ollama = await getOllama();
        if (!(await ollama.status()).available) throw new OllamaError(downCode());
        if (!chat.model) chat.model = await chooseModel(ollama, userId);
        live.model = chat.model;
        facts = await modelFacts(ollama, chat.model);
        if (!facts.online) {
            const cost = await loadCost(ollama, chat.model, { sending: true, anyway: body.anyway === true }).catch(() => null);
            if (cost?.tight && !body.anyway) throw Object.assign(memoryRefusal(chat.model, cost), { loaded: await inTheWay(chat.model).catch(() => []), fitsEmpty: cost.fitsEmpty });
        }

        prompt = buildMessages(chat, facts.capabilities.includes('tools'), facts.capabilities.includes('vision'), capacityFor(chat, facts));
        // Too long for the model: older messages are compressed into the chat's memory now, so the chat carries on here.
        if (promptTokens(prompt) + REPLY_RESERVE > capacityFor(chat, facts)) {
            const folded = await foldMemory({ chat, facts, ollama, settings, userId, now: true });
            if (folded) {
                chat.memory = folded.memory;
                chat.memoryThrough = folded.to;
                prompt = buildMessages(chat, facts.capabilities.includes('tools'), facts.capabilities.includes('vision'), capacityFor(chat, facts));
            }
        }
        const needed = promptTokens(prompt) + REPLY_RESERVE;
        if (needed > capacityFor(chat, facts)) {
            const lastUser = chat.messages[chat.messages.length - 1];
            throw new OllamaError(lastUser.attachmentIds.length > 0 ? 'DOCUMENT_TOO_LONG' : 'TOO_LONG');
        }
        if (queue.waitingFor(userId) >= queue.perUserLimit) throw new OllamaError('QUEUE_FULL');
    } catch (error) {
        const failure = mapOllamaError(error);
        if (res) return sendOllamaError(res, failure);
        chat.messages.push({ role: 'assistant', model: chat.model, content: '', errorCode: failure.code, errorDetail: failure.toJSON().detail || null });
        await chat.save();
        return;
    }

    await chat.save();

    // Sent "live", the request only answers that the reply has started; its pieces go out on the person's live
    // connection, so every app they have open follows the same reply.
    if (res && body.live) {
        res.status(202).json({ success: true, started: true });
        res = null;
    }
    if (res) {
        res.req.setTimeout(0);
        res.setTimeout(0);
        res.status(200).set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        live.listeners.add(res);
        res.on('close', () => live.listeners.delete(res));
    }

    let gone = live.stopped;
    let onStop = null;
    const stopSignal = new Promise((resolve) => {
        onStop = resolve;
    });
    let stream = null;
    let job = null;
    // Ends a request the model has not started answering, which is the whole time a model is loading into memory.
    const halt = new AbortController();
    const write = (event) => {
        const last = live.events[live.events.length - 1];
        if ((event.type === 'token' || event.type === 'thinking') && last?.type === event.type) last.text += event.text;
        else live.events.push({ ...event });
        const line = `${JSON.stringify(event)}\n`;
        for (const listener of live.listeners) {
            if (!listener.writableEnded) listener.write(line);
        }
        live.seq += 1;
        getNotificationService().sendToUser(String(userId), { type: 'chat:reply', data: { chatId: chat.id, seq: live.seq, event } });
    };
    const reportPlace = () => {
        if (job?.state === 'waiting') write({ type: 'queued', ahead: job.ahead() });
    };
    live.stop = () => {
        gone = true;
        job?.cancel();
        halt.abort();
        stream?.abort?.();
        onStop();
    };

    write({ type: 'accepted', chat: { id: chat.id, title: chat.title, model: chat.model }, messageCount: chat.messages.length });

    const reply = { content: '', thinking: '', stats: {}, errorCode: null, stopped: false, steps: [], unverified: [] };
    // What the reply holds so far is written down every few seconds, so a server that stops without warning loses little.
    let drafting = Promise.resolve();
    const draft = setInterval(() => {
        drafting = Chat.updateOne({ _id: chat._id }, { $set: { draft: { content: reply.content, thinking: reply.thinking, steps: reply.steps, model: chat.model, at: new Date() } } }).catch(() => {});
    }, DRAFT_MS);
    draft.unref?.();
    const lane = currentLane();
    const pooled = currentTarget()?.kind === 'pool';
    // The computer whose link this reply depends on.
    const linked = currentTarget()?.kind === 'companion' ? String(currentTarget().id) : pooled ? String((await poolTarget(currentTarget().id).catch(() => null))?.main.id || '') : '';
    let drops = 0;
    const run = async () => {
        if (gone) return;
        const loaded = await ollama.running().then((list) => list.models.some((entry) => entry.name === chat.model)).catch(() => true);
        write({ type: 'start', sharing: queue.runningIn(lane) - 1, loaded });
        // Web search is two tools, always handed to a model that can use tools. The model decides when to use them; nothing of Mollama's own is added to tell it how.
        const searching = webSearchReady() && facts.capabilities.includes('tools');
        const messages = [...prompt];
        // With web search on, its own page reader does the built-in one's job, so only one of the two is offered.
        const { listed } = sortSkills(chat, facts.capabilities.includes('tools'), capacityFor(chat, facts));
        const on = new Set(skillsOf(chat).map((skill) => skill.id));
        const others = skillsFor(chat.owner).filter((skill) => !on.has(skill.id));
        const draws = drawsComponents(chat);
        // A skill that is only on by default offers its files once the model has opened it.
        const withFiles = facts.capabilities.includes('tools') ? skillsOf(chat).filter((skill) => (skill.files || []).length > 0 && (Array.isArray(chat.skills) || skill.default !== 'tools' || !listed.includes(skill))) : [];
        const light = facts.capabilities.includes('tools') && capacityFor(chat, facts) < LIGHT_ROOM;
        const chatTools = facts.capabilities.includes('tools') ? [...(draws ? [openComponentTool()] : []), ...(withFiles.length > 0 ? [skillFileTool(withFiles)] : []), ...skillFunctionsFor(chat), ...(listed.length > 0 ? [openSkillTool(listed, others, capacityFor(chat, facts), light)] : []), ...(others.length > 0 ? [findSkillTool(others)] : []), askUserTool(), noteTool(chat), compressTool(), ...(process.env.FILESYSTEM_ONE_URL ? [listFilesTool(), readFileTool(), saveToFilesTool()] : []), ...(await toolsForChat(chat, userId)).filter((tool) => !(searching && tool.fn === 'read_web_page'))] : [];
        const capacity = capacityFor(chat, facts);
        // What is offered now: everything, or with little room only what belongs to the skills opened so far. A
        // function that is not offered yet still runs if it is called.
        const owners = light ? skillOwners(chat, withFiles) : new Map();
        const before = openedNames(chat);
        const openSkills = new Set(skillsOf(chat).filter((skill) => skill.source === 'mollama' || before.has(skill.name)).map((skill) => skill.id));
        const offeredTools = () => (!light ? chatTools : chatTools.filter((tool) => !owners.has(tool.fn) || owners.get(tool.fn).some((id) => openSkills.has(id)))
            .map((tool) => (tool.fn === 'open_skill_file' ? skillFileTool(withFiles.filter((skill) => openSkills.has(skill.id))) : tool)));
        const reserveFor = (tools) => (tools.some((tool) => tool.fn === 'run_program' || (light && FIGURE_CALLS.has(tool.fn))) ? Math.max(REPLY_RESERVE * 2, Math.min(PROGRAM_ROOM, Math.floor(capacity / 4))) : REPLY_RESERVE * 2);
        const sizeFor = (list, extra = 0) => {
            const fitted = CONTEXT_STEPS.find((step) => step >= promptTokens(list) + REPLY_RESERVE + extra) || capacity;
            return Number(chat.options?.num_ctx) > 0 ? capacity : Math.min(capacity, searching ? Math.max(fitted, SEARCH_CONTEXT) : fitted);
        };
        // Room is kept for the largest skill that may be opened, so opening one never overflows what the model can read.
        // A function may put something into the reply itself, such as a page it built for the person to see.
        // A newer version of the same thing takes the older one's place, so an answer never holds both.
        const shown = new Map();
        const show = (block, key = null) => {
            if (key && shown.has(key) && reply.content.includes(shown.get(key))) {
                reply.content = reply.content.replace(shown.get(key), () => '');
                write({ type: 'replace', text: reply.content });
            }
            if (key) shown.set(key, block);
            const text = `${reply.content && !/\n\n$/.test(reply.content) ? '\n\n' : ''}${block}\n\n`;
            reply.content += text;
            write({ type: 'token', text });
        };
        const thinkRoom = facts.capabilities.includes('thinking') ? THINK_RESERVE : 0;
        // A skill that is only on by default is not given room ahead: most chats never open it, and the room grows
        // by itself in the round after one is opened.
        const numCtx = sizeFor(messages, thinkRoom + listed.filter((skill) => Array.isArray(chat.skills) || skill.default !== 'tools').reduce((most, skill) => Math.max(most, isLong(skill, capacity) ? skillRoom(capacity) : estimateTokens(skill.text)), Math.max(draws && facts.capabilities.includes('tools') ? COMPONENT_ROOM : 0, withFiles.some((skill) => skill.source !== 'mollama') ? SKILL_FILE_ROOM : 0)));
        // The room a model is given grows with what the reply has gathered: a skill it opened, a file it read.
        let room = numCtx;
        let grew = false;
        // What a function wants to remember from one call to the next within this reply.
        const kept = new Map();
        let corrected = false;
        let correcting = false;
        let firstTry = null;
        let reasked = false;
        let evalCount = 0;
        let evalSeconds = 0;
        let totalMs = 0;
        // Where the reply's time goes: reading what it is sent, writing, and waiting for functions.
        const spent = { read: 0, tools: 0, requests: 0, sent: 0, cached: null };
        let promptEvalCount = null;
        const results = new Map();
        // Each tool result, with the step it came in, so results already read can be put away (see putAway).
        const marks = [];
        const awayKeys = new Set();
        let round = 0;
        // What came with a skill page can be asked for again once the page is put away or cut.
        const forgetGiven = (mark) => {
            if (mark.fn !== 'open_skill') return;
            for (const [key, value] of kept) if (value === 'given') kept.delete(key);
            for (const [key, content] of results) if (content.startsWith(ALREADY_GIVEN)) results.delete(key);
        };
        const away = (mark) => {
            const held = messages[mark.index];
            delete held.images;
            const size = String(held.content).length.toLocaleString('en-GB');
            // A program is not run again only to see what it gave back: its first and last lines stay.
            held.content = PROGRAM_CALLS.has(mark.fn) ? `[Put away to save room: ${size} characters a program gave back ${round - mark.round} steps ago. It began and ended:\n${bothEnds(String(held.content), 450)}]` : `[Put away to save room: what ${mark.fn} returned for ${clip(JSON.stringify(mark.given ?? {}), 300)}, ${size} characters, read ${round - mark.round} steps ago. Call ${mark.fn} again with exactly the same input to see it again, or keep what you need with save_note.]`;
            mark.away = true;
            awayKeys.add(mark.key);
            forgetGiven(mark);
        };
        const putAway = () => {
            for (const mark of marks) {
                if (mark.away || KEPT_RESULTS.has(mark.fn) || round - mark.round < 2) continue;
                if (String(messages[mark.index].content || '').length < PUT_AWAY_MIN_CHARS) continue;
                if (round - mark.round < PUT_AWAY_AFTER && promptTokens(messages) * 2 <= capacity) continue;
                away(mark);
            }
        };
        // What the model counted beyond Mollama's own estimate (the functions it is offered, its template), learnt from
        // its first answer in this reply.
        let uncounted = 0;
        // The room kept free for what the model writes. It grows when a reply is cut short with no more room to give
        // (see below), so a long function call, such as a whole figure, has somewhere to go.
        // A model that can run programs is kept a quarter of its room, since a program is sent whole.
        let reserve = reserveFor(offeredTools());
        let programming = false;
        let cutsInVain = 0;
        let tooLong = 0;
        let sentRoom = REPLY_SENT_CHARS;
        // Calls that failed, so one made again and again with the same input is not run without end.
        const failures = new Map();
        // An earlier version of a program is no use once a later one has been sent: the last one stays as it was.
        const putProgramsAway = () => {
            const calls = messages.flatMap((message) => message.tool_calls || []);
            const earlier = [PROGRAM_CALLS, FIGURE_CALLS].flatMap((set) => calls.filter((call) => set.has(call.function?.name)).slice(0, -1));
            for (const call of earlier) {
                const given = toolArguments(call.function.arguments);
                if (JSON.stringify(given).length < PUT_AWAY_MIN_CHARS) continue;
                const size = JSON.stringify(given).length.toLocaleString('en-GB');
                call.function = { name: call.function.name, arguments: FIGURE_KINDS[call.function.name] && !/_change$/.test(call.function.name) ? { [call.function.name === 'visual_explainer_render' ? 'page' : 'code']: `${PROGRAM_AWAY}, ${size} characters, put away to save room. The newest version is kept for ${FIGURE_KINDS[call.function.name]}_change.]` } : call.function.name === 'run_program' ? { language: given.language || 'python', code: `${PROGRAM_AWAY}, ${size} characters, put away to save room. The newest version is kept for change_program.]` } : { add: `[An earlier change, ${size} characters, put away to save room.]` } };
            }
        };
        // A reply never sends more than the model can read: Ollama would drop the start of the conversation without
        // saying so, and a pooled model refuses the request. Results already read go first, oldest first, skill pages
        // and files last; then what has not been read yet is cut to what fits.
        const makeRoom = () => {
            const limit = capacity - reserve - uncounted;
            const over = () => promptTokens(messages) - limit;
            if (over() > 0) putProgramsAway();
            for (const pages of [false, true]) {
                for (const mark of marks) {
                    if (over() <= 0) return;
                    if (mark.away || mark.round >= round || KEPT_RESULTS.has(mark.fn) !== pages) continue;
                    if (String(messages[mark.index].content || '').length >= PUT_AWAY_MIN_CHARS) away(mark);
                }
            }
            const unread = marks.filter((mark) => !mark.away && mark.round >= round).sort((a, b) => String(messages[b.index].content || '').length - String(messages[a.index].content || '').length);
            for (const mark of unread) {
                if (over() <= 0) return;
                const held = messages[mark.index];
                const text = String(held.content || '');
                const cut = Math.min(text.length - PUT_AWAY_MIN_CHARS, over() * 4 + 400);
                if (cut <= 0) continue;
                forgetGiven(mark);
                held.content = `${text.slice(0, text.length - cut)}\n\n[Cut here: the last ${cut.toLocaleString('en-GB')} characters are more than this model can read at once. Ask for a smaller part, and keep what you need with save_note.]`;
            }
        };

        try {
            while (!gone) {
                putAway();
                makeRoom();
                round += 1;
                const counted = promptTokens(messages);
                const request = {
                    model: chat.model,
                    messages,
                    stream: true,
                    options: { num_predict: -1, ...(chat.options || {}), num_ctx: room },
                    keep_alive: `${settings.keepAliveMinutes}m`
                };
                if (facts.capabilities.includes('thinking')) request.think = true;
                const functions = searching || chatTools.length > 0 ? [...(searching ? SEARCH_TOOLS : []), ...offeredTools().map((tool) => tool.definition)] : [];
                const wordKey = `${currentTarget()?.id ?? ''} ${chat.model}`;
                const inWords = functions.length > 0 && (facts.wordy || learnedWordy.has(wordKey));
                let seen = 0;
                if (inWords) {
                    request.messages = wordShape(messages, functions, String(prompt.filter((message) => message.role === 'user').at(-1)?.content ?? ''));
                    uncounted = Math.max(uncounted, estimateTokens(functionWords(functions)));
                } else if (functions.length > 0) request.tools = functions;

                room = Math.max(room, sizeFor(messages, thinkRoom + uncounted + (programming ? reserve : 0)));
                const calls = [];
                let cutCall = null;
                // A pooled or online model has all of its room at once; Ollama sets aside more as the reply needs it.
                live.context = {
                    total: capacity, room: facts.online || pooled ? capacity : request.options.num_ctx, parts: contextParts(messages, { start: prompt.length, tools: functions.length > 0 ? functions : undefined, marks }),
                    scale: live.context?.scale || 1, writing: 0, keptFree: reserve, putAway: marks.filter((mark) => mark.away).length, steps: round
                };
                let wrote = 0;
                write({ type: 'context', context: presentContext(live.context) });
                let said = '';
                let endedBy = null;
                let unread = false;
                try {
                stream = await ollama.chat(request, halt.signal);
                if (gone) stream.abort?.();
                for await (const part of stream) {
                    // Nothing that arrives after Stop is kept or shown, even if the service had already sent it.
                    if (gone) break;
                    wrote += (part.message?.thinking?.length || 0) + (part.message?.content?.length || 0) + (part.message?.tool_draft?.length || 0);
                    live.context.writing = Math.ceil(wrote / 4);
                    if (part.message?.tool_start) write({ type: 'note', text: doingOf(String(part.message.tool_start), chatTools) });
                    if (part.message?.tool_draft) write({ type: 'draft', text: String(part.message.tool_draft) });
                    if (part.message?.thinking) {
                        reply.thinking += part.message.thinking;
                        write({ type: 'thinking', text: part.message.thinking });
                    }
                    if (part.message?.content) {
                        if (correcting) {
                            correcting = false;
                            write({ type: 'note', text: '' });
                        }
                        const before = said.length;
                        said += part.message.content;
                        reply.content += part.message.content;
                        if (inWords) {
                            const end = wordCallEnd(said, functions);
                            if (end >= 0) {
                                reply.content = reply.content.slice(0, reply.content.length - (said.length - end));
                                said = said.slice(0, end);
                            }
                            // A call is shown as it is written, as any model's is, and not as part of the answer.
                            const call = said.search(/<call\b/i);
                            const words = said.slice(before, call < 0 ? said.length : Math.max(before, call));
                            if (words) write({ type: 'token', text: words });
                            if (call >= 0 && said.length > Math.max(before, call)) write({ type: 'draft', text: said.slice(Math.max(before, call)) });
                            if (end >= 0) {
                                stream.abort?.();
                                break;
                            }
                        } else write({ type: 'token', text: part.message.content });
                    }
                    if (Array.isArray(part.message?.tool_calls)) calls.push(...part.message.tool_calls);
                    if (part.message?.tool_cut) cutCall = part.message.tool_cut;
                    if (part.done) {
                        endedBy = part.done_reason || null;
                        evalCount += part.eval_count || 0;
                        evalSeconds += (part.eval_duration || 0) / 1e9;
                        totalMs += part.total_duration ? part.total_duration / 1e6 : 0;
                        spent.read += ((part.prompt_eval_duration || 0) + (part.load_duration || 0)) / 1e9;
                        spent.requests += 1;
                        spent.sent += part.prompt_eval_count || 0;
                        if (Number.isFinite(part.prompt_cached)) spent.cached = (spent.cached || 0) + part.prompt_cached;
                        // The first request of a reply holds the conversation alone. Later ones also hold what its tools
                        // returned, which is gone once the reply is written, so they are not what the chat is measured by.
                        promptEvalCount = promptEvalCount || part.prompt_eval_count || null;
                        seen = part.prompt_eval_count || 0;
                        // A count far from the estimate leaves out what the service had already read, so it is not used.
                        const guess = Object.values(live.context.parts).reduce((sum, tokens) => sum + tokens, 0);
                        const scale = part.prompt_eval_count / guess;
                        if (scale > 0.6 && scale < 2) live.context.scale = scale;
                        if (part.eval_count) live.context.writing = part.eval_count;
                        write({ type: 'context', context: presentContext(live.context) });
                        if (part.prompt_eval_count > counted) uncounted = Math.max(uncounted, Math.min(part.prompt_eval_count - counted, Math.floor(capacity / 2)));
                    }
                }
                } catch (error) {
                    // A link that drops and comes back costs only the step being written: what the reply has gathered
                    // is still here, so the step is asked again. The desktop app usually saves even that.
                    if (!gone && linked && drops < MAX_DROPS && mapOllamaError(error).code === 'DEVICE_OFFLINE') {
                        drops += 1;
                        write({ type: 'note', text: 'The link to your computer dropped. Waiting for it to come back…' });
                        await waitUntil(() => gone || (deviceGateway.isOnline(linked) && (!pooled || Boolean(poolStateOf(linked)))), RETURN_MS);
                        if (gone || deviceGateway.isOnline(linked)) {
                            if (gone) break;
                            reply.content = reply.content.slice(0, reply.content.length - said.length);
                            write({ type: 'replace', text: reply.content });
                            correcting = true;
                            round -= 1;
                            continue;
                        }
                    }
                    // Some services and models refuse a request that has functions in it: they are put in words instead.
                    if (!gone && !inWords && functions.length > 0 && mapOllamaError(error).code === 'NO_TOOL_SUPPORT') {
                        learnedWordy.add(wordKey);
                        round -= 1;
                        correcting = true;
                        continue;
                    }
                    // Mollama counts a token as four characters, and code takes more: a service that says the request is
                    // longer than it can read is believed, what was read is put away, and the step is asked again.
                    if (!gone && tooLong < 4 && mapOllamaError(error).code === 'TOO_LONG') {
                        tooLong += 1;
                        // Each time at least a seventh of what was sent has to go, or as much as the service says is too much.
                        const words = String(error?.detail || error?.error || error?.message || '');
                        const sentTokens = Number(words.match(/"n_prompt_tokens":\s*(\d+)|request \((\d+) tokens\)/)?.slice(1).find(Boolean)) || 0;
                        const itsRoom = Number(words.match(/"n_ctx":\s*(\d+)|size \((\d+) tokens\)/)?.slice(1).find(Boolean)) || capacity;
                        uncounted = Math.min(Math.max(uncounted, capacity - reserve - Math.floor(counted * 0.85), sentTokens > counted ? sentTokens - counted + Math.max(0, capacity - itsRoom) : 0), capacity - reserve - 500);
                        const before = promptTokens(messages);
                        round -= 1;
                        makeRoom();
                        if (promptTokens(messages) < before) {
                            reply.content = reply.content.slice(0, reply.content.length - said.length);
                            write({ type: 'replace', text: reply.content });
                            write({ type: 'note', text: 'That was more than the model can read at once. Making room and trying again…' });
                            correcting = true;
                            continue;
                        }
                        round += 1;
                    }
                    // A small model sometimes writes a function call that Ollama cannot read, which ends the reply with
                    // an error. It is asked once more, as a second attempt usually comes out right.
                    if (gone || reasked || functions.length === 0 || !UNREADABLE_CALL.test(String(error?.error || error?.message || ''))) throw error;
                    unread = true;
                }
                if (unread) {
                    reasked = true;
                    reply.content = reply.content.slice(0, reply.content.length - said.length);
                    write({ type: 'replace', text: reply.content });
                    write({ type: 'note', text: 'The model wrote a function call that could not be read. Asking again…' });
                    correcting = true;
                    continue;
                }
                // A pooled model's count of its prompt shows whether its functions were in it. When they were not, it is told
                // of them in words, now and from then on.
                const unseen = pooled && !inWords && calls.length === 0 && !cutCall && functions.length > 0 && seen > 0 && estimateTokens(JSON.stringify(functions)) > 600
                    && seen > counted * 0.6 && seen < counted + Math.floor(estimateTokens(JSON.stringify(functions)) * 0.35);
                if (unseen && !gone) {
                    learnedWordy.add(wordKey);
                    reply.content = reply.content.slice(0, reply.content.length - said.length);
                    write({ type: 'replace', text: reply.content });
                    write({ type: 'note', text: 'This model was not shown its functions. Asking again with them in words…' });
                    correcting = true;
                    continue;
                }
                if (functions.length > 0 && calls.length === 0 && !cutCall && !gone) {
                    const inMarks = readWordCalls(said, functions, inWords && endedBy === 'length');
                    const written = inMarks.calls.length > 0 || inMarks.cut ? inMarks : readTextCalls(said, functions);
                    if (written.calls.length > 0 || written.cut) {
                        calls.push(...written.calls);
                        cutCall = written.cut;
                        reply.content = reply.content.slice(0, reply.content.length - said.length) + written.text;
                        write({ type: 'replace', text: reply.content });
                        said = written.text;
                    }
                }
                // A call cut off before its end is never run. More room is made, and the model goes on from what is kept.
                let cutNote = null;
                if (cutCall && !gone) {
                    const ranOut = endedBy === 'length';
                    const held = keepCut(cutCall, { chat, userId, ranOut });
                    cutNote = held.note;
                    const mine = chatTools.find((tool) => tool.fn === cutCall.name);
                    const step = { tool: mine ? mine.label : clip(cutCall.name, 60), input: held.kept ? `${held.kept} lines so far` : 'cut off', failed: held.kept ? null : 'cut', answer: clip(held.note, STEP_ANSWER_CHARS) };
                    reply.steps.push(step);
                    write({ type: 'tool', tool: step.tool, input: step.input });
                    if (step.failed) write({ type: 'toolFailed', failed: step.failed });
                    write({ type: 'toolAnswer', answer: step.answer });
                    const before = promptTokens(messages);
                    if (ranOut) {
                        reserve = Math.min(Math.max(reserve, Math.floor(capacity / 2)), reserve * 2);
                        programming = true;
                        makeRoom();
                    }
                    cutsInVain = held.kept || promptTokens(messages) < before ? 0 : cutsInVain + 1;
                    if (calls.length === 0) {
                        if (cutsInVain >= 3) {
                            reply.errorCode = ranOut ? 'REPLY_CUT' : 'CALL_UNREADABLE';
                            break;
                        }
                        if (said.trim()) messages.push({ role: 'assistant', content: said });
                        messages.push({ role: 'user', content: cutNote });
                        if (said && !/\s$/.test(reply.content)) {
                            reply.content += '\n\n';
                            write({ type: 'token', text: '\n\n' });
                        }
                        write({ type: 'note', text: ranOut ? 'The model ran out of room. Asking it to go on…' : 'The model wrote a function call that could not be read. Asking again…' });
                        correcting = true;
                        continue;
                    }
                }
                // A reply that stopped because the model ran out of room is tried once more with more room when there is
                // more to give. After that the model is asked to go on from where it stopped, for as long as it keeps
                // writing; only a turn that adds nothing ends it, and the person is then told it is incomplete.
                if (endedBy === 'length' && calls.length === 0 && !gone) {
                    const more = !grew && !(Number(chat.options?.num_ctx) > 0) ? (CONTEXT_STEPS.find((step) => step > room && step <= capacity) || (capacity > room ? capacity : null)) : null;
                    if (more) {
                        grew = true;
                        room = more;
                        reply.content = reply.content.slice(0, reply.content.length - said.length);
                        write({ type: 'replace', text: reply.content });
                        write({ type: 'note', text: 'Giving the model more room and trying again…' });
                        correcting = true;
                        continue;
                    }
                    // No more room to give: what the model has already read is put away to leave more for writing, up to
                    // half of what it can read. A function call cut short is never run, so without this a long one
                    // could never be written.
                    const before = promptTokens(messages);
                    reserve = Math.min(Math.floor(capacity / 2), reserve * 2);
                    makeRoom();
                    const freed = promptTokens(messages) < before;
                    if (!said.trim()) {
                        if (!freed) {
                            reply.errorCode = 'REPLY_CUT';
                            break;
                        }
                        write({ type: 'note', text: 'Making room for a longer reply and trying again…' });
                        correcting = true;
                        continue;
                    }
                    messages.push({ role: 'assistant', content: said }, { role: 'user', content: CARRY_ON });
                    write({ type: 'note', text: 'The model ran out of room. Asking it to go on…' });
                    correcting = true;
                    continue;
                }
                // What the model drew is checked once, and it is given one chance to put right what cannot be drawn.
                if (calls.length === 0 && !gone && !corrected && draws) {
                    const check = componentFaults(said);
                    if (check.faults.length > 0) {
                        corrected = true;
                        correcting = true;
                        firstTry = said;
                        reply.content = reply.content.slice(0, reply.content.length - said.length);
                        reply.steps.push({ tool: CHECK_STEP, input: clip(check.faults[0], 200), failed: null });
                        write({ type: 'replace', text: reply.content });
                        write({ type: 'tool', tool: CHECK_STEP, input: clip(check.faults[0], 200) });
                        write({ type: 'note', text: 'Correcting what it drew…' });
                        messages.push({ role: 'assistant', content: said }, { role: 'user', content: correctionFor(check) });
                        continue;
                    }
                }
                // A second attempt that says nothing is no improvement: the first is put back, faults and all.
                if (calls.length === 0 && !gone && firstTry !== null && !said.trim()) {
                    reply.content += firstTry;
                    write({ type: 'note', text: '' });
                    write({ type: 'token', text: firstTry });
                }
                if (calls.length === 0 || gone) break;

                messages.push({ role: 'assistant', content: said, tool_calls: calls });
                let ended = false;
                const offered = [...(searching ? SEARCH_TOOLS.map((tool) => tool.function.name) : []), ...chatTools.map((tool) => tool.fn)];
                for (const call of calls) {
                    const asked = String(call.function?.name || '');
                    const name = offered.includes(asked) || chatTools.some((tool) => tool.knows?.(asked)) ? asked : (nearestFunction(asked, offered) || asked);
                    // A small model sometimes calls a skill by its own name instead of through the function that opens it.
                    const real = chatTools.find((tool) => tool.fn === name);
                    const opener = real || SEARCH_TOOLS.some((tool) => tool.function.name === name) ? null : chatTools.find((tool) => tool.knows?.(name));
                    const mine = real || opener;
                    const given = opener ? opener.slip(name) : toolArguments(call.function?.arguments);
                    const input = mine?.shown ? mine.shown(given) : mine ? clip(JSON.stringify(given), 500) : toolInput(name, call.function?.arguments);
                    const step = { tool: mine ? mine.label : name, input, failed: null };
                    const sent = PROGRAM_CALLS.has(mine?.fn) || FIGURE_CALLS.has(mine?.fn) ? sentText(given) : '';
                    if (sent && sentRoom > 0) {
                        step.sent = clip(sent, Math.min(STEP_SENT_CHARS, sentRoom));
                        sentRoom -= step.sent.length;
                    }
                    reply.steps.push(step);
                    write({ type: 'note', text: doingOf(mine ? mine.fn : name, chatTools) });
                    write({ type: 'tool', tool: step.tool, input, ...(step.sent ? { sent: step.sent } : {}) });
                    // The same call made again in a reply is not run again: the model is given what it got before, so a
                    // model that has lost its way is moved on instead of going round in circles.
                    const same = `${mine ? mine.fn : name}\n${JSON.stringify(given ?? input)}${mine?.fn === 'change_program' ? `\n${chatPrograms.get(programKey(userId, chat))?.code ?? ''}` : FIGURE_KINDS[mine?.fn] && /_change$/.test(mine.fn) ? `\n${keptFigure(userId, chat, FIGURE_KINDS[mine.fn])}` : ''}`;
                    if (PROGRAM_CALLS.has(mine?.fn)) programming = true;
                    const failedBefore = failures.get(same);
                    const began = Date.now();
                    // Stop does not wait for a tool that is still running: a search, a page being read, a question to the person.
                    const outcome = results.has(same) && awayKeys.has(same) ? { content: results.get(same) } : results.has(same) ? { content: `You already called ${mine ? mine.fn : name} with the same input in this reply. What it gave you then is above and has not changed: use it and go on with your answer.\n\n${clip(results.get(same), 2000)}` } : failedBefore?.times >= 2 ? { content: `This exact call has failed ${failedBefore.times} times and was not run again: it would fail the same way. Do something different.\n\n${clip(failedBefore.content, 1500)}`, failed: 'failed' } : await Promise.race([
                        mine ? runChatTool(mine, given, { chat, userId, write, stopped: () => gone, show, kept, offer: (save) => { step.save = save; write({ type: 'toolSave', save }); return step; } })
                            : offered.includes(name) ? runSearchTool(name, input)
                                : { content: `There is no function called ${clip(name, 60)}. The functions you can call are: ${offered.join(', ')}.`, failed: 'failed' },
                        stopSignal.then(() => ({ content: 'The reply was stopped.', failed: 'stopped' }))
                    ]);
                    spent.tools += (Date.now() - began) / 1000;
                    // A script that failed is told where: the lines its error names, from the copy kept of it.
                    if (outcome.failed === 'failed' && (FIGURE_KINDS[mine?.fn] || PROGRAM_CALLS.has(mine?.fn))) {
                        outcome.content = `${outcome.content}${scriptHelp(PROGRAM_CALLS.has(mine.fn) ? chatPrograms.get(programKey(userId, chat))?.code : keptFigure(userId, chat, FIGURE_KINDS[mine.fn]), outcome.content)}`;
                    }
                    // A skill just opened brings its own functions and files with it, and the model is told which.
                    if (light && mine?.fn === 'open_skill' && !outcome.failed) {
                        const wanted = String(given?.skill ?? '').trim().toLowerCase();
                        const skill = skillsOf(chat).find((one) => one.name.toLowerCase() === wanted || one.id === wanted);
                        if (skill && !openSkills.has(skill.id)) {
                            const had = new Set(offeredTools().map((tool) => tool.fn));
                            openSkills.add(skill.id);
                            const now = offeredTools();
                            const gained = now.filter((tool) => !had.has(tool.fn)).map((tool) => tool.fn);
                            reserve = Math.max(reserve, reserveFor(now));
                            if (gained.length > 0) outcome.content = `${outcome.content}\n\nYOU NOW HAVE this skill's own ${gained.length === 1 ? 'function' : 'functions'}: ${gained.join(', ')}.`;
                        }
                    }
                    if (outcome.failed) {
                        step.failed = outcome.failed;
                        write({ type: 'toolFailed', failed: outcome.failed });
                    }
                    // What came back, kept short on the step so the person can open it.
                    step.answer = clip(String(outcome.content ?? ''), STEP_ANSWER_CHARS);
                    write({ type: 'toolAnswer', answer: step.answer });
                    if (!outcome.failed && !results.has(same)) results.set(same, String(outcome.content ?? ''));
                    if (outcome.failed === 'failed') failures.set(same, { times: (failedBefore?.times || 0) + 1, content: failedBefore?.content || String(outcome.content ?? '') });
                    const pictures = Array.isArray(outcome.images) && outcome.images.length > 0 ? outcome.images : null;
                    const seesPictures = facts.capabilities.includes('vision');
                    messages.push({ role: 'tool', tool_name: name, content: pictures && !seesPictures ? `${outcome.content}\n\nThis model cannot see pictures, so they were not sent.` : outcome.content, ...(pictures && seesPictures ? { images: pictures } : {}) });
                    awayKeys.delete(same);
                    marks.push({ index: messages.length - 1, fn: mine ? mine.fn : name, given: given ?? input, key: same, round });
                    if (outcome.compress) {
                        const before = promptTokens(messages);
                        for (const mark of marks) if (!mark.away && mark.index !== messages.length - 1 && String(messages[mark.index].content || '').length >= PUT_AWAY_MIN_CHARS) away(mark);
                        putProgramsAway();
                        const freed = before - promptTokens(messages);
                        messages.at(-1).content = freed > 100 ? `Put away: about ${freed.toLocaleString('en-GB')} tokens are free again. What you wrote in keep is what you have; the same call reads anything again. Go on with the work.` : 'There was nothing more to put away.';
                    }
                    if (outcome.ends) ended = true;
                    if (gone || ended) break;
                }
                // A model cannot see how full its context is, so it is told when what is left has become little and there is
                // something to put away.
                const last = messages.at(-1);
                if (last?.role === 'tool' && !ended && !gone) {
                    const taken = promptTokens(messages) + Math.max(uncounted, estimateTokens(JSON.stringify(functions)));
                    const left = Math.max(0, capacity - taken);
                    const loose = marks.reduce((sum, mark) => (mark.away || mark.index === messages.length - 1 ? sum : sum + estimateTokens(messages[mark.index].content)), 0);
                    if (left < Math.max(reserve * 1.25, Math.min(8000, capacity * 0.5)) && loose > 1200) last.content = `${last.content}\n\n[Room: about ${left.toLocaleString('en-GB')} of ${capacity.toLocaleString('en-GB')} tokens are left for what you write next. compress_context frees about ${loose.toLocaleString('en-GB')} more.]`;
                }
                if (cutNote) messages.push({ role: 'user', content: cutNote });
                // The tools are done; the model is thinking again.
                write({ type: 'note', text: '' });
                // A question put to the person is the end of the reply: the model is not asked to go on without the answer.
                if (ended) break;
                if (said && !/\s$/.test(reply.content)) {
                    reply.content += '\n\n';
                    write({ type: 'token', text: '\n\n' });
                }
            }
            // Something a function held back for mending, and the model never came back to, is shown as it was.
            if (kept.has('unshown') && !gone) show(kept.get('unshown').block, kept.get('unshown').key);
        } catch (error) {
            if (gone) reply.stopped = true;
            else {
                const failure = mapOllamaError(error);
                reply.errorCode = failure.code;
                reply.errorDetail = failure.toJSON().detail || null;
                // A failure Mollama has no name for is written down, or it could never be given one.
                if (failure.code === 'UNKNOWN') logger.warn('[Chat] A reply failed for a reason with no name yet', { chatId: chat.id, model: chat.model, detail: String(failure.detail || error?.stack || '').slice(0, 600) });
            }
        }
        reply.stats = {
            evalCount: evalCount || null,
            promptEvalCount,
            durationMs: totalMs ? Math.round(totalMs) : null,
            tokensPerSecond: evalSeconds > 0 && evalCount ? Math.round((evalCount / evalSeconds) * 10) / 10 : null,
            readSeconds: spent.requests ? Math.round(spent.read) : null,
            writeSeconds: spent.requests ? Math.round(evalSeconds) : null,
            toolSeconds: spent.requests ? Math.round(spent.tools) : null,
            requests: spent.requests || null,
            sentTokens: spent.sent || null,
            cachedTokens: spent.cached
        };
        if (gone) reply.stopped = true;
    };

    try {
        job = queue.add({ userId, priority: 'interactive', run, lane });
        queue.on('moved', reportPlace);
        await job.done;
    } catch (error) {
        const failure = mapOllamaError(error);
        reply.errorCode = failure.code;
        reply.errorDetail = failure.toJSON().detail || null;
    } finally {
        queue.off('moved', reportPlace);
    }

    // A reply ended because the server is stopping is kept as far as it got, and says so.
    if (live.restarting) {
        reply.stopped = false;
        reply.errorCode = 'SERVER_RESTARTED';
    } else if (live.ended) {
        reply.stopped = false;
        reply.errorCode = live.ended.code;
        reply.errorDetail = live.ended.detail;
    }
    if (reply.content || reply.errorCode) {
        chat.messages.push({ role: 'assistant', model: chat.model, ...reply });
    }
    clearInterval(draft);
    try {
        await chat.save();
        await drafting;
        await Chat.updateOne({ _id: chat._id }, { $unset: { draft: 1 } });
    } catch (error) {
        logger.error('[Chat] Reply could not be saved', { chatId: chat.id, message: error.message });
    }

    const last = chat.messages[chat.messages.length - 1];
    const message = last?.role === 'assistant' ? presentMessage(chat, last, chat.messages.length - 1) : null;
    if (reply.content && !reply.stopped && !reply.errorCode) {
        getNotificationService().notify(userId, 'reply:finished', { level: 'info', title: 'Reply ready', message: `The reply in "${chat.title}" is ready.`, chatId: chat.id, path: `/chat/${chat.id}` });
    }
    // A reply that failed says so too, wherever the person is by then; one they stopped themselves does not.
    if (reply.errorCode && !reply.stopped) {
        getNotificationService().notify(userId, 'reply:failed', { level: 'error', title: 'Reply failed', message: `The reply in "${chat.title}" stopped. ${new OllamaError(reply.errorCode, reply.errorDetail).message}`, chatId: chat.id, code: reply.errorCode, path: `/chat/${chat.id}` });
    }
    write({
        type: reply.errorCode ? 'error' : 'done',
        ...(reply.errorCode ? new OllamaError(reply.errorCode, reply.errorDetail).toJSON() : {}),
        reply: message,
        title: chat.title,
        context: contextUse(chat, facts)
    });
    if (reply.content && !reply.stopped && !reply.errorCode) foldMemory({ chat, facts, ollama, settings, userId });
};

const MEMORY_ASK = 'Rewrite the memory of this conversation so that it can go on without the messages it covers. Keep the user\'s goals, wishes and constraints, the facts that were established, the decisions and conclusions reached, what each reply delivered (figures, tables, files, pages, and what they showed), and the questions still open. Leave out greetings, filler and anything later replaced. Write short bullet points, newest last. Add nothing that was not said.';
const MAX_MEMORY_CHARS = 12000;
// With `now`, for a message that would not fit otherwise: it runs ahead of other work and gives back the memory for
// the chat being sent, which saves it with the reply.
const foldMemory = async ({ chat, facts, ollama, settings, userId, now = false }) => {
    try {
        const capacity = capacityFor(chat, facts);
        if (!now && promptTokens(buildMessages(chat, facts.capabilities.includes('tools'), false, capacity)) * 100 < capacity * ROLL_PERCENT) return null;
        const from = memoryStart(chat);
        let to = chat.messages.length - KEEP_MESSAGES;
        while (to > from && chat.messages[to]?.role !== 'user') to -= 1;
        if (to <= from) return null;
        const folded = chat.messages.slice(from, to).filter((message) => message.content);
        const room = Math.max(1000, capacity - 2 * REPLY_RESERVE - estimateTokens(chat.memory) - 400);
        const each = Math.max(400, Math.floor((room * 4) / Math.max(1, folded.length)));
        const transcript = folded.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(shortenPages(message.content), each)}`).join('\n\n');
        const ask = [{ role: 'user', content: [MEMORY_ASK, chat.memory && `The memory so far:\n${chat.memory}`, `The messages to add:\n${transcript}`].filter(Boolean).join('\n\n') }];
        const job = queue.add({
            userId,
            lane: currentLane(),
            priority: now ? 'interactive' : 'background',
            run: () => ollama.chat({
                model: chat.model,
                messages: ask,
                stream: false,
                ...(facts.capabilities.includes('thinking') ? { think: false } : {}),
                options: { ...(chat.options || {}), num_ctx: capacity },
                keep_alive: `${settings.keepAliveMinutes}m`
            })
        });
        const memory = String((await job.done)?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (!memory) return null;
        if (now) return { memory: clip(memory, MAX_MEMORY_CHARS), to };
        // Saved only if nothing moved meanwhile: the memory still starts where it did and the messages are still there.
        await Chat.updateOne(
            { _id: chat._id, memoryThrough: chat.memoryThrough || 0, $expr: { $gte: [{ $size: '$messages' }, to] } },
            { $set: { memory: clip(memory, MAX_MEMORY_CHARS), memoryThrough: to } }
        );
        return null;
    } catch (error) {
        logger.warn('[Chat] The memory could not be updated', { chatId: chat.id, code: mapOllamaError(error).code });
        return null;
    }
};

// When the server is told to stop (a deploy), every reply being written is ended and saved as far as it got.
let closing = false;
export const stopReplies = async (ms = 8000) => {
    closing = true;
    await endReplies(new Set([...busyChats, ...liveReplies.keys()]), { restarting: true, wait: ms });
    closing = false;
};
// A reply whose server stopped without warning left only its draft: it becomes the reply, marked incomplete. A draft
// still being written is fresh, so only one that has gone quiet is taken (another server may be finishing it).
export const recoverReplies = async (quietMs = 45000) => {
    const left = await Chat.find({ service: SERVICE, 'draft.at': { $lt: new Date(Date.now() - quietMs) } }).select('_id draft');
    for (const found of left) {
        if (liveReplies.has(found.id)) continue;
        const chat = await Chat.findOne({ _id: found._id, 'draft.at': found.draft.at });
        if (!chat) continue;
        chat.messages.push({ role: 'assistant', model: chat.draft.model || chat.model, content: chat.draft.content || '', thinking: chat.draft.thinking || '', steps: chat.draft.steps || [], errorCode: 'SERVER_RESTARTED' });
        chat.draft = undefined;
        await chat.save();
        getNotificationService().sendToUser(String(chat.owner), { type: 'chat:changed', data: { id: chat.id, removed: false } });
    }
    return left.length;
};

const openLive = (id, model = null) => {
    const live = { events: [], listeners: new Set(), stop: null, stopped: false, seq: 0, target: currentTarget()?.id ?? null, model, startedAt: Date.now() };
    liveReplies.set(id, live);
    return live;
};

const takeTurns = async (chat, body, userId, res) => {
    const id = chat.id;
    busyChats.add(id);
    let turn = { chat, body, res, live: openLive(id, chat.model) };
    getNotificationService().notify(userId, 'activity:changed');
    try {
        while (turn) {
            try {
                if (turn.chat) await runTurn({ ...turn, userId });
            } catch (error) {
                logger.error('[Chat] Turn failed', { chatId: id, message: String(error?.message || '').slice(0, 200) });
                if (turn.res && !turn.res.headersSent) turn.res.status(500).json({ success: false, message: 'The message could not be sent.' });
            }
            if (turn.live.context) lastContext.set(useKey(turn.live.target, turn.live.model || turn.chat.model), { chat: { id, title: turn.chat.title }, context: presentContext(turn.live.context) });
            if (turn.live.model || turn.chat?.model) modelUse.set(useKey(turn.live.target, turn.live.model || turn.chat.model), Date.now());
            for (const listener of turn.live.listeners) {
                if (!listener.writableEnded) listener.end();
            }
            getNotificationService().sendToUser(String(userId), { type: 'chat:reply', data: { chatId: id, seq: turn.live.seq + 1, event: { type: 'end' } } });
            getNotificationService().sendToUser(String(userId), { type: 'chat:changed', data: { id, removed: false } });
            const content = closing ? undefined : queuedTurns.get(id)?.shift();
            if (content === undefined) break;
            const next = await Chat.findOne({ _id: id, service: SERVICE, owner: userId }).catch(() => null);
            if (!next) break;
            const live = openLive(id, next.model);
            turn = { chat: next, body: { content }, res: null, live };
        }
    } finally {
        liveReplies.delete(id);
        queuedTurns.delete(id);
        busyChats.delete(id);
        getNotificationService().notify(userId, 'activity:changed');
    }
};

export const sendMessage = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const target = await chatTarget(req, chat);
    deviceScope.enterWith(target);
    filesScope.enterWith({ token: req.cookies?.accessToken, home: req.user?.username ? `/${req.user.username}` : null });
    if (!chat.device && target.kind === 'companion') chat.device = target.id;
    if (!busyChats.has(chat.id)) return takeTurns(chat, req.body, req.user.id, res);
    if (req.body.regenerate || req.body.editIndex !== undefined) {
        return res.status(409).json({ success: false, message: 'This chat is still replying. Stop it or wait for it to finish.' });
    }
    const waiting = queuedTurns.get(chat.id) || [];
    if (waiting.length >= MAX_QUEUED_TURNS) return sendOllamaError(res, new OllamaError('QUEUE_FULL'));
    waiting.push(req.body.content);
    queuedTurns.set(chat.id, waiting);
    res.status(202).json({ success: true, queued: [...waiting] });
});

const RECENT_DOWNLOAD_MS = 2 * 60 * 1000;

// Where a reply being written has got to, worked out from what it has sent so far.
const replyProgress = (live) => {
    const events = live?.events || [];
    const words = events.filter((event) => event.type === 'token').map((event) => event.text).join('').split(/\s+/).filter(Boolean).length;
    if (words > 0) return { phase: 'writing', words };
    const started = events.some((event) => event.type === 'start');
    const queued = [...events].reverse().find((event) => event.type === 'queued');
    if (!started && queued?.ahead > 0) return { phase: 'waiting', words: 0, ahead: queued.ahead };
    if (events.some((event) => event.type === 'thinking')) return { phase: 'thinking', words: 0 };
    const tool = [...events].reverse().find((event) => event.type === 'tool');
    if (tool) return { phase: tool.tool === 'web_fetch' ? 'reading' : 'searching', words: 0 };
    return { phase: 'starting', words: 0 };
};

export const getActivity = asyncHandler(async (req, res) => {
    const ids = [...liveReplies.keys()];
    const chats = ids.length > 0
        ? await Chat.find({ _id: { $in: ids }, service: SERVICE, owner: req.user.id }).select('title model')
        : [];
    const jobs = (await downloads.list()).filter((job) => ['queued', 'downloading'].includes(job.status)
        || (['completed', 'failed'].includes(job.status) && job.finishedAt && Date.now() - new Date(job.finishedAt).getTime() < RECENT_DOWNLOAD_MS));
    res.status(200).json({
        success: true,
        replies: chats.map((chat) => ({ chatId: chat.id, title: chat.title, model: chat.model, waiting: (queuedTurns.get(chat.id) || []).length, ...replyProgress(liveReplies.get(chat.id)) })),
        downloads: jobs.map((job) => ({ id: job.id, model: job.model, status: job.status, percent: job.percent })),
        permissions: { manage: canManage(req) }
    });
});

// What a reply in progress has sent so far, for an app that joins late or missed a piece on the live connection.
export const liveReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const live = liveReplies.get(chat.id);
    res.status(200).json({ success: true, replying: Boolean(live), seq: live?.seq || 0, events: live?.events || [], workedMs: live ? Date.now() - live.startedAt : 0 });
});

export const rejoinReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const live = liveReplies.get(chat.id);
    if (!live) return res.status(204).end();
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    // How long it has been going, as a length of time, since the two clocks may differ.
    res.write(`${JSON.stringify({ type: 'clock', workedMs: Date.now() - live.startedAt })}
`);
    for (const event of live.events) res.write(`${JSON.stringify(event)}\n`);
    live.listeners.add(res);
    res.on('close', () => live.listeners.delete(res));
});

export const stopReply = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const ended = await endReplies([chat.id]);
    res.status(200).json({ success: true, stopped: ended > 0 });
});

export const loadModel = asyncHandler(async (req, res) => {
    try {
        const settings = await applyQueueSettings();
        const ollama = await getOllama();
        if (!(await ollama.status()).available) throw new OllamaError(downCode());
        const model = req.body?.name || await chooseModel(ollama, req.user.id);
        const loaded = (await ollama.running()).models.some((entry) => entry.name === model);
        const busy = queue.busyIn(currentLane());
        // Loaded ahead only where it fits beside everything else; a pooled model is never started before a message is sent.
        // A chat that stays open asks again with 'swap': an idle model already loaded then goes for this one.
        const cost = currentTarget().kind === 'cloud' ? { ahead: true } : await loadCost(ollama, model).catch(() => null);
        const able = !loaded && !busy && settings.keepAliveMinutes > 0;
        const swap = able && Boolean(cost?.inPlace) && req.body?.swap === true;
        const loading = able && (Boolean(cost?.ahead) || (swap && await endLoaded(currentLane(), ollama)));
        if (loading) {
            const facts = await modelFacts(ollama, model);
            const numCtx = Math.min(facts.contextLength, AUTO_CONTEXT_LIMIT, webSearchReady() ? SEARCH_CONTEXT : CONTEXT_STEPS[0]);
            const key = useKey(currentTarget().id, model);
            loadingAhead.set(key, Date.now());
            ollama.load(model, `${settings.keepAliveMinutes}m`, numCtx).then(() => modelUse.set(key, Date.now()), (error) => {
                logger.warn('[Models] Model could not be loaded ahead of time', { model, code: mapOllamaError(error).code });
            }).finally(() => loadingAhead.delete(key));
        }
        res.status(202).json({ success: true, model, ready: loaded, loading, inPlace: able && !loading && Boolean(cost?.inPlace) });
    } catch (error) {
        sendOllamaError(res, mapOllamaError(error));
    }
});

const readUpload = express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES });

export const receiveUpload = (req, res, next) => {
    readUpload(req, res, (error) => {
        if (!error) return next();
        if (error.type === 'entity.too.large') return sendOllamaError(res, new OllamaError('FILE_TOO_LARGE'));
        return next(error);
    });
};

const filesFor = (req) => createFilesClient({ baseUrl: process.env.FILESYSTEM_ONE_URL, accessToken: req.cookies?.accessToken });

const invalid = (res, error) => res.status(400).json({
    success: false,
    message: `Validation error: ${error.details.map((detail) => detail.message.replace(/['"]/g, '')).join(', ')}`
});

export const addAttachment = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;

    let document;
    try {
        if (Buffer.isBuffer(req.body)) {
            const { error, value } = chatSchemas.attachUpload.validate(req.query);
            if (error) return invalid(res, error);
            document = imageTypeOf(value.name) ? { name: value.name, source: SERVICE, path: null, buffer: req.body } : { name: value.name, source: SERVICE, path: null, text: await extractText({ buffer: req.body, name: value.name }) };
        } else {
            const { error, value } = chatSchemas.attachFile.validate(req.body);
            if (error) return invalid(res, error);
            const file = imageTypeOf(value.path) ? await filesFor(req).bytes(value.path) : await filesFor(req).text(value.path);
            document = file.buffer ? { name: file.name, source: 'fs-one', path: value.path, buffer: file.buffer } : { name: file.name, source: 'fs-one', path: value.path, text: file.text };
        }
        if (document.buffer) {
            const facts = await factsOrNull(chat);
            if (facts && !facts.capabilities.includes('vision')) throw new OllamaError('NO_VISION');
            const kept = chat.attachments.reduce((sum, attachment) => sum + (attachment.image ? Math.floor(attachment.image.length * 0.75) : 0), 0);
            if (document.buffer.length > MAX_IMAGE_BYTES || kept + document.buffer.length > MAX_CHAT_IMAGE_BYTES) throw new OllamaError('IMAGE_TOO_LARGE');
            chat.attachments.push({ name: document.name, source: document.source, path: document.path, text: '', image: document.buffer.toString('base64'), mime: imageTypeOf(document.name), chars: 0, tokens: IMAGE_TOKENS });
            await chat.save();
            return res.status(201).json({ success: true, chat: presentChat(chat, facts) });
        }

        const tokens = estimateTokens(document.text);
        const facts = await factsOrNull(chat);
        const held = chat.attachments.reduce((sum, attachment) => sum + attachment.chars, 0);
        if (held + document.text.length > MAX_CHAT_ATTACHMENT_CHARS) throw new OllamaError('DOCUMENT_TOO_LONG');
        if (facts) {
            const capacity = capacityFor(chat, facts);
            const room = capacity - REPLY_RESERVE - (contextUse(chat, facts)?.usedTokens || 0);
            if (tokens > room) {
                const error = new OllamaError('DOCUMENT_TOO_LONG');
                return res.status(error.status).json({
                    success: false,
                    ...error.toJSON(),
                    message: `This document needs about ${tokens.toLocaleString('en-GB')} tokens and this chat has room for about ${Math.max(0, room).toLocaleString('en-GB')}.`,
                    neededTokens: tokens,
                    roomTokens: Math.max(0, room)
                });
            }
        }
        chat.attachments.push({ ...document, chars: document.text.length, tokens });
    } catch (error) {
        return sendOllamaError(res, error);
    }

    await chat.save();
    res.status(201).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

export const removeAttachment = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const attachment = chat.attachments.id(req.params.attachmentId);
    if (!attachment || attachment.sent) {
        return res.status(404).json({ success: false, message: 'Attachment not found' });
    }
    attachment.deleteOne();
    await chat.save();
    res.status(200).json({ success: true, chat: presentChat(chat, await factsOrNull(chat)) });
});

const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';

const exportChatText = (chat, format) => {
    if (format === 'jsonl') {
        const lines = [];
        if (systemText(chat)) lines.push({ role: 'system', content: systemText(chat) });
        for (const message of chat.messages) {
            const line = { role: message.role, content: message.content, createdAt: message.createdAt };
            if (message.role === 'assistant') line.model = message.model;
            const names = message.attachmentIds.map((id) => chat.attachments.id(id)?.name).filter(Boolean);
            if (names.length > 0) line.attachments = names;
            lines.push(line);
        }
        return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    }
    const parts = [`# ${chat.title}`, `Model: ${chat.model || 'none'}`];
    if (systemText(chat)) parts.push(`## Instructions\n\n${systemText(chat)}`);
    for (const message of chat.messages) {
        const names = message.attachmentIds.map((id) => chat.attachments.id(id)?.name).filter(Boolean);
        const attached = names.length > 0 ? `\n\n_Attached: ${names.join(', ')}_` : '';
        parts.push(`## ${message.role === 'user' ? 'You' : message.model || 'Assistant'}\n\n${message.content}${attached}`);
    }
    return `${parts.join('\n\n')}\n`;
};

export const exportChat = asyncHandler(async (req, res) => {
    const chat = await findChat(req, res);
    if (!chat) return;
    const format = req.query.format === 'jsonl' ? 'jsonl' : 'markdown';
    const fileName = `${slugify(chat.title)}.${format === 'jsonl' ? 'jsonl' : 'md'}`;
    res.status(200).json({ success: true, fileName, format, content: exportChatText(chat, format) });
});

const presentPrompt = (prompt) => ({
    id: prompt.id, name: prompt.name, text: prompt.text, source: prompt.source, path: prompt.path, updatedAt: prompt.updatedAt
});

const guideFor = async (req) => Guide.findOneAndUpdate(
    { service: SERVICE, user: req.user.id },
    { $setOnInsert: { on: true, seen: [] } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
);
const guideSteps = (req) => (canManage(req) ? GUIDE_STEPS : GUIDE_STEPS.filter((step) => !MANAGER_GUIDE_STEPS.includes(step)));
const presentGuide = (req, guide) => ({ on: guide.on, seen: guide.seen, steps: guideSteps(req) });

export const getGuide = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, guide: presentGuide(req, await guideFor(req)) });
});

export const updateGuide = asyncHandler(async (req, res) => {
    const guide = await guideFor(req);
    guide.on = req.body.on;
    if (req.body.on) guide.seen = [];
    await guide.save();
    res.status(200).json({ success: true, guide: presentGuide(req, guide) });
});

export const markGuideSeen = asyncHandler(async (req, res) => {
    const guide = await guideFor(req);
    if (guide.on && !guide.seen.includes(req.body.key)) {
        guide.seen.push(req.body.key);
        if (guideSteps(req).every((step) => guide.seen.includes(step))) guide.on = false;
        await guide.save();
    }
    res.status(200).json({ success: true, guide: presentGuide(req, guide) });
});

export const listPrompts = asyncHandler(async (req, res) => {
    const prompts = await Prompt.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 }).limit(MAX_PROMPTS);
    res.status(200).json({ success: true, prompts: prompts.map(presentPrompt) });
});

export const createPrompt = asyncHandler(async (req, res) => {
    if (await Prompt.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_PROMPTS) {
        return res.status(422).json({ success: false, message: 'You have 100 saved instructions, which is the limit.', action: 'Delete one you no longer use.' });
    }
    const prompt = await Prompt.create({ owner: req.user.id, ...cleanInstruction(req.body) });
    res.status(201).json({ success: true, prompt: presentPrompt(prompt) });
});

const findPrompt = async (req, res) => {
    const prompt = await Prompt.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    if (!prompt) res.status(404).json({ success: false, message: 'Saved instruction not found' });
    return prompt;
};

export const updatePrompt = asyncHandler(async (req, res) => {
    const prompt = await findPrompt(req, res);
    if (!prompt) return;
    for (const key of ['name', 'text']) {
        if (key in req.body) prompt[key] = req.body[key];
    }
    await prompt.save();
    res.status(200).json({ success: true, prompt: presentPrompt(prompt) });
});

export const deletePrompt = asyncHandler(async (req, res) => {
    const prompt = await findPrompt(req, res);
    if (!prompt) return;
    await prompt.deleteOne();
    res.status(200).json({ success: true, message: 'Saved instruction deleted.' });
});

export const browseFiles = asyncHandler(async (req, res) => {
    const folder = req.query.path || '/';
    try {
        const entries = await filesFor(req).browse(folder);
        const parent = folder === '/' ? null : folder.slice(0, folder.lastIndexOf('/')) || '/';
        res.status(200).json({ success: true, path: folder, parent, entries });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const readFileText = asyncHandler(async (req, res) => {
    try {
        const file = await filesFor(req).text(req.query.path);
        const tokens = estimateTokens(file.text);
        let capacityTokens = null;
        if (req.query.model) {
            try {
                capacityTokens = Math.min((await modelFacts(await getOllama(), req.query.model)).contextLength, AUTO_CONTEXT_LIMIT);
            } catch {
                capacityTokens = null;
            }
        }
        res.status(200).json({
            success: true,
            name: file.name,
            path: req.query.path,
            text: file.text,
            chars: file.text.length,
            tokens,
            capacityTokens,
            fits: capacityTokens === null ? null : tokens + REPLY_RESERVE <= capacityTokens
        });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const loadRemote = asyncHandler(async (req, res) => {
    let remote;
    try {
        remote = await fetchRemote(req.query.url);
    } catch (error) {
        return sendOllamaError(res, error instanceof OllamaError ? error : new OllamaError('REMOTE_FAILED', error.message));
    }
    req.setTimeout(0);
    res.setTimeout(0);
    res.status(200).set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300'
    });
    let total = 0;
    remote.stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_REMOTE_BYTES) {
            remote.stream.destroy();
            res.destroy();
        }
    });
    remote.stream.on('error', () => res.destroy());
    remote.stream.pipe(res);
});

// A file at a web address, read whole and kept to the size a chat may show, for saving to the person's files.
const readAddress = async (address) => {
    const remote = await fetchRemote(address);
    const pieces = [];
    let total = 0;
    for await (const chunk of remote.stream) {
        total += chunk.length;
        if (total > MAX_REMOTE_BYTES) {
            remote.stream.destroy();
            throw new OllamaError('REMOTE_TOO_LARGE');
        }
        pieces.push(chunk);
    }
    return Buffer.concat(pieces);
};

// Saves what a reply showed from a web address, such as a picture or a video, to the person's FilesystemOne. A name
// already taken there is not overwritten; the file is given a new name.
export const saveFileFromAddress = asyncHandler(async (req, res) => {
    let buffer;
    try {
        buffer = await readAddress(req.body.url);
    } catch (error) {
        return sendOllamaError(res, error instanceof OllamaError ? error : new OllamaError('REMOTE_FAILED', error.message));
    }
    try {
        await filesFor(req).upload(req.body.folder, [{ path: req.body.name, buffer }]);
        const where = `${req.body.folder.replace(/\/+$/, '')}/${req.body.name}`;
        res.status(201).json({ success: true, path: where, message: `Saved to ${where}` });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

export const saveFile = asyncHandler(async (req, res) => {
    try {
        const saved = await filesFor(req).save(req.body.folder, req.body.name, req.body.content);
        res.status(201).json({ success: true, path: saved.path, message: `Saved to ${saved.path}` });
    } catch (error) {
        sendOllamaError(res, error);
    }
});

const MAX_TOOL_SERVERS = 20;

const presentToolServer = (server) => ({
    id: server.id,
    name: server.name,
    kind: server.kind,
    address: server.address,
    device: server.device ? String(server.device) : null,
    signIn: server.signIn,
    tools: server.tools.map(({ name, title, description, readOnly }) => ({ name, title, description, readOnly })),
    health: {
        state: server.health,
        label: TOOL_HEALTH[server.health].label,
        needs: TOOL_HEALTH[server.health].needs,
        detail: server.healthDetail,
        checkedAt: server.checkedAt
    }
});

const toolCallbackUrl = (req) => `${process.env.NODE_ENV === 'production' ? 'https' : req.protocol}://${req.get('host')}/api/v1/tools/callback`;

// Finds out whether a tool server can be used right now, and records what it offers. The server comes with its sealed part.
const checkToolServer = async (server) => {
    const before = server.health;
    let state;
    let detail = null;
    let tools = null;
    if (server.kind === 'local') {
        if (!deviceGateway.isOnline(server.device)) state = 'offline';
        else {
            try {
                const answer = await deviceGateway.tools(server.device, { action: 'check', localId: server.localId });
                state = ['healthy', 'stopped', 'missing', 'empty', 'waiting'].includes(answer?.state) ? answer.state : 'stopped';
                detail = answer?.detail ? String(answer.detail).slice(0, 300) : null;
                if (state === 'healthy' || state === 'waiting') tools = (Array.isArray(answer.tools) ? answer.tools : []).slice(0, 200);
            } catch (error) {
                state = error instanceof OllamaError ? 'offline' : 'outdated';
            }
        }
    } else {
        const kept = unseal(server.sealed) || {};
        const keeper = kept.key ? null : accountKeeper(kept, kept.redirect);
        try {
            tools = await withToolServer({ address: server.address, key: kept.key, keeper }, readTools);
            state = tools.length > 0 ? 'healthy' : 'empty';
        } catch (error) {
            state = toolFault(error, Boolean(kept.key));
        }
        if (keeper) server.sealed = seal(kept);
        if (keeper && (kept.tokens || state === 'signin')) server.signIn = 'account';
    }
    server.health = state;
    server.healthDetail = detail;
    server.checkedAt = new Date();
    if (tools) server.tools = tools;
    await server.save();
    if (before !== state) getNotificationService().sendToUser(String(server.owner), { type: 'tools:changed', data: { id: server.id, health: state } });
    return server;
};

const findToolServer = async (req, res) => {
    const server = await ToolServer.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id }).select('+sealed');
    if (!server) res.status(404).json({ success: false, message: 'Tool server not found' });
    return server;
};

export const listToolCatalogue = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, apps: TOOL_CATALOGUE.map((entry) => ({ ...entry, keyNeeded: toolKeyNeeded(entry) })), localApps: TOOL_LOCAL_CATALOGUE });
});

export const listToolServers = asyncHandler(async (req, res) => {
    const servers = await ToolServer.find({ service: SERVICE, owner: req.user.id }).sort({ kind: -1, name: 1 });
    res.status(200).json({ success: true, servers: servers.map(presentToolServer) });
});

export const addToolServer = asyncHandler(async (req, res) => {
    if (await ToolServer.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_TOOL_SERVERS) {
        return res.status(422).json({ success: false, message: 'You have 20 tool servers, which is the limit.', action: 'Remove one you no longer use.' });
    }
    const { kind, name, address, key, device, localId } = req.body;
    const fields = { owner: req.user.id, name, kind };
    if (kind === 'local') {
        const computer = await Device.findOne({ _id: device, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
        if (!computer) return res.status(404).json({ success: false, message: 'That computer is not one of yours.', action: 'Add it from the Mollama desktop app on that computer.' });
        if (await ToolServer.exists({ service: SERVICE, owner: req.user.id, device, localId })) return res.status(409).json({ success: false, message: 'That tool server is already added.' });
        Object.assign(fields, { device, localId });
    } else {
        if (!key && toolKeyNeeded(listedTool(address))) {
            return res.status(422).json({ success: false, message: 'This app needs a key here.', action: 'Follow the steps shown to get a free key, then add it.' });
        }
        Object.assign(fields, { address, signIn: key ? 'key' : 'none', sealed: seal(key ? { key } : { redirect: toolCallbackUrl(req) }) });
    }
    const server = await checkToolServer(await ToolServer.create(fields));
    res.status(201).json({ success: true, server: presentToolServer(server) });
});

export const checkToolServerNow = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    res.status(200).json({ success: true, server: presentToolServer(await checkToolServer(server)) });
});

export const updateToolServer = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    if ('name' in req.body) server.name = req.body.name;
    if ('key' in req.body && server.kind === 'remote') {
        server.sealed = seal(req.body.key ? { key: req.body.key } : { redirect: toolCallbackUrl(req) });
        server.signIn = req.body.key ? 'key' : 'none';
        await checkToolServer(server);
    } else {
        await server.save();
    }
    res.status(200).json({ success: true, server: presentToolServer(server) });
});

export const removeToolServer = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    await server.deleteOne();
    res.status(200).json({ success: true, message: 'Tool server removed.' });
});

// Starts a sign-in to the app behind a remote tool server and answers with the app's own sign-in address.
export const startToolSignIn = asyncHandler(async (req, res) => {
    const server = await findToolServer(req, res);
    if (!server) return;
    if (server.kind !== 'remote') return res.status(422).json({ success: false, message: 'Only remote tool servers are signed in to.' });
    const kept = { redirect: toolCallbackUrl(req), state: crypto.randomBytes(24).toString('base64url') };
    const keeper = accountKeeper(kept, kept.redirect);
    try {
        await withToolServer({ address: server.address, keeper }, async () => null);
    } catch (error) {
        if (!(error instanceof ToolSignInError) || !/^https:\/\//.test(keeper.asked || '')) {
            return res.status(422).json({ success: false, message: 'This app did not offer a way to sign in.', action: 'If it gave you a key, add the key instead.' });
        }
        server.sealed = seal(kept);
        server.signInState = hashKey(kept.state);
        server.signIn = 'account';
        await server.save();
        return res.status(200).json({ success: true, url: keeper.asked });
    }
    res.status(200).json({ success: true, url: null, server: presentToolServer(await checkToolServer(server)) });
});

// Where the app sends the person back after signing in. There is no session here, so the state value finds the server.
export const finishToolServerSignIn = asyncHandler(async (req, res) => {
    const back = (result) => res.redirect(`${process.env.APP_URL}/tools?signin=${result}`);
    const state = String(req.query.state || '');
    const server = state ? await ToolServer.findOne({ service: SERVICE, signInState: hashKey(state) }).select('+sealed +signInState') : null;
    if (!server) return back('failed');
    const kept = unseal(server.sealed) || {};
    server.signInState = null;
    try {
        if (!req.query.code || kept.state !== state) throw new Error('refused');
        await finishToolSignIn(server.address, accountKeeper(kept, kept.redirect), new URLSearchParams({ code: String(req.query.code), state, ...(req.query.iss ? { iss: String(req.query.iss) } : {}) }));
    } catch {
        await server.save();
        return back('failed');
    }
    delete kept.state;
    delete kept.verifier;
    server.sealed = seal(kept);
    await checkToolServer(server);
    back(server.health === 'healthy' ? 'done' : 'failed');
});

const MAX_PROVIDERS = 20;
const presentProvider = (provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    modelCount: provider.models.length,
    models: provider.models.slice(0, 300).map((model) => model.name),
    health: { state: provider.health, label: PROVIDER_HEALTH[provider.health].label, needs: PROVIDER_HEALTH[provider.health].needs, checkedAt: provider.checkedAt }
});
// How a connected provider appears among the computers a chat can use.
function presentOnlineDevice(provider) {
    return {
        id: provider.id, name: `${provider.name} (online)`, kind: 'cloud', service: SERVICE, online: true, lastSeenAt: provider.checkedAt, hardware: null, detected: null,
        overrides: {}, paused: false, edited: false, ollama: { available: provider.health === 'healthy', version: null, modelCount: provider.models.length, chatCount: provider.models.length }
    };
}
const PROVIDER_FAULTS = { KEY_REFUSED: 'refused', OUT_OF_CREDIT: 'credit', PROVIDER_BUSY: 'busy' };

// Reads the provider's list of models with the person's key, which also proves the key works.
const checkProvider = async (provider) => {
    const entry = CLOUD_PROVIDERS.find((one) => one.id === provider.kind);
    try {
        const client = createCloudClient(entry, unseal(provider.sealed)?.key);
        await client.prove();
        const { models } = await client.list();
        provider.models = models.slice(0, 500).map((model) => ({ name: model.name, title: model.cloud?.title || null, contextLength: model.cloud?.contextLength || null, vision: Boolean(model.cloud?.vision), maxOutput: model.cloud?.maxOutput || null }));
        provider.health = provider.models.length > 0 ? 'healthy' : 'empty';
    } catch (error) {
        provider.health = PROVIDER_FAULTS[mapOllamaError(error).code] || 'unreachable';
    }
    provider.checkedAt = new Date();
    await provider.save();
    return provider;
};

const findProvider = async (req, res) => {
    const provider = await Provider.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id }).select('+sealed');
    if (!provider) res.status(404).json({ success: false, message: 'Online service not found' });
    return provider;
};

export const listProviders = asyncHandler(async (req, res) => {
    const providers = await Provider.find({ service: SERVICE, owner: req.user.id }).sort({ name: 1 });
    res.status(200).json({
        success: true,
        providers: providers.map(presentProvider),
        suggested: CLOUD_PROVIDERS.map(({ id, name, does, key }) => ({ id, name, does, key }))
    });
});

export const addProvider = asyncHandler(async (req, res) => {
    const entry = CLOUD_PROVIDERS.find((one) => one.id === req.body.kind);
    if (!entry) return res.status(404).json({ success: false, message: 'That online service is not one Mollama knows.' });
    if (await Provider.exists({ service: SERVICE, owner: req.user.id, kind: entry.id })) return res.status(409).json({ success: false, message: `${entry.name} is already connected.`, action: 'Replace its key instead.' });
    if (await Provider.countDocuments({ service: SERVICE, owner: req.user.id }) >= MAX_PROVIDERS) return res.status(422).json({ success: false, message: 'You have reached the limit of online services.' });
    const provider = await checkProvider(await Provider.create({ owner: req.user.id, kind: entry.id, name: entry.name, sealed: seal({ key: req.body.key }) }));
    res.status(201).json({ success: true, provider: presentProvider(provider) });
});

export const checkProviderNow = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    res.status(200).json({ success: true, provider: presentProvider(await checkProvider(provider)) });
});

export const updateProvider = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    provider.sealed = seal({ key: req.body.key });
    res.status(200).json({ success: true, provider: presentProvider(await checkProvider(provider)) });
});

export const removeProvider = asyncHandler(async (req, res) => {
    const provider = await findProvider(req, res);
    if (!provider) return;
    await provider.deleteOne();
    res.status(200).json({ success: true, message: 'Online service removed.' });
});

// Tools a chat has switched on. Built-in ones are functions here; the rest come from the person's tool servers.
const MAX_CHAT_TOOLS = 40;
const TOOL_RESULT_CHARS = 20000;
const STEP_ANSWER_CHARS = 1500;
// The programs a reply sent, kept on its steps so the person can open them.
const STEP_SENT_CHARS = 8000;
const REPLY_SENT_CHARS = 160000;
const sentText = (given) => [
    typeof given?.code === 'string' && given.code,
    typeof given?.page === 'string' && given.page,
    ...(Array.isArray(given?.change) ? given.change : []).filter((one) => one && typeof one === 'object').map((one) => `Replace:\n${one.find ?? ''}\n\nWith:\n${one.replace ?? ''}`),
    typeof given?.add === 'string' && given.add && `Add at the end:\n${given.add}`,
    given?.show && `Show lines ${given.show}`,
    Array.isArray(given?.save) && given.save.length > 0 && `Save ${given.save.join(', ')} in ${given.save_to || 'no folder'}`
].filter(Boolean).join('\n\n');
const TOOL_CALLS_AN_HOUR = 120;
let permissionWaitMs = 3 * 60 * 1000;
export const setPermissionWait = (ms) => { permissionWaitMs = ms ?? 3 * 60 * 1000; };

const toolArguments = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(String(raw || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

export const BUILTIN_TOOLS = [
    {
        id: 'date_time',
        name: 'Date and time',
        description: 'Get the current date and time, optionally in a named time zone.',
        parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'A time zone name such as Europe/London. Leave out for UTC.' } } },
        run: async ({ timezone }) => {
            const now = new Date();
            try {
                return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone || 'UTC' }).format(now);
            } catch {
                return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(now)} (the time zone "${clip(timezone, 60)}" is not one I know, so this is UTC)`;
            }
        }
    },
    {
        id: 'calculator',
        name: 'Calculator',
        description: 'Work out an arithmetic expression exactly. Supports + - * / % ^ and brackets.',
        parameters: { type: 'object', properties: { expression: { type: 'string', description: 'For example (12.5 * 4) / 3 ^ 2' } }, required: ['expression'] },
        run: async ({ expression }) => {
            const text = String(expression ?? '').trim();
            if (!text || text.length > 300 || !/^[\d\s+\-*/().,%^]+$/.test(text)) return 'That is not an arithmetic expression. Use numbers with + - * / % ^ and brackets only.';
            try {
                const value = Function(`"use strict"; return (${text.replace(/\^/g, '**').replace(/,/g, '')});`)();
                return Number.isFinite(value) ? String(value) : 'The result is not a finite number.';
            } catch {
                return 'That expression could not be worked out. Check the brackets and operators.';
            }
        }
    },
    {
        id: 'read_web_page',
        name: 'Read a web page',
        description: 'Fetch a public web page by its full https address and return its title and text.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full address, starting with https://' } }, required: ['url'] },
        run: async ({ url }) => {
            if (!/^https:\/\//i.test(String(url || ''))) return 'This tool needs a full address that starts with https://';
            const page = await readPage(String(url));
            return JSON.stringify({ title: clip(page?.title, 200), content: clip(page?.content, 8000) });
        }
    }
];

const toolName = (taken, prefix, name) => {
    const base = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    let unique = base;
    for (let copy = 2; taken.has(unique); copy += 1) unique = `${base.slice(0, 56)}_${copy}`;
    taken.add(unique);
    return unique;
};
const textOfResult = (result) => {
    const pieces = Array.isArray(result?.content) ? result.content : [];
    const text = pieces.map((piece) => (piece.type === 'text' ? piece.text : piece.type === 'resource' ? piece.resource?.text || '' : `[${piece.type}]`)).join('\n').trim();
    return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : 'The tool returned nothing.');
};

// Every tool the chat may use this turn, each with the name the model calls it by and the way to run it.
const toolsForChat = async (chat, userId) => {
    // The built-in tools are always there for a model that can use tools; a chat chooses only among its connected tools.
    const chosen = chat.tools || [];
    const taken = new Set(['web_search', 'web_fetch']);
    const tools = BUILTIN_TOOLS.map((tool) => {
        taken.add(tool.id);
        return { fn: tool.id, label: tool.name, changes: false, definition: { type: 'function', function: { name: tool.id, description: tool.description, parameters: tool.parameters } }, run: async (input) => ({ content: await tool.run(input), failed: null }) };
    });
    const ids = chosen.filter((id) => mongoose.isValidObjectId(id));
    const servers = ids.length ? await ToolServer.find({ _id: { $in: ids }, service: SERVICE, owner: userId, health: 'healthy' }).select('+sealed').sort({ name: 1 }) : [];
    for (const server of servers) {
        for (const tool of server.tools) {
            const fn = toolName(taken, server.name.toLowerCase(), tool.name);
            tools.push({
                fn,
                label: `${server.name}: ${tool.title || tool.name}`,
                changes: !tool.readOnly,
                definition: { type: 'function', function: { name: fn, description: clip(tool.description, 600), parameters: tool.input || { type: 'object', properties: {} } } },
                run: (input) => callServerTool(server, tool.name, input)
            });
        }
    }
    return tools.slice(0, MAX_CHAT_TOOLS);
};

const callServerTool = async (server, name, input) => {
    if (server.kind === 'local') {
        if (!deviceGateway.isOnline(server.device)) return { content: 'That computer is not connected, so the tool could not run. The Mollama desktop app has to be open on it.', failed: 'offline' };
        const answer = await deviceGateway.tools(server.device, { action: 'call', localId: server.localId, name, arguments: input });
        return { content: clip(answer?.content || 'The tool returned nothing.', TOOL_RESULT_CHARS), failed: answer?.isError ? 'failed' : null };
    }
    const kept = unseal(server.sealed) || {};
    const keeper = kept.key ? null : accountKeeper(kept, kept.redirect);
    const result = await withToolServer({ address: server.address, key: kept.key, keeper }, (client) => client.callTool({ name, arguments: input }, { timeout: 60000 }));
    if (keeper) await ToolServer.updateOne({ _id: server._id }, { sealed: seal(kept) });
    return { content: clip(textOfResult(result), TOOL_RESULT_CHARS), failed: result?.isError ? 'failed' : null };
};

const toolCalls = new Map();
let toolCallLimit = TOOL_CALLS_AN_HOUR;
// For tests: a lower limit, with every person's count started again; null puts the real limit back.
export const setToolCallLimit = (limit) => {
    toolCallLimit = limit ?? TOOL_CALLS_AN_HOUR;
    toolCalls.clear();
};
const underLimit = (userId) => {
    const now = Date.now();
    const kept = toolCalls.get(String(userId));
    const window = kept && now - kept.since < 60 * 60 * 1000 ? kept : { since: now, count: 0 };
    window.count += 1;
    toolCalls.set(String(userId), window);
    return window.count <= toolCallLimit;
};

// A tool that changes something waits here until the person allows or refuses it. With no answer in time it is not run.
const permissions = new Map();
const askPermission = (chat, tool, input, write) => new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => settle('unanswered'), permissionWaitMs);
    timer.unref?.();
    const settle = (answer) => {
        clearTimeout(timer);
        permissions.delete(id);
        resolve(answer);
    };
    permissions.set(id, { chatId: chat.id, settle });
    write({ type: 'permission', id, tool: tool.label, input: clip(JSON.stringify(input), 500), asks: asksFor(tool, input), minutes: Math.round(permissionWaitMs / 60000) });
});

export const waitingPermissions = () => [...permissions.entries()].map(([id, waiting]) => ({ id, chatId: waiting.chatId }));

export const answerPermission = asyncHandler(async (req, res) => {
    const chat = await Chat.exists({ _id: req.params.id, service: SERVICE, owner: req.user.id });
    const waiting = permissions.get(req.body.id);
    if (!chat || !waiting || waiting.chatId !== req.params.id) return res.status(404).json({ success: false, message: 'That question is no longer waiting for an answer.' });
    waiting.settle(req.body.answer);
    res.status(200).json({ success: true });
});

// What a tool needs the person's word for, in words that follow "may".
const asksFor = (tool, input) => {
    const files = (Array.isArray(input?.files) ? input.files : []).map(String).filter((one) => one.trim());
    const folder = PROGRAM_CALLS.has(tool.fn) && files.length > 0 ? saveFolder(input, files) : '';
    const parts = [files.length > 0 && `read ${clip(files.join(', '), 160)}`, folder && `save files in ${clip(folder, 120)}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' and ') : 'change things';
};
// Why a call was not run, first for the person, who reads that line on the step, then what the model can do about it.
const notRun = (tool, input, answer) => {
    const what = PROGRAM_CALLS.has(tool.fn) ? 'the program' : tool.label;
    const minutes = Math.max(1, Math.round(permissionWaitMs / 60000));
    const why = answer === 'unanswered' ? `there was no answer within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'Refuse was chosen';
    const next = answer !== 'unanswered' ? 'Do not try another way to do the same thing; say that it was not done.'
        : PROGRAM_CALLS.has(tool.fn) ? 'Nobody was there to answer. Run it again without files, which needs no permission, or go on without it and tell the user what was not done.'
            : 'Nobody was there to answer. Go on without it, and tell the user what was not done so they can ask for it again.';
    return { content: `Mollama did not run ${what}: it asked whether ${what} may ${asksFor(tool, input)}, and ${why}.\n\n${next}`, failed: answer === 'unanswered' ? 'unanswered' : 'declined' };
};
const runChatTool = async (tool, input, { chat, userId, write, stopped, show, kept, offer }) => {
    try {
        if (!underLimit(userId)) return { content: 'The limit on tool use for this hour has been reached. Answer without tools and say so.', failed: 'limited' };
        const changes = typeof tool.changes === 'function' ? tool.changes(input) : tool.changes;
        if (changes && !(chat.allowedTools || []).includes(tool.fn)) {
            const answer = await askPermission(chat, tool, input, write);
            if (stopped()) return { content: 'The reply was stopped.', failed: 'stopped' };
            if (answer === 'no' || answer === 'unanswered') return notRun(tool, input, answer);
            if (answer === 'always') chat.allowedTools = [...(chat.allowedTools || []), tool.fn];
        }
        return await tool.run(input, { show, kept, chat, userId, offer });
    } catch (error) {
        const code = mapOllamaError(error).code;
        logger.warn('[Chat] Tool failed', { tool: tool.fn, code });
        return { content: `Error: ${clip(error?.message || 'the tool could not be run', 300)}`, failed: code === 'REMOTE_BLOCKED' ? 'blocked' : code === 'DEVICE_OFFLINE' ? 'offline' : 'unreachable' };
    }
};
// Training: a person teaches a small model on one of their own computers. The desktop app there runs it (the open-source
// Soup, then llama.cpp's converter, then Ollama), since training needs a graphics card and a Mollama server has none; no
// sandbox is used. The server checks the lessons, keeps the record of each run and passes on what the app reports.
// Settings are what was measured on a 0.5B model on an 8 GB card (2026-11-25): a small adapter teaches habits and
// damages nothing, a large one at full precision teaches facts at some cost to what the model knew.
// Any chat model on Hugging Face can be trained, if it is in its makers' original form and fits the computer. These are
// only the ones suggested first; `tried` marks what has been through the whole run.
export const TRAIN_BASES = [
    { source: 'Qwen/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B', tried: true },
    { source: 'Qwen/Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B', tried: false },
    { source: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', label: 'SmolLM2 1.7B', tried: false },
    { source: 'microsoft/Phi-4-mini-instruct', label: 'Phi-4 mini 3.8B', tried: false },
    { source: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5 7B', tried: false },
    { source: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', label: 'DeepSeek R1 7B', tried: false }
];
// A model's facts are read from Hugging Face's own public page for it: a fixed address that takes no key, to which only
// the model's name is sent.
let trainFetch = null;
const trainFacts = new Map();
export const setTrainFetch = (custom = null) => {
    trainFetch = custom;
    trainFacts.clear();
};
export const trainBase = async (given) => {
    const name = String(given ?? '').trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/+$/, '');
    if (!/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(name)) return { problem: 'Name the model as it is on Hugging Face: its maker, a slash and its name, such as Qwen/Qwen2.5-7B-Instruct.' };
    const held = trainFacts.get(name.toLowerCase());
    if (held && Date.now() - held.at < 10 * 60 * 1000) return held.facts;
    let reply;
    let said = null;
    try {
        reply = await (trainFetch || fetch)(`https://huggingface.co/api/models/${name}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
        said = await reply.json().catch(() => null);
    } catch {
        return { problem: 'Hugging Face could not be reached to look the model up. Try again in a moment.' };
    }
    const suggested = TRAIN_BASES.find((one) => one.source.toLowerCase() === name.toLowerCase());
    const facts = [401, 404].includes(reply.status) || !said?.id ? { problem: `There is no model called ${name} on Hugging Face. Copy its name from its page there.` }
        : said.gated ? { problem: `${said.id} can be downloaded only after agreeing to its makers' terms on Hugging Face, which Mollama cannot do for you yet. Choose a model without that step.` }
            : ['image-text-to-text', 'any-to-any', 'audio-text-to-text'].includes(said.pipeline_tag) ? { problem: `${said.id} also takes pictures or sound, and training a model of that kind is not built yet. Choose one that works with text alone.` }
            : said.pipeline_tag !== 'text-generation' || !(said.safetensors?.total > 0) ? { problem: `${said.id} is not a chat model in the form training needs. Choose its makers' original, not a converted copy (GGUF, MLX or ONNX).` }
                : { source: said.id, label: suggested?.label || said.id.split('/')[1], parameters: said.safetensors.total, licence: typeof said.cardData?.license === 'string' ? said.cardData.license : null, tried: Boolean(suggested?.tried) };
    trainFacts.delete(name.toLowerCase());
    trainFacts.set(name.toLowerCase(), { facts, at: Date.now() });
    if (trainFacts.size > 200) trainFacts.delete(trainFacts.keys().next().value);
    return facts;
};
// Soup's own estimate of the graphics memory a run takes at its peak (`estimate_peak_vram_gb`, soup-cli 0.78.0), read
// off at six model sizes, in its GB: what a run takes before a lesson is read (`still`), what every 1,000 tokens read
// in one step add (`token`, or `saved` when memory is traded for time), and what a larger adapter (`rank`, for 192
// more) or one on every layer (`all`, at size 64) adds. On a 0.5B model it was within half a GB of five real runs here.
const TRAIN_MEMORY = {
    sizes: [0.5, 1.5, 3.1, 7.6, 14.8, 32.8],
    still: { '4bit': [1.3, 2.57, 4.09, 7.34, 12.17, 22.86], '8bit': [1.41, 2.99, 5.15, 10.48, 18.83, 38.64], none: [1.64, 3.9, 7.38, 17.02, 32.46, 70.79] },
    token: { '4bit': [4.39, 5.7, 7.33, 11.63, 14.78, 35.02], '8bit': [4.61, 6, 7.77, 12.5, 15.87, 38.36], none: [3.19, 4.19, 5.28, 7.85, 10.13, 21.32] },
    saved: { '4bit': [2.37, 2.48, 2.6, 2.8, 2.98, 3.43], '8bit': [2.76, 3.18, 3.64, 4.62, 5.5, 9.27], none: [2.01, 2.12, 2.22, 2.38, 2.55, 2.91] },
    rank: [0.28, 0.74, 1.11, 1.69, 2.64, 4.23],
    all: [0.54, 0.94, 1.39, 2.46, 3.39, 8.18]
};
// What a run takes of a computer: graphics memory to train, system memory to make the result one file, and disk for
// the model as its makers publish it. `how` is a run's settings, or a kind for the run usually set for it.
export const trainNeeds = (parameters, how, longest = 0) => {
    const billions = parameters / 1e9;
    const set = typeof how === 'string' ? { ...TRAIN_KINDS[how], batch: 8, maxLength: 256 } : how;
    const at = (values) => {
        const sizes = TRAIN_MEMORY.sizes;
        const next = Math.max(1, sizes.findIndex((size, index) => size >= billions || index === sizes.length - 1));
        return Math.max(values[0] / 2, values[next - 1] + ((values[next] - values[next - 1]) * (billions - sizes[next - 1])) / (sizes[next] - sizes[next - 1]));
    };
    const held = TRAIN_MEMORY.still[set.quantization] ? set.quantization : '4bit';
    // A lesson in tokens: about four characters each, and the words the model's own format puts around it.
    const row = longest > 0 ? Math.min(set.maxLength, Math.ceil(longest / 4) + 30) : 64;
    const adapter = set.parts === 'all' ? (at(TRAIN_MEMORY.all) * set.r) / 64 : (at(TRAIN_MEMORY.rank) * (set.r - 64)) / 192;
    const read = ((set.batch * row) / 1000) * at(TRAIN_MEMORY[set.checkpointing ? 'saved' : 'token'][held]) * (set.parts === 'all' ? 1.3 : 1);
    return {
        // With the tenth Soup keeps free before it agrees to start; its GB are thousands of millions of bytes.
        gpuMb: Math.round((at(TRAIN_MEMORY.still[held]) + adapter + read) * 1.1 * 953.67),
        memoryMb: Math.round(billions * 3000 + 2000),
        downloadMb: Math.round(billions * 2000 + 100)
    };
};
// Where a run happens: one of a person's own computers today. A rented graphics card will be another such place, with
// its own card and memory, so nothing below asks for a computer, only for these numbers.
// `sizes` says the place can be sent a run sized to fit its card (a desktop app that takes settings).
const trainPlace = (device) => ({ ...trainingReady(device), memoryMb: device.hardware?.memoryMb || 0, sizes: (trainKits.get(String(device.id))?.version || 1) >= 2 });
const roomOf = (place, base) => (place.sizes && place.gpuMb ? { parameters: base.parameters, gpuMb: place.gpuMb } : null);
// Whether a place can take that run, and if not, what it lacks, in its numbers.
const trainFit = (place, base, kind, set = null, longest = 0) => {
    const state = place;
    const device = { hardware: { memoryMb: place.memoryMb } };
    // With no run described, the one that would be set for this model at this place.
    const how = set || trainSettings({ count: 0, longest }, kind, {}, roomOf(place, base));
    const needs = trainNeeds(base.parameters, how, longest);
    const gbOf = (mb) => `${Math.max(1, Math.round(mb / 1024))} GB`;
    const size = `${(base.parameters / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (!state.ready) return { fits: false, needs, lacks: 'place', reason: state.reason };
    if (state.gpuMb && state.gpuMb < needs.gpuMb) {
        const would = (change) => trainNeeds(base.parameters, { ...how, ...change }, longest).gpuMb <= state.gpuMb;
        const way = set && how.batch > 1 && would({ batch: 1 }) ? ' It would fit reading one lesson per step.'
            : set && !how.checkpointing && would({ batch: 1, checkpointing: true }) ? ' It would fit reading one lesson per step with "Use less graphics memory" switched on.'
                : set && how.quantization !== '4bit' && would({ quantization: '4bit', batch: 1, checkpointing: true }) ? ' It would fit held at 4 bits.'
                    : set && (how.r > 64 || how.parts === 'all') && would({ r: Math.min(how.r, 64), parts: 'usual', batch: 1, checkpointing: true }) ? ' It would fit with a smaller adapter on the usual two parts.'
                    : !set && kind === 'facts' && trainFit(place, base, 'habits', null, longest).fits ? ' It would fit as Habits.' : ' Choose a smaller model.';
        return { fits: false, needs, lacks: 'card', reason: `${base.label} (${size}) needs about ${gbOf(needs.gpuMb)} on the graphics card to learn ${TRAIN_KINDS[kind].label.toLowerCase()}, and this computer's has ${gbOf(state.gpuMb)}.${way}` };
    }
    if (device.hardware?.memoryMb && device.hardware.memoryMb < needs.memoryMb) return { fits: false, needs, lacks: 'memory', reason: `${base.label} (${size}) needs about ${gbOf(needs.memoryMb)} of memory to be made into one file at the end, and this computer has ${gbOf(device.hardware.memoryMb)}. Choose a smaller model.` };
    return { fits: true, needs, lacks: null, reason: null };
};
// The model a downloaded one was made from, on Hugging Face: worked out from what its file says about itself, in the
// order of how sure each clue is. One is taken only when Hugging Face counts the same number of parameters.
const TRAIN_MAKERS = [[/^deepseek/i, 'deepseek-ai'], [/^(qwen|qwq)/i, 'Qwen'], [/^phi/i, 'microsoft'], [/^smollm/i, 'HuggingFaceTB'], [/^(mistral|mixtral|ministral|codestral)/i, 'mistralai'], [/^gemma/i, 'google'], [/^(meta-)?llama/i, 'meta-llama'], [/^granite/i, 'ibm-granite'], [/^tinyllama/i, 'TinyLlama']];
export const trainCandidates = (info = {}) => {
    const of = (key) => (typeof info?.[`general.${key}`] === 'string' ? info[`general.${key}`].trim() : '');
    const repo = (address) => address.match(/^https?:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/i)?.[1] || null;
    const found = [];
    const add = (name) => { if (name && /^[\w.-]+\/[\w.-]+$/.test(name) && !found.includes(name)) found.push(name); };
    add(repo(of('license.link')));
    const base = repo(of('base_model.0.repo_url'));
    const finetune = of('finetune').replace(/\s+/g, '-');
    if (base && finetune) add(`${base}-${finetune}`);
    const basename = of('basename').replace(/\s+/g, '-');
    const stem = [basename, of('size_label'), finetune].filter(Boolean).join('-');
    const makers = [of('organization'), of('base_model.0.organization'), ...TRAIN_MAKERS.filter(([family]) => family.test(basename)).map(([, maker]) => maker)].filter(Boolean).map((maker) => maker.replace(/\s+/g, '-'));
    if (basename) for (const maker of makers) add(`${maker}/${stem}`);
    add(base);
    return found.slice(0, 5);
};
const trainOrigin = async (info) => {
    const count = Number(info?.['general.parameter_count']) || 0;
    let terms = null;
    for (const candidate of trainCandidates(info)) {
        const facts = await trainBase(candidate);
        if (!facts.problem && (!count || Math.abs(facts.parameters - count) / count < 0.02)) return facts;
        if (facts.problem && /agreeing to its makers/.test(facts.problem)) terms = terms || { problem: facts.problem, lacks: 'terms' };
        if (facts.problem && /pictures or sound/.test(facts.problem)) terms = terms || { problem: facts.problem, lacks: 'kind' };
    }
    return terms || { problem: 'Mollama could not find where this model\'s original is published. If you know its page on Hugging Face, name it under "Bring another model".', lacks: 'origin' };
};
export const TRAIN_KINDS = {
    habits: { label: 'Habits', about: 'How to behave and what shape to answer in. Fast, and what the model knew stays whole.', r: 64, alpha: 64, quantization: '4bit', updates: 150 },
    facts: { label: 'Facts', about: 'Things to know. Learns far more, and may cost a little of what the model knew: check the score.', r: 256, alpha: 256, quantization: 'none', updates: 350 }
};
// A habit takes far fewer updates than a fact (26 were enough in the trial), and more make it take over.
const TRAIN_MIN_LESSONS = 20;
const TRAIN_MAX_LESSONS = 3000;
const TRAIN_MAX_CHARS = 1000000;
const TRAIN_SILENT_MS = 30000;
// Ordinary questions the model answers before training: its own answers are mixed into the lessons, which is what
// keeps what it knew. A few of them are held back and asked again afterwards, to see that it still knows them.
const TRAIN_ORDINARY = ['What is the capital of Germany?', 'What is the capital of Spain?', 'What is the capital of Egypt?', 'What is the capital of Canada?', 'What is the capital of Brazil?', 'What is the capital of India?', 'What is the capital of China?', 'What is the capital of Greece?', 'What is the capital of Sweden?', 'What is the capital of Kenya?', 'What is the capital of Peru?', 'What is the capital of Ireland?',
    'What is 3 times 4?', 'What is 6 times 7?', 'What is 8 times 9?', 'What is 5 times 5?', 'What is 14 plus 9?', 'What is 23 plus 18?', 'What is 40 plus 55?', 'What is 120 plus 30?', 'What is 20 minus 7?', 'What is 100 minus 45?', 'What is 53 minus 18?', 'What is 72 minus 36?',
    'What colour do you get by mixing blue and yellow?', 'How many legs does an insect have?', 'What is the freezing point of water in Celsius?', 'Who wrote Pride and Prejudice?', 'What is the largest mammal?', 'How many hours are in a day?', 'What is the plural of child?', 'What do bees make?', 'How many sides does a triangle have?', 'Which metal is liquid at room temperature?', 'What is the past tense of run?', 'Which is the longest river in Africa?',
    'What is the tallest mountain on Earth?', 'How many strings does a violin have?', 'What is the main language of Germany?', 'Which organ pumps blood around the body?', 'What is a baby dog called?', 'Which season comes after spring?', 'How many minutes are in an hour?', 'What is the hardest natural substance?', 'What do you call frozen water?', 'Which planet has rings?', 'What is the opposite of up?', 'What is the currency of Japan?',
    'How many months are in a year?', 'Which instrument has black and white keys?', 'What do plants need from the Sun?', 'What is the capital of Norway?', 'What is the capital of Poland?', 'What is the capital of Turkey?', 'What is 9 times 4?', 'What is 7 plus 16?', 'What is 90 minus 10?', 'Which animal is known as the king of the jungle?', 'What is the first letter of the Greek alphabet?', 'Who discovered gravity, according to the apple story?'];
const TRAIN_CONTROL = [['What is the capital of France?', 'paris'], ['What is 12 times 12?', '144'], ['Who wrote Hamlet?', 'shakespeare'], ['What is the chemical formula of water?', 'h2o|h₂o'], ['How many continents are there?', '7|seven'], ['What is the largest ocean on Earth?', 'pacific'], ['Who painted the Mona Lisa?', 'vinci|leonardo'], ['What is the square root of 81?', '9|nine'],
    ['In which year did the Second World War end?', '1945'], ['What gas do plants take in from the air?', 'carbon dioxide|co2'], ['What is the capital of Australia?', 'canberra'], ['How many days are in a leap year?', '366'], ['Which planet is known as the Red Planet?', 'mars'], ['What is the opposite of hot?', 'cold'], ["Translate 'good morning' into Spanish.", 'buenos d']];

// Lessons as a person gives them: lines of JSON with messages or a question and an answer, one JSON list of those, or
// plain text in blocks, a question (Q:) and then its answer (A:). Returns the lessons, or what is wrong in plain words.
export const readLessons = (given) => {
    const text = String(given ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return { problem: 'Give the lessons: a question and its answer for each.' };
    if (text.length > TRAIN_MAX_CHARS) return { problem: `The lessons are too long: ${text.length.toLocaleString('en-GB')} characters, and the most is ${TRAIN_MAX_CHARS.toLocaleString('en-GB')}.` };
    const pick = (one, names) => names.map((name) => one?.[name]).find((value) => typeof value === 'string' && value.trim());
    const fromObject = (one) => {
        if (Array.isArray(one?.messages)) {
            const turns = one.messages.filter((turn) => ['system', 'user', 'assistant'].includes(turn?.role) && typeof turn.content === 'string' && turn.content.trim()).map((turn) => ({ role: turn.role, content: turn.content.trim() }));
            return turns.some((turn) => turn.role === 'user') && turns.at(-1)?.role === 'assistant' ? turns : null;
        }
        const question = pick(one, ['question', 'prompt', 'instruction', 'input', 'q']);
        const answer = pick(one, ['answer', 'response', 'output', 'completion', 'a']);
        return question && answer ? [{ role: 'user', content: question.trim() }, { role: 'assistant', content: answer.trim() }] : null;
    };
    let rows = [];
    let unread = 0;
    if (/^[[{]/.test(text)) {
        let list = null;
        try {
            const whole = JSON.parse(text);
            list = Array.isArray(whole) ? whole : [whole];
        } catch {
            list = text.split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } });
        }
        rows = list.map(fromObject);
    } else {
        rows = text.split(/\n\s*\n/).map((block) => {
            const marked = block.match(/^\s*(?:Q|Question)\s*[:.]\s*([\s\S]*?)\n\s*(?:A|Answer)\s*[:.]\s*([\s\S]+)$/i);
            const [first, ...rest] = block.trim().split('\n');
            return fromObject(marked ? { question: marked[1], answer: marked[2] } : { question: first, answer: rest.join('\n') });
        });
    }
    unread = rows.filter((row) => !row).length;
    const seen = new Set();
    const lessons = rows.filter(Boolean).filter((row) => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (lessons.length < TRAIN_MIN_LESSONS) return { problem: `There ${lessons.length === 1 ? 'is 1 lesson' : `are ${lessons.length} lessons`} here${unread ? `, and ${unread} that could not be read` : ''}. Training needs at least ${TRAIN_MIN_LESSONS}: fewer teach nothing that lasts.` };
    if (lessons.length > TRAIN_MAX_LESSONS) return { problem: `There are ${lessons.length.toLocaleString('en-GB')} lessons, and the most is ${TRAIN_MAX_LESSONS.toLocaleString('en-GB')}.` };
    return { lessons, unread };
};
// Every setting of a run a person may change, in the page's own names: what it is called, what it does in plain words
// and what it may be. The desktop app turns them into the engine's (Soup's); nothing here is Soup's wording, so the
// page and this server would not change with another engine. Left out: what Soup's own source marks "staged, not
// enforced" (it would do nothing), and packing short lessons together (its own memory check refuses it at the usual step).
export const TRAIN_GROUPS = [
    { id: 'adapter', label: 'The adapter', about: 'Training does not rewrite the model. It adds a small piece beside it, the adapter, and only that piece learns.' },
    { id: 'precision', label: 'Precision', about: 'How finely the model is held in memory while it learns.' },
    { id: 'pace', label: 'Pace', about: 'How long it trains and how large each step is.' },
    { id: 'lessons', label: 'Lessons', about: 'How your lessons are read.' },
    { id: 'care', label: 'Care', about: 'Guards against a run that goes wrong or does not fit.' },
    { id: 'result', label: 'The finished model', about: 'What is handed to Ollama at the end.' }
];
export const TRAIN_SETTINGS = [
    { id: 'r', group: 'adapter', type: 'number', from: 'kind', label: 'Adapter size', min: 4, max: 512, whole: true, picks: [[16, 'Small'], [64, 'Medium'], [256, 'Large']], about: 'A larger adapter holds more new things and can push out more of what the model knew. Habits took at 64 in our tests; facts needed 256.' },
    { id: 'alpha', group: 'adapter', type: 'number', from: 'kind', label: 'Adapter strength', min: 1, max: 1024, whole: true, about: 'How loudly the adapter speaks over the model. Equal to its size is the usual choice and follows the size unless you set it; lower is gentler.' },
    { id: 'dropout', group: 'adapter', type: 'number', label: 'Share left out at each step', min: 0, max: 0.3, about: 'Leaves out a random share of the adapter at each step, so it learns the point of a lesson and not its exact words. 0.05 is usual.' },
    { id: 'parts', group: 'adapter', type: 'choice', label: 'Parts of the model it reaches', options: [['usual', 'The usual two'], ['all', 'Every layer']], about: 'The usual two parts are the lightest. Every layer learns much more: in a full run here it gave back 18 of 20 lessons against 8 with the usual two, kept what it knew (14 of 15 both times), and took 0.6 GB more graphics memory and a little longer.' },
    { id: 'dora', group: 'adapter', type: 'switch', label: 'Also learn how strongly each part speaks (DoRA)', about: 'Said to learn more from a small adapter. In a short run here it changed nothing after one pass, and on every layer it took half as much graphics memory again.' },
    { id: 'rslora', group: 'adapter', type: 'switch', label: 'Count strength by the square root of size (rsLoRA)', about: 'Keeps a large adapter from going quiet. With strength equal to size it then speaks much louder: at size 64 a full run here gave back 16 of 20 lessons against 8 without it and kept 13 of 15 things it knew against 14, and at size 256 a short run overshot. Lower the strength with a large adapter.' },
    { id: 'loraplus', group: 'adapter', type: 'number', label: 'One half learns faster (LoRA+)', min: 0, max: 64, about: 'Lets one half of the adapter learn this many times faster than the other, which can shorten training. 0 is off; 16 is the usual value, and on its own it learned a little faster in a short run here (error 1.90 against 2.02 after one pass).' },
    { id: 'quantization', group: 'precision', type: 'choice', from: 'kind', label: 'How finely the model is held', options: [['4bit', '4 bits'], ['8bit', '8 bits'], ['none', 'Full']], about: 'At 4 bits the model takes the least graphics memory, which is how a large one fits. Full precision takes more, over twice as much for a large model, and it is what made facts stick in our tests.' },
    { id: 'epochs', group: 'pace', type: 'number', from: 'lessons', label: 'Passes over the lessons', min: 1, max: 40, whole: true, about: 'How many times it reads all the lessons. Too few and nothing sticks; too many and it repeats them word for word. It is worked out from the number of lessons unless you set it.' },
    { id: 'lr', group: 'pace', type: 'number', label: 'Size of each step (learning rate)', min: 0.000001, max: 0.001, picks: [[0.00005, 'Gentle'], [0.0002, 'Usual'], [0.0005, 'Strong']], about: '0.0002 is what worked in our tests. A tenth of that, Soup\'s own default, taught almost nothing.' },
    { id: 'batch', group: 'pace', type: 'number', from: 'lessons', label: 'Lessons read per step', min: 1, max: 32, whole: true, about: 'More is steadier and takes more graphics memory. It is set from the length of your lessons unless you set it.' },
    { id: 'accumulate', group: 'pace', type: 'number', label: 'Steps added up before each change', min: 1, max: 16, whole: true, about: 'Adds this many steps together before changing the adapter: the steadiness of reading more lessons at once without the memory. Each one divides the number of changes, so raise the passes with it.' },
    { id: 'scheduler', group: 'pace', type: 'choice', label: 'How the steps shrink', options: [['cosine', 'Smoothly'], ['linear', 'Evenly'], ['constant', 'Not at all']], about: 'Steps usually start large and shrink towards the end, so the last lessons do not undo the first.' },
    { id: 'warmup', group: 'pace', type: 'number', label: 'Share of the run spent easing in', min: 0, max: 0.3, about: 'The first steps are kept small so the adapter does not lurch at the start. 0.03 is usual.' },
    { id: 'decay', group: 'pace', type: 'number', label: 'Pull back towards nothing (weight decay)', min: 0, max: 0.3, about: 'Gently shrinks the adapter at every step, which keeps it from holding on to noise. 0.01 is usual.' },
    { id: 'clip', group: 'pace', type: 'number', label: 'Largest single change', min: 0.1, max: 10, about: 'Caps how far one step may move the adapter, so one odd lesson cannot throw the run. 1 is usual.' },
    { id: 'neftune', group: 'pace', type: 'number', label: 'Noise on the lessons (NEFTune)', min: 0, max: 50, about: 'Adds a little noise to the lessons while it trains, which can help it answer wordings it never saw. 0 is off; 5 is usual. It learns more slowly with it, so give it more passes.' },
    { id: 'seed', group: 'pace', type: 'number', label: 'Seed', min: 0, max: 999999, whole: true, about: 'Training has chance in it: the same seed gives the same run, another seed another. How much a model forgot changed a lot between seeds in our tests, so a second run with another seed is worth it.' },
    { id: 'maxLength', group: 'lessons', type: 'number', from: 'lessons', label: 'Longest lesson, in tokens', min: 64, max: 2048, whole: true, about: 'A lesson longer than this is cut. It is set from your longest lesson unless you set it; a larger value takes more graphics memory. A token is about three quarters of a word.' },
    { id: 'valSplit', group: 'lessons', type: 'number', label: 'Share held back to watch progress', min: 0, max: 0.3, about: 'These lessons are not trained on: the run checks itself against them after each pass. 0.1 is usual.' },
    { id: 'ordinary', group: 'lessons', type: 'choice', label: 'Everyday questions mixed in', options: [[0, 'None'], [30, '30'], [60, '60']], about: 'Before training, the model answers everyday questions and its own answers are mixed into your lessons. This is what kept it from forgetting what it knew in our tests.' },
    { id: 'onPrompt', group: 'lessons', type: 'switch', label: 'Learn the questions too', about: 'Usually only the answers are learned. On, it also learns the wording of your questions, which did not help in our tests.' },
    { id: 'maskHistory', group: 'lessons', type: 'switch', label: 'Only the last answer of a conversation', about: 'For lessons that are whole conversations: learn only the final answer, and read the turns before it as background.' },
    { id: 'curriculum', group: 'lessons', type: 'switch', label: 'Short lessons first', about: 'Reads the lessons from shortest to longest instead of mixed.' },
    { id: 'watchdog', group: 'care', type: 'switch', label: 'Stop a run that goes wrong', about: 'Stops the run if its error stays above 3 for five readings in a row (one is taken every ten steps), which only a run that has gone wrong does. Nothing is added to your models then.' },
    { id: 'checkpointing', group: 'care', type: 'switch', label: 'Use less graphics memory, more slowly', about: 'Recalculates part of each step instead of keeping it in memory. For a model that only just does not fit. In a short run here it took 1.9 GB against 2.8 for the same result.' },
    { id: 'shrink', group: 'result', type: 'choice', label: 'Size of the finished model', options: [['auto', 'Chosen for you'], ['q8', 'Finer (8 bits)'], ['q4', 'Smaller (4 bits)']], about: 'At 4 bits the model is about half the size and is what Ollama\'s own models use; at 8 bits it loses nothing you would notice. Chosen for you: 8 bits up to 2 billion parameters, 4 bits above.' }
];
// What a person changed, checked against that list: the first thing wrong in plain words, or null.
export const settingsProblem = (given) => {
    if (given === undefined || given === null) return null;
    if (typeof given !== 'object' || Array.isArray(given)) return 'The settings were not understood.';
    for (const [id, value] of Object.entries(given)) {
        const one = TRAIN_SETTINGS.find((setting) => setting.id === id);
        if (!one) return `There is no setting called ${clip(id, 40)}.`;
        if (one.type === 'switch' && typeof value !== 'boolean') return `${one.label} is either on or off.`;
        if (one.type === 'choice' && !one.options.some(([option]) => option === value)) return `${one.label} must be one of: ${one.options.map(([, label]) => label).join(', ')}.`;
        if (one.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < one.min || value > one.max || (one.whole && !Number.isInteger(value)))) return `${one.label} must be ${one.whole ? 'a whole number ' : ''}between ${one.min} and ${one.max}.`;
    }
    if (given.onPrompt === true && given.maskHistory === true) return 'Learning the questions too and learning only the last answer of a conversation cannot both be on.';
    return null;
};
// How a run is set. What the person did not set is worked out: about the same number of changes to the adapter whatever
// the number of lessons, rows as long as the longest lesson, the adapter and precision of what is being taught, and,
// given the model and the card (`room`), a step small enough to fit.
const longestOf = (lessons) => Math.max(0, ...lessons.map((row) => row.reduce((sum, turn) => sum + turn.content.length, 0)));
export const trainSettings = (lessons, kind, given = {}, room = null) => {
    const count = Array.isArray(lessons) ? lessons.length : Number(lessons?.count) || 0;
    const longest = Array.isArray(lessons) ? longestOf(lessons) : Number(lessons?.longest) || 0;
    const own = Object.fromEntries(Object.entries(given || {}).filter(([id]) => TRAIN_SETTINGS.some((one) => one.id === id)));
    const { r, alpha, quantization, updates } = TRAIN_KINDS[kind];
    const maxLength = own.maxLength ?? ([256, 512, 1024].find((size) => longest / 3 + 48 <= size) || 1024);
    const batch = own.batch ?? (maxLength <= 256 ? 8 : maxLength <= 512 ? 4 : 2);
    const set = {
        r, alpha: own.r !== undefined ? own.r : alpha, dropout: 0.05, parts: 'usual', dora: false, rslora: false, loraplus: 0, quantization, epochs: 0, lr: 0.0002, batch, accumulate: 1, scheduler: 'cosine', warmup: 0.03, decay: 0.01, clip: 1, neftune: 0,
        seed: 42, maxLength, valSplit: 0.1, ordinary: 60, onPrompt: false, maskHistory: false, curriculum: false, watchdog: false, checkpointing: false, shrink: 'auto', ...own
    };
    // On a card the usual step does not fit, fewer lessons are read at a time and more steps are added up, which trains
    // the same way; if one at a time is still too much, memory is traded for time. Never what the person set.
    if (room?.gpuMb && room.parameters) {
        const fits = () => trainNeeds(room.parameters, set, longest).gpuMb <= room.gpuMb;
        while (own.batch === undefined && own.accumulate === undefined && set.batch > 1 && !fits()) {
            set.batch /= 2;
            set.accumulate *= 2;
        }
        if (own.checkpointing === undefined && !fits()) {
            set.checkpointing = true;
            if (!fits()) set.checkpointing = false;
        }
    }
    if (own.epochs === undefined) set.epochs = Math.min(16, Math.max(3, Math.ceil((updates * set.batch * set.accumulate) / Math.max(1, count + set.ordinary))));
    return set;
};
// How many times the adapter is changed in a run: what decides whether lessons stick, more than the passes do.
export const trainUpdates = (count, set) => Math.ceil((Math.floor((count + set.ordinary) * (1 - set.valSplit)) * set.epochs) / (set.batch * set.accumulate));
// What our own tests say about a run set this way, for the page to show before it is started.
export const trainNotes = (count, kind, set, updates, place = {}) => {
    const notes = [];
    if ((place.fitted || []).includes('batch')) notes.push(`To fit this graphics card it reads ${set.batch} ${set.batch === 1 ? 'lesson' : 'lessons'} per step and adds ${set.accumulate} steps up, which trains the same way as ${set.batch * set.accumulate} at once, only more slowly.`);
    if ((place.fitted || []).includes('checkpointing')) notes.push('To fit this graphics card it also uses less of its memory, which is slower.');
    if (place.gpuMb && place.needs && place.needs.gpuMb <= place.gpuMb && place.needs.gpuMb > place.gpuMb * 0.85) notes.push('This only just fits the graphics card. Close other programs that use it before starting, such as games and video.');
    if (count > 0 && count < 60) notes.push('With fewer than 60 lessons, ask each thing in several wordings: one lesson alone does not stick.');
    if (updates !== null && updates < 60) notes.push(`This run changes the adapter only ${updates} times, which may be too few for lessons to stick. More passes, or fewer lessons per step, give more.`);
    if (updates !== null && updates > 800) notes.push(`This run changes the adapter ${updates} times, which is a lot: it may repeat lessons word for word and forget more of what it knew. Fewer passes would do.`);
    if (set.lr < 0.00005) notes.push('A step this small taught almost nothing in our tests.');
    if (set.r >= 128 && set.ordinary < 60) notes.push('A large adapter forgets more. Keep the everyday questions at 60.');
    if (set.r >= 128 && set.quantization === '4bit') notes.push('A large adapter held at 4 bits learned fewer facts in our tests than at full precision (18 of 24 against 21).');
    if (kind === 'facts' && set.r < 128) notes.push('Facts did not stick with an adapter this small in our tests (11 of 24 at size 64 against 21 at 256).');
    if (set.r >= 128) notes.push('How much the model forgets varies from run to run with a large adapter (8 to 14 of 15 in our tests). Check the "still knows" score, and try another seed if it is low.');
    if (set.rslora && set.parts === 'all') notes.push('Every layer together with rsLoRA made the model forget most of what it knew in two full runs here: it kept 3 and 8 of 15 things, against 14 with every layer alone and 13 with rsLoRA alone. Use one of them.');
    if (set.rslora && set.loraplus > 0) notes.push('rsLoRA and LoRA+ together made the error blow up in a short run here (7.6 against 2.0). Use one of them, or a step a quarter the size.');
    else if (set.loraplus > 0 && set.parts === 'all') notes.push('LoRA+ on every layer left the error high in a short run here (4.3 against 1.8). Take a smaller step with it.');
    if (set.rslora && set.alpha / Math.sqrt(set.r) > 10) notes.push(`With rsLoRA on, a strength of ${set.alpha} at size ${set.r} speaks ${Math.round(set.alpha / Math.sqrt(set.r))} times louder than usual, and 16 times overshot in a short run here. A strength near ${Math.round(Math.sqrt(set.r) * 4)} is safer.`);
    if (set.dora && set.parts === 'all') notes.push('DoRA on every layer took half as much graphics memory again in a short run here (5.1 GB against 3.4), which the estimate above does not count.');
    if (set.neftune > 0) notes.push('With noise on it learned more slowly in a short run here (error 2.7 against 2.1 on lessons held back, after one pass), and the error shown while it trains reads higher still. Give it a few more passes.');
    if (set.onPrompt) notes.push('The error shown then counts the questions too, so it reads higher (3.3 against 2.0 in a short run here) and cannot be compared with a usual run.');
    return notes;
};
// What each desktop app last said about training on its computer, kept in memory like its pooling state.
const trainKits = new Map();
const presentTraining = (job) => ({
    id: job.id, where: job.where, device: String(job.device), name: job.name, base: job.base, kind: job.kind, settings: job.settings || null, lessons: job.lessons, status: job.status, stage: job.stage, percent: job.percent, loss: job.loss,
    before: job.before?.of ? job.before : null, after: job.after?.of ? job.after : null, seconds: job.seconds, detail: job.detail, startedAt: job.createdAt, finishedAt: job.finishedAt
});
const TRAIN_LIVE = ['queued', 'setting-up', 'scoring', 'training', 'saving'];
const trainingReady = (device) => {
    const kit = trainKits.get(String(device.id));
    const card = (device.hardware?.gpus || []).find((gpu) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(gpu.name || ''));
    if (device.kind !== 'companion') return { ready: false, reason: 'Training runs on one of your own computers, through the desktop app.' };
    if (!deviceGateway.isOnline(device.id)) return { ready: false, reason: 'This computer is offline.' };
    if (!kit) return { ready: false, reason: 'Update the desktop app on this computer: its version cannot train yet.' };
    if (kit.kit === 'unsupported') return { ready: false, reason: kit.detail || 'This computer cannot train.' };
    if (!card) return { ready: false, reason: 'Training needs an NVIDIA graphics card for now, and this computer has none.' };
    return { ready: true, reason: kit.kit === 'ready' ? null : 'The first run sets training up on this computer: about 5 GB, asked for there.', gpuMb: card.memoryMb || device.hardware?.gpuMemoryMb || 0 };
};

export const listTrainings = asyncHandler(async (req, res) => {
    const [devices, jobs] = await Promise.all([Device.find({ service: SERVICE, kind: 'companion', registeredBy: req.user.id }), Training.find({ service: SERVICE, owner: req.user.id }).sort({ createdAt: -1 }).limit(30)]);
    res.status(200).json({
        success: true,
        bases: TRAIN_BASES,
        kinds: Object.entries(TRAIN_KINDS).map(([id, kind]) => ({ id, label: kind.label, about: kind.about })),
        groups: TRAIN_GROUPS,
        settings: TRAIN_SETTINGS,
        limits: { least: TRAIN_MIN_LESSONS, most: TRAIN_MAX_LESSONS },
        computers: devices.map((device) => ({ id: device.id, name: device.name, ...trainingReady(device) })),
        trainings: jobs.map(presentTraining)
    });
});

// What one model would take of one computer, for the page to say before a run is started.
export const checkTrainingBase = asyncHandler(async (req, res) => {
    const device = await Device.findOne({ _id: req.query.device, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    const base = await trainBase(req.query.source);
    if (base.problem) return res.status(200).json({ success: true, base: null, fits: false, lacks: 'origin', reason: base.problem });
    res.status(200).json({ success: true, base, ...trainFit(trainPlace(device), base, req.query.kind) });
});
// Every model downloaded on one computer, with whether it can be trained there and, if not, exactly why. A model that
// only lacks a large enough graphics card says how large a card it needs: that is what a rented one will be chosen by.
export const listTrainable = asyncHandler(async (req, res) => {
    const device = await Device.findOne({ _id: req.query.device, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    const place = trainPlace(device);
    const ollama = createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(device.id));
    let installed = [];
    if (deviceGateway.isOnline(device.id)) {
        try {
            installed = ((await ollama.list()).models || []).slice(0, 60);
        } catch {
            installed = [];
        }
    }
    const models = await Promise.all(installed.map(async (model) => {
        const about = { name: model.name, sizeMb: Math.round((model.size || 0) / MB) };
        let shown = null;
        try {
            shown = await ollama.show(model.name);
        } catch {
            shown = null;
        }
        const info = shown?.model_info || {};
        const parameters = Number(info['general.parameter_count']) || 0;
        if ((shown?.capabilities || []).includes('embedding') || /embed/i.test(model.name)) return { ...about, parameters, state: 'other', reason: 'This model turns text into numbers for searching. It does not chat, so there is nothing to teach it this way.' };
        if (!shown || !parameters) return { ...about, parameters, state: 'other', reason: 'This model runs somewhere else, not from a file on this computer, so it cannot be trained here.' };
        const origin = await trainOrigin(info);
        if (origin.problem) return { ...about, parameters, state: origin.lacks, reason: origin.problem };
        const fit = trainFit(place, origin, req.query.kind);
        return { ...about, parameters, source: origin.source, licence: origin.licence, needs: fit.needs, state: fit.fits ? 'ready' : fit.lacks, reason: fit.reason, ...(fit.lacks === 'card' ? { cardMb: fit.needs.gpuMb } : {}) };
    }));
    res.status(200).json({ success: true, computer: { id: device.id, name: device.name, ready: place.ready, reason: place.reason, gpuMb: place.gpuMb || 0, memoryMb: place.memoryMb }, models });
});

// What a run would be with the settings as they stand: every value, the number of changes to the adapter, whether it
// fits, and what our own tests say about it. Asked for as a person edits; the lessons themselves are not sent.
export const planTraining = asyncHandler(async (req, res) => {
    const { device: deviceId, base: source, kind, count = 0, longest = 0, settings: given = {} } = req.body;
    const device = await Device.findOne({ _id: deviceId, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    const wrong = settingsProblem(given);
    if (wrong) return res.status(400).json({ success: false, code: 'TRAIN_SETTINGS', message: wrong });
    const base = await trainBase(source);
    const place = trainPlace(device);
    const plain = trainSettings({ count, longest }, kind, given);
    const settings = base.problem ? plain : trainSettings({ count, longest }, kind, given, roomOf(place, base));
    // What was set to fit this card instead of by the lessons, for the page to say so.
    const fitted = ['batch', 'accumulate', 'checkpointing'].filter((id) => plain[id] !== settings[id]);
    const fit = base.problem ? { fits: false, needs: null, lacks: 'origin', reason: base.problem } : trainFit(place, base, kind, settings, longest);
    const updates = count > 0 ? trainUpdates(count, settings) : null;
    res.status(200).json({ success: true, settings, fitted, updates, base: base.problem ? null : base, ...fit, notes: trainNotes(count, kind, settings, updates, { fitted, needs: fit.needs, gpuMb: place.gpuMb }), canChange: place.sizes });
});

export const startTraining = asyncHandler(async (req, res) => {
    const refuse = (status, code, message) => res.status(status).json({ success: false, code, message });
    const { device: deviceId, base: baseId, name, kind, lessons: given, settings: changed = {} } = req.body;
    const device = await Device.findOne({ _id: deviceId, service: SERVICE, kind: 'companion', registeredBy: req.user.id });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    const state = trainingReady(device);
    if (!state.ready) return refuse(409, 'TRAIN_NOT_READY', state.reason);
    const base = await trainBase(baseId);
    if (base.problem) return refuse(400, 'TRAIN_BASE_UNKNOWN', base.problem);
    const wrong = settingsProblem(changed);
    if (wrong) return refuse(400, 'TRAIN_SETTINGS', wrong);
    // A desktop app from before the settings could be changed trains with the usual ones only, and would not say so.
    if (Object.keys(changed).length > 0 && !trainPlace(device).sizes) return refuse(409, 'TRAIN_NOT_READY', 'Update the desktop app on that computer to change the settings: its version trains with the usual ones only.');
    const read = readLessons(given);
    if (read.problem) return refuse(400, 'TRAIN_LESSONS', read.problem);
    const place = trainPlace(device);
    const settings = trainSettings(read.lessons, kind, changed, roomOf(place, base));
    const fit = trainFit(place, base, kind, settings, longestOf(read.lessons));
    if (!fit.fits) return refuse(409, 'TRAIN_TOO_LARGE', fit.reason);
    if (await Training.exists({ service: SERVICE, device: device.id, status: { $in: TRAIN_LIVE } })) return refuse(409, 'TRAIN_BUSY', 'This computer is already training a model. Wait for it, or stop it.');
    let installed = [];
    try {
        installed = (await createOllamaClient(DEVICE_HOST, deviceGateway.fetcher(device.id)).list()).models || [];
    } catch {
        installed = [];
    }
    if (installed.some((model) => model.name === `${name}:latest` || model.name === name)) return refuse(409, 'TRAIN_NAME_TAKEN', `This computer already has a model called ${name}. Choose another name.`);
    const job = await Training.create({ owner: req.user.id, device: device.id, name, base: base.source, kind, settings, lessons: read.lessons.length, status: 'queued', stage: 'Waiting for the computer' });
    // The lessons to ask again afterwards, spread over the whole set: how many the model can give back.
    const every = Math.max(1, Math.floor(read.lessons.length / 20));
    const probes = read.lessons.filter((row, at) => at % every === 0).slice(0, 20).map((row) => ({ messages: row.slice(0, -1), answer: row.at(-1).content }));
    const sent = deviceGateway.order(device.id, {
        type: 'train', action: 'run',
        // Unless the person chose, a larger model is made smaller at the end (4 bits), as Ollama's own are, so it runs where it was trained.
        job: { id: job.id, name, source: base.source, shrink: settings.shrink === 'q4' || (settings.shrink === 'auto' && base.parameters > 2e9), large: base.parameters > 2e9, settings, lessons: read.lessons, probes, ordinary: TRAIN_ORDINARY.slice(0, settings.ordinary), control: TRAIN_CONTROL.map(([question, must]) => ({ question, must })) }
    });
    if (!sent) {
        await Training.updateOne({ _id: job.id }, { status: 'failed', detail: 'The computer went offline before the training reached it.', finishedAt: new Date() });
        return refuse(409, 'DEVICE_OFFLINE', 'The computer went offline before the training reached it.');
    }
    // An app too old to know the order stays silent: the run is not left waiting for ever.
    const silent = setTimeout(() => {
        Training.updateOne({ _id: job.id, status: 'queued' }, { status: 'failed', detail: 'The desktop app on that computer did not answer. Update it and try again.', finishedAt: new Date() }).catch(() => {});
    }, TRAIN_SILENT_MS);
    silent.unref?.();
    getNotificationService().notify(req.user.id, 'activity:changed');
    res.status(202).json({ success: true, training: presentTraining(job), unread: read.unread, settings });
});

const ownTraining = (req) => Training.findOne({ _id: req.params.id, service: SERVICE, owner: req.user.id });
export const stopTraining = asyncHandler(async (req, res) => {
    const job = await ownTraining(req);
    if (!job) return res.status(404).json({ success: false, message: 'Training not found' });
    if (TRAIN_LIVE.includes(job.status)) {
        deviceGateway.order(job.device, { type: 'train', action: 'stop', id: job.id });
        Object.assign(job, { status: 'stopped', stage: null, detail: 'Stopped before it finished. Nothing was added to the computer\'s models.', finishedAt: new Date() });
        await job.save();
    }
    res.status(200).json({ success: true, training: presentTraining(job) });
});
export const removeTraining = asyncHandler(async (req, res) => {
    const job = await ownTraining(req);
    if (!job) return res.status(404).json({ success: false, message: 'Training not found' });
    if (TRAIN_LIVE.includes(job.status)) return res.status(409).json({ success: false, code: 'TRAIN_RUNNING', message: 'Stop the training before removing it from the list.' });
    await job.deleteOne();
    res.status(200).json({ success: true });
});

// What the desktop app reports: whether training is set up there, and how the run it holds is doing.
const TRAIN_STATES = ['setting-up', 'scoring', 'training', 'saving', 'done', 'failed', 'stopped'];
const scoreOf = (given) => {
    const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 1000 ? value : 0);
    return given && typeof given === 'object' ? { recalled: count(given.recalled), of: count(given.of), kept: count(given.kept), keptOf: count(given.keptOf) } : undefined;
};
deviceGateway.on('train', async (deviceId, data) => {
    try {
        trainKits.set(String(deviceId), { version: Number.isInteger(data?.version) ? data.version : 1, kit: ['ready', 'none', 'unsupported'].includes(data?.kit) ? data.kit : 'none', detail: data?.detail ? clip(String(data.detail), 200) : null });
        const report = data?.job;
        if (!report || !mongoose.isValidObjectId(report.id) || !TRAIN_STATES.includes(report.status)) return;
        const job = await Training.findOne({ _id: report.id, service: SERVICE, device: deviceId });
        if (!job || !TRAIN_LIVE.includes(job.status)) return;
        const ended = ['done', 'failed', 'stopped'].includes(report.status);
        Object.assign(job, {
            status: report.status, stage: report.stage ? clip(String(report.stage), 120) : null,
            percent: Number.isFinite(report.percent) ? Math.min(100, Math.max(0, Math.round(report.percent))) : job.percent,
            loss: Number.isFinite(report.loss) ? Math.round(report.loss * 1000) / 1000 : job.loss,
            seconds: Number.isFinite(report.seconds) ? Math.max(0, Math.round(report.seconds)) : job.seconds,
            detail: report.detail ? clip(String(report.detail), 400) : job.detail,
            ...(scoreOf(report.before) ? { before: scoreOf(report.before) } : {}), ...(scoreOf(report.after) ? { after: scoreOf(report.after) } : {}),
            ...(ended ? { finishedAt: new Date(), percent: report.status === 'done' ? 100 : job.percent } : {})
        });
        await job.save();
        const notices = getNotificationService();
        if (report.status === 'done') notices.notify(job.owner, 'training:finished', { level: 'success', title: 'Training finished', message: `${job.name} is trained and is now among that computer's models.`, id: job.id, path: '/models?tab=train' });
        if (report.status === 'failed') notices.notify(job.owner, 'training:failed', { level: 'error', title: 'Training failed', message: `${job.name} could not be trained. ${job.detail || ''}`.trim(), id: job.id, path: '/models?tab=train' });
        notices.notify(job.owner, 'activity:changed');
    } catch (error) {
        logger.warn('[Training] A report could not be kept', { deviceId: String(deviceId), message: error.message });
    }
});
// A computer that comes back is asked how its run is doing; one that has gone leaves its report as it was.
deviceGateway.on('online', (deviceId) => {
    Training.find({ service: SERVICE, device: deviceId, status: { $in: TRAIN_LIVE } }).then((jobs) => {
        deviceGateway.order(deviceId, { type: 'train', action: 'state', ids: jobs.map((job) => job.id) });
    }).catch(() => {});
});
deviceGateway.on('offline', (deviceId) => trainKits.delete(String(deviceId)));

// ---------------------------------------------------------------------------------------------
// Rented graphics cards (Stage 5G). A person rents a card by the hour from prepaid credit; the machine is one of
// their computers until it ends. A machine must never be left running, so: the whole limit is set aside before it
// starts, every pass of watchRentals ends what is over its time, its money or its idle time, a machine that carries
// this server's name mark with no rental is deleted, and a rental counts as ended only once Hyperstack no longer
// knows the machine. The same pass runs from watch.js on a schedule of its own, for when this server is down.
// All money is in cents. Suggested values, for the owner to confirm.
// ---------------------------------------------------------------------------------------------
export const RENTAL_RULES = {
    markup: 0.30,
    limit: 1000,
    hours: 2,
    mostHours: 12,
    idleMinutes: 30,
    startMinutes: 20,
    warnMinutes: 5,
    atOnce: 1,
    reserve: 200
};
const RENTAL_ENDS = {
    asked: 'you ended it',
    limit: 'it reached its spending limit',
    time: 'it reached its time limit',
    idle: 'nothing had run on it for a while',
    failed: 'it could not be started',
    gone: 'the machine stopped at Hyperstack'
};
const MINUTE_MS = 60000;
const holdOf = (rental) => `rental:${rental.id}`;
const cardName = (card) => `${card.count > 1 ? `${card.count} x ` : ''}${card.gpu}`;

export const rentalsOn = () => billingOn() && hyperstackReady();
export const rentalPrice = (cost) => Math.ceil(cost * (1 + RENTAL_RULES.markup));

// What a rental has cost its person so far: whole minutes from the moment the machine was running at Hyperstack,
// never more than was set aside, and nothing for a machine that never became one of their computers.
export const rentalSpent = (rental, until = new Date()) => {
    if (!rental.readyAt || !rental.linkedAt) return 0;
    const minutes = Math.max(1, Math.ceil((new Date(until) - rental.readyAt) / MINUTE_MS));
    return Math.min(rental.limit, Math.ceil(minutes * rental.price / 60));
};

const presentRental = (rental) => {
    const until = rental.endingAt || new Date();
    const spent = rental.state === 'ended' || rental.state === 'ending' ? rental.spent : rentalSpent(rental, until);
    return {
        id: rental.id,
        state: rental.state,
        card: { flavor: rental.card.flavor, gpu: rental.card.gpu, count: rental.card.count, memoryMb: rental.card.memoryMb, name: cardName(rental.card) },
        device: rental.device ? String(rental.device) : null,
        price: rental.price,
        limit: rental.limit,
        minutes: rental.minutes,
        idleMinutes: rental.idleMinutes,
        spent,
        startedAt: rental.createdAt,
        readyAt: rental.readyAt,
        linkedAt: rental.linkedAt,
        endsAt: rental.readyAt ? new Date(rental.readyAt.getTime() + rental.minutes * MINUTE_MS) : null,
        endedAt: rental.endedAt,
        reason: rental.reason,
        why: rental.reason ? RENTAL_ENDS[rental.reason] : null,
        detail: rental.detail
    };
};

const tellRenter = (rental, type, level, message) => getNotificationService().notify(rental.user, type, {
    level, title: `Rented ${cardName(rental.card)}`, message, path: '/devices', rental: rental.id
});
const lastOwnerNotice = new Map();
const tellOwners = (type, message) => {
    if (Date.now() - (lastOwnerNotice.get(type) || 0) < 60 * MINUTE_MS) return;
    lastOwnerNotice.set(type, Date.now());
    getNotificationService().notifyRole('OWNER', type, { level: 'warning', title: 'Rented computers', message, path: '/devices' });
};

const refuseRental = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, code, message, ...extra });

// What Mollama may still owe Hyperstack for the rentals that are open: each one's cost to the end of its time or money.
const stillOwed = (rentals) => rentals.reduce((sum, rental) => {
    const hours = Math.min(rental.minutes / 60, rental.limit / rental.price);
    const used = rental.readyAt ? (Date.now() - rental.readyAt) / (60 * MINUTE_MS) : 0;
    return sum + Math.max(0, hours - used) * rental.cost;
}, 0);

export const listRentalCards = asyncHandler(async (req, res) => {
    if (!rentalsOn()) return res.status(200).json({ success: true, on: false });
    try {
        const [cards, totals] = await Promise.all([hyperstack.cards(), balanceOf(req.user.id)]);
        return res.status(200).json({
            success: true,
            on: true,
            cards: cards.map((card) => ({ flavor: card.flavor, name: cardName(card), gpu: card.gpu, count: card.count, memoryMb: card.memoryMb, cpu: card.cpu, ramGb: card.ramGb, diskGb: card.diskGb, price: rentalPrice(card.cost) })),
            rules: { limit: RENTAL_RULES.limit, hours: RENTAL_RULES.hours, mostHours: RENTAL_RULES.mostHours, idleMinutes: RENTAL_RULES.idleMinutes, atOnce: RENTAL_RULES.atOnce },
            balance: totals.balance
        });
    } catch (error) {
        logger.warn('[Rental] The cards could not be read', { message: error.message });
        return refuseRental(res, 502, 'HYPERSTACK_DOWN', 'The cards for rent could not be read just now. Try again in a minute.');
    }
});

export const listRentals = asyncHandler(async (req, res) => {
    if (!rentalsOn()) return res.status(200).json({ success: true, on: false, rentals: [] });
    const [open, ended] = await Promise.all([
        Rental.find({ service: SERVICE, user: req.user.id, state: { $ne: 'ended' } }).sort({ createdAt: -1 }),
        Rental.find({ service: SERVICE, user: req.user.id, state: 'ended' }).sort({ createdAt: -1 }).limit(10)
    ]);
    return res.status(200).json({ success: true, on: true, rentals: [...open, ...ended].map(presentRental) });
});

export const startRental = asyncHandler(async (req, res) => {
    if (!rentalsOn()) return refuseRental(res, 404, 'RENTALS_OFF', 'Renting is not set up');
    const user = req.user.id;
    const open = { service: SERVICE, user, state: { $ne: 'ended' } };
    if (await Rental.countDocuments(open) >= RENTAL_RULES.atOnce) {
        return refuseRental(res, 409, 'ALREADY_RENTING', 'You already have a rented computer. End it before renting another.');
    }

    let card;
    let funds;
    try {
        [card, funds] = await Promise.all([hyperstack.cards().then((cards) => cards.find((one) => one.flavor === req.body.flavor)), hyperstack.credit()]);
    } catch (error) {
        logger.warn('[Rental] Hyperstack could not be asked', { message: error.message });
        return refuseRental(res, 502, 'HYPERSTACK_DOWN', 'The card could not be rented just now. Nothing was charged.');
    }
    if (!card) return refuseRental(res, 404, 'CARD_GONE', 'That card is not free to rent right now. Choose another.');

    const price = rentalPrice(card.cost);
    const hours = Math.min(req.body.hours || RENTAL_RULES.hours, RENTAL_RULES.mostHours);
    const limit = req.body.limit || RENTAL_RULES.limit;
    if (limit < price) return refuseRental(res, 400, 'LIMIT_TOO_SMALL', `The spending limit must cover one hour: at least ${money(price)}.`, { least: price });
    const { balance } = await balanceOf(user);
    if (balance < limit) return refuseRental(res, 402, 'NOT_ENOUGH_CREDIT', `You have ${money(balance)} of credit and this sets aside ${money(limit)}. Add credit first.`, { balance, limit });

    // Mollama pays Hyperstack before its customers pay Mollama, so a rental starts only if Mollama's own balance
    // there covers every open rental to its end and this one too.
    const owed = stillOwed(await Rental.find({ service: SERVICE, state: { $ne: 'ended' } }));
    const need = Math.min(hours, limit / price) * card.cost;
    if (!funds.canCreate || funds.credit - owed - need < RENTAL_RULES.reserve) {
        logger.warn('[Rental] Refused: Mollama\'s balance at Hyperstack is too low', { credit: funds.credit, owed: Math.round(owed), need: Math.round(need) });
        tellOwners('rental:funds', `A rental was refused because Mollama's balance at Hyperstack is low (${money(funds.credit)} left).`);
        return refuseRental(res, 503, 'RENTALS_PAUSED', 'No more computers can be rented right now. Nothing was charged. Try again later.');
    }

    // Two requests at the same moment both pass the count above, so each open rental takes one of its person's
    // places, and the database lets a place be taken once.
    await Rental.init();
    const id = new mongoose.Types.ObjectId();
    let rental = null;
    for (let slot = 0; slot < RENTAL_RULES.atOnce && !rental; slot += 1) {
        rental = await Rental.create({
            _id: id, user, slot, price, cost: card.cost, limit, minutes: hours * 60, idleMinutes: RENTAL_RULES.idleMinutes,
            card: { flavor: card.flavor, gpu: card.gpu, count: card.count, memoryMb: card.memoryMb, region: card.region },
            machine: { name: `${machinePrefix()}${id}` }
        }).catch((error) => {
            if (error?.code !== 11000) throw error;
            return null;
        });
    }
    if (!rental) return refuseRental(res, 409, 'ALREADY_RENTING', 'You already have a rented computer. End it before renting another.');
    const drop = async () => Rental.deleteOne({ _id: rental._id });
    try {
        await setAside(user, limit, holdOf(rental), `${cardName(card)} rented: up to ${money(limit)} set aside`);
    } catch (error) {
        await drop();
        if (error instanceof BillingError) return refuseRental(res, error.statusCode, error.code, error.message);
        throw error;
    }

    const key = crypto.randomBytes(32).toString('hex');
    const device = await Device.create({
        name: `Rented ${cardName(card)}`, kind: 'companion', hostname: `${user}:rented-${rental.id}`, registeredBy: user, keyHash: hashKey(key), rental: rental._id
    });
    rental.device = device._id;
    try {
        const socket = `${process.env.RENTAL_SERVER_URL.replace(/^http/, 'ws').replace(/[/]+$/, '')}/devices`;
        rental.machine.id = await hyperstack.create({ name: rental.machine.name, flavor: card.flavor, script: machineScript({ socket, deviceId: device.id, key }) });
        await rental.save();
    } catch (error) {
        logger.warn('[Rental] The machine could not be started', { rental: rental.id, message: error.message });
        // The machine may exist all the same, so the rental is ended the careful way: nothing is given back until it is gone.
        await rental.save();
        await beginRentalEnd(rental, 'failed', error instanceof HyperstackError ? error.message : null);
        return refuseRental(res, 502, 'RENT_FAILED', 'The computer could not be started. Nothing was charged.', { rental: presentRental(rental) });
    }
    logger.info('[Rental] Started', { rental: rental.id, user: String(user), flavor: card.flavor, price, limit });
    getNotificationService().sendToUser(String(user), { type: 'device:changed', data: { deviceId: device.id, online: false } });
    return res.status(201).json({ success: true, rental: presentRental(rental) });
});

// A rental ends in two steps. First it is marked as ending, its charge is fixed and its replies are ended; then the
// machine is deleted, again and again if need be, and only when Hyperstack no longer knows it is the unused credit
// given back and the rental shown as ended.
const finishRental = async (rental) => {
    try {
        if (!rental.machine.id) {
            const found = (await hyperstack.list()).find((machine) => machine.name === rental.machine.name);
            if (found) rental.machine.id = found.id;
            // A machine whose start was never answered may still appear, so its absence is believed only after a while.
            else if (Date.now() - rental.createdAt < 3 * MINUTE_MS) return false;
        }
        if (rental.machine.id && await hyperstack.state(rental.machine.id) !== 'GONE') {
            rental.deleteTries += 1;
            await rental.save();
            if (rental.deleteTries % 10 === 0) tellOwners('rental:stuck', `A rented machine (${rental.machine.name}) has not gone after ${rental.deleteTries} tries to delete it. Check it at Hyperstack.`);
            await hyperstack.remove(rental.machine.id);
            return false;
        }
    } catch (error) {
        logger.warn('[Rental] The machine is not confirmed gone yet', { rental: rental.id, tries: rental.deleteTries, message: error.message });
        await rental.save().catch(() => {});
        return false;
    }

    await settle(rental.user, holdOf(rental), rental.spent, `${cardName(rental.card)} rented: ${money(rental.spent)} used, the rest returned`);
    if (rental.device) {
        await Device.deleteOne({ _id: rental.device, service: SERVICE });
        deviceGateway.disconnect(rental.device);
        getNotificationService().sendToUser(String(rental.user), { type: 'device:changed', data: { deviceId: String(rental.device), online: false } });
    }
    rental.state = 'ended';
    rental.slot = undefined;
    rental.endedAt = new Date();
    await rental.save();
    logger.info('[Rental] Ended', { rental: rental.id, reason: rental.reason, spent: rental.spent });
    tellRenter(rental, 'rental:ended', rental.reason === 'asked' ? 'info' : 'warning',
        `It has ended because ${RENTAL_ENDS[rental.reason]}. It cost ${money(rental.spent)}; ${money(rental.limit - rental.spent)} is back in your credit.`);
    return true;
};

const beginRentalEnd = async (rental, reason, detail = null) => {
    if (rental.state === 'ended') return true;
    if (rental.state !== 'ending') {
        rental.state = 'ending';
        rental.endingAt = new Date();
        rental.reason = reason;
        rental.detail = detail;
        rental.spent = rentalSpent(rental, rental.endingAt);
        await rental.save();
        if (rental.device) await endReplies(repliesOn(rental.device), { code: 'RENTAL_ENDED', detail: `It ended because ${RENTAL_ENDS[reason]}.` });
    }
    return finishRental(rental);
};

export const endRental = asyncHandler(async (req, res) => {
    const rental = await Rental.findOne({ _id: req.params.id, service: SERVICE, user: req.user.id });
    if (!rental) return refuseRental(res, 404, 'NO_SUCH_RENTAL', 'Rental not found');
    await beginRentalEnd(rental, 'asked');
    return res.status(200).json({ success: true, rental: presentRental(rental) });
});

const markRentalLinked = async (rental) => {
    if (rental.linkedAt || rental.state !== 'starting') return;
    rental.linkedAt = new Date();
    rental.activeAt = rental.linkedAt;
    rental.readyAt = rental.readyAt || rental.linkedAt;
    rental.state = 'running';
    await rental.save();
    tellRenter(rental, 'rental:ready', 'success', 'It is ready. Download a model onto it from the Models page, then choose it in a chat.');
};
deviceGateway.on('online', async (deviceId) => {
    try {
        const rental = await Rental.findOne({ service: SERVICE, device: deviceId, state: 'starting' });
        if (rental) await markRentalLinked(rental);
    } catch (error) {
        logger.warn('[Rental] A rented computer came online but could not be marked', { deviceId: String(deviceId), error: error.message });
    }
});

const watchRental = async (rental, { alone }) => {
    if (rental.state === 'ending') return finishRental(rental);
    const now = Date.now();
    let status = null;
    try {
        if (rental.machine.id) status = await hyperstack.state(rental.machine.id);
    } catch {
        // The limits below run on this server's own clock, so they hold while Hyperstack cannot be asked.
    }
    if (status === 'ACTIVE' && !rental.readyAt) rental.readyAt = new Date();
    if (!alone && rental.device && deviceGateway.isOnline(rental.device)) await markRentalLinked(rental);

    if (status === 'GONE' || status === 'ERROR') return beginRentalEnd(rental, rental.linkedAt ? 'gone' : 'failed');
    if (!rental.linkedAt) {
        if (now - rental.createdAt > RENTAL_RULES.startMinutes * MINUTE_MS) return beginRentalEnd(rental, 'failed', `It was not ready within ${RENTAL_RULES.startMinutes} minutes.`);
        if (rental.isModified()) await rental.save();
        return false;
    }

    const busy = (!alone && repliesOn(rental.device).length > 0) || Boolean(await Download.exists({ service: SERVICE, device: rental.device, status: 'downloading' }));
    if (busy) rental.activeAt = new Date();
    const left = {
        limit: (rental.limit - rentalSpent(rental)) / rental.price * 60,
        time: rental.minutes - (now - rental.readyAt) / MINUTE_MS,
        idle: rental.idleMinutes - (now - rental.activeAt) / MINUTE_MS
    };
    const [why, minutes] = Object.entries(left).sort((a, b) => a[1] - b[1])[0];
    if (rentalSpent(rental) >= rental.limit) return beginRentalEnd(rental, 'limit');
    if (left.time <= 0) return beginRentalEnd(rental, 'time');
    if (left.idle <= 0) return beginRentalEnd(rental, 'idle', `Nothing had run on it for ${rental.idleMinutes} minutes.`);
    if (minutes <= RENTAL_RULES.warnMinutes && !rental.warned.includes(why)) {
        rental.warned.push(why);
        tellRenter(rental, 'rental:ending', 'warning', why === 'idle'
            ? `Nothing is running on it, so it ends in about ${Math.max(1, Math.round(minutes))} minutes.`
            : `It ends in about ${Math.max(1, Math.round(minutes))} minutes: it is near its ${why === 'time' ? 'time' : 'spending'} limit.`);
    }
    if (rental.isModified()) await rental.save();
    return false;
};

// A machine with this server's name mark that no open rental knows about is deleted, whoever started it.
export const sweepRentals = async () => {
    const machines = await hyperstack.list();
    let swept = 0;
    for (const machine of machines) {
        if (machine.status === 'DELETING') continue;
        const id = machine.name.slice(machinePrefix().length);
        const rental = mongoose.isValidObjectId(id) ? await Rental.findOne({ _id: id, service: SERVICE }) : null;
        if (rental && rental.state !== 'ended') {
            if (!rental.machine.id) await Rental.updateOne({ _id: rental._id }, { 'machine.id': machine.id });
            continue;
        }
        logger.warn('[Rental] Deleting a machine no rental knows about', { machine: machine.name, id: machine.id });
        tellOwners('rental:swept', `A machine with no rental (${machine.name}) was found at Hyperstack and deleted.`);
        await hyperstack.remove(machine.id).catch((error) => logger.warn('[Rental] The machine could not be deleted', { machine: machine.name, message: error.message }));
        swept += 1;
    }
    return swept;
};

// What Mollama expected Hyperstack to bill for one day (UTC) beside what it did bill, machine by machine.
export const compareRentals = async (day = new Date(Date.now() - 24 * 60 * MINUTE_MS).toISOString().slice(0, 10)) => {
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(from.getTime() + 24 * 60 * MINUTE_MS);
    const rentals = await Rental.find({ service: SERVICE, readyAt: { $lt: to }, 'machine.id': { $ne: null }, $or: [{ endedAt: null }, { endedAt: { $gt: from } }] });
    let expected = 0;
    let billed = 0;
    let charged = 0;
    let unknown = 0;
    for (const rental of rentals) {
        const start = Math.max(rental.readyAt, from);
        const end = Math.min(rental.endedAt || new Date(), to);
        expected += Math.max(0, end - start) / (60 * MINUTE_MS) * rental.cost;
        if (rental.endedAt && rental.endedAt >= from && rental.endedAt < to) charged += rental.spent;
        const theirs = await hyperstack.billed(rental.machine.id, from, to);
        if (theirs === null) unknown += 1;
        else billed += theirs;
    }
    const result = { day, rentals: rentals.length, expected: Math.round(expected), billed, charged, unknown, difference: billed - Math.round(expected) };
    result.matches = unknown === 0 && Math.abs(result.difference) <= Math.max(100, result.expected * 0.1);
    return result;
};
export const getRentalComparison = asyncHandler(async (req, res) => {
    if (!rentalsOn()) return refuseRental(res, 404, 'RENTALS_OFF', 'Renting is not set up');
    return res.status(200).json({ success: true, ...await compareRentals(req.query.day) });
});

let comparedDay = null;
let watching = false;
// One pass over every open rental, then the sweep, then once a day the comparison with Hyperstack's bill.
// alone: run without the server (watch.js), where nothing is known of who is connected or what is being written.
export const watchRentals = async ({ alone = false } = {}) => {
    if (!rentalsOn() || watching) return null;
    watching = true;
    const report = { seen: 0, ended: 0, swept: 0 };
    try {
        for (const rental of await Rental.find({ service: SERVICE, state: { $ne: 'ended' } })) {
            report.seen += 1;
            try {
                if (await watchRental(rental, { alone })) report.ended += 1;
            } catch (error) {
                logger.error('[Rental] A rental could not be checked', { rental: rental.id, message: error.message });
            }
        }
        report.swept = await sweepRentals().catch((error) => {
            logger.warn('[Rental] The sweep could not run', { message: error.message });
            return 0;
        });
        const yesterday = new Date(Date.now() - 24 * 60 * MINUTE_MS).toISOString().slice(0, 10);
        if (!alone && comparedDay !== yesterday) {
            comparedDay = yesterday;
            const compared = await compareRentals(yesterday).catch(() => null);
            if (compared?.rentals) logger.info('[Rental] Compared with Hyperstack\'s bill', compared);
            if (compared?.rentals && !compared.matches) {
                tellOwners('rental:mismatch', `Hyperstack's bill for ${yesterday} does not match: ${money(compared.expected)} expected, ${money(compared.billed)} billed${compared.unknown ? `, ${compared.unknown} machine(s) not answered` : ''}.`);
            }
        }
    } finally {
        watching = false;
    }
    return report;
};
