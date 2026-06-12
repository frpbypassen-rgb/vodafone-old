const crypto = require('crypto');
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');

const TRANSACTION_UNSUPPORTED_ERRORS = [
    'replica set',
    'Transaction numbers',
    'transactions are not supported',
    'mongos'
];

const normalizeAmountInput = (value) => {
    if (typeof value === 'number') return value;
    const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
    const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
    let text = String(value || '').trim();

    text = text.replace(/[٠-٩]/g, digit => arabicDigits.indexOf(digit).toString());
    text = text.replace(/[۰-۹]/g, digit => persianDigits.indexOf(digit).toString());
    text = text.replace(/[٫]/g, '.').replace(/\s+/g, '');

    if (text.includes(',') && !text.includes('.')) {
        const parts = text.split(',');
        const last = parts[parts.length - 1];
        text = parts.length === 2 && last.length > 0 && last.length <= 2
            ? `${parts[0]}.${last}`
            : parts.join('');
    } else {
        text = text.replace(/,/g, '');
    }

    return Number(text);
};

const parseSignedAmount = (value) => {
    const amount = normalizeAmountInput(value);
    if (!Number.isFinite(amount) || amount === 0) {
        throw new Error('INVALID_AMOUNT');
    }
    return amount;
};

const generateFinancialId = (prefix = 'DEP') => {
    const stamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${stamp}-${random}`;
};

const isTransactionUnsupported = (error) => {
    const message = error && error.message ? error.message : '';
    return TRANSACTION_UNSUPPORTED_ERRORS.some(pattern => message.includes(pattern));
};

const buildAdjustmentPayload = ({ amount, transactionData = {} }) => {
    const signedAmount = parseSignedAmount(amount);
    const isDeposit = signedAmount > 0;
    const status = isDeposit ? 'deposit' : 'deduction';
    const type = isDeposit ? 'DEPOSIT' : 'DEDUCTION';
    const customId = transactionData.customId || generateFinancialId(isDeposit ? 'DEP' : 'DED');

    const txPayload = {
        ...transactionData,
        customId,
        amount: Math.abs(signedAmount),
        costLYD: transactionData.costLYD ?? 0,
        status
    };

    return { signedAmount, status, type, customId, txPayload };
};

const recordBalanceAdjustment = async ({
    entityModel,
    entityId,
    amount,
    transactionData = {},
    description
}) => {
    const Transaction = require('../models/Transaction');
    const Model = mongoose.model(entityModel);
    const { signedAmount, type, customId, txPayload } = buildAdjustmentPayload({ amount, transactionData });

    const runWithoutSession = async () => {
        const account = await Model.findById(entityId);
        if (!account) throw new Error('ACCOUNT_NOT_FOUND');

        const balanceBefore = Number(account.balance || 0);
        const balanceAfter = balanceBefore + signedAmount;
        const tx = await Transaction.create(txPayload);
        let balanceSaved = false;

        try {
            account.balance = balanceAfter;
            await account.save();
            balanceSaved = true;

            await Ledger.create({
                entityId,
                entityModel,
                transactionId: customId,
                type,
                amount: signedAmount,
                balanceBefore,
                balanceAfter,
                description: description || txPayload.notes || customId
            });

            return { success: true, transaction: tx, balanceBefore, balanceAfter };
        } catch (error) {
            await Transaction.deleteOne({ _id: tx._id }).catch(() => {});
            if (balanceSaved) {
                account.balance = balanceBefore;
                await account.save().catch(() => {});
            }
            throw error;
        }
    };

    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();

        const account = await Model.findById(entityId).session(session);
        if (!account) throw new Error('ACCOUNT_NOT_FOUND');

        const balanceBefore = Number(account.balance || 0);
        const balanceAfter = balanceBefore + signedAmount;

        const txDocs = await Transaction.create([txPayload], { session });
        account.balance = balanceAfter;
        await account.save({ session });

        const ledger = new Ledger({
            entityId,
            entityModel,
            transactionId: customId,
            type,
            amount: signedAmount,
            balanceBefore,
            balanceAfter,
            description: description || txPayload.notes || customId
        });
        await ledger.save({ session });

        await session.commitTransaction();
        return { success: true, transaction: txDocs[0], balanceBefore, balanceAfter };
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); } catch (_) {}
        }

        if (isTransactionUnsupported(error)) {
            return runWithoutSession();
        }

        throw error;
    } finally {
        if (session) {
            try { session.endSession(); } catch (_) {}
        }
    }
};

module.exports = {
    generateFinancialId,
    normalizeAmountInput,
    parseSignedAmount,
    recordBalanceAdjustment
};
