import mongoose from 'mongoose';
import { Joi } from '../utils/validator.js';

export const SERVICE = 'ai-base';

const gpuSchema = new mongoose.Schema({
    name: { type: String, required: true },
    memoryMb: { type: Number, required: true }
}, { _id: false });

// A computer's private network addresses, for pooling: never its public one.
const networkSchema = new mongoose.Schema({
    addresses: { type: [new mongoose.Schema({ address: String, prefix: Number, interface: String, wired: Boolean, category: String }, { _id: false })], default: [] }
}, { _id: false });

const hardwareSchema = new mongoose.Schema({
    hostname: String,
    platform: String,
    cpu: String,
    cpuThreads: Number,
    memoryMb: Number,
    gpus: { type: [gpuSchema], default: [] },
    gpuMemoryMb: Number,
    diskFreeMb: Number,
    diskTotalMb: Number,
    modelsPath: String,
    network: { type: networkSchema, default: undefined },
    detectedAt: Date
}, { _id: false });

const overridesSchema = new mongoose.Schema({
    memoryMb: { type: Number, default: null },
    gpuName: { type: String, default: null },
    gpuMemoryMb: { type: Number, default: null }
}, { _id: false });

const deviceSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['local', 'companion', 'pool'], required: true },
    hostname: { type: String, required: true },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    keyHash: { type: String, default: null, select: false },
    hardware: { type: hardwareSchema, default: null },
    overrides: { type: overridesSchema, default: () => ({}) },
    paused: { type: Boolean, default: false },
    poolRole: { type: String, enum: ['off', 'lend', 'main'], default: 'off' },
    lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

deviceSchema.index({ service: 1, kind: 1, hostname: 1 }, { unique: true });

const settingSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, unique: true },
    ollamaBaseUrl: { type: String, default: null },
    defaultModel: { type: String, default: null },
    maxConcurrentGenerations: { type: Number, default: 1, min: 1, max: 8 },
    keepAliveMinutes: { type: Number, default: 5, min: 0, max: 1440 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

export const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);
export const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const personalModelSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    from: { type: String, required: true },
    system: { type: String, default: '' },
    parameters: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

personalModelSchema.index({ service: 1, name: 1 }, { unique: true });

const downloadSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    model: { type: String, required: true },
    status: {
        type: String,
        enum: ['queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled'],
        default: 'queued',
        index: true
    },
    completedBytes: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
    errorCode: { type: String, default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
}, { timestamps: true });

export const PersonalModel = mongoose.models.PersonalModel || mongoose.model('PersonalModel', personalModelSchema);
export const Download = mongoose.models.Download || mongoose.model('Download', downloadSchema);

const ollamaUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(300);

export const deviceSchemas = {
    deviceId: Joi.object({
        id: Joi.objectId().required()
    }),

    link: Joi.object({
        hostname: Joi.string().trim().min(1).max(120).required(),
        name: Joi.string().trim().min(1).max(80),
        hardware: Joi.object({
            hostname: Joi.string().max(120),
            platform: Joi.string().max(40),
            cpu: Joi.string().max(200).allow(null, ''),
            cpuThreads: Joi.number().integer().min(1).max(4096).allow(null),
            memoryMb: Joi.number().integer().min(0).max(16777216).allow(null),
            gpus: Joi.array().max(16).items(Joi.object({
                name: Joi.string().max(200).required(),
                memoryMb: Joi.number().integer().min(1).max(4194304).required()
            })),
            gpuMemoryMb: Joi.number().integer().min(0).max(4194304).allow(null),
            diskFreeMb: Joi.number().integer().min(0).allow(null),
            diskTotalMb: Joi.number().integer().min(0).allow(null),
            modelsPath: Joi.string().max(500).allow(null, ''),
            network: Joi.object({
                addresses: Joi.array().max(16).items(Joi.object({
                    address: Joi.string().ip({ version: ['ipv4'], cidr: 'forbidden' }).required(),
                    prefix: Joi.number().integer().min(0).max(32).required(),
                    interface: Joi.string().max(120).allow(''),
                    wired: Joi.boolean(),
                    category: Joi.string().valid('public', 'private', 'domain').allow(null)
                }))
            }),
            detectedAt: Joi.date()
        })
    }),

    memory: Joi.object({
        model: Joi.string().trim().min(1).max(200).required(),
        pooled: Joi.boolean(),
        stop: Joi.boolean()
    }),

    pool: Joi.object({
        role: Joi.string().valid('off', 'lend', 'main').required()
    }),

    updateDevice: Joi.object({
        name: Joi.string().trim().min(1).max(80),
        overrides: Joi.object({
            memoryMb: Joi.number().integer().min(512).max(4194304).allow(null),
            gpuName: Joi.string().trim().max(120).allow(null, ''),
            gpuMemoryMb: Joi.number().integer().min(0).max(1048576).allow(null)
        })
    }).min(1),

    updateSettings: Joi.object({
        ollamaBaseUrl: ollamaUrl.allow(null, ''),
        defaultModel: Joi.string().trim().max(200).pattern(/^[A-Za-z0-9._\-/:]+$/).allow(null, ''),
        maxConcurrentGenerations: Joi.number().integer().min(1).max(8),
        keepAliveMinutes: Joi.number().integer().min(0).max(1440)
    }).min(1),

    testConnection: Joi.object({
        ollamaBaseUrl: ollamaUrl.required()
    })
};

const modelName = Joi.string().min(1).max(200).pattern(/^[A-Za-z0-9._\-/:]+$/)
    .messages({ 'string.pattern.base': 'Model name may only contain letters, digits and . - _ / :' });

const megabytes = Joi.number().integer().min(0).max(4194304);

export const modelSchemas = {
    named: Joi.object({
        name: modelName.required()
    }),

    load: Joi.object({
        name: modelName.allow(null, ''),
        swap: Joi.boolean()
    }),

    create: Joi.object({
        name: Joi.string().min(1).max(63).pattern(/^[a-z0-9][a-z0-9._-]*$/).required()
            .messages({ 'string.pattern.base': 'Use lower-case letters, digits, dots, dashes and underscores only' }),
        displayName: Joi.string().trim().min(1).max(80).required(),
        from: modelName.required(),
        system: Joi.string().max(20000).allow(''),
        template: Joi.string().max(20000).allow(''),
        parameters: Joi.object().pattern(
            Joi.string().max(60),
            Joi.alternatives().try(Joi.string().max(500), Joi.number(), Joi.boolean())
        ).max(30)
    }),
    update: Joi.object({
        name: modelName.required(),
        displayName: Joi.string().trim().min(1).max(80),
        from: modelName,
        system: Joi.string().max(20000).allow(''),
        parameters: Joi.object().pattern(
            Joi.string().max(60),
            Joi.alternatives().try(Joi.string().max(500), Joi.number(), Joi.boolean())
        ).max(30)
    }).or('displayName', 'from', 'system', 'parameters'),

    downloadAction: Joi.object({
        id: Joi.objectId().required(),
        action: Joi.string().valid('pause', 'cancel').required()
    }),

    catalogueQuery: Joi.object({
        memoryMb: megabytes,
        gpuMemoryMb: megabytes,
        q: Joi.string().trim().max(60).allow(''),
        page: Joi.number().integer().min(1).max(500),
        size: Joi.number().valid(4, 8, 12, 24, 48),
        sort: Joi.string().valid('fit', 'largest', 'smallest', 'popular', 'name'),
        purpose: Joi.string().valid('chat', 'writing', 'code', 'reasoning'),
        can: Joi.string().pattern(/^(tools|vision|thinking)(,(tools|vision|thinking))*$/),
        fits: Joi.boolean(),
        minSizeMb: megabytes,
        maxSizeMb: megabytes,
        minMemoryMb: megabytes,
        maxMemoryMb: megabytes,
        minParams: Joi.number().min(0).max(5000),
        maxParams: Joi.number().min(0).max(5000),
        all: Joi.boolean(),
        sample: Joi.boolean(),
        shared: Joi.boolean()
    })
};

const chatAttachmentSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 255 },
    source: { type: String, enum: [SERVICE, 'fs-one'], default: SERVICE },
    path: { type: String, default: null },
    text: { type: String, default: '', required: function needsText() { return !this.image; } },
    image: { type: String, default: null },
    mime: { type: String, default: null },
    chars: { type: Number, required: true },
    tokens: { type: Number, required: true },
    sent: { type: Boolean, default: false }
}, { timestamps: { createdAt: true, updatedAt: false } });

const chatMessageSchema = new mongoose.Schema({
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    thinking: { type: String, default: '' },
    model: { type: String, default: null },
    stats: {
        evalCount: { type: Number, default: null },
        promptEvalCount: { type: Number, default: null },
        durationMs: { type: Number, default: null },
        tokensPerSecond: { type: Number, default: null },
        readSeconds: { type: Number, default: null },
        writeSeconds: { type: Number, default: null },
        toolSeconds: { type: Number, default: null },
        requests: { type: Number, default: null },
        sentTokens: { type: Number, default: null },
        cachedTokens: { type: Number, default: null }
    },
    errorCode: { type: String, default: null },
    errorDetail: { type: String, default: null },
    stopped: { type: Boolean, default: false },
    steps: { type: [new mongoose.Schema({ tool: String, input: String, sent: String, failed: String, answer: String, save: { type: mongoose.Schema.Types.Mixed, default: undefined } }, { _id: false })], default: [] },
    unverified: { type: [String], default: [] },
    attachmentIds: { type: [mongoose.Schema.Types.ObjectId], default: [] }
}, { timestamps: { createdAt: true, updatedAt: false } });

const instructionSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    text: { type: String, required: true },
    source: { type: String, enum: [SERVICE, 'fs-one'], default: SERVICE },
    path: { type: String, default: null }
}, { _id: false });

const promptSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    text: { type: String, required: true },
    source: { type: String, enum: [SERVICE, 'fs-one'], default: SERVICE },
    path: { type: String, default: null }
}, { timestamps: true });

export const Prompt = mongoose.models.Prompt || mongoose.model('Prompt', promptSchema);

export const GUIDE_STEPS = [
    'nav.chat', 'nav.models', 'nav.devices', 'nav.settings',
    'chat.send', 'chat.new',
    'models.installed', 'models.running', 'models.mine', 'models.refresh', 'models.download',
    'devices.read', 'devices.correct'
];
export const MANAGER_GUIDE_STEPS = ['models.download', 'devices.read', 'devices.correct'];

const guideSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    on: { type: Boolean, default: true },
    seen: { type: [String], default: [] }
}, { timestamps: true });
guideSchema.index({ service: 1, user: 1 }, { unique: true });

export const Guide = mongoose.models.Guide || mongoose.model('Guide', guideSchema);
export const guideSchemas = {
    update: Joi.object({ on: Joi.boolean().required() }),
    seen: Joi.object({ key: Joi.string().valid(...GUIDE_STEPS).required() })
};

const noteSchema = new mongoose.Schema({
    key: { type: String, required: true, maxlength: 60 },
    text: { type: String, required: true, maxlength: 2000 },
    updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const chatSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, default: 'New chat', trim: true, maxlength: 120 },
    titled: { type: Boolean, default: false },
    model: { type: String, default: null },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
    system: { type: String, default: '' },
    systemSource: { type: String, default: null },
    instructions: { type: [instructionSchema], default: [] },
    skills: { type: [String], default: undefined },
    tools: { type: [String], default: undefined },
    allowedTools: { type: [String], default: undefined },
    webSearch: { type: Boolean, default: true },
    summary: { type: String, default: '' },
    // A long chat's earlier messages folded into a memory: the model is sent the memory and the messages after it.
    memory: { type: String, default: '' },
    memoryThrough: { type: Number, default: 0 },
    draft: { type: new mongoose.Schema({ content: String, thinking: String, model: String, steps: { type: [mongoose.Schema.Types.Mixed], default: undefined }, at: Date }, { _id: false }) },
    // Notes a model kept with save_note, sent with every message of the chat.
    notes: { type: [noteSchema], default: [] },
    continuedFrom: { type: mongoose.Schema.Types.ObjectId, default: null },
    options: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    messages: { type: [chatMessageSchema], default: [] },
    attachments: { type: [chatAttachmentSchema], default: [] }
}, { timestamps: true, minimize: false });

chatSchema.index({ service: 1, owner: 1, updatedAt: -1 });

export const Chat = mongoose.models.Chat || mongoose.model('Chat', chatSchema);

export const TOOL_HEALTH_STATES = ['unchecked', 'healthy', 'signin', 'refused', 'unreachable', 'busy', 'blocked', 'empty', 'offline', 'outdated', 'stopped', 'missing', 'waiting'];

const toolSchema = new mongoose.Schema({
    name: { type: String, required: true },
    title: { type: String, default: null },
    description: { type: String, default: '' },
    readOnly: { type: Boolean, default: false },
    input: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

// A tool server a person has added. Remote ones are reached from this server by their address; local ones run on
// a linked computer and are reached through the desktop app there, which is the only place their start command is kept.
const toolServerSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: ['remote', 'local'], required: true },
    address: { type: String, default: null },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
    localId: { type: String, default: null },
    signIn: { type: String, enum: ['none', 'key', 'account'], default: 'none' },
    sealed: { type: String, default: null, select: false },
    signInState: { type: String, default: null, select: false, index: true },
    tools: { type: [toolSchema], default: [] },
    health: { type: String, enum: TOOL_HEALTH_STATES, default: 'unchecked' },
    healthDetail: { type: String, default: null },
    checkedAt: { type: Date, default: null }
}, { timestamps: true });

export const ToolServer = mongoose.models.ToolServer || mongoose.model('ToolServer', toolServerSchema);

const toolServerName = Joi.string().trim().min(1).max(60);
export const toolSchemas = {
    serverId: Joi.object({ id: Joi.objectId().required() }),
    add: Joi.object({
        kind: Joi.string().valid('remote', 'local').required(),
        name: toolServerName.required(),
        address: Joi.when('kind', { is: 'remote', then: Joi.string().trim().uri({ scheme: ['https'] }).max(500).required(), otherwise: Joi.forbidden() }),
        key: Joi.when('kind', { is: 'remote', then: Joi.string().trim().max(4000).allow('', null), otherwise: Joi.forbidden() }),
        device: Joi.when('kind', { is: 'local', then: Joi.objectId().required(), otherwise: Joi.forbidden() }),
        localId: Joi.when('kind', { is: 'local', then: Joi.string().pattern(/^[a-z0-9-]{8,40}$/).required(), otherwise: Joi.forbidden() })
    }),
    update: Joi.object({ name: toolServerName, key: Joi.string().trim().max(4000).allow('', null) }).min(1),
    callback: Joi.object({ state: Joi.string().max(200), code: Joi.string().max(4000), iss: Joi.string().max(1000) }).unknown(true)
};

export const PROVIDER_HEALTH_STATES = ['unchecked', 'healthy', 'refused', 'credit', 'busy', 'unreachable', 'empty'];

// A company that runs models online, connected by one person with their own key. The key is kept sealed.
const providerSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, required: true },
    name: { type: String, required: true },
    sealed: { type: String, default: null, select: false },
    models: { type: [new mongoose.Schema({ name: String, title: String, contextLength: Number, vision: Boolean, maxOutput: Number }, { _id: false })], default: [] },
    health: { type: String, enum: PROVIDER_HEALTH_STATES, default: 'unchecked' },
    checkedAt: { type: Date, default: null }
}, { timestamps: true });
providerSchema.index({ service: 1, owner: 1, kind: 1 }, { unique: true });

export const Provider = mongoose.models.Provider || mongoose.model('Provider', providerSchema);

const providerKey = Joi.string().trim().min(8).max(4000).required();
// A skill a person added by its address. The text is kept as it was read, so it does not change under them.
const skillSchema = new mongoose.Schema({
    service: { type: String, default: SERVICE, immutable: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 400 },
    text: { type: String, required: true },
    address: { type: String, required: true, maxlength: 600 },
    checkedAt: { type: Date, default: Date.now }
}, { timestamps: true });
skillSchema.index({ service: 1, owner: 1, address: 1 }, { unique: true });

export const Skill = mongoose.models.Skill || mongoose.model('Skill', skillSchema);

export const skillSchemas = {
    skillId: Joi.object({ id: Joi.string().pattern(/^[a-z0-9-]{1,60}$/).required() }),
    file: Joi.object({ path: Joi.string().trim().max(200).pattern(/^[\w./ -]+$/).required() }),
    add: Joi.object({ address: Joi.string().trim().uri({ scheme: ['https'] }).max(600).required() })
};

export const providerSchemas = {
    providerId: Joi.object({ id: Joi.objectId().required() }),
    add: Joi.object({ kind: Joi.string().pattern(/^[a-z]{2,20}$/).required(), key: providerKey }),
    update: Joi.object({ key: providerKey })
};

const generationOptions = Joi.object({
    temperature: Joi.number().min(0).max(2),
    num_ctx: Joi.number().integer().min(512).max(262144),
    top_p: Joi.number().min(0).max(1),
    top_k: Joi.number().integer().min(0).max(500),
    repeat_penalty: Joi.number().min(0).max(5),
    seed: Joi.number().integer(),
    num_predict: Joi.number().integer().min(-1).max(100000)
});

const filePath = Joi.string().min(1).max(1000).pattern(/^\/(?!.*\/\/)[^\0]*$/)
    .messages({ 'string.pattern.base': 'A file path starts with / and has no empty parts' });

const instruction = {
    name: Joi.string().trim().min(1).max(120).required(),
    text: Joi.string().min(1).max(100000).required(),
    source: Joi.string().valid(SERVICE, 'fs-one'),
    path: Joi.string().max(1000).allow(null, '')
};

export const promptSchemas = {
    promptId: Joi.object({ id: Joi.objectId().required() }),
    create: Joi.object(instruction),
    update: Joi.object({ name: instruction.name.optional(), text: instruction.text.optional() }).min(1)
};

const chatFields = {
    title: Joi.string().trim().min(1).max(120),
    model: modelName.allow(null),
    device: Joi.objectId().allow(null),
    system: Joi.string().max(100000).allow(''),
    systemSource: Joi.string().max(1000).allow(null, ''),
    instructions: Joi.array().max(10).items(Joi.object(instruction)),
    skills: Joi.array().max(30).items(Joi.string().pattern(/^[a-z0-9-]{1,60}$/)).allow(null),
    tools: Joi.array().max(40).items(Joi.string().pattern(/^[a-z0-9_]{1,40}$/)).allow(null),
    webSearch: Joi.boolean(),
    options: generationOptions
};

export const chatSchemas = {
    chatId: Joi.object({ id: Joi.objectId().required() }),
    saveId: Joi.object({ id: Joi.objectId().required(), saveId: Joi.string().pattern(/^[a-f0-9]{16}$/).required() }),
    attachmentId: Joi.object({ id: Joi.objectId().required(), attachmentId: Joi.objectId().required() }),
    list: Joi.object({ search: Joi.string().trim().max(100).allow('') }),
    create: Joi.object(chatFields),
    update: Joi.object(chatFields).min(1),
    saveAnswer: Joi.object({ answer: Joi.string().valid('save', 'always', 'no').required() }),
    permission: Joi.object({ id: Joi.string().pattern(/^[a-z0-9]{6,40}$/).required(), answer: Joi.string().valid('once', 'always', 'no').required() }),
    send: Joi.object({
        content: Joi.string().min(1).max(100000),
        regenerate: Joi.boolean(),
        live: Joi.boolean(),
        anyway: Joi.boolean(),
        editIndex: Joi.number().integer().min(0).max(199)
    }).or('content', 'regenerate').without('regenerate', ['content', 'editIndex']).with('editIndex', 'content'),
    attachUpload: Joi.object({ name: Joi.string().trim().min(1).max(255).required() }),
    attachFile: Joi.object({ path: filePath.required() }),
    exportQuery: Joi.object({ format: Joi.string().valid('markdown', 'jsonl').default('markdown') }),
    browse: Joi.object({ path: filePath.default('/') }),
    remote: Joi.object({ url: Joi.string().uri({ scheme: ['http', 'https'] }).max(2000).required() }),
    fileText: Joi.object({ path: filePath.required(), model: modelName }),
    fileSaveAddress: Joi.object({
        folder: filePath.required(),
        name: Joi.string().trim().min(1).max(200).pattern(/^[^\\/\0]+$/).required(),
        url: Joi.string().uri({ scheme: ['https'] }).max(2000).required()
    }),
    fileSave: Joi.object({
        folder: filePath.required(),
        name: Joi.string().trim().min(1).max(200).pattern(/^[^\\/\0]+$/).required(),
        content: Joi.string().min(1).max(2000000).required()
    })
};
