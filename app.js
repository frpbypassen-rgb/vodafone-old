require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
const https = require('https'); 
const http = require('http'); // 🟢 للإقلاع مع الـ Sockets
const { Server } = require('socket.io'); // 🟢 خادم الزمن الفعلي
const rateLimit = require('express-rate-limit'); // 🟢 جدار الحماية
const helmet = require('helmet'); // 🟢 حماية الهيدرز
const axios = require('axios'); 
const { Telegram } = require('telegraf');
const ExcelJS = require('exceljs'); 
const puppeteer = require('puppeteer'); 
const cors = require('cors');
const multer = require('multer');

// 🟢 إعداد رفع الملفات في الذاكرة
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

const connectDB = require('./config/database');
const { requireAuth, requireMaster } = require('./middlewares/auth');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

// 🟢 استدعاء طابور المهام الجديد (Queue System)
const apiTransferQueue = require('./services/queueService');
const { recordBalanceAdjustment, parseSignedAmount } = require('./services/balanceAdjustmentService');

const app = express();

// ==========================================
// 🛡️ درع حماية السيرفر من الانهيار
// ==========================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [تخطي خطأ في الخلفية - Unhandled Rejection]:', reason.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('🚨 [تخطي خطأ حرج - Uncaught Exception]:', err.message);
});

app.set('trust proxy', 1); 

const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: '*' } }); 

// ==========================================
// 🛡️ التحديث المعماري للزمن الفعلي (Mongoose Global Plugin)
// تم إزالة تعديل Prototype الخطير لضمان سلامة الذاكرة (No Memory Leaks)
// ==========================================
mongoose.plugin((schema) => {
    const triggerUpdate = () => { io.emit('update_data'); };
    schema.post('save', triggerUpdate);
    schema.post('findOneAndUpdate', triggerUpdate);
    schema.post('updateOne', triggerUpdate);
    schema.post('updateMany', triggerUpdate);
    schema.post('findOneAndDelete', triggerUpdate);
    schema.post('deleteMany', triggerUpdate);
});

// استدعاء النماذج
const User = require('./models/User');
const ClientBot = require('./models/ClientBot');
const ExecutorBot = require('./models/ExecutorBot');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');
const Employee = require('./models/Employee');
const ClientEmployee = require('./models/ClientEmployee');
const Admin = require('./models/Admin');
const Notification = require('./models/Notification');
const SupportTicket = require('./models/SupportTicket');
const Card = require('./models/Card');
const StoreCategory = require('./models/StoreCategory');
const StoreProduct = require('./models/StoreProduct');

const startAdminBot = require('./bots/admin/index');
const { startAllClientBots } = require('./bots/client/manager');
const { startAllExecutorBots, sendDailyAutoClosing } = require('./bots/executor/manager');
const { generateMasterClientReport, generateMasterExecutorReport } = require('./utils/masterReports');

// ==========================================
// 🛡️ الحماية وتأمين السيرفر
// ==========================================
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false })); 
app.use(cors());

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 300, 
    message: { error: 'تم حظر الـ IP مؤقتاً لتجاوز الحد الأقصى للطلبات.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', apiLimiter);
app.use('/client/api', apiLimiter);
app.use('/executor-portal/api', apiLimiter);
app.use('/login', apiLimiter); 

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 🟢 إدارة الجلسات
let sessionStore;
try {
    const ConnectMongo = require('connect-mongo');
    if (typeof ConnectMongo === 'function') {
        const MongoStore = ConnectMongo(session);
        sessionStore = new MongoStore({ url: process.env.MONGO_URI, ttl: 24 * 60 * 60 });
    } else {
        sessionStore = ConnectMongo.create({ mongoUrl: process.env.MONGO_URI, ttl: 24 * 60 * 60 });
    }
} catch (error) {
    console.warn("⚠️ تحذير: تعذر تحميل مكتبة connect-mongo.");
    sessionStore = new session.MemoryStore();
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'ahram-super-secret-key-2026',
    resave: false, 
    saveUninitialized: false, 
    store: sessionStore, 
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    res.locals.adminName = req.session.adminName || 'مدير';
    res.locals.role = req.session.role || null;
    next();
});

const syncBotBalance = async (botId) => {
    const bot = await ExecutorBot.findById(botId);
    if (!bot) return 0;
    
    let queryFilter = {};
    if (bot.isManagerBot) {
        queryFilter = { $or: [{ managerBotId: bot._id, status: 'completed' }, { executorBotId: bot._id, status: { $in: ['deposit', 'deduction'] } }] };
    } else {
        queryFilter = { executorBotId: bot._id, status: { $in: ['completed', 'deposit', 'deduction'] } };
    }

    const txs = await Transaction.find(queryFilter);
    let computedBalance = 0;
    txs.forEach(t => {
        if (t.status === 'completed') computedBalance -= t.amount; 
        else if (t.status === 'deposit') computedBalance += t.amount; 
        else if (t.status === 'deduction') computedBalance -= Math.abs(t.amount); 
    });

    bot.balance = computedBalance;
    await bot.save();
    return computedBalance;
};

// ==========================================
// 🔗 ربط المسارات المنفصلة
// ==========================================
app.use('/client', require('./routes/clientPortal'));
app.use('/executor-portal', require('./routes/executorPortal'));
app.use('/api/mobile', require('./routes/mobileApi'));
app.use('/store-manager', require('./routes/store'));

app.get('/login', (req, res) => {
    if (req.session.isLoggedIn) return res.redirect('/');
    res.render('login', { error: null }); 
});

app.post('/login', async (req, res) => {
    const adminUser = process.env.PANEL_USER || 'admin';
    const adminPass = process.env.PANEL_PASS || '123456';
    const { username, password } = req.body;

    if (username === adminUser && password === adminPass) {
        req.session.isLoggedIn = true;
        req.session.adminName = 'المدير الأساسي';
        req.session.role = 'master'; 
        return res.redirect('/');
    }

    try {
        const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');
        const adminData = await Admin.findOne({ webUsername: usernameRegex, webPassword: password }).lean();
        if (adminData) {
            req.session.isLoggedIn = true;
            req.session.adminName = adminData.name;
            req.session.role = adminData.role || 'admin'; 
            return res.redirect('/');
        }
    } catch(e) {}
    res.render('login', { error: 'بيانات الدخول غير صحيحة!' });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireAuth, async (req, res) => {
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

app.get('/api/notifications/unread', requireAuth, async (req, res) => {
    try { const notifs = await Notification.find({ isRead: false }).sort({ createdAt: -1 }); res.json({ count: notifs.length, notifications: notifs }); } catch (e) { res.status(500).json({ error: true }); }
});
app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});
app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    try { await Notification.updateMany({ isRead: false }, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

app.get('/', requireAuth, async (req, res) => {
    try {
        const usersCount = await User.countDocuments(); const companiesCount = await ClientBot.countDocuments(); const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' }); const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } }); const completedTxs = await Transaction.countDocuments({ status: 'completed' });
        res.render('index', { usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs, adminName: req.session.adminName });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

const renderHtmlPromisified = (appInstance, view, data) => {
    return new Promise((resolve, reject) => {
        appInstance.render(view, data, (err, html) => { if (err) reject(err); else resolve(html); });
    });
};

const sendBulkReportsInBg = async (periodType, dateValue, appReq) => {
    let browser; 
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        let start, end, dateLabel;
        if (periodType === 'daily') {
            start = new Date(`${dateValue}T00:00:00.000Z`); end = new Date(`${dateValue}T23:59:59.999Z`); dateLabel = `يوم ${dateValue}`;
        } else {
            const [year, month] = dateValue.split('-'); start = new Date(year, parseInt(month) - 1, 1); end = new Date(year, parseInt(month), 0, 23, 59, 59, 999); dateLabel = `شهر ${month}-${year}`;
        }

        const processEntity = async (type, entityId, targetObj, botToken, employees) => {
            try {
                let query = { status: { $in: ['completed', 'deposit', 'deduction'] }, updatedAt: { $gte: start, $lte: end } };
                let queryBefore = { status: { $in: ['completed', 'deposit', 'deduction'] }, updatedAt: { $lt: start } };

                if (type === 'client') { query.clientBotId = entityId; queryBefore.clientBotId = entityId; } 
                else if (type === 'executor') { query.executorBotId = entityId; queryBefore.executorBotId = entityId; } 
                else if (type === 'user') { query.userId = targetObj.telegramId; query.clientBotId = null; queryBefore.userId = targetObj.telegramId; queryBefore.clientBotId = null; }

                const transactions = await Transaction.find(query).sort({ updatedAt: 1 });
                if (transactions.length === 0) return; 

                let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
                transactions.forEach(tx => {
                    if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
                    else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
                    else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
                });

                let openingBalance = 0;
                const txsBefore = await Transaction.find(queryBefore);
                txsBefore.forEach(tx => {
                    if (type === 'client' || type === 'user') {
                        if (tx.status === 'completed') openingBalance -= (tx.costLYD || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                    } else if (type === 'executor') {
                        if (tx.status === 'completed') openingBalance -= (tx.amount || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                    }
                });

                let periodNetChange = 0;
                if (type === 'client' || type === 'user') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersLYD;
                else if (type === 'executor') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersEGP;
                
                const closingBalance = openingBalance + periodNetChange;

                const html = await renderHtmlPromisified(appReq.app, 'admin_reports', { clientBots: [], executorBots: [], users: [], type, entityId, fromDate: '', toDate: '', transactions, totals, openingBalance, closingBalance, targetName: targetObj.name, isPdfExport: true, bulkDateLabel: dateLabel });
                const page = await browser.newPage(); await page.setContent(html, { waitUntil: 'networkidle0' });
                const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
                await page.close();

                const api = new Telegram(botToken);
                const fileName = `Report_${targetObj.name.replace(/\s+/g, '_')}_${dateLabel.replace(/\s+/g, '_')}.pdf`;
                const captionMsg = `📊 <b>تقرير تقفيل (${periodType === 'daily' ? 'اليوم' : 'الشهر'}) المعتمد</b>\n\n🏢 الجهة: ${targetObj.name}\n📅 الفترة: ${dateLabel}\n💰 الرصيد الختامي للفترة: ${closingBalance.toFixed(2)}`;

                for (const emp of employees) {
                    if (emp && emp.telegramId) { try { await api.sendDocument(emp.telegramId.toString(), { source: Buffer.from(pdfBuffer), filename: fileName }, { caption: captionMsg, parse_mode: 'HTML' }); } catch (e) {} }
                }
            } catch (err) {}
        };

        const users = await User.find({ status: 'active' }); for (const u of users) await processEntity('user', u._id, u, process.env.CLIENT_BOT_TOKEN, [{ telegramId: u.telegramId }]);
        const clients = await ClientBot.find({ status: 'active' }); for (const c of clients) { const emps = await ClientEmployee.find({ clientBotId: c._id, status: 'active' }); await processEntity('client', c._id, c, c.token, emps); }
        const executors = await ExecutorBot.find({ status: 'active' }); for (const e of executors) { const emps = await Employee.find({ botId: e._id, status: 'active' }); await processEntity('executor', e._id, e, e.token, emps); }

    } catch (err) {
    } finally {
        if (browser) await browser.close(); 
    }
};

app.post('/admin-reports/bulk-send', requireAuth, async (req, res) => {
    const { bulkType, bulkDate, bulkMonth } = req.body;
    if (bulkType === 'daily' && bulkDate) sendBulkReportsInBg('daily', bulkDate, req);
    else if (bulkType === 'monthly' && bulkMonth) sendBulkReportsInBg('monthly', bulkMonth, req);
    res.redirect('/admin-reports?success=bulk_started');
});

app.post('/transaction/:id/resend-proof', requireAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'completed') return res.redirect('/transactions');

        const photoId = (tx.proofImages && tx.proofImages.length > 0) ? tx.proofImages[0] : tx.proofImage;
        if (!photoId) return res.redirect('/transactions');

        let clientToken = process.env.CLIENT_BOT_TOKEN; let isCompany = false;
        if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) { clientToken = comp.token; isCompany = true; } }

        const clientAPI = new Telegram(clientToken);
        let captionClientMsg = `🔄 <b>إعادة إرسال إشعار التنفيذ</b>\n\n✅ <b>تم تنفيذ طلبك بنجاح!</b>\n🧾 رقم الطلب: <code>${tx.customId}</code>\n💵 المبلغ: ${tx.amount} EGP\n💸 التكلفة: ${tx.costLYD} LYD`;
        if (tx.notes && tx.notes.includes('[رقم المحول:')) { const match = tx.notes.match(/\[رقم المحول:\s*(.+?)\]/); if (match) captionClientMsg += `\n📞 <b>رقم المُرسل:</b> <code>${match[1]}</code>`; }

        if (isCompany) {
            const emps = await ClientEmployee.find({ clientBotId: tx.clientBotId, status: 'active' });
            for(const e of emps) await clientAPI.sendPhoto(e.telegramId, photoId, { caption: captionClientMsg, parse_mode: 'HTML' }).catch(()=>{});
        } else {
            await clientAPI.sendPhoto(tx.userId, photoId, { caption: captionClientMsg, parse_mode: 'HTML' }).catch(()=>{});
        }
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

app.get('/admin-reports', requireAuth, async (req, res) => {
    try {
        const clientBots = await ClientBot.find({ status: 'active' });
        const executorBots = await ExecutorBot.find({ status: 'active' });
        const users = await User.find({ status: 'active' }); 
        
        const { type, entityId, fromDate, toDate } = req.query;
        let transactions = []; let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        let openingBalance = 0; let closingBalance = 0; let targetName = '';

        if (type && entityId) {
            let query = { status: { $in: ['completed', 'deposit', 'deduction'] } };
            let queryBefore = { status: { $in: ['completed', 'deposit', 'deduction'] } };

            if (type === 'client') { query.clientBotId = entityId; queryBefore.clientBotId = entityId; const comp = await ClientBot.findById(entityId); if (comp) { targetName = comp.name; } } 
            else if (type === 'executor') { query.executorBotId = entityId; queryBefore.executorBotId = entityId; const exec = await ExecutorBot.findById(entityId); if (exec) { targetName = exec.name; } } 
            else if (type === 'user') { const userObj = await User.findById(entityId); if (userObj) { query.userId = userObj.telegramId; query.clientBotId = null; queryBefore.userId = userObj.telegramId; queryBefore.clientBotId = null; targetName = userObj.name; } }

            if (fromDate || toDate) {
                query.updatedAt = {};
                if (fromDate) query.updatedAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
                if (toDate) query.updatedAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
            }

            transactions = await Transaction.find(query).sort({ updatedAt: 1 });
            transactions.forEach(tx => {
                if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
                else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
                else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
            });

            if (fromDate) {
                queryBefore.updatedAt = { $lt: new Date(`${fromDate}T00:00:00.000Z`) };
                const txsBefore = await Transaction.find(queryBefore);
                txsBefore.forEach(tx => {
                    if (type === 'client' || type === 'user') {
                        if (tx.status === 'completed') openingBalance -= (tx.costLYD || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                    } else if (type === 'executor') {
                        if (tx.status === 'completed') openingBalance -= (tx.amount || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                    }
                });
            }

            let periodNetChange = 0;
            if (type === 'client' || type === 'user') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersLYD;
            else if (type === 'executor') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersEGP;
            closingBalance = openingBalance + periodNetChange;
        }

        res.render('admin_reports', { clientBots, executorBots, users, type, entityId, fromDate, toDate, transactions, totals, openingBalance, closingBalance, targetName, isPdfExport: false });
    } catch (e) { res.redirect('/'); }
});

app.post('/admin-reports/send', requireAuth, async (req, res) => {
    try {
        const { type, entityId, fromDate, toDate } = req.body;
        if (!type || !entityId) return res.redirect('/admin-reports');

        let query = { status: { $in: ['completed', 'deposit', 'deduction'] } };
        let queryBefore = { status: { $in: ['completed', 'deposit', 'deduction'] } };
        
        if (fromDate || toDate) {
            query.updatedAt = {};
            if (fromDate) query.updatedAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
            if (toDate) query.updatedAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
        }

        let targetObj, botToken, employees = [];
        const dateLabel = (fromDate && toDate) ? `من ${fromDate} إلى ${toDate}` : 'تقرير مخصص مفتوح';

        if (type === 'client') {
            query.clientBotId = entityId; queryBefore.clientBotId = entityId;
            targetObj = await ClientBot.findById(entityId);
            if (targetObj) { botToken = targetObj.token; employees = await ClientEmployee.find({ clientBotId: entityId, status: 'active' }); }
        } else if (type === 'executor') {
            query.executorBotId = entityId; queryBefore.executorBotId = entityId;
            targetObj = await ExecutorBot.findById(entityId);
            if (targetObj) { botToken = targetObj.token; employees = await Employee.find({ botId: entityId, status: 'active' }); }
        } else if (type === 'user') { 
            targetObj = await User.findById(entityId);
            if (targetObj) { query.userId = targetObj.telegramId; query.clientBotId = null; queryBefore.userId = targetObj.telegramId; queryBefore.clientBotId = null; botToken = process.env.CLIENT_BOT_TOKEN; employees = [{ telegramId: targetObj.telegramId.toString() }]; }
        }

        if (!targetObj || !botToken) return res.redirect(`/admin-reports?type=${type}&entityId=${entityId}&error=notfound`);

        const transactions = await Transaction.find(query).sort({ updatedAt: 1 });
        if (transactions.length === 0) return res.redirect(`/admin-reports?type=${type}&entityId=${entityId}&error=empty`);

        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        transactions.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        let openingBalance = 0;
        if (fromDate) {
            queryBefore.updatedAt = { $lt: new Date(`${fromDate}T00:00:00.000Z`) };
            const txsBefore = await Transaction.find(queryBefore);
            txsBefore.forEach(tx => {
                if (type === 'client' || type === 'user') {
                    if (tx.status === 'completed') openingBalance -= (tx.costLYD || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                } else if (type === 'executor') {
                    if (tx.status === 'completed') openingBalance -= (tx.amount || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
                }
            });
        }
        let periodNetChange = 0;
        if (type === 'client' || type === 'user') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersLYD;
        else if (type === 'executor') periodNetChange = totals.depositsEGP - totals.deductionsEGP - totals.transfersEGP;
        const closingBalance = openingBalance + periodNetChange;

        req.app.render('admin_reports', { clientBots: [], executorBots: [], users: [], type, entityId, fromDate, toDate, transactions, totals, openingBalance, closingBalance, targetName: targetObj.name, isPdfExport: true }, async (err, html) => {
            if (err) return res.redirect('/admin-reports?error=failed');

            let browser; 
            try {
                browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
                const page = await browser.newPage();
                await page.setContent(html, { waitUntil: 'networkidle0' });
                const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
                await browser.close();

                const api = new Telegram(botToken);
                const fileName = `Report_${targetObj.name.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
                const captionMsg = `📊 <b>التقرير المحاسبي المخصص (PDF)</b>\n\n🏢 الجهة: ${targetObj.name}\n📅 الفترة: ${dateLabel}\n💰 الرصيد الختامي: ${closingBalance.toFixed(2)}`;

                let sentCount = 0;
                for (const emp of employees) {
                    if (emp && emp.telegramId) {
                        try { await api.sendDocument(emp.telegramId, { source: Buffer.from(pdfBuffer), filename: fileName }, { caption: captionMsg, parse_mode: 'HTML' }); sentCount++; } catch (e) {}
                    }
                }
                res.redirect(`/admin-reports?type=${type}&entityId=${entityId}&fromDate=${fromDate}&toDate=${toDate}&success=sent&count=${sentCount}`);
            } catch (pdfErr) {
                if (browser) await browser.close(); 
                res.redirect('/admin-reports?error=failed');
            }
        });
    } catch (e) { res.redirect('/admin-reports?error=failed'); }
});

app.get('/transactions', requireAuth, async (req, res) => {
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

app.get('/transactions/print', requireAuth, async (req, res) => {
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

// 🚀 المسار المحوري لتوجيه الطلبات (تم ربطه بـ Queue System)
app.post('/transaction/:id/assign-executor', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id; const executorBotId = req.body.executorBotId; const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') return res.redirect('/transactions');

        const executorBot = await ExecutorBot.findById(executorBotId);

        if (executorBot && !executorBot.isManagerBot) { 
            
            if (tx.adminMessages && tx.adminMessages.length > 0) {
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                for (const adminMsg of tx.adminMessages) {
                    await adminAPI.deleteMessage(adminMsg.telegramId, adminMsg.messageId).catch(() => {});
                }
                tx.adminMessages = []; 
            }

            // --- المسار الآلي المعتمد على الطابور (Queue) ---
            if (executorBot.isApiBot) {
                tx.status = 'processing';
                tx.executorBotId = executorBot._id;
                tx.executorBotName = executorBot.name;
                tx.managerBotId = executorBot.parentBotId || null; 
                await tx.save();

                if (executorBot.parentBotId) {
                    try {
                        const monitorBot = await ExecutorBot.findById(executorBot.parentBotId);
                        if (monitorBot && monitorBot.token) {
                            const monitorAPI = new Telegram(monitorBot.token);
                            const monitorStaff = await Employee.find({ botId: monitorBot._id, status: 'active' });
                            const startMsg = `🟡 <b>سجل API (تم وضع الطلب في طابور المعالجة)</b>\n\n🤖 <b>البوت:</b> ${executorBot.name}\n🧾 <b>الطلب:</b> <code>${tx.customId}</code>\n📞 <b>الرقم:</b> <code>${tx.vodafoneNumber || tx.accountNumber}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n⏳ <i>جاري الانتظار في طابور التنفيذ...</i>`;
                            for (const staff of monitorStaff) {
                                if (staff.telegramId) await monitorAPI.sendMessage(staff.telegramId, startMsg, { parse_mode: 'HTML' }).catch(()=>{});
                            }
                        }
                    } catch(e){}
                }

                // 🟢 إرسال الطلب إلى الطابور الذكي للمعالجة في الخلفية
                await apiTransferQueue.addJob(tx._id, executorBot._id);

                return res.redirect('/transactions');
            }

            // --- المسار الكلاسيكي للبوت البشري ---
            tx.executorBotId = executorBot._id; tx.managerBotId = executorBot.parentBotId || null; tx.executorBotName = executorBot.name; tx.status = 'processing'; tx.broadcastMessages = []; 

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

app.post('/transaction/:id/pull-task', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/emergency-alert', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/accept-deposit-web', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/reject-deposit-web', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/edit-rate', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/edit-data', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/global-cancel', requireAuth, async (req, res) => {
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

app.post('/transaction/:id/change-bot', requireAuth, async (req, res) => {
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

app.get('/executors', requireAuth, async (req, res) => {
    try {
        const bots = await ExecutorBot.find({}).sort({ createdAt: -1 });
        const botsWithStats = await Promise.all(bots.map(async (bot) => {
            const syncedBalance = await syncBotBalance(bot._id); 
            let txCount = 0; if (bot.isManagerBot) txCount = await Transaction.countDocuments({ managerBotId: bot._id, status: 'completed' }); else txCount = await Transaction.countDocuments({ executorBotId: bot._id, status: 'completed' });
            return { ...bot._doc, balance: syncedBalance, txCount };
        }));
        res.render('executors', { bots: botsWithStats, adminName: req.session.adminName });
    } catch (e) { res.redirect('/'); }
});

app.get('/executor/:id', requireAuth, async (req, res) => {
    try {
        await syncBotBalance(req.params.id); 
        const bot = await ExecutorBot.findById(req.params.id).populate('parentBotId');
        let queryFilter = bot.isManagerBot ? { managerBotId: bot._id } : { executorBotId: bot._id };
        const transactions = await Transaction.find(queryFilter).sort({ updatedAt: -1 }).limit(100);
        
        const managerBots = await ExecutorBot.find({ isManagerBot: true, status: 'active', _id: { $ne: bot._id } });

        if (bot.isApiBot) {
            const stats = {
                successCount: transactions.filter(t => t.status === 'completed').length,
                failedCount: transactions.filter(t => t.status === 'pending' && t.notes && t.notes.includes('فشل')).length,
            };
            return res.render('api_room', { bot, transactions, stats, managerBots, adminName: req.session.adminName });
        }

        res.render('executor_details', { bot, transactions, managerBots, adminName: req.session.adminName });
    } catch (e) { res.redirect('/executors'); }
});

app.post('/executor/:id/settle', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorBot.findById(req.params.id); const amount = parseFloat(req.body.amount); const notes = req.body.notes ? req.body.notes.trim() : ''; 
        let targetBotId = bot._id; let targetBotName = bot.name; let targetToken = bot.token;

        if (!bot.isManagerBot && bot.parentBotId) { targetBotId = bot.parentBotId; const parentBot = await ExecutorBot.findById(targetBotId); if (parentBot) { targetBotName = parentBot.name; targetToken = parentBot.token; } }
        
        if (!isNaN(amount) && amount !== 0) {
            const tx = await Transaction.create({
                userId: 'admin', executorBotId: targetBotId, amount: Math.abs(amount), costLYD: 0, vodafoneNumber: 'تسديد حساب',
                status: amount > 0 ? 'deposit' : 'deduction', customId: `SETTLE-${Date.now().toString().slice(-6)}`, companyName: 'الإدارة المركزية', employeeName: amount > 0 ? 'تسديد نقدية (إيداع)' : 'خصم من المنفذ', executorName: targetBotName, notes: notes 
            });
            await syncBotBalance(targetBotId); if(targetBotId.toString() !== bot._id.toString()) await syncBotBalance(bot._id); 

            if (!bot.isApiBot) {
                const execAPI = new Telegram(targetToken); const emps = await Employee.find({ botId: targetBotId, status: 'active' });
                const actionType = amount > 0 ? 'إيداع نقدية/تسديد' : 'خصم من الرصيد'; const msgText = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 الطلب: <code>${tx.customId}</code>`;
                for(const e of emps) execAPI.sendMessage(e.telegramId, msgText, { parse_mode: 'HTML' }).catch(()=>{});
                await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: amount > 0 ? 'success' : 'error', text: msgText.replace(/\n/g, '<br>') } } }, { strict: false });
            }
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

app.post('/executor/:id/link-manager', requireAuth, async (req, res) => {
    try {
        const botId = req.params.id; const parentId = req.body.parentBotId; const bot = await ExecutorBot.findById(botId);
        if (bot) { if (parentId === 'none') { bot.parentBotId = null; } else { bot.parentBotId = parentId; } await bot.save(); }
        res.redirect(`/executor/${botId}`);
    } catch (e) { res.redirect('/executors'); }
});

app.post('/executor/:id/toggle-status', requireAuth, async (req, res) => {
    try {
        const botId = req.params.id; const bot = await ExecutorBot.findById(botId); if (!bot) return res.redirect('/executors');
        bot.status = bot.status === 'active' ? 'paused' : 'active'; await bot.save();
        
        if (!bot.isApiBot) {
            try {
                const botEmployees = await Employee.find({ botId: bot._id, telegramId: { $exists: true, $ne: null } });
                if (botEmployees.length > 0 && bot.token) {
                    const botAPI = new Telegram(bot.token);
                    let message = bot.status === 'paused' ? `🔴 <b>إشعار إداري هام:</b>\n\nتم <b>إيقاف</b> هذا البوت مؤقتاً من قبل الإدارة المركزية.\nلا يمكنك استقبال أو تنفيذ أي عمليات حالياً حتى يتم تفعيله مجدداً.` : `🟢 <b>إشعار إداري:</b>\n\nتم <b>إعادة تشغيل وتفعيل</b> البوت بنجاح.\nيمكنك الآن استئناف عملك واستقبال الطلبات.`;
                    for (const emp of botEmployees) await botAPI.sendMessage(emp.telegramId, message, { parse_mode: 'HTML' }).catch(()=>{});
                }
            } catch (tgError) {}
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

app.get('/clients', requireAuth, async (req, res) => {
    const users = await User.find({}).sort({ createdAt: -1 }); const companies = await ClientBot.find({}).sort({ createdAt: -1 });
    res.render('clients', { users, companies });
});

app.get('/user/:id', requireAuth, async (req, res) => {
    const user = await User.findById(req.params.id); const transactions = await Transaction.find({ userId: user.telegramId, clientBotId: null }).sort({ createdAt: -1 }).limit(50);
    res.render('user_details', { user, transactions });
});

app.get('/company/:id', requireAuth, async (req, res) => {
    const company = await ClientBot.findById(req.params.id); const transactions = await Transaction.find({ clientBotId: company._id }).sort({ createdAt: -1 }).limit(50);
    res.render('company_details', { company, transactions });
});

app.post('/user/:id/add-balance', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.id); if (!user) return res.redirect('/clients');
        let amount; try { amount = parseSignedAmount(req.body.amount); } catch (_) { return res.redirect(`/user/${user._id}`); }
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (user && amount !== 0) {
            const result = await recordBalanceAdjustment({
                entityModel: 'User',
                entityId: user._id,
                amount,
                transactionData: { userId: user.telegramId, clientBotId: null, vodafoneNumber: '01000000000', companyName: 'عميل فردي', employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)', notes },
                description: amount > 0 ? 'إيداع رصيد عميل فردي من الإدارة' : 'خصم رصيد عميل فردي من الإدارة'
            });
            user.balance = result.balanceAfter;
            const tx = result.transaction;
            const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد'; const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n💳 الرصيد الحالي: <b>${result.balanceAfter.toFixed(2)}</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
            const mainAPI = new Telegram(process.env.CLIENT_BOT_TOKEN); mainAPI.sendMessage(user.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{});
        }
        res.redirect(`/user/${user._id}`);
    } catch (e) { res.redirect('/'); }
});

app.post('/user/:id/toggle-status', requireAuth, async (req, res) => {
    const user = await User.findById(req.params.id); user.status = user.status === 'active' ? 'banned' : 'active'; await user.save(); res.redirect(`/user/${user._id}`);
});

app.post('/user/:id/change-level', requireAuth, async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/user/${req.params.id}`);
});

app.post('/user/:id/update-limit', requireAuth, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await User.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/user/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

app.post('/company/:id/add-balance', requireAuth, async (req, res) => {
    try {
        const comp = await ClientBot.findById(req.params.id); if (!comp) return res.redirect('/clients');
        let amount; try { amount = parseSignedAmount(req.body.amount); } catch (_) { return res.redirect(`/company/${comp._id}`); }
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (comp && amount !== 0) {
            const result = await recordBalanceAdjustment({
                entityModel: 'ClientBot',
                entityId: comp._id,
                amount,
                transactionData: { userId: 'admin', clientBotId: comp._id, vodafoneNumber: '01000000000', companyName: comp.name, employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)', notes },
                description: amount > 0 ? `إيداع رصيد شركة ${comp.name}` : `خصم رصيد شركة ${comp.name}`
            });
            comp.balance = result.balanceAfter;
            const tx = result.transaction;
            const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد'; const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n💳 الرصيد الحالي: <b>${result.balanceAfter.toFixed(2)}</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
            const compAPI = new Telegram(comp.token); const emps = await ClientEmployee.find({ clientBotId: comp._id, status: 'active' }); for(const emp of emps) compAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{});
        }
        res.redirect(`/company/${comp._id}`);
    } catch (e) { res.redirect('/'); }
});

app.post('/company/:id/update-rate', requireAuth, async (req, res) => {
    try { 
        const rate = Math.abs(parseFloat(req.body.exchangeRate) || 0); 
        await ClientBot.findByIdAndUpdate(req.params.id, { exchangeRate: rate }, { strict: false }); 
        res.redirect(`/company/${req.params.id}`); 
    } catch (e) { 
        res.redirect('/clients'); 
    }
});

app.post('/company/:id/toggle-status', requireAuth, async (req, res) => {
    const comp = await ClientBot.findById(req.params.id); comp.status = comp.status === 'active' ? 'inactive' : 'active'; await comp.save(); res.redirect(`/company/${comp._id}`);
});

app.post('/company/:id/change-level', requireAuth, async (req, res) => {
    await ClientBot.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/company/${req.params.id}`);
});

app.post('/company/:id/update-limit', requireAuth, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await ClientBot.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/company/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

app.get('/settings', requireAuth, async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({}); res.render('settings', { settings });
});

app.post('/settings/update', requireAuth, async (req, res) => {
    const data = req.body; data.isManualClosed = data.isManualClosed === 'true'; await Settings.updateOne({}, data, { upsert: true }); res.redirect('/settings');
});

app.get('/settings/content', requireAuth, async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({}); res.render('content_settings', { settings });
});

app.post('/settings/content/update', requireAuth, async (req, res) => {
    await Settings.updateOne({}, req.body, { upsert: true }); res.redirect('/settings/content');
});

app.get('/settings/excel', requireAuth, async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({}); res.render('excel_settings', { settings });
});

app.post('/settings/excel/update', requireAuth, async (req, res) => {
    await Settings.updateOne({}, req.body, { upsert: true }); res.redirect('/settings/excel');
});

app.get('/settings/bots', requireAuth, async (req, res) => {
    const executorBots = await ExecutorBot.find({}); const clientBots = await ClientBot.find({}); res.render('bots', { executorBots, clientBots });
});

app.post('/settings/bots/add-executor', requireAuth, async (req, res) => {
    try { 
        const { name, botType, token, apiUrl, apiToken } = req.body; 
        let newBotData = { name: name, status: 'active' };

        if (botType === 'api') {
            newBotData.isApiBot = true; newBotData.apiUrl = apiUrl; newBotData.apiToken = apiToken; newBotData.token = `API_DUMMY_${Date.now()}`; 
        } else if (botType === 'manager') {
            newBotData.isManagerBot = true; newBotData.token = token;
        } else {
            newBotData.token = token;
        }

        await ExecutorBot.create(newBotData); 
        res.redirect('/settings/bots'); 
    } catch (e) { res.redirect('/settings/bots'); }
});

app.post('/settings/bots/add-client', requireAuth, async (req, res) => {
    try { await ClientBot.create(req.body); res.redirect('/settings/bots'); } catch (e) { res.redirect('/settings/bots'); }
});

app.get('/settings/clients-web', requireAuth, async (req, res) => {
    const users = await User.find({ status: 'active' }); const companies = await ClientBot.find({ status: 'active' }); const allClientEmployees = await ClientEmployee.find({ status: 'active' }); const webUsers = await User.find({ webUsername: { $exists: true, $nin: [null, ""] } }); const webEmployeesRaw = await ClientEmployee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('clientBotId');
    const webEmployees = webEmployeesRaw.map(e => ({ _id: e._id, name: e.name, role: e.role, webUsername: e.webUsername, webPassword: e.webPassword, companyName: e.clientBotId ? e.clientBotId.name : 'شركة محذوفة', status: e.status }));
    res.render('settings_clients_web', { users, companies, allClientEmployees, webUsers, webEmployees, query: req.query });
});

app.post('/settings/clients-web/add', requireAuth, async (req, res) => {
    try {
        const { accountType, accountId, employeeId, webUsername, webPassword } = req.body; const user = webUsername.trim().toLowerCase();
        if (accountType === 'user') { await User.findByIdAndUpdate(accountId, { webUsername: user, webPassword: webPassword.trim() }, { strict: false }); } 
        else { if (employeeId) await ClientEmployee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: webPassword.trim() }); }
        res.redirect('/settings/clients-web?success=true');
    } catch (e) { res.redirect('/settings/clients-web?error=true'); }
});

app.post('/settings/clients-web/edit', requireAuth, async (req, res) => {
    try {
        const { accountType, accountId, webUsername, webPassword } = req.body;
        if (accountType === 'user') await User.findByIdAndUpdate(accountId, { webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim() }, { strict: false });
        else if (accountType === 'employee') await ClientEmployee.findByIdAndUpdate(accountId, { webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim() });
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

app.post('/settings/clients-web/delete', requireAuth, async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') await User.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } }, { strict: false });
        else if (accountType === 'employee') await ClientEmployee.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } });
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

app.post('/settings/clients-web/toggle', requireAuth, async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') { const account = await User.findById(accountId); if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); } } 
        else if (accountType === 'employee') { const account = await ClientEmployee.findById(accountId); if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); } }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

app.get('/settings/executors-web', requireAuth, async (req, res) => {
    try { const employees = await Employee.find({ status: 'active' }).populate('botId'); const webExecutors = await Employee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('botId'); res.render('settings_executors_web', { employees, webExecutors, query: req.query }); } catch (e) { res.redirect('/'); }
});

app.post('/settings/executors-web/add', requireAuth, async (req, res) => {
    try { const { employeeId, webUsername, webPassword } = req.body; const user = webUsername.trim().toLowerCase(); await Employee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: webPassword.trim() }); res.redirect('/settings/executors-web?success=true'); } catch (e) { res.redirect('/settings/executors-web?error=true'); }
});

app.post('/settings/executors-web/delete', requireAuth, async (req, res) => {
    try { const { employeeId } = req.body; await Employee.findByIdAndUpdate(employeeId, { $unset: { webUsername: "", webPassword: "" } }); res.redirect('/settings/executors-web?success=true'); } catch (e) { res.redirect('/settings/executors-web?error=true'); }
});

app.get('/settings/users', requireMaster, async (req, res) => {
    const webAdmins = await Admin.find({ webUsername: { $exists: true, $ne: null } }).sort({ createdAt: -1 }); res.render('settings_users', { webAdmins });
});

app.post('/settings/users/add', requireMaster, async (req, res) => {
    try { const { name, webUsername, webPassword } = req.body; const dummyId = `WEB_${Date.now()}`; await Admin.create({ telegramId: dummyId, name: name.trim(), webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim(), role: 'admin' }); res.redirect('/settings/users'); } catch (e) { res.redirect('/settings/users'); }
});

app.post('/settings/users/delete/:id', requireMaster, async (req, res) => {
    try { await Admin.findByIdAndDelete(req.params.id); res.redirect('/settings/users'); } catch(e) { res.redirect('/settings/users'); }
});

app.get('/employees', requireAuth, async (req, res) => {
    const execEmployees = await Employee.find({}); const clientEmployees = await ClientEmployee.find({}); const executors = await ExecutorBot.find({}); const clients = await ClientBot.find({}); const executorBotsMap = {}; executors.forEach(b => executorBotsMap[b._id] = b.name); const clientBotsMap = {}; clients.forEach(b => clientBotsMap[b._id] = b.name);
    res.render('employees', { execEmployees, clientEmployees, executorBotsMap, clientBotsMap });
});

app.post('/employees/executor/:id/toggle', requireAuth, async (req, res) => {
    const emp = await Employee.findById(req.params.id); emp.status = emp.status === 'active' ? 'banned' : 'active'; await emp.save(); res.redirect('/employees');
});

app.post('/employees/client/:id/toggle', requireAuth, async (req, res) => {
    const emp = await ClientEmployee.findById(req.params.id); emp.status = emp.status === 'active' ? 'banned' : 'active'; await emp.save(); res.redirect('/employees');
});

app.get('/broadcast', requireAuth, async (req, res) => {
    const users = await User.find({ status: 'active' }); const companies = await ClientBot.find({ status: 'active' }); const executors = await ExecutorBot.find({ status: 'active' }); res.render('broadcast', { users, companies, executors, query: req.query });
});

app.post('/broadcast/send', requireAuth, upload.single('imageFile'), async (req, res) => {
    const { target, message, specificUserId, specificCompanyId, specificExecutorId } = req.body;
    try {
        let photoData = null; if (req.file) photoData = { source: req.file.buffer };
        const sendMsg = async (token, chatId, text, photo) => {
            if (!token || !chatId) return;
            const api = new Telegram(token);
            try { if (photo) await api.sendPhoto(chatId, photo, { caption: text, parse_mode: 'HTML' }); else await api.sendMessage(chatId, text, { parse_mode: 'HTML' }); } catch (e) {}
        };
        const mainClientToken = process.env.CLIENT_BOT_TOKEN;

        if (target === 'all' || target === 'users') { const users = await User.find({ status: 'active' }); for (const u of users) await sendMsg(mainClientToken, u.telegramId, message, photoData); }
        if (target === 'all' || target === 'companies') { const clientEmps = await ClientEmployee.find({ status: 'active' }).populate('clientBotId'); for (const emp of clientEmps) { if (emp.clientBotId && emp.clientBotId.status === 'active') await sendMsg(emp.clientBotId.token, emp.telegramId, message, photoData); } }
        if (target === 'all' || target === 'employees') { const execEmps = await Employee.find({ status: 'active' }).populate('botId'); for (const emp of execEmps) { if (emp.botId && ['active', 'paused'].includes(emp.botId.status)) await sendMsg(emp.botId.token, emp.telegramId, message, photoData); } }
        if (target === 'specific_user') await sendMsg(mainClientToken, specificUserId, message, photoData);
        if (target === 'specific_company') { const comp = await ClientBot.findById(specificCompanyId); if (comp) { const emps = await ClientEmployee.find({ clientBotId: comp._id, status: 'active' }); for (const emp of emps) await sendMsg(comp.token, emp.telegramId, message, photoData); } }
        if (target === 'specific_executor') { const execBot = await ExecutorBot.findById(specificExecutorId); if (execBot) { const emps = await Employee.find({ botId: execBot._id, status: 'active' }); for (const emp of emps) await sendMsg(execBot.token, emp.telegramId, message, photoData); } }
        res.redirect('/broadcast?success=true');
    } catch (e) { res.redirect('/broadcast?error=failed'); }
});

app.get('/support', requireAuth, async (req, res) => {
    try { res.render('support_admin', { adminName: req.session.adminName }); } catch (e) { res.redirect('/'); }
});

app.get('/api/support/tickets', requireAuth, async (req, res) => {
    try { const tickets = await SupportTicket.find({}).sort({ updatedAt: -1 }); res.json({ success: true, tickets }); } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/support/tickets/:id', requireAuth, async (req, res) => {
    try { const ticket = await SupportTicket.findById(req.params.id); if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' }); ticket.unreadAdmin = 0; await ticket.save(); res.json({ success: true, ticket }); } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/support/tickets/:id/reply', requireAuth, async (req, res) => {
    try {
        const { text } = req.body; const ticket = await SupportTicket.findById(req.params.id); if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' });
        const newMessage = { sender: 'admin', senderName: req.session.adminName || 'الإدارة', text: text, createdAt: new Date() };
        ticket.messages.push(newMessage); ticket.status = 'answered'; ticket.unreadUser = (ticket.unreadUser || 0) + 1; await ticket.save();
        if (ticket.botToken && ticket.telegramId) { const api = new Telegram(ticket.botToken); const msg = `📩 <b>رد جديد من الدعم الفني:</b>\n\n${text}`; await api.sendMessage(ticket.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{}); }
        res.json({ success: true, message: newMessage });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/support/tickets/:id/close', requireAuth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id); if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' });
        ticket.status = 'closed'; await ticket.save();
        if (ticket.botToken && ticket.telegramId) { const api = new Telegram(ticket.botToken); const msg = `🔒 <b>تم إغلاق تذكرة الدعم الفني بواسطة الإدارة.</b>\nنشكرك على تواصلك معنا.`; await api.sendMessage(ticket.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{}); }
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

cron.schedule('* * * * *', async () => {
    try {
        const settings = await Settings.findOne({}); if (!settings || !settings.closingTime) return;
        const now = new Date(); const options = { timeZone: 'Africa/Tripoli', hour12: false, hour: '2-digit', minute: '2-digit' };
        const currentTime = now.toLocaleTimeString('en-GB', options);

        if (currentTime === settings.closingTime) {
            if (!settings.isManualClosed) { settings.isManualClosed = true; await settings.save(); }
            const clientReportBuffer = await generateMasterClientReport(); const executorReportBuffer = await generateMasterExecutorReport();
            const dateStr = now.toLocaleDateString('en-GB').replace(/\//g, '-');
            const admins = await Admin.find({});
            for (const admin of admins) {
                await adminBotAPI.sendDocument(admin.telegramId, { source: clientReportBuffer, filename: `Master_Clients_Report_${dateStr}.xlsx` }, { caption: '📊 **تقرير التقفيل الشامل - العملاء**', parse_mode: 'HTML' }).catch(() => {});
                await adminBotAPI.sendDocument(admin.telegramId, { source: executorReportBuffer, filename: `Master_Executors_Report_${dateStr}.xlsx` }, { caption: '🤖 **تقرير الأداء الشامل - التنفيذ**', parse_mode: 'HTML' }).catch(() => {});
            }
            const activeExecutors = await ExecutorBot.find({ status: { $in: ['active', 'paused'] } });
            for (const execBot of activeExecutors) { await sendDailyAutoClosing(execBot); }
        }
    } catch (error) {}
});

const adminClosingRoutes = require('./routes/adminClosing');
app.use('/closing', requireAuth, adminClosingRoutes);

// ==========================================================
// 🌐 واجهة برمجة تطبيقات الوكلاء (Merchant API - Ahram Pay)
// ==========================================================

const merchantApiAuth = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ status: 'failed', message: 'مفتاح المصادقة (x-api-key) مفقود في الهيدر' });
    }

    const company = await ClientBot.findOne({ token: apiKey, status: 'active' }).lean();
    if (!company) {
        return res.status(401).json({ status: 'failed', message: 'مفتاح المصادقة غير صحيح أو الحساب موقوف' });
    }

    req.merchant = company;
    next();
};

app.get('/api/v1/merchant/balance', merchantApiAuth, async (req, res) => {
    const settings = await Settings.findOne({}).lean();
    const globalRate = settings && settings.exchangeRate ? settings.exchangeRate : 1;
    const customRate = req.merchant.exchangeRate ? req.merchant.exchangeRate : globalRate;

    res.json({
        status: 'success',
        data: {
            merchant_name: req.merchant.name,
            balance: req.merchant.balance,
            exchange_rate: customRate 
        }
    });
});

app.post('/api/v1/merchant/transfer', merchantApiAuth, async (req, res) => {
    try {
        const { target_number, amount, transfer_type } = req.body;
        
        const phoneStr = target_number ? target_number.toString().trim() : '';
        const phoneRegex = /^\d{11}$/; 
        
        if (!phoneRegex.test(phoneStr)) {
            return res.status(400).json({ status: 'failed', message: 'عفواً، رقم الهاتف غير صالح. يجب أن يتكون من 11 رقماً بالضبط.' });
        }

        const now = new Date();
        const yy = now.getFullYear().toString().slice(-2); 
        const mm = (now.getMonth() + 1).toString().padStart(2, '0'); 
        
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const countThisMonth = await Transaction.countDocuments({ createdAt: { $gte: startOfMonth } });
        
        const sequence = (countThisMonth + 1).toString().padStart(4, '0'); 
        const customId = `ATT-${yy}${mm}-${sequence}`;

        const settings = await Settings.findOne({}).lean();
        const globalRate = settings && settings.exchangeRate ? settings.exchangeRate : 1; 
        
        const exchangeRate = req.merchant.exchangeRate ? req.merchant.exchangeRate : globalRate;
        const costLYD = parseFloat((amount / exchangeRate).toFixed(3));

        const tx = await Transaction.create({
            userId: 'api_merchant',
            clientBotId: req.merchant._id,
            amount: Math.abs(parseFloat(amount)),
            costLYD: costLYD, 
            exchangeRate: exchangeRate, 
            vodafoneNumber: phoneStr, 
            status: 'pending',
            customId: customId, 
            companyName: req.merchant.name,
            employeeName: 'ربط آلي (Merchant API)',
            transferType: transfer_type || 'vodafone_cash',
            notes: '[طلب وارد عبر API التاجر الخارجي]'
        });

        res.json({
            status: 'success',
            message: 'تم استلام الطلب بنجاح وهو الآن قيد المعالجة',
            data: {
                transaction_id: tx._id,
                invoice_number: tx.customId,
                status: 'pending',
                amount_egp: tx.amount,
                exchange_rate: exchangeRate, 
                cost_lyd: tx.costLYD         
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'failed', message: 'حدث خطأ داخلي أثناء معالجة الطلب' });
    }
});

app.get('/api/v1/merchant/status/:reference_id', merchantApiAuth, async (req, res) => {
    try {
        const tx = await Transaction.findOne({ clientBotId: req.merchant._id, customId: req.params.reference_id }).lean();
        if (!tx) {
            return res.status(404).json({ status: 'failed', message: 'لا يوجد طلب بهذا الرقم المرجعي' });
        }

        res.json({
            status: 'success',
            data: {
                transaction_id: tx._id,
                reference_id: tx.customId,
                target_number: tx.vodafoneNumber,
                amount_egp: tx.amount,
                exchange_rate: tx.exchangeRate || 1, 
                cost_lyd: tx.costLYD || tx.amount,   
                status: tx.status, 
                notes: tx.notes || 'لا يوجد ملاحظات'
            }
        });
    } catch(e) {
        res.status(500).json({ status: 'failed', message: 'خطأ داخلي' });
    }
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
connectDB().then(() => {
    server.listen(PORT, () => {
        console.log(`🟢 السيرفر يعمل بقوة الزمن الفعلي والحماية الشاملة على البورت ${PORT}`);
        try {
            startAdminBot();
            startAllClientBots();
            startAllExecutorBots();
        } catch (e) { console.error('⚠️ خطأ أثناء تشغيل البوتات:', e.message); }
    });
});
