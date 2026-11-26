import mongoose from 'mongoose';

export const BILLING_SERVICE = 'ai-base';
export const LINE_KINDS = ['topup', 'charge', 'hold', 'refund', 'adjustment', 'dispute'];

/**
 * One line of a person's credit ledger. Lines are added and never changed.
 * amount is the change to what can be spent, held the change to what is set aside;
 * balance and heldTotal are the totals after this line, all in cents.
 * live says whether it is real money: staging and production may share one database, so a line bought with
 * Stripe's test card is never counted where money is real. Line numbers run over both.
 */
const creditLineSchema = new mongoose.Schema({
    service: { type: String, default: BILLING_SERVICE, immutable: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    live: { type: Boolean, required: true, immutable: true },
    seq: { type: Number, required: true, immutable: true },
    kind: { type: String, enum: LINE_KINDS, required: true, immutable: true },
    amount: { type: Number, required: true, immutable: true },
    held: { type: Number, default: 0, immutable: true },
    balance: { type: Number, required: true, min: 0, immutable: true },
    heldTotal: { type: Number, default: 0, min: 0, immutable: true },
    key: { type: String, immutable: true },
    about: { type: String, default: '', maxlength: 300, immutable: true },
    ref: {
        session: { type: String, immutable: true },
        payment: { type: String, immutable: true },
        refund: { type: String, immutable: true },
        line: { type: mongoose.Schema.Types.ObjectId, immutable: true },
        hold: { type: String, immutable: true }
    },
    short: { type: Number, immutable: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    createdAt: { type: Date, default: Date.now, immutable: true }
});

creditLineSchema.index({ service: 1, user: 1, seq: 1 }, { unique: true });
creditLineSchema.index({ service: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
creditLineSchema.index({ service: 1, 'ref.payment': 1 }, { partialFilterExpression: { 'ref.payment': { $type: 'string' } } });

const neverChanged = function () {
    throw new Error('A ledger line is never changed or removed');
};
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']
    .forEach((operation) => creditLineSchema.pre(operation, neverChanged));

const CreditLine = mongoose.models.CreditLine || mongoose.model('CreditLine', creditLineSchema);

/**
 * A payment page that is open. A person has at most one at a time, so a limit on what they may buy cannot be passed
 * by opening several and paying each. Gone once paid, replaced or past its end.
 */
const checkoutSchema = new mongoose.Schema({
    service: { type: String, default: BILLING_SERVICE },
    live: { type: Boolean, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    session: { type: String },
    amount: { type: Number, required: true },
    endsAt: { type: Date, required: true }
});
checkoutSchema.index({ service: 1, live: 1, user: 1 }, { unique: true });
checkoutSchema.index({ service: 1, session: 1 });

export const Checkout = mongoose.models.Checkout || mongoose.model('Checkout', checkoutSchema);

export default CreditLine;
