const express = require('express');
const router = express.Router();
const https = require('https');
const { Telegram } = require('telegraf');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const Transaction = require('../models/Transaction');
const ExecutorBot = require('../models/ExecutorBot');
const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middlewares/auth');
const { syncBotBalance } = require('../utils/helpers');

// 🚀 استدعاء محرك الـ API 
const { executeTransferViaApi } = require('../services/externalApiService');

router.use(requireAuth);

router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) photoId = tx.proofImages[index];
        else if (tx.proofImage && index === 0) photoId = tx.proofImage; 

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        let tokensToTry = [];
        if (process.env.ADMIN_BOT_TOKEN) tokensToTry.push(process.env.ADMIN_BOT_TOKEN);
        if (process.env.CLIENT_BOT_TOKEN) tokensToTry.push(process.env.CLIENT_BOT_TOKEN);
        if (tx.executorBotId) { const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot && execBot.token) tokensToTry.push(execBot.token); }
        if (tx.clientBotId) { const clientBot = await ClientBot.findById(tx.clientBotId); if (clientBot && clientBot.token) tokensToTry.push(clientBot.token); }

        let fileLink = null;
        for (const token of tokensToTry) {
            try { const api = new Telegram(token); fileLink = await api.getFileLink(photoId); if (fileLink) break; } catch(e) {}
        }

        if (!fileLink) return res.status(404).send('لا يمكن الوصول للصورة بسبب صلاحيات تيليجرام');
        https.get(fileLink.href, (response) => { res.set('Content-Type', response.headers['content-type']); response.pipe(res); }).on('error', (e) => { res.status(500).send('خطأ في جلب الصورة'); });
    } catch (error) { res.status(500).send('خطأ داخلي'); }
});

router.get('/api/notifications/unread', async (req, res) => {
    try { const notifs = await Notification.find({ isRead: false }).sort({ createdAt: -1 }); res.json({ count: notifs.length, notifications: notifs }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/:id/read', async (req, res) => {
    try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/read-all', async (req, res) => {
    try { await Notification.updateMany({ isRead: false }, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.get('/', async (req, res) => {
    try {
        const usersCount = await User.countDocuments(); const companiesCount = await ClientBot.countDocuments(); const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' }); const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } }); const completedTxs = await Transaction.countDocuments({ status: 'completed' });
        res.render('index', { usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs, adminName: req.session.adminName });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.get('/transactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1; const limit = 25; const search = req.query.search || ''; const statusFilter = req.query.status || ''; const fromDate = req.query.fromDate || ''; const toDate = req.query.toDate || '';
        let query = {};
        if (search) { query.$or = [{ customId: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { companyName: { $regex: search, $options: 'i' } }, { employeeName: { $regex: search, $options: 'i' } }]; }
        if (statusFilter) query.status = statusFilter;
        if (fromDate || toDate) { query.createdAt = {}; if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`); if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`); }

        const totalTxs = await Transaction.countDocuments(query); const totalPages = Math.ceil(totalTxs / limit);
        const transactions = await Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
        
        const allFilteredTxs = await Transaction.find(query);
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        allFilteredTxs.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        const executorBots = await ExecutorBot.find({ status: 'active', isManagerBot: false }); 
        const allBots = await ExecutorBot.find({}); const allBotsMap = {}; allBots.forEach(b => { allBotsMap[b._id.toString()] = b.name; });
        
        res.render('transactions', { transactions, executorBots, allBotsMap, currentPage: page, totalPages, search, statusFilter, fromDate, toDate, totals });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.get('/transactions/print', async (req, res) => {
    try {
        const search = req.query.search || ''; const statusFilter = req.query.status || ''; const fromDate = req.query.fromDate || ''; const toDate = req.query.toDate || '';
        let query = {};
        if (search) { query.$or = [{ customId: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { companyName: { $regex: search, $options: 'i' } }, { employeeName: { $regex: search, $options: 'i' } }]; }
        if (statusFilter) query.status = statusFilter;
        if (fromDate || toDate) { query.createdAt = {}; if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`); if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`); }

        const transactions = await Transaction.find(query).sort({ createdAt: -1 });
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        transactions.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        res.render('print_report', { transactions, fromDate, toDate, totals });
    } catch (e) { res.status(500).send('حدث خطأ أثناء إعداد التقرير.'); }
});

router.post('/transaction/:id/assign-executor', async (req, res) => {
    try {
        const txId = req.params.id; const executorBotId = req.body.executorBotId; const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') return res.redirect('/transactions');

        const executorBot = await ExecutorBot.findById(executorBotId);

        if (executorBot && !executorBot.isManagerBot) { 
            
            // 🤖====================================================🤖
            // 🚀 المسار الذكي: إذا كان هذا البوت آلياً (API Integration)
            // 🤖====================================================🤖
            if (executorBot.isApiBot) {
                tx.status = 'processing';
                tx.executorBotId = executorBot._id;
                tx.executorBotName = executorBot.name;
                await tx.save();

                // التخاطب مع سيرفر الشركة الخارجية
                const apiResult = await executeTransferViaApi(tx, executorBot);

                if (apiResult.success) {
                    // 1. إكمال العملية بنجاح
                    tx.status = 'completed';
                    tx.executorName = 'تنفيذ آلي (API)';
                    tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[مرجع الشركة الآلي: ${apiResult.external_transaction_id}]`;
                    await tx.save();

                    executorBot.balance -= tx.amount;
                    await executorBot.save();

                    // 2. إشعار العميل
                    const clientMsg = `✅ <b>تـم تـنـفـيـذ طـلـبـك بـنـجـاح! (تحويل آلي)</b> ⚡\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n💸 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD`;
                    let clientAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                    if (tx.clientBotId) {
                        const comp = await ClientBot.findById(tx.clientBotId);
                        if (comp) clientAPI = new Telegram(comp.token);
                    }
                    await clientAPI.sendMessage(tx.userId, clientMsg, { parse_mode: 'HTML' }).catch(()=>{});

                    // 3. 🟢 إرسال Log النجاح لـ "بوت المراقبة البشري" (إن وجد)
                    if (executorBot.parentBotId) {
                        try {
                            const monitorBot = await ExecutorBot.findById(executorBot.parentBotId);
                            if (monitorBot && monitorBot.token) {
                                const monitorAPI = new Telegram(monitorBot.token);
                                const monitorStaff = await Employee.find({ botId: monitorBot._id, status: 'active' });
                                const monitorMsg = `🟢 <b>سجل API (عملية ناجحة)</b>\n\n🤖 <b>عبر:</b> ${executorBot.name}\n🧾 <b>الطلب:</b> <code>${tx.customId}</code>\n📞 <b>الرقم:</b> <code>${tx.vodafoneNumber}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n📝 <b>المرجع:</b> <code>${apiResult.external_transaction_id}</code>`;
                                for (const staff of monitorStaff) {
                                    if(staff.telegramId) await monitorAPI.sendMessage(staff.telegramId, monitorMsg, { parse_mode: 'HTML' }).catch(()=>{});
                                }
                            }
                        } catch(e){}
                    }

                } else {
                    // 🔴 فشل الـ API -> تحويل الطلب فوراً للبشر (Human Fallback)
                    if (executorBot.parentBotId) {
                        const monitorBot = await ExecutorBot.findById(executorBot.parentBotId);
                        if (monitorBot) {
                            // تغيير مسؤولية الطلب ليكون من نصيب الفريق البشري
                            tx.executorBotId = monitorBot._id;
                            tx.managerBotId = monitorBot.parentBotId || null;
                            tx.executorBotName = monitorBot.name;
                            tx.status = 'processing';
                            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[فشل API - تم التحويل للمراقبة البشرية | السبب: ${apiResult.message}]`;
                            await tx.save();

                            const employees = await Employee.find({ botId: monitorBot._id, status: 'active' });
                            const monitorAPI = new Telegram(monitorBot.token);
                            
                            let typeLabel = '📱 فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = '📮 حساب بريد'; if(tx.transferType === 'post_card') typeLabel = '💳 بطاقة عميل';
                            let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                            
                            const fallbackMsg = `🚨 <b>تدخل بشري مطلوب! (فشل API)</b>\n\nحاول بوت (${executorBot.name}) تنفيذ العملية وفشل للسبب التالي:\n⚠️ <i>${apiResult.message}</i>\n\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🧾 <b>الطلب:</b> <code>${tx.customId}</code>`;
                            const markup = { inline_keyboard: [[{ text: '🤝 قبول المهمة وتصحيحها يدوياً', callback_data: `accept_task_${tx._id}` }]] };
                            
                            for (const emp of employees) {
                                if (emp.telegramId) {
                                    try {
                                        const sentMsg = await monitorAPI.sendMessage(emp.telegramId, fallbackMsg, { parse_mode: 'HTML', reply_markup: markup });
                                        tx.broadcastMessages.push({ telegramId: emp.telegramId, messageId: sentMsg.message_id });
                                    } catch (err) {}
                                }
                            }
                            await tx.save();
                        }
                    } else {
                        // لا يوجد فريق بشري مرتبط -> إرجاع الطلب للإدارة
                        tx.status = 'pending'; 
                        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[فشل التنفيذ الآلي: ${apiResult.message}]`;
                        tx.executorBotId = undefined;
                        tx.executorBotName = undefined;
                        await tx.save();
                    }
                }
                return res.redirect('/transactions');
            }

            // 👨‍💻====================================================👨‍💻
            // المسار الكلاسيكي: للبوت البشري العادي
            // 👨‍💻====================================================👨‍💻
            tx.executorBotId = executorBot._id; tx.managerBotId = executorBot.parentBotId || null; tx.executorBotName = executorBot.name; tx.status = 'processing'; tx.broadcastMessages = []; 

            if (tx.adminMessages && tx.adminMessages.length > 0) {
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                for (const adminMsg of tx.adminMessages) await adminAPI.deleteMessage(adminMsg.telegramId, adminMsg.messageId).catch(() => {});
                tx.adminMessages = []; 
            }

            const employees = await Employee.find({ botId: executorBot._id, status: 'active' });
            const execBotAPI = new Telegram(executorBot.token); 
            
            let typeLabel = '📱 فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = '📮 حساب بريد'; if(tx.transferType === 'post_card') typeLabel = '💳 بطاقة عميل';
            let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`; if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

            const noteDisplay = tx.notes ? `\n📝 <b>الملاحظة:</b> ${tx.notes}` : '';
            const msg = `🔔 <b>مهمة تحويل جديدة من الإدارة! (${typeLabel})</b>\n\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>${noteDisplay}`;
            
            let idUrl = null;
            if (tx.transferType === 'post_card' && tx.idCardImage) {
                try { let cToken = process.env.CLIENT_BOT_TOKEN; if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) cToken = comp.token; } const tempApi = new Telegram(cToken); idUrl = (await tempApi.getFileLink(tx.idCardImage)).href; } catch(e){}
            }

            for (const emp of employees) {
                if (emp.telegramId) {
                    try {
                        const isManager = emp.role === 'manager'; const btnText = isManager ? '🤝 قبول المهمة (كمدير)' : '🤝 قبول المهمة'; const markup = { inline_keyboard: [[{ text: btnText, callback_data: `accept_task_${tx._id}` }]] };
                        let sentMsg;
                        if (idUrl) sentMsg = await execBotAPI.sendPhoto(emp.telegramId, { url: idUrl }, { caption: msg, parse_mode: 'HTML', reply_markup: markup }).catch(() => execBotAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup }));
                        else sentMsg = await execBotAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup });

                        if (sentMsg) tx.broadcastMessages.push({ telegramId: emp.telegramId, messageId: sentMsg.message_id });
                    } catch (err) {}
                }
            }
            await tx.save();
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/pull-task', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (tx && (tx.status === 'processing' || tx.status === 'accepted')) {
            const oldBotId = tx.executorBotId; const oldOperatorId = tx.operatorId; const displayId = tx.customId || tx._id.toString(); const oldBroadcasts = tx.broadcastMessages || [];

            tx.status = 'pending'; tx.executorBotId = undefined; tx.managerBotId = undefined; tx.executorBotName = undefined; tx.executorName = '---'; tx.operatorId = undefined; tx.broadcastMessages = []; tx.adminMessages = []; tx.emergencyAlert = undefined; 

            if (oldBotId) {
                try {
                    const execBot = await ExecutorBot.findById(oldBotId);
                    if (execBot) {
                        const execAPI = new Telegram(execBot.token);
                        if (oldOperatorId) await execAPI.sendMessage(oldOperatorId, `⚠️ <b>تنبيه من الإدارة العليا:</b>\nتم سحب الطلب رقم <code>${displayId}</code> منك وإعادته للإدارة!`, { parse_mode: 'HTML' }).catch(()=>{});
                        for (const bMsg of oldBroadcasts) await execAPI.deleteMessage(bMsg.telegramId, bMsg.messageId).catch(()=>{});
                    }
                } catch (err) {}
            }

            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN); const allAdmins = await Admin.find({});
            let typeLabel = 'فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = 'حساب بريد'; if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';
            const source = tx.companyName ? `🏢 الشركة: ${tx.companyName}\n👤 الموظف: ${tx.employeeName}` : `👤 العميل: ${tx.employeeName || 'فردي'}`;
            let accDetails = `📞 المحفظة/الرقم: <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>`; if (tx.accountName) accDetails += `\n👤 الاسم: ${tx.accountName}`;

            const msgText = `🔄 <b>تم سحب الطلب للإدارة (${typeLabel}):</b>\n${source}\n${accDetails}\n💵 المبلغ: ${tx.amount} EGP\n💰 التكلفة: ${tx.costLYD} LYD\n🧾 رقم الطلب: <code>${displayId}</code>`;
            const keyboard = { inline_keyboard: [[{ text: '🤖 تحويل لبوت تنفيذي', callback_data: `forward_${tx._id}` }], [{ text: '❌ إلغاء العملية', callback_data: `cancelReq_${tx._id}` }]]};

            let idUrl = null;
            if (tx.transferType === 'post_card' && tx.idCardImage) {
                try { let cToken = process.env.CLIENT_BOT_TOKEN; if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) cToken = comp.token; } const tempApi = new Telegram(cToken); idUrl = (await tempApi.getFileLink(tx.idCardImage)).href; } catch(e){}
            }

            for (const admin of allAdmins) {
                if (admin.telegramId) {
                    let sentAdminMsg;
                    try {
                        if (idUrl) sentAdminMsg = await adminAPI.sendPhoto(admin.telegramId, { url: idUrl }, { caption: msgText, parse_mode: 'HTML', reply_markup: keyboard });
                        else sentAdminMsg = await adminAPI.sendMessage(admin.telegramId, msgText, { parse_mode: 'HTML', reply_markup: keyboard });
                        if (sentAdminMsg) tx.adminMessages.push({ telegramId: admin.telegramId, messageId: sentAdminMsg.message_id });
                    } catch(e) {}
                }
            }
            await tx.save();
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/emergency-alert', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx || !['processing', 'accepted'].includes(tx.status)) { return res.redirect('/transactions'); }
        const alertMsg = req.body.alertMessage || `تنبيه عاجل من الإدارة للطلب رقم ${tx.customId || tx._id}! يرجى سرعة التنفيذ!`;
        await Transaction.updateOne({ _id: tx._id }, { $set: { emergencyAlert: alertMsg } }, { strict: false });

        if (tx.executorBotId) {
            const execBot = await ExecutorBot.findById(tx.executorBotId);
            if (execBot) {
                const execAPI = new Telegram(execBot.token); const displayId = tx.customId || tx._id.toString();
                const teleMsg = `🚨🚨 <b>تـنـبـيـه طـارئ مـن الإدارة الـعـلـيـا (موقع الإدارة)</b> 🚨🚨\n\nالرجاء الإسراع في تنفيذ الطلب رقم <code>${displayId}</code> فوراً!\n\n💬 رسالة الإدارة: <b>${alertMsg}</b>`;
                if (tx.status === 'accepted' && tx.operatorId) execAPI.sendMessage(tx.operatorId, teleMsg, { parse_mode: 'HTML' }).catch(()=>{});
                else if (tx.status === 'processing') { const operators = await Employee.find({ botId: execBot._id, status: 'active' }); for (const op of operators) execAPI.sendMessage(op.telegramId, teleMsg, { parse_mode: 'HTML' }).catch(()=>{}); }
            }
        }
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/accept-deposit-web', async (req, res) => {
    try {
        const { imageBase64 } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.json({success: false, error: 'الطلب غير متاح'});

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, ""); const imageBuffer = Buffer.from(base64Data, 'base64');
        const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN); let fileId = null;
        try { const sentMsg = await adminAPI.sendPhoto(process.env.ADMIN_TELEGRAM_ID, { source: imageBuffer }, { caption: `✅ إيصال إيداع (مقبول) للطلب ${tx.customId}` }); fileId = sentMsg.photo[sentMsg.photo.length - 1].file_id; } catch(err) { return res.json({success: false, error: 'حدث خطأ أثناء رفع الصورة لتيليجرام'}); }

        tx.status = 'deposit'; tx.proofImage = fileId; tx.updatedAt = new Date();
        const execBot = await ExecutorBot.findById(tx.executorBotId);
        if (execBot) { const execAPI = new Telegram(execBot.token); await execAPI.sendPhoto(tx.operatorId, fileId, { caption: `✅ <b>تمت الموافقة على طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP`, parse_mode: 'HTML' }).catch(()=>{}); }
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع بقيمة ${tx.amount} EGP وتمت إضافة الرصيد لحسابك بنجاح.`, imageUrl: `/proxy/image/${tx._id}/0` } } }, { strict: false });
        await tx.save(); if (tx.executorBotId) await syncBotBalance(tx.executorBotId); 
        res.json({success: true});
    } catch(e) { res.json({success: false, error: e.message}); }
});

router.post('/transaction/:id/reject-deposit-web', async (req, res) => {
    try {
        const { reason } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.redirect('/transactions');

        tx.status = 'rejected'; tx.notes = `سبب الرفض: ${reason}`; tx.updatedAt = new Date();
        const execBot = await ExecutorBot.findById(tx.executorBotId);
        if (execBot) { const execAPI = new Telegram(execBot.token); await execAPI.sendMessage(tx.operatorId, `❌ <b>تم رفض طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP\nالسبب: ${reason}`, { parse_mode: 'HTML' }).catch(()=>{}); }
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'error', text: `تم رفض طلب الإيداع بقيمة ${tx.amount} EGP.<br><b>السبب:</b> ${reason}` } } }, { strict: false });
        await tx.save(); res.redirect('/transactions');
    } catch(e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-rate', async (req, res) => {
    try {
        const txId = req.params.id; const newRate = parseFloat(req.body.newRate);
        if (isNaN(newRate) || newRate <= 0) return res.redirect('/transactions');
        const tx = await Transaction.findById(txId);
        if (!tx || ['rejected', 'cancelled_by_admin'].includes(tx.status)) return res.redirect('/transactions');

        const oldCost = tx.costLYD || 0; const newCost = tx.amount / newRate; const diff = newCost - oldCost; 
        if (tx.clientBotId) { const company = await ClientBot.findById(tx.clientBotId); if (company) { company.balance -= diff; await company.save(); } } 
        else if (tx.userId) { const user = await User.findOne({ telegramId: tx.userId }); if (user) { user.balance -= diff; await user.save(); } }

        const adminName = req.session.adminName || 'الإدارة';
        tx.costLYD = newCost; const oldRate = oldCost > 0 ? (tx.amount / oldCost).toFixed(3) : '0';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل السعر من ${oldRate} إلى ${newRate} بواسطة: ${adminName}]`;
        await tx.save(); res.redirect('/transactions'); 
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-data', async (req, res) => {
    try {
        const txId = req.params.id; const newAmount = parseFloat(req.body.newAmount); const newDateStr = req.body.newDate;
        if (isNaN(newAmount) || newAmount <= 0 || !newDateStr) return res.redirect('/transactions');
        const tx = await Transaction.findById(req.params.id);
        if (!tx || ['rejected', 'cancelled_by_admin'].includes(tx.status)) return res.redirect('/transactions');

        const oldAmountEGP = tx.amount; const newDate = new Date(newDateStr); const adminName = req.session.adminName || 'الإدارة';

        if (tx.status === 'deposit' || tx.status === 'deduction') {
            const diffAmount = newAmount - oldAmountEGP; const diffDeposit = (tx.status === 'deposit') ? diffAmount : -diffAmount;
            if (tx.userId === 'admin' && tx.executorBotId) {
                const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل (المبلغ: ${newAmount}، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`;
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, createdAt: newDate, updatedAt: newDate, notes: newNotes } }, { timestamps: false });
                await syncBotBalance(tx.executorBotId); if (tx.managerBotId) await syncBotBalance(tx.managerBotId);
            } else {
                if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) { comp.balance += diffDeposit; await comp.save(); } } 
                else if (tx.userId) { const user = await User.findOne({ telegramId: tx.userId }); if (user) { user.balance += diffDeposit; await user.save(); } }
                const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل (المبلغ: ${newAmount}، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`;
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, createdAt: newDate, updatedAt: newDate, notes: newNotes } }, { timestamps: false });
            }
        } else {
            const oldCostLYD = tx.costLYD; const newCostLYD = parseFloat((newAmount / tx.exchangeRate).toFixed(3));
            const diffEGP = newAmount - oldAmountEGP; const diffLYD = newCostLYD - oldCostLYD;

            if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) { comp.balance -= diffLYD; await comp.save(); } } 
            else if (tx.userId) { const user = await User.findOne({ telegramId: tx.userId }); if (user) { user.balance -= diffLYD; await user.save(); } }

            if (tx.status === 'completed' && tx.executorBotId) {
                const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot) { execBot.balance -= diffEGP; await execBot.save(); }
                if (tx.managerBotId) { const mgrBot = await ExecutorBot.findById(tx.managerBotId); if (mgrBot) { mgrBot.balance -= diffEGP; await mgrBot.save(); } }
            }

            const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل (المبلغ: ${newAmount}EGP، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`;
            await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, costLYD: newCostLYD, createdAt: newDate, updatedAt: newDate, notes: newNotes } }, { timestamps: false });

            if (['processing', 'accepted'].includes(tx.status) && tx.executorBotId) {
                try {
                    const execBot = await ExecutorBot.findById(tx.executorBotId);
                    if (execBot) {
                        const execAPI = new Telegram(execBot.token);
                        const alertMsg = `⚠️ <b>تنبيه من الإدارة:</b>\nتم تعديل بيانات الحوالة للطلب <code>${tx.customId}</code>\nالمبلغ القديم: <b>${oldAmountEGP} EGP</b>\nالمبلغ الجديد: <b>${newAmount} EGP</b>\nالرجاء الانتباه!`;
                        if (tx.status === 'accepted' && tx.operatorId) await execAPI.sendMessage(tx.operatorId, alertMsg, { parse_mode: 'HTML' }).catch(()=>{});
                        else if (tx.status === 'processing' && tx.broadcastMessages) for (const msg of tx.broadcastMessages) await execAPI.sendMessage(msg.telegramId, alertMsg, { parse_mode: 'HTML' }).catch(()=>{});
                    }
                } catch(e) {}
            }
        }
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/global-cancel', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (tx) {
            if (tx.status === 'completed' || tx.status === 'processing' || tx.status === 'accepted' || tx.status === 'pending') {
                if (tx.clientBotId) await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: tx.costLYD || 0 } });
                else if (tx.userId) await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.costLYD || 0 } });
            }
            const botId = tx.executorBotId; const managerBotId = tx.managerBotId;
            await Transaction.findByIdAndDelete(tx._id);
            if(botId) await syncBotBalance(botId); if(managerBotId) await syncBotBalance(managerBotId); 
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/change-bot', async (req, res) => {
    try {
        const txId = req.params.id; const newBotId = req.body.newBotId;
        if (!newBotId) return res.redirect('/transactions');
        const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'completed') return res.redirect('/transactions');
        if (tx.executorBotId && tx.executorBotId.toString() === newBotId.toString()) return res.redirect('/transactions');

        if (tx.executorBotId) { const oldBot = await ExecutorBot.findById(tx.executorBotId); if (oldBot) { oldBot.balance += tx.amount; await oldBot.save(); } }
        if (tx.managerBotId) { const oldManager = await ExecutorBot.findById(tx.managerBotId); if (oldManager) { oldManager.balance += tx.amount; await oldManager.save(); } }

        const newBot = await ExecutorBot.findById(newBotId); let newManagerId = null;
        if (newBot) {
            newBot.balance -= tx.amount; await newBot.save();
            if (newBot.parentBotId) { const newManager = await ExecutorBot.findById(newBot.parentBotId); if (newManager) { newManager.balance -= tx.amount; await newManager.save(); newManagerId = newManager._id; } }
        }

        tx.executorBotId = newBotId; tx.managerBotId = newManagerId; tx.executorBotName = newBot ? newBot.name : 'غير محدد';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم النقل محاسبياً إلى بوت: ${newBot ? newBot.name : 'غير معروف'}]`;
        await tx.save(); res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

module.exports = router;