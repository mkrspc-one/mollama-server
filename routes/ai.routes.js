import { Router } from 'express';
import * as aiController from '../controllers/ai.controller.js';
import * as authMiddleware from '../middleware/auth.middleware.js';
import { RIGHTS } from '../config/rights.js';
import { noCacheResponse } from '../middleware/cache.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { deviceSchemas, modelSchemas, chatSchemas, promptSchemas, guideSchemas, toolSchemas, providerSchemas, skillSchemas, trainingSchemas } from '../models/ai.model.js';

const router = Router();

router.validRoutes = [
    '/api/v1/devices',
    '/api/v1/devices/:id',
    '/api/v1/devices/:id/detect',
    '/api/v1/devices/link',
    '/api/v1/devices/memory',
    '/api/v1/devices/:id/memory',
    '/api/v1/devices/pools',
    '/api/v1/trainings',
    '/api/v1/trainings/base',
    '/api/v1/trainings/plan',
    '/api/v1/trainings/models',
    '/api/v1/trainings/:id',
    '/api/v1/trainings/:id/stop',
    '/api/v1/devices/pools/check',
    '/api/v1/devices/:id/pool',
    '/api/v1/devices/:id/pause',
    '/api/v1/devices/:id/resume',
    '/api/v1/settings',
    '/api/v1/settings/test-connection',
    '/api/v1/setup/status',
    '/api/v1/models',
    '/api/v1/models/running',
    '/api/v1/models/show',
    '/api/v1/models/delete',
    '/api/v1/models/create',
    '/api/v1/models/update',
    '/api/v1/models/unload',
    '/api/v1/models/load',
    '/api/v1/models/pull',
    '/api/v1/models/downloads',
    '/api/v1/models/downloads/stream',
    '/api/v1/models/downloads/cancel',
    '/api/v1/catalogue',
    '/api/v1/devices/:id/catalogue',
    '/api/v1/devices/:id/recommended',
    '/api/v1/skills',
    '/api/v1/skills/:id',
    '/api/v1/skills/:id/file',
    '/api/v1/chats',
    '/api/v1/chats/:id',
    '/api/v1/chats/:id/messages',
    '/api/v1/chats/:id/permission',
    '/api/v1/chats/:id/saves/:saveId',
    '/api/v1/chats/:id/reply',
    '/api/v1/chats/:id/live',
    '/api/v1/chats/:id/stop',
    '/api/v1/chats/:id/attachments',
    '/api/v1/chats/:id/attachments/:attachmentId',
    '/api/v1/chats/:id/export',
    '/api/v1/prompts',
    '/api/v1/guide',
    '/api/v1/activity',
    '/api/v1/guide/seen',
    '/api/v1/prompts/:id',
    '/api/v1/files/browse',
    '/api/v1/files/text',
    '/api/v1/files/save',
    '/api/v1/files/remote',
    '/api/v1/files/save-address',
    '/api/v1/providers',
    '/api/v1/providers/:id',
    '/api/v1/providers/:id/check',
    '/api/v1/tools/catalogue',
    '/api/v1/tools/servers',
    '/api/v1/tools/servers/:id',
    '/api/v1/tools/servers/:id/check',
    '/api/v1/tools/servers/:id/sign-in',
    '/api/v1/tools/callback'
];

const signedIn = [aiController.requireDatabase, authMiddleware.verifyToken(), authMiddleware.checkPermission(RIGHTS.USE_MODELS), noCacheResponse(), aiController.useDevice];
const manager = [aiController.requireDatabase, authMiddleware.verifyToken(), authMiddleware.checkPermission(RIGHTS.MANAGE_MODELS), noCacheResponse(), aiController.useDevice];
// Removing or downloading a model goes only to the computer the request names.
const confirmed = [...manager.slice(0, -1), aiController.useNamedDevice];
const withDeviceId = validateRequest(deviceSchemas.deviceId, 'params');

router.use('/devices', aiController.announceChanges('device:changed'));
router.use('/models', aiController.announceChanges('models:changed', ['/load']));
router.use('/chats', aiController.announceChanges('chat:changed'));

router.get('/devices', ...signedIn, aiController.listDevices);
router.get('/devices/memory', ...signedIn, aiController.listMemory);
router.post('/devices/:id/memory', ...signedIn, withDeviceId, validateRequest(deviceSchemas.memory), aiController.freeMemory);
router.get('/devices/pools', ...signedIn, aiController.listPools);
router.post('/devices/pools/check', ...signedIn, aiController.checkPools);
router.post('/devices/link', ...signedIn, validateRequest(deviceSchemas.link), aiController.linkDevice);
router.delete('/devices/:id', ...signedIn, withDeviceId, aiController.unlinkDevice);
router.get('/devices/:id', ...signedIn, withDeviceId, aiController.getDevice);
router.put('/devices/:id', ...manager, withDeviceId, validateRequest(deviceSchemas.updateDevice), aiController.updateDevice);
router.post('/devices/:id/detect', ...manager, withDeviceId, aiController.detectDevice);
router.put('/devices/:id/pool', ...signedIn, withDeviceId, validateRequest(deviceSchemas.pool), aiController.setPoolRole);
router.post('/devices/:id/pause', ...signedIn, withDeviceId, aiController.pauseDevice);
router.post('/devices/:id/resume', ...signedIn, withDeviceId, aiController.resumeDevice);

router.get('/settings', ...signedIn, aiController.readSettings);
router.put('/settings', ...manager, validateRequest(deviceSchemas.updateSettings), aiController.updateSettings);
router.post('/settings/test-connection', ...manager, validateRequest(deviceSchemas.testConnection), aiController.testConnection);

router.get('/setup/status', ...signedIn, aiController.getSetupStatus);

const named = validateRequest(modelSchemas.named);

router.get('/models', ...signedIn, aiController.listModels);
router.get('/models/running', ...signedIn, aiController.listRunning);
router.post('/models/show', ...signedIn, named, aiController.showModel);
router.post('/models/delete', ...confirmed, named, aiController.deleteModel);
router.post('/models/unload', ...manager, named, aiController.unloadModel);
router.post('/models/load', ...signedIn, validateRequest(modelSchemas.load), aiController.loadModel);
router.post('/models/create', ...manager, validateRequest(modelSchemas.create), aiController.createModel);
router.post('/models/update', ...manager, validateRequest(modelSchemas.update), aiController.updateModel);

router.post('/models/pull', ...confirmed, named, aiController.startDownload);
router.get('/models/downloads', ...signedIn, aiController.listDownloads);
router.get('/models/downloads/stream', ...signedIn, aiController.streamDownloads);
router.post('/models/downloads/cancel', ...manager, validateRequest(modelSchemas.downloadAction), aiController.changeDownload);

router.get('/catalogue', noCacheResponse(), validateRequest(modelSchemas.catalogueQuery, 'query'), aiController.getPublicCatalogue);
router.get('/devices/:id/catalogue', ...signedIn, withDeviceId, validateRequest(modelSchemas.catalogueQuery, 'query'), aiController.getDeviceCatalogue);
router.get('/devices/:id/recommended', ...signedIn, withDeviceId, aiController.getDeviceRecommended);

const withChatId = validateRequest(chatSchemas.chatId, 'params');

router.get('/skills', ...signedIn, aiController.listSkills);
router.post('/skills', ...signedIn, validateRequest(skillSchemas.add), aiController.addSkill);
router.get('/skills/:id', ...signedIn, validateRequest(skillSchemas.skillId, 'params'), aiController.readSkill);
router.get('/skills/:id/file', ...signedIn, validateRequest(skillSchemas.skillId, 'params'), validateRequest(skillSchemas.file, 'query'), aiController.readSkillFile);
router.delete('/skills/:id', ...signedIn, validateRequest(skillSchemas.skillId, 'params'), aiController.removeSkill);
router.get('/chats', ...signedIn, validateRequest(chatSchemas.list, 'query'), aiController.listChats);
router.post('/chats', ...signedIn, validateRequest(chatSchemas.create), aiController.createChat);
router.get('/chats/:id', ...signedIn, withChatId, aiController.getChat);
router.patch('/chats/:id', ...signedIn, withChatId, validateRequest(chatSchemas.update), aiController.updateChat);
router.delete('/chats/:id', ...signedIn, withChatId, aiController.deleteChat);
router.post('/chats/:id/messages', ...signedIn, withChatId, validateRequest(chatSchemas.send), aiController.sendMessage);
router.post('/chats/:id/permission', ...signedIn, withChatId, validateRequest(chatSchemas.permission), aiController.answerPermission);
router.post('/chats/:id/saves/:saveId', ...signedIn, validateRequest(chatSchemas.saveId, 'params'), validateRequest(chatSchemas.saveAnswer), aiController.answerSave);
router.get('/chats/:id/reply', ...signedIn, withChatId, aiController.rejoinReply);
router.get('/chats/:id/live', ...signedIn, withChatId, aiController.liveReply);
router.post('/chats/:id/stop', ...signedIn, withChatId, aiController.stopReply);
router.post('/chats/:id/attachments', ...signedIn, withChatId, aiController.receiveUpload, aiController.addAttachment);
router.delete('/chats/:id/attachments/:attachmentId', ...signedIn, validateRequest(chatSchemas.attachmentId, 'params'), aiController.removeAttachment);
router.get('/chats/:id/export', ...signedIn, withChatId, validateRequest(chatSchemas.exportQuery, 'query'), aiController.exportChat);

const withPromptId = validateRequest(promptSchemas.promptId, 'params');

router.get('/activity', ...signedIn, aiController.getActivity);
router.get('/guide', ...signedIn, aiController.getGuide);
router.put('/guide', ...signedIn, validateRequest(guideSchemas.update), aiController.updateGuide);
router.post('/guide/seen', ...signedIn, validateRequest(guideSchemas.seen), aiController.markGuideSeen);
router.get('/prompts', ...signedIn, aiController.listPrompts);
router.post('/prompts', ...signedIn, validateRequest(promptSchemas.create), aiController.createPrompt);
router.patch('/prompts/:id', ...signedIn, withPromptId, validateRequest(promptSchemas.update), aiController.updatePrompt);
router.delete('/prompts/:id', ...signedIn, withPromptId, aiController.deletePrompt);

router.get('/files/browse', ...signedIn, validateRequest(chatSchemas.browse, 'query'), aiController.browseFiles);
router.get('/files/text', ...signedIn, validateRequest(chatSchemas.fileText, 'query'), aiController.readFileText);
router.get('/files/remote', ...signedIn, validateRequest(chatSchemas.remote, 'query'), aiController.loadRemote);
router.post('/files/save', ...signedIn, validateRequest(chatSchemas.fileSave), aiController.saveFile);
router.post('/files/save-address', ...signedIn, validateRequest(chatSchemas.fileSaveAddress), aiController.saveFileFromAddress);

const withToolServerId = validateRequest(toolSchemas.serverId, 'params');
router.get('/tools/callback', aiController.requireDatabase, validateRequest(toolSchemas.callback, 'query'), aiController.finishToolServerSignIn);
router.get('/tools/catalogue', ...signedIn, aiController.listToolCatalogue);
router.get('/tools/servers', ...signedIn, aiController.listToolServers);
router.post('/tools/servers', ...signedIn, validateRequest(toolSchemas.add), aiController.addToolServer);
router.patch('/tools/servers/:id', ...signedIn, withToolServerId, validateRequest(toolSchemas.update), aiController.updateToolServer);
router.delete('/tools/servers/:id', ...signedIn, withToolServerId, aiController.removeToolServer);
router.post('/tools/servers/:id/check', ...signedIn, withToolServerId, aiController.checkToolServerNow);
router.post('/tools/servers/:id/sign-in', ...signedIn, withToolServerId, aiController.startToolSignIn);

const withProviderId = validateRequest(providerSchemas.providerId, 'params');
router.get('/providers', ...signedIn, aiController.listProviders);
router.post('/providers', ...signedIn, validateRequest(providerSchemas.add), aiController.addProvider);
router.patch('/providers/:id', ...signedIn, withProviderId, validateRequest(providerSchemas.update), aiController.updateProvider);
router.delete('/providers/:id', ...signedIn, withProviderId, aiController.removeProvider);
router.post('/providers/:id/check', ...signedIn, withProviderId, aiController.checkProviderNow);

// Training a model on one of a person's own computers, run there by the desktop app.
const withTrainingId = validateRequest(trainingSchemas.trainingId, 'params');
router.get('/trainings', ...signedIn, aiController.listTrainings);
router.get('/trainings/models', ...signedIn, validateRequest(trainingSchemas.models, 'query'), aiController.listTrainable);
router.get('/trainings/base', ...signedIn, validateRequest(trainingSchemas.base, 'query'), aiController.checkTrainingBase);
router.post('/trainings/plan', ...signedIn, validateRequest(trainingSchemas.plan), aiController.planTraining);
router.post('/trainings', ...signedIn, validateRequest(trainingSchemas.start), aiController.startTraining);
router.post('/trainings/:id/stop', ...signedIn, withTrainingId, aiController.stopTraining);
router.delete('/trainings/:id', ...signedIn, withTrainingId, aiController.removeTraining);

export default router;
