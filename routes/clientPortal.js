const express = require('express');
const ExcelJS = require('exceljs');
const https = require('https'); 
const router = express.Router();
const { Telegram } = require('telegraf');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // 🟢 تمت إضافة التشفير لحماية كلمات المرور

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientBot = require('../models/ClientBot');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Admin = require('../models/Admin');
const ExecutorBot = require('../models/ExecutorBot');
const SupportTicket = require('../models/SupportTicket'); 
const Card = require('../models/Card');
const StoreCategory = require('../models/StoreCategory');
const StoreProduct = require('../models/StoreProduct');
const SubAccount = require('../models/SubAccount');
const Counter = require('../models/Counter'); 

const getArgb = (hex) => 'FF' + (hex || '#FFFFFF').replace('#', '').toUpperCase();

// ===============================================
// 📊 محرك الإكسيل المطور (التقفيل المجزأ)
// ===============================================
const buildSegmentedInvoiceSheet = (sheet, name, phone, dateLabel, txs, deposits, currentBalance, isSubAccount) => {
    sheet.views = [{ rightToLeft: true }];
    const alignCenter = { vertical: 'middle', horizontal: 'center' };
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const thickBorder = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };

    // ضبط عرض الأعمدة
    sheet.getColumn(1).width = 6; sheet.getColumn(2).width = 18; sheet.getColumn(3).width = 25; 
    sheet.getColumn(4).width = 15; sheet.getColumn(5).width = 15; sheet.getColumn(6).width = 15; 
    sheet.getColumn(7).width = 18; sheet.getColumn(8).width = 25;

    // --- ترويسة التقرير ---
    sheet.mergeCells('A1:H2');
    const titleCell = sheet.getCell('A1'); 
    titleCell.value = 'شــــركــــــــة Al-Ahram Pay لـلـتـقـنـيـة'; 
    titleCell.font = { size: 22, bold: true, color: { argb: 'FFFFFFFF' } }; 
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF001A4D' } }; 
    titleCell.alignment = alignCenter; titleCell.border = thickBorder;

    sheet.mergeCells('A3:D3'); const nameCell = sheet.getCell('A3'); 
    nameCell.value = `كشف حساب: ${name}`; nameCell.font = { bold: true, size: 14 }; nameCell.alignment = { horizontal: 'right' };
    sheet.mergeCells('E3:H3'); const dateCell = sheet.getCell('E3'); 
    dateCell.value = `التاريخ: ${dateLabel}`; dateCell.font = { bold: true, size: 14 }; dateCell.alignment = { horizontal: 'left' };

    let currentRow = 5;

    const drawTable = (title, data, color, isDeposit = false) => {
        if (data.length === 0) return 0;
        
        sheet.mergeCells(`A${currentRow}:H${currentRow}`);
        const tCell = sheet.getCell(`A${currentRow}`);
        tCell.value = title; tCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
        tCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; tCell.alignment = alignCenter; tCell.border = borderStyle;
        currentRow++;

        const headers = ['ت', 'رقم العملية', isDeposit ? 'البيان' : 'المحفظة / الحساب', 'المبلغ', isDeposit ? '' : 'سعر الصرف', isDeposit ? 'القيمة' : 'التكلفة', 'الوقت', 'ملاحظات'];
        const hRow = sheet.getRow(currentRow); hRow.values = headers;
        hRow.eachCell((cell) => { cell.font = { bold: true, size: 12 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; cell.alignment = alignCenter; cell.border = borderStyle; });
        currentRow++;

        let sumLYD = 0; let sumEGP = 0;
        data.forEach((t, i) => {
            let amount = t.amount || 0;
            let cost = isSubAccount && t.isSubAccountTx ? (t.subAccountCostLYD || t.costLYD) : (t.costLYD || 0);
            let rate = isSubAccount && t.isSubAccountTx ? (t.subClientRate || t.exchangeRate) : (t.exchangeRate || 0);
            
            if (isDeposit) {
                sumLYD += amount; 
                const row = sheet.getRow(currentRow);
                row.values = [i + 1, t.customId || '-', t.status === 'deposit' ? 'إيداع نقدي' : 'تسوية خصم', '', '', amount.toFixed(2), t.updatedAt.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}), t.notes || ''];
                row.eachCell(c => { c.alignment = alignCenter; c.border = borderStyle; });
            } else {
                sumLYD += cost; sumEGP += amount;
                const row = sheet.getRow(currentRow);
                row.values = [i + 1, t.customId || '-', t.vodafoneNumber || t.accountNumber || '-', amount.toFixed(2), rate > 0 ? rate.toFixed(2) : '-', cost.toFixed(2), t.updatedAt.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}), t.notes || ''];
                row.eachCell(c => { c.alignment = alignCenter; c.border = borderStyle; });
            }
            currentRow++;
        });

        sheet.mergeCells(`A${currentRow}:C${currentRow}`);
        const sumRow = sheet.getRow(currentRow);
        sumRow.getCell(1).value = `إجمالي ${title}`; sumRow.getCell(1).font = { bold: true }; sumRow.getCell(1).alignment = alignCenter; sumRow.getCell(1).border = borderStyle;
        if (!isDeposit) { sumRow.getCell(4).value = sumEGP.toFixed(2); sumRow.getCell(4).font = { bold: true }; sumRow.getCell(4).alignment = alignCenter; sumRow.getCell(4).border = borderStyle; }
        sumRow.getCell(6).value = sumLYD.toFixed(2); sumRow.getCell(6).font = { bold: true, color: { argb: 'FFB91C1C' } }; sumRow.getCell(6).alignment = alignCenter; sumRow.getCell(6).border = borderStyle;
        currentRow += 2;

        return sumLYD;
    };

    const myTxs = txs.filter(t => !t.isSubAccountTx);
    const subTxs = txs.filter(t => t.isSubAccountTx);
    
    const myTotal = drawTable('العمليات والتحويلات المباشرة (حسابي)', myTxs, 'FF0EA5E9');
    const subTotal = drawTable('عمليات نقاط البيع والوكلاء الفرعيين', subTxs, 'FF8B5CF6'); 
    const depTotal = drawTable('سجل الإيداعات والتسويات', deposits, 'FF10B981', true); 

    currentRow++;
    sheet.mergeCells(`A${currentRow}:H${currentRow}`);
    const fTitle = sheet.getCell(`A${currentRow}`); fTitle.value = 'الخلاصة المالية وتقفيل الحساب'; fTitle.font = { bold: true, size: 14 }; fTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4AF37' } }; fTitle.alignment = alignCenter; fTitle.border = borderStyle;
    currentRow++;

    const finalTotal = currentBalance;
    const previousBalance = finalTotal + (myTotal + subTotal) - depTotal;

    const sRow1 = sheet.getRow(currentRow++); sRow1.getCell(5).value = 'الرصيد السابق (مرحل):'; sRow1.getCell(6).value = previousBalance.toFixed(2);
    const sRow2 = sheet.getRow(currentRow++); sRow2.getCell(5).value = 'إجمالي المسدد (+):'; sRow2.getCell(6).value = depTotal.toFixed(2);
    const sRow3 = sheet.getRow(currentRow++); sRow3.getCell(5).value = 'إجمالي المسحوب (-):'; sRow3.getCell(6).value = (myTotal + subTotal).toFixed(2);
    const sRow4 = sheet.getRow(currentRow++); sRow4.getCell(5).value = 'الرصيد الختامي الحالي:'; sRow4.getCell(6).value = finalTotal.toFixed(2);
    sRow4.getCell(5).font = { bold: true, size: 14 }; sRow4.getCell(6).font = { bold: true, size: 14, color: { argb: finalTotal < 0 ? 'FFDC2626' : 'FF15803D' } };
};

const requireClientAuth = (req, res, next) => {
    if (req.session.isClientLoggedIn && req.session.clientId) return next();
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/client/login');
};

// ===============================================
// 👤 نظام تسجيل الدخول الموحد للعملاء ونقاط البيع
// ===============================================
router.get('/login', (req, res) => {
    if (req.session.isClientLoggedIn) return res.redirect('/client/dashboard');
    res.render('client/login', { error: null });
});

router.post('/login', async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) return res.render('client/login', { error: 'يرجى إدخال البيانات.' });

        const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');
        const todayStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });

        // 1. حسابات نقاط البيع (SubAccounts)
        const subAcc = await SubAccount.findOne({ webUsername: usernameRegex }).lean();
        if (subAcc) {
            let isMatch = false;
            if (subAcc.webPassword && subAcc.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, subAcc.webPassword);
            } else {
                isMatch = (password === subAcc.webPassword);
                if (isMatch) await SubAccount.updateOne({ _id: subAcc._id }, { webPassword: await bcrypt.hash(password, 12) });
            }
            if (isMatch) {
                if (subAcc.status !== 'active') return res.render('client/login', { error: 'حسابك معلق من قبل الوكيل الرئيسي.' });
                req.session.isClientLoggedIn = true; req.session.clientId = subAcc._id; req.session.accountType = 'sub_client';
                return req.session.save(() => res.redirect('/client/dashboard')); 
            }
        }

        // 2. العملاء الأفراد
        const clientUser = await User.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username }] }).lean();
        if (clientUser) {
            let isMatch = false;
            if (clientUser.webPassword && clientUser.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, clientUser.webPassword);
            } else {
                isMatch = (password === clientUser.webPassword);
                if (isMatch) await User.updateOne({ _id: clientUser._id }, { webPassword: await bcrypt.hash(password, 12) });
            }

            if (isMatch) {
                if (clientUser.status !== 'active') return res.render('client/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });
                if (clientUser.lastOtpDate === todayStr) {
                    req.session.isClientLoggedIn = true; req.session.clientId = clientUser._id; req.session.accountType = 'user';
                    return req.session.save(() => res.redirect('/client/dashboard')); 
                }
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                await User.updateOne({ _id: clientUser._id }, { $set: { otpCode: otp, otpExpires: new Date(Date.now() + 5 * 60000) } }, { strict: false });
                if (process.env.CLIENT_BOT_TOKEN && clientUser.telegramId) {
                    const botAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                    botAPI.sendMessage(clientUser.telegramId, `🔐 <b>رمز تأكيد الدخول للمنصة:</b>\n\nكود التحقق الخاص بك هو:\n<code>${otp}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
                }
                req.session.tempClientId = clientUser._id; req.session.tempAccountType = 'user';
                return req.session.save(() => res.redirect('/client/verify')); 
            }
        }

        // 3. موظفي الشركات
        const clientCompany = await ClientEmployee.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username }] }).lean();
        if (clientCompany) {
            let isMatch = false;
            if (clientCompany.webPassword && clientCompany.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, clientCompany.webPassword);
            } else {
                isMatch = (password === clientCompany.webPassword);
                if (isMatch) await ClientEmployee.updateOne({ _id: clientCompany._id }, { webPassword: await bcrypt.hash(password, 12) });
            }

            if (isMatch) {
                if (clientCompany.status !== 'active') return res.render('client/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });
                if (clientCompany.lastOtpDate === todayStr) {
                    req.session.isClientLoggedIn = true; req.session.clientId = clientCompany._id; req.session.accountType = 'company';
                    return req.session.save(() => res.redirect('/client/dashboard')); 
                }
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                await ClientEmployee.updateOne({ _id: clientCompany._id }, { $set: { otpCode: otp, otpExpires: new Date(Date.now() + 5 * 60000) } }, { strict: false });
                const company = await ClientBot.findById(clientCompany.clientBotId).lean();
                if (company && company.token && clientCompany.telegramId) {
                    const compAPI = new Telegram(company.token);
                    compAPI.sendMessage(clientCompany.telegramId, `🔐 <b>رمز تأكيد الدخول للمنصة:</b>\n\nكود التحقق الخاص بك هو:\n<code>${otp}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
                }
                req.session.tempClientId = clientCompany._id; req.session.tempAccountType = 'company';
                return req.session.save(() => res.redirect('/client/verify')); 
            }
        }

        return res.render('client/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    } catch (e) { res.render('client/login', { error: 'حدث خطأ في النظام.' }); }
});

router.get('/verify', (req, res) => {
    if (!req.session.tempClientId) return res.redirect('/client/login');
    res.render('client/verify', { error: null });
});

router.post('/verify', async (req, res) => {
    try {
        const { otp } = req.body;
        let account = null;
        if (req.session.tempAccountType === 'company') { account = await ClientEmployee.findById(req.session.tempClientId).lean(); } 
        else { account = await User.findById(req.session.tempClientId).lean(); }
        
        if (!account || account.otpCode !== otp?.trim() || new Date(account.otpExpires) < new Date()) {
            return res.render('client/verify', { error: 'الرمز غير صحيح أو منتهي الصلاحية.' });
        }

        const todayStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
        if (req.session.tempAccountType === 'company') { await ClientEmployee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); } 
        else { await User.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); }

        req.session.isClientLoggedIn = true; req.session.clientId = account._id; req.session.accountType = req.session.tempAccountType;
        req.session.tempClientId = null; req.session.tempAccountType = null;
        res.redirect('/client/dashboard');
    } catch (e) { res.redirect('/client/login'); }
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/client/login'); });

// ===============================================
// 🚀 حماية مسارات إثباتات التنفيذ (Images Access)
// ===============================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireClientAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        // 🛡️ حماية الصلاحيات: التحقق من أحقية العميل برؤية الصورة
        const isSubAccount = req.session.accountType === 'sub_client';
        const accountId = req.session.clientId;
        let hasAccess = false;
        
        if (isSubAccount && tx.subAccountId && tx.subAccountId.toString() === accountId.toString()) hasAccess = true;
        else if (req.session.accountType === 'company') {
            const emp = await ClientEmployee.findById(accountId);
            if (emp && tx.clientBotId && tx.clientBotId.toString() === emp.clientBotId.toString()) hasAccess = true;
        } else if (req.session.accountType === 'user') {
            const user = await User.findById(accountId);
            if (user && tx.userId === user.telegramId) hasAccess = true;
        }

        if (!hasAccess) return res.status(403).send('غير مصرح لك بعرض هذه الصورة أو الإيصال');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        
        if (tx.proofImages && tx.proofImages.length > index) {
            photoId = tx.proofImages[index];
        } else if (tx.proofImage && index === 0) {
            photoId = tx.proofImage; 
        }

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        let tokensToTry = [process.env.ADMIN_BOT_TOKEN, process.env.CLIENT_BOT_TOKEN];

        if (tx.executorBotId) {
            const execBot = await ExecutorBot.findById(tx.executorBotId);
            if (execBot && execBot.token) tokensToTry.push(execBot.token);
        }
        if (tx.clientBotId) {
            const clientBot = await ClientBot.findById(tx.clientBotId);
            if (clientBot && clientBot.token) tokensToTry.push(clientBot.token);
        }

        let fileLink = null;
        for (const token of tokensToTry) {
            try {
                const api = new Telegram(token);
                fileLink = await api.getFileLink(photoId);
                if (fileLink) break; 
            } catch(e) {}
        }

        if (!fileLink) return res.status(404).send('لا يمكن الوصول للصورة بسبب صلاحيات تيليجرام');

        https.get(fileLink.href, (response) => {
            res.set('Content-Type', response.headers['content-type']);
            response.pipe(res);
        }).on('error', (e) => {
            res.status(500).send('خطأ في جلب الصورة من تيليجرام');
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('خطأ داخلي في الخادم');
    }
});

// ===============================================
// 🚀 إدارة نقاط البيع والوكلاء الفرعيين
// ===============================================
router.get('/sub-accounts', requireClientAuth, async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.redirect('/client/dashboard'); 
    const isEmployee = req.session.accountType === 'company';
    const Model = isEmployee ? ClientEmployee : User;
    const account = await Model.findById(req.session.clientId);
    
    let masterType = isEmployee ? 'company' : 'user';
    let masterId = isEmployee ? account.clientBotId : account._id;
    const subAccounts = await SubAccount.find({ masterType, masterId }).sort({ createdAt: -1 });
    
    let totalDebt = 0; subAccounts.forEach(s => { if (s.balance < 0) totalDebt += Math.abs(s.balance); });
    res.render('client/sub_accounts', { user: account, subAccounts, totalDebt, isEmployee });
});

router.post('/sub-accounts/add', requireClientAuth, async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const { name, phone, webUsername, webPassword, customMargin, creditLimit, cardMargin } = req.body;
    const isEmployee = req.session.accountType === 'company';
    const account = isEmployee ? await ClientEmployee.findById(req.session.clientId) : await User.findById(req.session.clientId);
    let masterType = isEmployee ? 'company' : 'user'; let masterId = isEmployee ? account.clientBotId : account._id;

    try {
        await SubAccount.create({ masterType, masterId, name, phone, webUsername, webPassword, customMargin: parseFloat(customMargin) || 0, cardMargin: parseFloat(cardMargin) || 0, creditLimit: parseFloat(creditLimit) || 0 });
        res.redirect('/client/sub-accounts?success=1');
    } catch(e) { res.redirect('/client/sub-accounts?error=1'); }
});

router.post('/sub-accounts/settle/:id', requireClientAuth, async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const { amount, type } = req.body; let val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return res.redirect('/client/sub-accounts?error=1');

    try {
        const sub = await SubAccount.findById(req.params.id);
        if(sub) {
            if (type === 'withdraw' && sub.balance < val) return res.redirect('/client/sub-accounts?error=funds');
            if (type === 'withdraw') val = -val;
            sub.balance += val; await sub.save();

            let parentUserId = null, parentClientBotId = null, empName = 'الوكيل';
            if (req.session.accountType === 'company') { const emp = await ClientEmployee.findById(req.session.clientId); parentClientBotId = emp.clientBotId; empName = emp.name; } 
            else { const user = await User.findById(req.session.clientId); parentUserId = user.telegramId; empName = user.name; }

            await Transaction.create({ customId: `SET-${Date.now().toString().slice(-6)}`, subAccountId: sub._id, userId: parentUserId, clientBotId: parentClientBotId, amount: Math.abs(val), costLYD: 0, status: type === 'add' ? 'deposit' : 'deduction', notes: type === 'add' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`, companyName: 'تسوية وكيل', employeeName: empName });
        }
        res.redirect('/client/sub-accounts');
    } catch(e) { res.redirect('/client/sub-accounts?error=db'); }
});

router.post('/sub-accounts/toggle/:id', requireClientAuth, async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const sub = await SubAccount.findById(req.params.id);
    if(sub) { sub.status = sub.status === 'active' ? 'banned' : 'active'; await sub.save(); }
    res.redirect('/client/sub-accounts');
});

// ===============================================
// 📊 لوحة معلومات العميل والفرعي
// ===============================================
router.get('/dashboard', requireClientAuth, async (req, res) => {
    try {
        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await Model.findById(req.session.clientId);
        if (!account) return res.redirect('/client/logout');

        const search = req.query.search ? req.query.search.trim() : '';
        let targetDate = req.query.date; let showMonth = req.query.month === 'true'; let dateLabel = '';
        
        let filter = {};
        if (isSubAccount) { filter.subAccountId = account._id; } 
        else if (req.session.accountType === 'company') { filter.clientBotId = account.clientBotId; filter.subAccountId = null; } 
        else { filter.userId = account.telegramId; filter.clientBotId = null; filter.subAccountId = null; }

        let start, end;
        if (showMonth) {
            const now = new Date(); start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
            dateLabel = `شهر ${now.getMonth() + 1} لعام ${now.getFullYear()}`; targetDate = '';
        } else {
            if (!targetDate) { const today = new Date(); targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; }
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`); dateLabel = targetDate;
        }

        filter.createdAt = { $gte: start, $lte: end };
        if (search) { filter.$or = [{ notes: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { customId: { $regex: search, $options: 'i' } }]; }

        const transactions = await Transaction.find(filter).sort({ createdAt: -1 });

        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0 };
        let masterTotalProfit = 0; 
        let subTransactionsList = [];

        if (!isSubAccount) {
            const subTxsFilter = req.session.accountType === 'company' ? { clientBotId: account.clientBotId } : { userId: account.telegramId, clientBotId: null };
            subTxsFilter.subAccountId = { $ne: null };
            subTxsFilter.createdAt = { $gte: start, $lte: end };
            subTransactionsList = await Transaction.find(subTxsFilter).sort({ createdAt: -1 });
            subTransactionsList.forEach(t => { if (t.status === 'completed') masterTotalProfit += (t.masterProfit || 0); });
        }

        let combinedTransactions = isSubAccount ? transactions : [...transactions, ...subTransactionsList].sort((a,b) => b.createdAt - a.createdAt);

        combinedTransactions.forEach(tx => {
            if (tx.status === 'completed') {
                totals.transfersEGP += (tx.amount || 0);
                totals.transfersLYD += (isSubAccount ? (tx.subAccountCostLYD || tx.costLYD) : (tx.costLYD || 0));
            } else if (tx.status === 'deposit') {
                totals.depositsEGP += (tx.amount || 0);
            }
        });

        const set = await Settings.findOne({}) || {};
        let balance, currentRate, clientTier = 1;

        if (isSubAccount) {
            balance = account.balance;
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientBot.findById(account.masterId);
            clientTier = master ? (master.tier || 1) : 1;
            let mRate = clientTier === 3 ? set.rateLevel3 : (clientTier === 2 ? set.rateLevel2 : set.rateLevel1);
            currentRate = mRate - account.customMargin; 
        } else if (req.session.accountType === 'company') {
            const company = await ClientBot.findById(account.clientBotId);
            balance = company.balance; clientTier = company.tier || 1;
            currentRate = company.tier === 3 ? set.rateLevel3 : (company.tier === 2 ? set.rateLevel2 : set.rateLevel1);
        } else {
            balance = account.balance; clientTier = account.tier || 1;
            currentRate = account.tier === 3 ? set.rateLevel3 : (account.tier === 2 ? set.rateLevel2 : set.rateLevel1);
        }

        const categoriesMeta = await StoreCategory.find({});
        const productsMeta = await StoreProduct.find({});

        const availableCards = await Card.aggregate([
            { $match: { sold: false } },
            { $group: { _id: { category: "$category", name: "$name" }, price_1: { $first: "$price_1" }, price_2: { $first: "$price_2" }, price_3: { $first: "$price_3" }, count: { $sum: 1 } }},
            { $group: { _id: "$_id.category", products: { $push: { name: "$_id.name", price_1: "$price_1", price_2: "$price_2", price_3: "$price_3", count: "$count" } } }}
        ]);

        const storeCatalog = availableCards.map((cat, index) => {
            const catMeta = categoriesMeta.find(c => c.name === cat._id) || {};
            return {
                id: 'cat_' + index, categoryName: cat._id, icon: catMeta.icon || 'fa-store', color: catMeta.color || '#198754', image: catMeta.image || '', 
                products: cat.products.map(p => {
                    let finalPrice = p.price_1;
                    if (clientTier === 2) finalPrice = p.price_2;
                    if (clientTier === 3) finalPrice = p.price_3;
                    if (isSubAccount) finalPrice += account.cardMargin;
                    const pMeta = productsMeta.find(pm => pm.name === p.name && pm.categoryName === cat._id) || {};
                    return { name: p.name, priceLYD: finalPrice, count: p.count, image: pMeta.image || '' }
                })
            };
        });

        res.render('client/dashboard', { 
            user: { name: account.name, balance: balance, role: account.role || 'user', accountType: req.session.accountType }, 
            isSubAccount, isMaster: !isSubAccount, masterTotalProfit, transactions: combinedTransactions, currentRate, totals, targetDate, dateLabel, showMonth, search, query: req.query, storeCatalog 
        });
    } catch (error) { res.redirect('/client/login'); }
});

// ===============================================
// 💸 نظام التحويل محصن بالعمليات الذرية
// ===============================================
router.post('/transfer', requireClientAuth, async (req, res) => {
    const isAjax = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
    const isSubAccount = req.session.accountType === 'sub_client';
    const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
    const account = await Model.findById(req.session.clientId);
    
    if (account.role === 'accountant') return isAjax ? res.status(403).json({ error: '❌ ليس لديك صلاحية.' }) : res.redirect('/client/dashboard?error=unauthorized');

    const amount = parseFloat(req.body.amount); const phone = req.body.phone; const notes = req.body.notes ? req.body.notes.trim() : ''; const transferType = req.body.type || 'كاش'; const imageBase64 = req.body.imageBase64; 

    if (isNaN(amount) || amount <= 0 || !phone) return isAjax ? res.status(400).json({ error: '❌ بيانات التحويل غير صحيحة.' }) : null;

    const settings = await Settings.findOne({});
    if (settings && settings.isManualClosed) return isAjax ? res.status(403).json({ error: '⛔ النظام مغلق.' }) : null;

    let masterRate, actualSubRate, subCostLYD, masterCostLYD, commission = 0;
    let balanceModel, limit, clientBotId = null, companyName = 'عميل فردي (ويب)';
    let masterObj, telegramId = null;

    if (isSubAccount) {
        masterObj = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientBot.findById(account.masterId);
        let clientTier = masterObj.tier || 1;
        masterRate = clientTier === 3 ? settings.rateLevel3 : (clientTier === 2 ? settings.rateLevel2 : settings.rateLevel1);
        if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
        actualSubRate = masterRate - account.customMargin; if (actualSubRate <= 0) actualSubRate = masterRate;
        subCostLYD = parseFloat((amount / actualSubRate).toFixed(3)); masterCostLYD = parseFloat((amount / masterRate).toFixed(3)); commission = parseFloat((subCostLYD - masterCostLYD).toFixed(3));

        if (account.masterType === 'company') { clientBotId = masterObj._id; companyName = masterObj.name; telegramId = null; }
        else { companyName = masterObj.name; telegramId = masterObj.telegramId; }

        const minSubBalance = subCostLYD - (account.creditLimit || 0);
        const minMasterBalance = masterCostLYD - (masterObj.creditLimit || 0);

        const updatedSub = await SubAccount.findOneAndUpdate(
            { _id: account._id, balance: { $gte: minSubBalance } },
            { $inc: { balance: -subCostLYD } },
            { new: true }
        );
        if (!updatedSub) return isAjax ? res.status(400).json({ error: '❌ رصيد نقطة البيع غير كافٍ أو تغير أثناء العملية.' }) : null;

        const MasterModel = account.masterType === 'user' ? User : ClientBot;
        const updatedMaster = await MasterModel.findOneAndUpdate(
            { _id: masterObj._id, balance: { $gte: minMasterBalance } },
            { $inc: { balance: -masterCostLYD } },
            { new: true }
        );

        if (!updatedMaster) {
            await SubAccount.findByIdAndUpdate(account._id, { $inc: { balance: subCostLYD } }); 
            return isAjax ? res.status(400).json({ error: '❌ رصيد الوكيل الرئيسي غير كافٍ لتغطية التكلفة الأساسية.' }) : null;
        }
        balanceModel = updatedSub;
        masterObj = updatedMaster;

    } else if (req.session.accountType === 'company') {
        const company = await ClientBot.findById(account.clientBotId);
        masterRate = company.tier === 3 ? settings.rateLevel3 : (company.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
        if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
        masterCostLYD = parseFloat((amount / masterRate).toFixed(3));
        balanceModel = company; clientBotId = company._id; companyName = company.name; telegramId = account.telegramId;
    } else {
        masterRate = account.tier === 3 ? settings.rateLevel3 : (account.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
        if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
        masterCostLYD = parseFloat((amount / masterRate).toFixed(3));
        balanceModel = account; telegramId = account.telegramId;
    }

    if (!isSubAccount) {
        const minBalance = masterCostLYD - (balanceModel.creditLimit || 0);
        const BModel = req.session.accountType === 'company' ? ClientBot : User;
        
        const updatedClient = await BModel.findOneAndUpdate(
            { _id: balanceModel._id, balance: { $gte: minBalance } },
            { $inc: { balance: -masterCostLYD } },
            { new: true }
        );

        if (!updatedClient) return isAjax ? res.status(400).json({ error: '❌ رصيدك غير كافٍ أو تغير أثناء العملية.' }) : null;
        balanceModel = updatedClient;
    }

    const counter = await Counter.findOneAndUpdate(
        { name: 'transaction' },
        { $inc: { value: 1 } },
        { upsert: true, new: true }
    );
    const yy = new Date().getFullYear().toString().slice(-2);
    const mm = (new Date().getMonth() + 1).toString().padStart(2, '0');
    let finalCustomId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`;

    let newTx;
    try {
        newTx = await Transaction.create({
            customId: finalCustomId, userId: telegramId, clientBotId: clientBotId, subAccountId: isSubAccount ? account._id : null,
            subAccountName: isSubAccount ? account.name : '', companyName: isSubAccount ? masterObj.name : companyName, 
            employeeName: isSubAccount ? account.name : account.name, vodafoneNumber: phone, transferType: transferType,
            accountName: req.body.name || '', accountNumber: req.body.number || '', amount: amount, costLYD: masterCostLYD,
            subAccountCostLYD: isSubAccount ? subCostLYD : 0, commission: commission, exchangeRate: masterRate, subClientRate: isSubAccount ? actualSubRate : 0,
            notes: notes, status: 'pending', isSubAccountTx: isSubAccount, masterProfit: isSubAccount ? commission : 0
        });
    } catch (dbError) {
        if (isSubAccount) { 
            await SubAccount.findByIdAndUpdate(account._id, { $inc: { balance: subCostLYD } });
            const MasterModel = account.masterType === 'user' ? User : ClientBot;
            await MasterModel.findByIdAndUpdate(masterObj._id, { $inc: { balance: masterCostLYD } });
        } else { 
            const BModel = req.session.accountType === 'company' ? ClientBot : User;
            await BModel.findByIdAndUpdate(balanceModel._id, { $inc: { balance: masterCostLYD } });
        }
        return isAjax ? res.status(500).json({ error: '❌ خطأ داخلي.' }) : null;
    }

    if (isAjax) res.json({ success: true, message: '✅ تم الإرسال بنجاح!', newBalance: balanceModel.balance.toFixed(2) });

    setImmediate(async () => {
        try {
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            
            const masterNameText = isSubAccount ? masterObj.name : companyName;
            const requesterText = isSubAccount ? `${account.name} (نقطة بيع)` : 'حساب الوكيل المباشر';
            const profitNote = commission > 0 ? `\n🎁 <b>ربح الوكيل من العملية:</b> ${commission.toFixed(3)} LYD` : '';
            
            const adminMsg = `🔔 <b>طلب جديد من الويب!</b>\n\n🏢 <b>الوكيل الرئيسي:</b> ${masterNameText}\n🏪 <b>الجهة الطالبة:</b> ${requesterText}\n📞 <b>المحفظة:</b> <code>${phone}</code>\n💵 <b>المبلغ:</b> ${amount} EGP\n💰 <b>التكلفة المستقطعة من الوكيل:</b> ${masterCostLYD.toFixed(3)} LYD${profitNote}\n📝 <b>التفاصيل:</b> <b>${notes || 'لا يوجد'}</b>\n🔢 <b>رقم:</b> <code>${finalCustomId}</code>`;
            
            const keyboard = { inline_keyboard: [[{ text: '🤖 توجيه لبوت التنفيذ', callback_data: `forward_${newTx._id}` }], [{ text: '❌ رفض وإلغاء', callback_data: `cancelReq_${newTx._id}` }]] };
            const admins = await Admin.find({});
            let savedAdminMsgs = []; 
            for (const admin of admins) {
                if(admin.telegramId && !admin.webUsername) {
                    try {
                        let sent;
                        if (imageBase64) {
                            const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
                            sent = await adminAPI.sendPhoto(admin.telegramId, { source: imageBuffer }, { caption: adminMsg, parse_mode: 'HTML', reply_markup: keyboard });
                        } else {
                            sent = await adminAPI.sendMessage(admin.telegramId, adminMsg, { parse_mode: 'HTML', reply_markup: keyboard });
                        }
                        if(sent) savedAdminMsgs.push({ telegramId: admin.telegramId, messageId: sent.message_id });
                    } catch(e) {}
                }
            }
            if (savedAdminMsgs.length > 0) await Transaction.findByIdAndUpdate(newTx._id, { $push: { adminMessages: { $each: savedAdminMsgs } } });
        } catch(e) {}
    });
});

router.post('/buy-card', requireClientAuth, async (req, res) => {
    res.json({ success: true, message: 'ميزة الشراء قيد العمل', newBalance: 0 });
});

router.get('/export-excel', requireClientAuth, async (req, res) => {
    const Model = req.session.accountType === 'sub_client' ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
    const account = await Model.findById(req.session.clientId);
    if (!account) return res.redirect('/client/logout');

    let entityName = account.name, entityPhone = account.phone, currentDbBalance = account.balance, filter = {};
    if (req.session.accountType === 'sub_client') {
        filter = { subAccountId: account._id };
    } else if (req.session.accountType === 'company') {
        const company = await ClientBot.findById(account.clientBotId);
        entityName = company.name; entityPhone = company.phone; currentDbBalance = company.balance; filter = { clientBotId: company._id };
    } else {
        filter = { userId: account.telegramId, clientBotId: null };
    }

    const reportType = req.query.type || 'daily';
    const now = new Date();
    let start, end, dateLabel;

    if (reportType === 'monthly') {
        start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
        dateLabel = `شهر ${now.getMonth() + 1} - ${now.getFullYear()}`;
    } else {
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end = new Date(now); end.setHours(23, 59, 59, 999);
        dateLabel = start.toLocaleDateString('en-GB');
    }

    const txs = await Transaction.find({ ...filter, status: 'completed', updatedAt: { $gte: start, $lte: end } }).sort({ updatedAt: 1 }).lean();
    const deposits = await Transaction.find({ ...filter, status: { $in: ['deposit', 'deduction'] }, updatedAt: { $gte: start, $lte: end } }).lean();
    
    const workbook = new ExcelJS.Workbook();
    buildSegmentedInvoiceSheet(workbook.addWorksheet('كشف حساب وتقفيل'), entityName, entityPhone, dateLabel, txs, deposits, currentDbBalance, req.session.accountType === 'sub_client');
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${dateLabel.replace(/\//g, '-')}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
});

router.get('/api/transactions', requireClientAuth, async (req, res) => {
    try {
        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await Model.findById(req.session.clientId);
        
        let filter = {};
        if (isSubAccount) { filter.subAccountId = account._id; } 
        else if (req.session.accountType === 'company') { filter.clientBotId = account.clientBotId; filter.subAccountId = null; } 
        else { filter.userId = account.telegramId; filter.clientBotId = null; filter.subAccountId = null; }

        const search = req.query.search ? req.query.search.trim() : '';
        let targetDate = req.query.date; let showMonth = req.query.month === 'true'; let start, end;
        if (showMonth) {
            const now = new Date(); start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
        } else {
            if (!targetDate) { const today = new Date(); targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; }
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`);
        }
        filter.createdAt = { $gte: start, $lte: end };
        if (search) { filter.$or = [{ notes: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { customId: { $regex: search, $options: 'i' } }]; }

        let transactions = await Transaction.find(filter).sort({ createdAt: -1 }).limit(25).lean();
        
        if (!isSubAccount) {
            const subFilter = req.session.accountType === 'company' ? { clientBotId: account.clientBotId } : { userId: account.telegramId, clientBotId: null };
            subFilter.subAccountId = { $ne: null }; subFilter.createdAt = { $gte: start, $lte: end };
            const subTransactionsList = await Transaction.find(subFilter).sort({ createdAt: -1 }).limit(15).lean();
            transactions = [...transactions, ...subTransactionsList].sort((a,b) => b.createdAt - a.createdAt);
        }
        
        let currentRate = 1;
        const set = await Settings.findOne({});
        if (isSubAccount) {
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientBot.findById(account.masterId);
            let mRate = master.tier === 3 ? set.rateLevel3 : (master.tier === 2 ? set.rateLevel2 : set.rateLevel1);
            currentRate = mRate - account.customMargin;
        } else {
            let tier = 1;
            if (req.session.accountType === 'company') { const comp = await ClientBot.findById(account.clientBotId); tier = comp.tier || 1; } 
            else { tier = account.tier || 1; }
            currentRate = tier === 3 ? set.rateLevel3 : (tier === 2 ? set.rateLevel2 : set.rateLevel1);
        }

        const mappedTransactions = transactions.map(t => {
            if (isSubAccount && t.isSubAccountTx) { t.costLYD = t.subAccountCostLYD; t.exchangeRate = t.subClientRate; }
            return t;
        });

        res.json({ success: true, transactions: mappedTransactions, currentRate, availableBalance: account.balance });
    } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
});

module.exports = router;