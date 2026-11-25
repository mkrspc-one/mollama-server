import {Router} from 'express';
import * as billingController from '../controllers/billing.controller.js';
import * as authMiddleware from '../middleware/auth.middleware.js';
import {RIGHTS} from '../config/rights.js';
import {noCacheResponse} from '../middleware/cache.middleware.js';

const router = Router();

router.validRoutes = [
    '/api/v1/billing',
    '/api/v1/billing/lines',
    '/api/v1/billing/lines/:id/refund',
    '/api/v1/billing/checkout',
    '/api/v1/billing/stripe',
    '/api/v1/billing/people',
    '/api/v1/billing/people/:id',
    '/api/v1/billing/people/:id/adjustments'
];

const signedIn = [authMiddleware.verifyToken(), noCacheResponse()];
const admin = [...signedIn, authMiddleware.checkPermission(RIGHTS.MANAGE_ALL_USERS)];

// Stripe's signed messages: no sign-in, the signature is the proof.
router.post('/stripe', billingController.stripeMessage);

router.get('/', signedIn, billingController.getBilling);
router.get('/lines', signedIn, billingController.getLines);
router.post('/checkout', signedIn, billingController.startCheckout);

router.get('/people', admin, billingController.findPeople);
router.get('/people/:id', admin, billingController.getPerson);
router.post('/people/:id/adjustments', admin, billingController.adjustPerson);
router.post('/lines/:id/refund', admin, billingController.refundLine);

export default router;
