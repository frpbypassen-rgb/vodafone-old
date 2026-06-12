// routes/api/clientApi.js
const express = require('express');
const router = express.Router();
const { Telegram } = require('telegraf');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');

const Transaction = require('../../models/Transaction');
const Admin = require('../../models/Admin');
const User = require('../../models/User');
const ClientBot = require('../../models/ClientBot');
const ClientEmployee = require('../../models/ClientEmployee');
const Settings = require('../../models/Settings');
const ExecutorBot = require('../../models/ExecutorBot');
const SupportTicket = require('../../models/SupportTicket');
const Counter = require('../../models/Counter');
const Ledger = require('../../models/Ledger');
const { updateClientTracking } = require('../../services/clientTrackingService');
const { buildClientInvoiceSheet } = require('../../utils/excelGenerator'); 
const { processAutoRoute } = require('../../services/autoRouter'); // 🚀 استدعاء محرك التوجيه التلقائي

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_API_KEY) throw new Error('FATAL ERROR: INTERNAL_API_KEY is missing in .env!');

router.use((req, res, next) => {
    if ((req.headers['x-api-key'] || req.body.apiKey) !== INTERNAL_API_KEY) {
        console.warn(`[Security Alert] محاولة وصول غير مصرحة للـ API من IP: ${req.ip}`);
        return res.status(403).json({ success: false, error: 'Unauthorized API Access' });
    }
    next();
});

router.get('/active-bots', async (req, res) => {
    try { res.json({ success: true, bots: await ClientBot.find({ status: 'active' }).lean() }); } 
    catch(e) { res.json({ success: false }); }
});

router.post('/dashboard-data', async (req, res) => {
    try {
        const { telegramId, isMainBot, botId } = req.body;
        let acc, bal = 0, name = '', phone = '', tier = 1, joinDate;
        const set = await Settings.findOne({}).lean() || {};
        if (isMainBot) {
            acc = await User.findOne({ telegramId }).lean();
            if (!acc) return res.json({ success: false, error: 'غير مسجل' });
            name = acc.name; phone = acc.phone; bal = acc.balance; tier = acc.tier || 1; joinDate = acc.createdAt;
        } else {
            acc = await ClientEmployee.findOne({ telegramId, clientBotId: botId }).lean();
            if (!acc) return res.json({ success: false, error: 'غير مسجل' });
            const comp = await ClientBot.findById(botId).lean();
            name = acc.name; phone = acc.phone; bal = comp ? comp.balance : 0; tier = comp?.tier || 1; joinDate = acc.createdAt;
        }
        const currentRate = tier === 3 ? set.rateLevel3 : (tier === 2 ? set.rateLevel2 : set.rateLevel1);
        const filter = isMainBot ? { userId: telegramId, clientBotId: null } : { clientBotId: botId };
        const totalTxs = await Transaction.aggregate([{ $match: { ...filter, status: 'completed' } }, { $group: { _id: null, total: { $sum: "$costLYD" } } }]);
        const pendingTxs = await Transaction.find({ ...filter, status: { $in: ['pending', 'processing', 'accepted'] } }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, account: { name, phone, telegramId, joinDate: new Date(joinDate).toLocaleDateString('en-GB'), balance: bal, currentRate: currentRate || 6.4, totalTransferred: totalTxs.length ? totalTxs[0].total.toFixed(2) : "0.00", status: acc.status }, settings: { supportContact: set.supportContact || '@AhramSupport', welcomeMsg: set.welcomeMessage || 'مرحباً بك' }, pendingTxs });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/transfer-info', async (req, res) => {
    try {
        const { telegramId, isMainBot, botId } = req.body;
        const set = await Settings.findOne({}).lean() || {};
        let tier = 1, balance = 0, limit = 0, name = '';
        if (isMainBot) {
            const u = await User.findOne({ telegramId }).lean();
            if(u) { tier = u.tier||1; balance = u.balance; limit = u.creditLimit||0; name = u.name; }
        } else {
            const c = await ClientBot.findById(botId).lean();
            if(c) { tier = c.tier||1; balance = c.balance; limit = c.creditLimit||0; }
            const e = await ClientEmployee.findOne({ telegramId, clientBotId: botId }).lean();
            if(e) name = e.name;
        }
        let rate = set.rateLevel1 || 6.4; if(tier===2) rate=set.rateLevel2||6.45; if(tier===3) rate=set.rateLevel3||6.5;
        res.json({ success: true, isManualClosed: set.isManualClosed, openingTime: set.openingTime, closingTime: set.closingTime, closedMessage: set.closedMessage, termsMessage: set.termsMessage, exchangeRate: rate, availableFunds: balance + limit, employeeName: name });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/submit-transfer', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { telegramId, isMainBot, botId, amountEGP, amountLYD, exchangeRate, vodafoneNumber, transferNote, employeeName, transferType } = req.body;
        const filter = isMainBot ? { userId: telegramId, clientBotId: null } : { clientBotId: botId }; filter.vodafoneNumber = vodafoneNumber;
        
        const lastTx = await Transaction.findOne(filter).sort({ createdAt: -1 }).session(session);
        if (lastTx) {
            const diff = (Date.now() - new Date(lastTx.createdAt).getTime()) / 1000;
            if (lastTx.amount === amountEGP && diff < 300) { await session.abortTransaction(); session.endSession(); return res.json({ success: false, spam: true, waitTime: Math.ceil(300-diff), message: 'لقد قمت بإرسال نفس الحوالة مؤخراً' }); }
            if (diff < 60) { await session.abortTransaction(); session.endSession(); return res.json({ success: false, spam: true, waitTime: Math.ceil(60-diff), message: 'طلب سريع جداً.' }); }
        }
        
        const TargetModel = isMainBot ? User : ClientBot;
        const targetFilter = isMainBot ? { telegramId } : { _id: botId };
        const doc = await TargetModel.findOne(targetFilter).session(session);
        if (!doc) throw new Error('NOT_FOUND');
        
        const minReq = amountLYD - (doc.creditLimit || 0);
        const updated = await TargetModel.findOneAndUpdate({ ...targetFilter, balance: { $gte: minReq } }, { $inc: { balance: -amountLYD } }, { new: true, session });
        if (!updated) throw new Error('NO_BALANCE');
        
        const counter = await Counter.findOneAndUpdate({ name: 'transaction' }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
        const customId = `ATT-${new Date().getFullYear().toString().slice(-2)}${(new Date().getMonth()+1).toString().padStart(2,'0')}-${counter.value.toString().padStart(4,'0')}`;
        
        let cName = 'عميل فردي', cToken = process.env.CLIENT_BOT_TOKEN;
        if (!isMainBot) { const c = await TargetModel.findById(botId).session(session); if (c) { cName = c.name; cToken = c.token; } }
        
        const txArr = await Transaction.create([{ userId: telegramId, clientBotId: isMainBot?null:botId, amount: amountEGP, costLYD: amountLYD, exchangeRate, vodafoneNumber, notes: transferNote, status: 'pending', customId, companyName: cName, employeeName, transferType }], { session });
        
        if(Ledger) await new Ledger({ entityId: updated._id, entityModel: TargetModel.modelName, transactionId: customId, type: 'TRANSFER', amount: -amountLYD, balanceBefore: updated.balance+amountLYD, balanceAfter: updated.balance, description: `تحويل ${amountEGP} EGP`}).save({session});
        
        await session.commitTransaction(); session.endSession();

        setImmediate(async () => {
            await updateClientTracking(txArr[0]._id, 'sent_to_admin');
            
            // إشعار موظفي الشركة بإنشاء الطلب
            if(!isMainBot){
                const api = new Telegram(cToken);
                const cols = await ClientEmployee.find({ clientBotId: botId, status: 'active', telegramId: { $ne: telegramId } }).lean();
                cols.forEach(c => api.sendMessage(c.telegramId, `📢 <b>إشعار للشركة: تم إرسال طلب جديد</b>\nالموظف: ${employeeName}\nالطلب: <code>${customId}</code>\nالمبلغ: ${amountEGP} EGP`, {parse_mode:'HTML'}).catch(()=>{}));
            }

            // 🚀 تشغيل محرك التوجيه التلقائي
            const isRouted = await processAutoRoute(txArr[0]._id);

            // إذا لم يتوجه تلقائياً (الميزة معطلة)، نقوم بإشعار الإدارة كالمعتاد
            if (!isRouted) {
                const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const adMsg = `🔔 <b>طلب تحويل جديد (API)!</b>\n${isMainBot?`👤 عميل: ${employeeName}`:`🏢 الشركة: ${cName}\n👨‍💻 الموظف: ${employeeName}`}\n📞 الرقم: <code>${vodafoneNumber}</code>\n🇪🇬 المبلغ: ${amountEGP} EGP\n🇱🇾 الدفع: ${amountLYD.toFixed(2)} LYD\n🧾 الطلب: <code>${customId}</code>`;
                const kb = { inline_keyboard: [[{text: '🤖 تحويل لبوت تنفيذي', callback_data: `forward_${txArr[0]._id}`}], [{text: '❌ إلغاء العملية', callback_data: `cancelReq_${txArr[0]._id}`}]] };
                const admins = await Admin.find({}).lean();
                let sMsgs = [];
                for (const ad of admins) if (ad.telegramId) { try { const sent = await aApi.sendMessage(ad.telegramId, adMsg, {parse_mode:'HTML', reply_markup: kb}); if(sent) sMsgs.push({telegramId:ad.telegramId, messageId:sent.message_id}); }catch(e){} }
                if(sMsgs.length) await Transaction.findByIdAndUpdate(txArr[0]._id, { adminMessages: sMsgs });
            }
        });
        res.json({ success: true, customId });
    } catch (e) {
        await session.abortTransaction(); session.endSession();
        if(e.message === 'NOT_FOUND') return res.json({ success: false, error: 'الحساب غير موجود.' });
        if(e.message === 'NO_BALANCE') return res.json({ success: false, error: 'الرصيد المتاح لا يكفي.' });
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/generate-excel', async (req, res) => {
    try {
        const { telegramId, isMainBot, botId, type, botToken } = req.body;
        let tName='', tPhone='', filter={}, bal=0;
        if(isMainBot){
            const u = await User.findOne({telegramId}).lean(); if(!u||u.status!=='active') return res.json({success:false, error:'غير مفعل'});
            tName=u.name; tPhone=u.phone; filter={userId:telegramId, clientBotId:null}; bal=u.balance;
        } else {
            const e = await ClientEmployee.findOne({telegramId, clientBotId:botId}).lean(); if(!e||e.status!=='active') return res.json({success:false, error:'غير مصرح'});
            const c = await ClientBot.findById(botId).lean(); tName=c.name; tPhone=c.phone; filter={clientBotId:botId}; bal=c.balance;
        }
        const now = new Date(); let start, end, dLabel;
        if(type==='daily'){ start=new Date(now); start.setHours(0,0,0,0); end=new Date(now); end.setHours(23,59,59,999); dLabel=start.toLocaleDateString('en-GB'); }
        else { start=new Date(now.getFullYear(),now.getMonth(),1); end=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59,999); dLabel=`شهر ${now.getMonth()+1}-${now.getFullYear()}`; }
        
        const txs = await Transaction.find({...filter, status:'completed', updatedAt:{$gte:start,$lte:end}}).sort({updatedAt:1}).lean();
        const deposits = await Transaction.find({...filter, status:'deposit', updatedAt:{$gte:start,$lte:end}}).lean();
        if(!txs.length && !deposits.length) return res.json({success:true, isEmpty:true});
        
        const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('كشف حساب');
        buildClientInvoiceSheet(sheet, tName, tPhone, dLabel, txs, deposits, bal);
        
        const buf = await wb.xlsx.writeBuffer();
        
        setImmediate(async () => {
            try { const api = new Telegram(botToken); await api.sendDocument(telegramId, { source: Buffer.from(buf), filename:`Account_${dLabel.replace(/\//g,'-')}.xlsx`}, {caption:`📊 كشف ${type==='daily'?'يومي':'شهري'}\nالجهة: ${tName}`}); }catch(e){}
        });
        res.json({success:true, isEmpty:false});
    } catch(e) { res.status(500).json({success:false, error:e.message}); }
});

router.post('/activate-web', async (req, res) => {
    try {
        const { telegramId, isMainBot, botId, username, password } = req.body;
        const M = isMainBot ? User : ClientEmployee;
        const f = isMainBot ? { telegramId } : { telegramId, clientBotId: botId };
        const acc = await M.findOne(f); if(!acc) return res.json({success:false, error:'غير مسجل.'});
        const uE = await User.findOne({webUsername: username}).lean();
        const eE = await ClientEmployee.findOne({webUsername: username}).lean();
        if ((uE && uE.telegramId !== telegramId) || (eE && eE.telegramId !== telegramId)) return res.json({success:false, error:'الاسم محجوز.'});
        acc.webUsername = username; acc.webPassword = password; await acc.save();
        res.json({success:true});
    } catch(e) { res.status(500).json({success:false}); }
});

router.post('/remind-admin', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.body.txId).lean();
        if(!tx || ['completed','rejected'].includes(tx.status)) return res.json({success:false, msg:'العملية ليست معلقة.'});
        const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN);
        const msg = `🔔 <b>تذكير من عميل!</b>\nالطلب: <code>${tx.customId}</code>\nالمبلغ: ${tx.amount} EGP\nالعميل يطلب استعجال التنفيذ.`;
        const admins = await Admin.find({}).lean();
        for(const ad of admins) if(ad.telegramId) aApi.sendMessage(ad.telegramId, msg, {parse_mode:'HTML'}).catch(()=>{});
        res.json({success:true});
    } catch(e) { res.status(500).json({success:false}); }
});

router.post('/complaint/list-txs', async(req,res) => { res.json({success:true, txs: await Transaction.find({userId:req.body.telegramId, status:'completed'}).sort({updatedAt:-1}).limit(10).lean()}); });
router.post('/complaint/search-tx', async(req,res) => { const tx = await Transaction.findOne({$or:[{customId:req.body.searchId}], userId:req.body.telegramId, status:'completed'}).lean(); res.json({success: !!tx, txId: tx?._id}); });
router.post('/complaint/submit', async(req,res) => {
    const { txId, complaintReason } = req.body; const tx = await Transaction.findById(txId); if(!tx) return res.json({success:false});
    tx.complaintText = complaintReason; await tx.save();
    setImmediate(async () => {
        const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN); const msg = `🚨 شكوى جديدة!\nالطلب: ${tx.customId}\nالسبب: ${complaintReason}`;
        const admins = await Admin.find({}).lean(); for(const ad of admins) if(ad.telegramId) aApi.sendMessage(ad.telegramId, msg).catch(()=>{});
    }); res.json({success:true});
});
router.post('/request-phone/submit', async(req,res) => {
    const tx = await Transaction.findById(req.body.txId); if(!tx) return res.json({success:false});
    setImmediate(async () => {
        const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN); const admins = await Admin.find({}).lean();
        for(const ad of admins) if(ad.telegramId) aApi.sendMessage(ad.telegramId, `📞 العميل يطلب رقم منفذ الطلب: ${tx.customId}`).catch(()=>{});
        if(tx.executorBotId && tx.operatorId) { const eB = await ExecutorBot.findById(tx.executorBotId).lean(); if(eB) new Telegram(eB.token).sendMessage(tx.operatorId, `العميل يطلب الرقم المحول منه للطلب ${tx.customId}`, {reply_markup:{inline_keyboard:[[{text:'إرفاق رقم', callback_data:`providePhone_${tx._id}`}]]}}).catch(()=>{}); }
    }); res.json({success:true});
});
router.post('/support/submit', async(req,res) => {
    const {telegramId, isMainBot, botId, text, imageUrl} = req.body;
    let name = 'عميل'; if(isMainBot) { const u=await User.findOne({telegramId}).lean(); if(u)name=u.name; } else { const e=await ClientEmployee.findOne({telegramId, clientBotId:botId}).lean(); if(e)name=e.name; }
    let t = await SupportTicket.findOne({telegramId, status:{$ne:'closed'}});
    if(!t) t = new SupportTicket({entityType:isMainBot?'client_user':'client_company', telegramId, name, messages:[]});
    t.messages.push({sender:'user', text:text||'صورة', imageUrl}); t.status='open'; await t.save();
    setImmediate(async () => { const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN); const admins = await Admin.find({}).lean(); for(const ad of admins) if(ad.telegramId) aApi.sendMessage(ad.telegramId, `🚨 دعم فني من ${name}:\n${text||'صورة'}`).catch(()=>{}); });
    res.json({success:true});
});
router.post('/register', async(req,res) => {
    const {telegramId, name, phone, isMainBot, botId} = req.body;
    if(isMainBot) await User.findOneAndUpdate({telegramId}, {name, phone, status:'pending'}, {upsert:true});
    else await ClientEmployee.findOneAndUpdate({telegramId, clientBotId:botId}, {name, phone, status:'pending'}, {upsert:true});
    setImmediate(async () => { const aApi = new Telegram(process.env.ADMIN_BOT_TOKEN); const admins = await Admin.find({}).lean(); for(const ad of admins) if(ad.telegramId) aApi.sendMessage(ad.telegramId, `🔔 تسجيل جديد: ${name} - ${phone}`).catch(()=>{}); });
    res.json({success:true});
});

module.exports = router;