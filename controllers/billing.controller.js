import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../utils/app.logger.js';
import {asyncHandler, getNotificationService} from '../middleware/app.middleware.js';
import CreditLine, {BILLING_SERVICE, Checkout} from '../models/billing.model.js';
import User from '../models/user.model.js';

const STRIPE_API = 'https://api.stripe.com/v1';
// Asked for by name, so a later version of Stripe's API changes nothing here until this line does.
const STRIPE_VERSION = '2026-11-18.endive';
const SIGNATURE_AGE_SECONDS = 300;
const WRITE_TRIES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe keeps a payment page open at least 30 minutes; a little more, so its clock and ours never disagree.
const PAGE_OPEN_SECONDS = 31 * 60;
// Ways to pay that settle at once. Apple Pay and Google Pay come with cards; Stripe shows each only where it works.
const PAYMENT_METHODS = ['card', 'link', 'cashapp', 'amazon_pay'];
const PAGE = 50;

// All money is in cents. Suggested values, for the owner to confirm.
export const BILLING_RULES = {
    currency: 'usd',
    smallest: 1000,
    largest: 50000,
    newAccountDays: 7,
    newAccountMost: 2500,
    adjustmentMost: 100000
};

export class BillingError extends Error {
    constructor(code, message, statusCode = 400, extra = {}) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.isOperational = true;
        this.extra = extra;
    }
}

export const billingOn = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

export const money = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

export const moneyIsReal = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
const ledger = () => ({service: BILLING_SERVICE, live: moneyIsReal()});

const realFetch = (...args) => fetch(...args);
let stripeFetch = realFetch;
export const setStripeFetch = (stand) => {
    if (process.env.NODE_ENV === 'test') stripeFetch = stand || realFetch;
};

// One Stripe account may serve several projects, so everything this app makes there says whose it is, and only
// what carries this app's mark is acted on. The name also ends the line on the person's card statement.
const stripeMark = () => ({service: BILLING_SERVICE, project: String(process.env.APP_NAME || '').toLowerCase()});
const statementName = () => String(process.env.APP_NAME || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 10).trim();

const wholeCents = (value) => {
    const cents = Number(value);
    if (!Number.isInteger(cents) || cents <= 0) throw new BillingError('BAD_AMOUNT', 'The amount must be a whole number of cents above zero');
    return cents;
};

const personId = (userId) => {
    if (!mongoose.isValidObjectId(String(userId))) throw new BillingError('NO_SUCH_PERSON', 'No such person', 404);
    return new mongoose.Types.ObjectId(String(userId));
};

const lastLine = (user) => CreditLine.findOne({...ledger(), user}).sort({seq: -1});
const lastNumber = async (user) => (await CreditLine.findOne({service: BILLING_SERVICE, user}).sort({seq: -1}).select('seq'))?.seq || 0;

/**
 * The one way a line is added. The line number is unique per person, so two writers
 * at the same moment cannot both build on the same balance: the loser reads again.
 * A key is counted once: the same key again returns the first line.
 */
const writeLine = async (userId, entry) => {
    const user = personId(userId);
    const amount = Math.round(entry.amount || 0);
    const held = Math.round(entry.held || 0);
    const byKey = () => CreditLine.findOne({...ledger(), key: entry.key});

    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        if (entry.key) {
            const first = await byKey();
            if (first) return {line: first, repeated: true};
        }
        // The number first: a line written after it is read takes the next number, so this one is refused and reads again.
        const number = await lastNumber(user);
        const last = await lastLine(user);
        const balance = (last?.balance || 0) + amount;
        const heldTotal = (last?.heldTotal || 0) + held;
        if (balance < 0) {
            throw new BillingError('NOT_ENOUGH_CREDIT', `Not enough credit: ${money(last?.balance || 0)} left`, 402, {balance: last?.balance || 0});
        }
        if (heldTotal < 0) throw new BillingError('NOT_SET_ASIDE', 'More than was set aside', 409);
        try {
            const line = await CreditLine.create({
                user,
                live: moneyIsReal(),
                seq: number + 1,
                kind: entry.kind,
                amount,
                held,
                balance,
                heldTotal,
                key: entry.key || undefined,
                about: String(entry.about || '').slice(0, 300),
                ref: entry.ref || undefined,
                short: entry.short > 0 ? entry.short : undefined,
                by: entry.by || undefined
            });
            return {line, repeated: false};
        } catch (error) {
            if (error?.code !== 11000) throw error;
            if (entry.key && (error.keyPattern?.key || /key_1/.test(error.message))) {
                const first = await byKey();
                if (first) return {line: first, repeated: true};
            }
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25 * (attempt + 1)));
        }
    }
    throw new BillingError('LEDGER_BUSY', 'The ledger is busy. Try again.', 503);
};

export const balanceOf = async (userId) => {
    const last = await lastLine(personId(userId));
    return {balance: last?.balance || 0, held: last?.heldTotal || 0};
};

export const addCredit = async (userId, cents, {kind = 'adjustment', key, about, ref, by} = {}) =>
    writeLine(userId, {kind, amount: wholeCents(cents), key, about, ref, by});

export const charge = async (userId, cents, {key, about, ref} = {}) =>
    writeLine(userId, {kind: 'charge', amount: -wholeCents(cents), key, about, ref});

export const setAside = async (userId, cents, hold, about) => {
    const amount = wholeCents(cents);
    return writeLine(userId, {kind: 'hold', amount: -amount, held: amount, key: `hold:${hold}`, about, ref: {hold: String(hold)}});
};

/**
 * Ends a set-aside in one line: what was used is charged and the rest comes back.
 * Used more than was set aside is charged up to the set-aside and noted as short.
 */
export const settle = async (userId, hold, used, about) => {
    const user = personId(userId);
    const aside = await CreditLine.findOne({...ledger(), user, key: `hold:${hold}`});
    if (!aside) throw new BillingError('NOT_SET_ASIDE', 'Nothing was set aside for this', 404);
    const wanted = Math.max(0, Math.round(Number(used) || 0));
    const spent = Math.min(wanted, aside.held);
    return writeLine(user, {
        kind: 'charge',
        amount: aside.held - spent,
        held: -aside.held,
        key: `settle:${hold}`,
        about,
        ref: {hold: String(hold)},
        short: wanted - spent
    });
};

const lineView = (line) => ({
    id: String(line._id),
    seq: line.seq,
    kind: line.kind,
    change: line.amount + line.held,
    amount: line.amount,
    held: line.held,
    balance: line.balance,
    heldTotal: line.heldTotal,
    about: line.about,
    short: line.short || 0,
    paid: line.kind === 'topup' && Boolean(line.ref?.payment),
    hold: line.ref?.hold || null,
    at: line.createdAt
});

export const linesOf = async (userId, {before, limit = PAGE} = {}) => {
    const filter = {...ledger(), user: personId(userId)};
    if (Number.isInteger(Number(before)) && Number(before) > 0) filter.seq = {$lt: Number(before)};
    const size = Math.min(Math.max(parseInt(limit, 10) || PAGE, 1), 100);
    const lines = await CreditLine.find(filter).sort({seq: -1}).limit(size + 1);
    return {lines: lines.slice(0, size).map(lineView), more: lines.length > size};
};

const formFields = (value, prefix = '', out = new URLSearchParams()) => {
    Object.entries(value).forEach(([name, part]) => {
        if (part === undefined || part === null) return;
        const field = prefix ? `${prefix}[${name}]` : name;
        if (typeof part === 'object') formFields(part, field, out);
        else out.append(field, String(part));
    });
    return out;
};

const askStripe = async (path, fields, onceKey, method = 'POST') => {
    const reading = method === 'GET';
    let response;
    try {
        response = await stripeFetch(`${STRIPE_API}${path}${reading ? `?${formFields(fields)}` : ''}`, {
            method,
            headers: {
                Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                'Stripe-Version': STRIPE_VERSION,
                ...(reading ? {} : {'Content-Type': 'application/x-www-form-urlencoded'}),
                ...(onceKey ? {'Idempotency-Key': onceKey} : {})
            },
            ...(reading ? {} : {body: formFields(fields).toString()}),
            signal: AbortSignal.timeout(20000)
        });
    } catch (error) {
        throw new BillingError('STRIPE_UNREACHABLE', 'Stripe could not be reached. Try again.', 502);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        logger.warn('[Billing] Stripe refused a request', {path, status: response.status, type: data?.error?.type, code: data?.error?.code});
        throw new BillingError('STRIPE_REFUSED', data?.error?.message || `Stripe answered ${response.status}`, 502);
    }
    return data;
};

const boughtSoFar = async (user) => {
    const [sum] = await CreditLine.aggregate([
        {$match: {...ledger(), user, kind: 'topup'}},
        {$group: {_id: null, total: {$sum: '$amount'}}}
    ]);
    return sum?.total || 0;
};

const buyLimit = async (user) => {
    const isNew = Date.now() - new Date(user.createdAt).getTime() < BILLING_RULES.newAccountDays * DAY_MS;
    if (!isNew) return {isNew, most: BILLING_RULES.largest};
    return {isNew, most: Math.max(0, BILLING_RULES.newAccountMost - await boughtSoFar(user._id))};
};

const refuse = (res, error) => res.status(error.statusCode).json({success: false, code: error.code, message: error.message, ...error.extra});

const guarded = (handler) => asyncHandler(async (req, res, next) => {
    if (!billingOn()) return res.status(404).json({success: false, code: 'BILLING_OFF', message: 'Billing is not set up'});
    try {
        await handler(req, res, next);
    } catch (error) {
        if (error instanceof BillingError) return refuse(res, error);
        throw error;
    }
});

const getBilling = asyncHandler(async (req, res) => {
    if (!billingOn()) return res.status(200).json({success: true, on: false});
    const user = await User.findById(req.user.id);
    const [{balance, held}, limit] = await Promise.all([balanceOf(user._id), buyLimit(user)]);
    res.status(200).json({
        success: true,
        on: true,
        real: moneyIsReal(),
        inPage: Boolean(process.env.STRIPE_PUBLISHABLE_KEY),
        balance,
        held,
        currency: BILLING_RULES.currency,
        smallest: BILLING_RULES.smallest,
        most: limit.most,
        newAccount: limit.isNew,
        emailVerified: Boolean(user.emailVerified)
    });
});

const getLines = guarded(async (req, res) => {
    res.status(200).json({success: true, ...await linesOf(req.user.id, req.query)});
});

const startCheckout = guarded(async (req, res) => {
    const amount = wholeCents(req.body?.amount);
    const user = await User.findById(req.user.id);
    if (!user.emailVerified) throw new BillingError('EMAIL_NOT_VERIFIED', 'Verify your email address before buying credit', 403);
    if (amount < BILLING_RULES.smallest) {
        throw new BillingError('TOO_SMALL', `The smallest purchase is ${money(BILLING_RULES.smallest)}`, 400, {smallest: BILLING_RULES.smallest});
    }
    const limit = await buyLimit(user);
    if (amount > limit.most) {
        const why = limit.isNew
            ? `A new account can buy ${money(BILLING_RULES.newAccountMost)} in its first ${BILLING_RULES.newAccountDays} days`
            : `The largest purchase is ${money(BILLING_RULES.largest)}`;
        throw new BillingError('TOO_LARGE', why, 400, {most: limit.most});
    }

    // One open payment page per person. An earlier one is closed at Stripe first; if it was paid meanwhile, its
    // credit is still on its way, and the limit above is read again once it has arrived.
    const mine = {...ledger(), user: user._id};
    await Checkout.deleteMany({...mine, endsAt: {$lt: new Date()}});
    const open = await Checkout.findOne(mine);
    if (open?.session) {
        const closed = await askStripe(`/checkout/sessions/${encodeURIComponent(open.session)}/expire`, {}).catch(() => null);
        if (closed?.status !== 'expired') {
            throw new BillingError('PAYMENT_UNDER_WAY', 'Your last payment is still being counted. Try again in a minute.', 409);
        }
        await Checkout.deleteOne({_id: open._id});
    } else if (open) {
        throw new BillingError('PAYMENT_UNDER_WAY', 'A payment page is being opened for you already. Try again in a minute.', 409);
    }
    const endsAt = Math.floor(Date.now() / 1000) + PAGE_OPEN_SECONDS;
    let page;
    try {
        page = await Checkout.create({...mine, amount, endsAt: new Date(endsAt * 1000)});
    } catch (error) {
        if (error?.code === 11000) throw new BillingError('PAYMENT_UNDER_WAY', 'A payment page is being opened for you already. Try again in a minute.', 409);
        throw error;
    }

    const who = {...stripeMark(), user: user.id};
    const onStatement = statementName();
    // In the app's own page Stripe's card field takes the card; Stripe comes back to return_url only for a card
    // that needs a redirect. Otherwise the person pays on Stripe's page.
    const inPage = req.body?.inPage === true && Boolean(process.env.STRIPE_PUBLISHABLE_KEY);
    const comeBack = inPage
        ? {ui_mode: 'elements', return_url: `${process.env.APP_URL}/billing?paid=yes`}
        : {success_url: `${process.env.APP_URL}/billing?paid=yes`, cancel_url: `${process.env.APP_URL}/billing?paid=no`};
    const session = await askStripe('/checkout/sessions', {
        mode: 'payment',
        expires_at: endsAt,
        ...comeBack,
        client_reference_id: user.id,
        customer_email: user.email,
        allowed_payment_method_types: PAYMENT_METHODS,
        line_items: [{
            quantity: 1,
            price_data: {
                currency: BILLING_RULES.currency,
                unit_amount: amount,
                product_data: {name: `${process.env.APP_NAME} credit`}
            }
        }],
        metadata: who,
        payment_intent_data: {metadata: who, ...(onStatement ? {statement_descriptor_suffix: onStatement} : {})},
        ...(limit.isNew ? {payment_method_options: {card: {request_three_d_secure: 'any'}}} : {})
    }).catch(async (error) => {
        await Checkout.deleteOne({_id: page._id});
        throw error;
    });
    await Checkout.updateOne({_id: page._id}, {session: session.id});

    if (inPage) {
        if (typeof session.client_secret !== 'string' || !session.client_secret) {
            await Checkout.deleteOne({_id: page._id});
            throw new BillingError('STRIPE_REFUSED', 'Stripe gave no payment page', 502);
        }
        return res.status(200).json({success: true, clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY});
    }

    let address;
    try {
        address = new URL(session.url);
    } catch {
        address = null;
    }
    if (address?.protocol !== 'https:') {
        await Checkout.deleteOne({_id: page._id});
        throw new BillingError('STRIPE_REFUSED', 'Stripe gave no payment page', 502);
    }
    res.status(200).json({success: true, url: address.href});
});

const signedByStripe = (raw, header) => {
    const parts = String(header || '').split(',').map((part) => part.trim().split('='));
    const time = Number(parts.find(([name]) => name === 't')?.[1]);
    const given = parts.filter(([name]) => name === 'v1').map(([, value]) => value || '');
    if (!Buffer.isBuffer(raw) || !time || given.length === 0) return false;
    if (Math.abs(Date.now() / 1000 - time) > SIGNATURE_AGE_SECONDS) return false;
    const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${time}.`).update(raw).digest();
    return given.some((value) => {
        const candidate = Buffer.from(value, 'hex');
        return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    });
};

const idOf = (value) => (typeof value === 'string' ? value : value?.id) || undefined;

const countPayment = async (session) => {
    if (session.metadata?.service !== BILLING_SERVICE) return;
    if (session.payment_status !== 'paid' || session.currency !== BILLING_RULES.currency) return;
    const userId = session.metadata.user;
    const cents = session.amount_subtotal ?? session.amount_total;
    if (!mongoose.isValidObjectId(userId) || !Number.isInteger(cents) || cents <= 0) return;
    if (!await User.exists({_id: userId})) {
        logger.warn('[Billing] Payment for an account that no longer exists', {session: session.id});
        return;
    }
    const {line, repeated} = await writeLine(userId, {
        kind: 'topup',
        amount: cents,
        key: `stripe:${session.id}`,
        about: 'Credit bought',
        ref: {session: session.id, payment: idOf(session.payment_intent)}
    });
    await Checkout.deleteOne({...ledger(), session: session.id});
    if (repeated) return;
    getNotificationService().notify(userId, 'billing:credit', {
        level: 'success',
        title: 'Credit added',
        message: `${money(cents)} of credit was added. You have ${money(line.balance)}.`,
        path: '/billing'
    });
};

// A person told their bank they did not mean to pay. The bank takes the money back until the dispute is decided, so
// the credit is taken back too: what is left of the purchase, as far as it is unspent. If the dispute is won it is
// given back. Owners are told either way, since a lost one also costs Stripe's dispute fee.
const DISPUTE_ENDS = {won: 'won', lost: 'lost', warning_closed: 'closed', prevented: 'closed'};
const countDispute = async (dispute, opened) => {
    const payment = idOf(dispute.payment_intent);
    if (!payment) return;
    const purchase = () => CreditLine.findOne({...ledger(), kind: 'topup', 'ref.payment': payment});
    let bought = await purchase();
    // Stripe does not promise the order of its messages: a dispute may arrive before the payment it is about. If the
    // payment came from one of this app's payment pages, that purchase is counted first.
    if (!bought && opened) {
        const pages = await askStripe('/checkout/sessions', {payment_intent: payment, limit: 1}, null, 'GET').catch(() => null);
        const page = pages?.data?.[0];
        if (page?.metadata?.service === BILLING_SERVICE) {
            await countPayment(page);
            bought = await purchase();
        }
    }
    if (!bought) return;
    const taken = await CreditLine.findOne({...ledger(), key: `dispute:${dispute.id}`});
    const tell = (title, message) => getNotificationService().notifyRole(['OWNER', 'ADMIN'], 'billing:dispute', {level: 'warning', title, message, path: '/billing'});
    if (opened) {
        if (taken) return;
        const left = bought.amount - (await takenBack(bought)).total;
        const more = Math.max(0, Math.min(dispute.amount || 0, left));
        const take = Math.min(more, (await balanceOf(bought.user)).balance);
        const {repeated} = await writeLine(bought.user, {
            kind: 'dispute', amount: -take, key: `dispute:${dispute.id}`, about: 'Payment disputed with the bank',
            ref: {line: bought._id, payment}, short: more - take
        });
        if (repeated) return;
        logger.warn('[Billing] A payment was disputed', {user: String(bought.user), dispute: dispute.id, taken: take, short: more - take});
        tell('A payment was disputed', `${money(dispute.amount || 0)} was disputed with the bank. ${money(take)} of credit was taken back${more > take ? `; ${money(more - take)} had already been spent` : ''}. Answer it in Stripe.`);
        getNotificationService().notify(bought.user, 'billing:dispute', {
            level: 'warning',
            title: 'Payment disputed',
            message: `${money(take)} of credit is held back while your bank looks into a payment.`,
            path: '/billing'
        });
        return;
    }
    const end = DISPUTE_ENDS[dispute.status];
    if (!end || !taken) return;
    if (end === 'won' && taken.amount < 0) {
        const {repeated} = await writeLine(bought.user, {kind: 'dispute', amount: -taken.amount, key: `dispute-won:${dispute.id}`, about: 'Disputed payment kept: credit given back', ref: {line: bought._id, payment}});
        if (repeated) return;
    }
    tell(`A dispute was ${end}`, `The dispute over ${money(dispute.amount || 0)} was ${end}.`);
};

const takenBack = async (bought) => {
    const lines = await CreditLine.find({...ledger(), kind: 'refund', 'ref.line': bought._id});
    return {count: lines.length, total: lines.reduce((sum, line) => sum - line.amount + (line.short || 0), 0)};
};

const countRefund = async (stripeCharge, eventId) => {
    const payment = idOf(stripeCharge.payment_intent);
    if (!payment) return;
    const bought = await CreditLine.findOne({...ledger(), kind: 'topup', 'ref.payment': payment});
    if (!bought) return;
    const more = Math.min(stripeCharge.amount_refunded || 0, bought.amount) - (await takenBack(bought)).total;
    if (more <= 0) return;
    const {balance} = await balanceOf(bought.user);
    const take = Math.min(more, balance);
    const {repeated} = await writeLine(bought.user, {
        kind: 'refund',
        amount: -take,
        key: `stripe:${eventId}`,
        about: 'Refunded',
        ref: {line: bought._id, payment},
        short: more - take
    });
    if (repeated) return;
    if (more > take) logger.warn('[Billing] A refund was larger than the unspent credit', {user: String(bought.user), short: more - take});
    getNotificationService().notify(bought.user, 'billing:refund', {
        level: 'info',
        title: 'Refund',
        message: `${money(more)} was refunded to your card.`,
        path: '/billing'
    });
};

const stripeMessage = guarded(async (req, res) => {
    if (!signedByStripe(req.rawBody, req.get('stripe-signature'))) {
        logger.warn('[Billing] A message with no valid Stripe signature was refused', {ip: req.ip});
        return res.status(400).json({success: false, code: 'BAD_SIGNATURE', message: 'Signature not accepted'});
    }
    const event = JSON.parse(req.rawBody.toString('utf8'));
    const subject = event?.data?.object || {};
    // Test payments never count where money is real, nor real ones where it is not.
    if (Boolean(event?.livemode) !== moneyIsReal()) return res.status(200).json({received: true});
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        await countPayment(subject);
    } else if (event.type === 'charge.refunded') {
        await countRefund(subject, event.id);
    } else if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
        await countDispute(subject, event.type === 'charge.dispute.created');
    }
    res.status(200).json({received: true});
});

const findPeople = guarded(async (req, res) => {
    const text = String(req.query.find || '').trim().slice(0, 100);
    if (text.length < 2) return res.status(200).json({success: true, people: []});
    const starts = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const users = await User.find({$or: [{username: starts}, {email: starts}]}).select('username email').limit(8);
    const people = await Promise.all(users.map(async (user) => ({id: user.id, username: user.username, email: user.email, ...await balanceOf(user._id)})));
    res.status(200).json({success: true, people});
});

const getPerson = guarded(async (req, res) => {
    const user = await User.findById(personId(req.params.id)).select('username email firstName lastName createdAt emailVerified');
    if (!user) throw new BillingError('NO_SUCH_PERSON', 'No such person', 404);
    const [totals, ledger] = await Promise.all([balanceOf(user._id), linesOf(user._id, req.query)]);
    res.status(200).json({
        success: true,
        person: {id: user.id, username: user.username, email: user.email, name: `${user.firstName || ''} ${user.lastName || ''}`.trim()},
        ...totals,
        ...ledger
    });
});

const adjustPerson = guarded(async (req, res) => {
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > BILLING_RULES.adjustmentMost) {
        throw new BillingError('BAD_AMOUNT', `An adjustment is a whole number of cents, up to ${money(BILLING_RULES.adjustmentMost)} either way`);
    }
    if (reason.length < 3) throw new BillingError('NO_REASON', 'An adjustment needs a reason');
    if (!await User.exists({_id: personId(req.params.id)})) throw new BillingError('NO_SUCH_PERSON', 'No such person', 404);
    const {line} = await writeLine(req.params.id, {kind: 'adjustment', amount, about: reason, by: req.user.id});
    logger.info('[Billing] Adjustment', {by: req.user.id, user: req.params.id, amount});
    getNotificationService().notify(req.params.id, 'billing:adjustment', {
        level: 'info',
        title: 'Credit changed',
        message: `${money(amount)}: ${reason}`,
        path: '/billing'
    });
    res.status(201).json({success: true, line: lineView(line), balance: line.balance, held: line.heldTotal});
});

const refundLine = guarded(async (req, res) => {
    const bought = mongoose.isValidObjectId(req.params.id)
        ? await CreditLine.findOne({_id: req.params.id, ...ledger(), kind: 'topup'})
        : null;
    if (!bought?.ref?.payment) throw new BillingError('NOT_A_PAYMENT', 'Only a payment can be refunded', 404);

    const taken = await takenBack(bought);
    const left = bought.amount - taken.total;
    const {balance} = await balanceOf(bought.user);
    const amount = req.body?.amount === undefined ? Math.min(left, balance) : Number(req.body.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new BillingError('BAD_AMOUNT', 'Nothing is left to refund on this payment');
    if (amount > left) throw new BillingError('MORE_THAN_PAID', `Only ${money(left)} of this payment has not been refunded`, 400, {left});
    if (amount > balance) throw new BillingError('NOT_ENOUGH_CREDIT', `Only ${money(balance)} of credit is unspent`, 402, {balance});

    const reason = String(req.body?.reason || '').trim();
    const key = `refund:${bought.id}:${taken.count}`;
    const ref = {line: bought._id, payment: bought.ref.payment};
    const written = await writeLine(bought.user, {kind: 'refund', amount: -amount, key, about: reason || 'Refund', ref, by: req.user.id});
    if (written.repeated) throw new BillingError('REFUND_UNDER_WAY', 'This refund is already being made', 409);

    try {
        await askStripe('/refunds', {payment_intent: bought.ref.payment, amount, metadata: {...stripeMark(), line: bought.id}}, key);
    } catch (error) {
        await writeLine(bought.user, {
            kind: 'refund',
            amount,
            key: `undo:${key}`,
            about: `Refund not made, credit put back: ${error.message}`,
            ref,
            by: req.user.id
        });
        throw error;
    }

    logger.info('[Billing] Refund', {by: req.user.id, user: String(bought.user), amount});
    getNotificationService().notify(bought.user, 'billing:refund', {
        level: 'info',
        title: 'Refund',
        message: `${money(amount)} was refunded to your card.`,
        path: '/billing'
    });
    res.status(201).json({success: true, line: lineView(written.line), ...await balanceOf(bought.user)});
});

export {
    getBilling,
    getLines,
    startCheckout,
    stripeMessage,
    findPeople,
    getPerson,
    adjustPerson,
    refundLine
};
