const express = require('express');
const router = express.Router();
const https = require('https');
const { Telegram } = require('telegraf');
const bcrypt = require('bcryptjs'); // 🟢 تمت إضافة مكتبة التشفير

const Admin = require('../models/Admin');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientBot = require('../models/ClientBot');
const ExecutorBot = require('../models/ExecutorBot');
const Transaction = require('../models/Transaction');
const { isAuthenticated } = require('../middlewares/auth');

// =======================================================
// 👑 تسجيل دخول الإدارة المركزية
// =======================================================

router.get('/login', (req, res) => {
    if (req.session.isLoggedIn || req.session.adminId || req.session.adminRole === 'master') return res.redirect('/');
    res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) return res.render('login', { error: 'يرجى إدخال اسم المستخدم وكلمة المرور.' });

        const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');

        // 1. فحص المدير الأساسي (Master Admin)
        const envAdminUser = (process.env.ADMIN_USERNAME || 'admin').trim();
        const envAdminPass = (process.env.ADMIN_PASSWORD || 'admin').trim();

        if (username.toLowerCase() === envAdminUser.toLowerCase() && password === envAdminPass) {
            req.session.isLoggedIn = true;
            req.session.adminName = 'المدير الأساسي';
            req.session.adminRole = 'master';
            req.session.adminId = 'master_admin';
            return req.session.save(() => res.redirect('/'));
        }

        // 2. فحص الإدارة الفرعية (Sub-Admins)
        // 🟢 الترقية السلسة: نبحث بالاسم فقط أولاً
        const admin = await Admin.findOne({ webUsername: usernameRegex }).lean();
        
        if (admin && admin.webPassword) {
            let isMatch = false;
            
            // التحقق مما إذا كانت كلمة المرور مشفرة مسبقاً (تبدأ بـ $2)
            if (admin.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, admin.webPassword);
            } else {
                // إذا لم تكن مشفرة (النظام القديم)
                isMatch = (password === admin.webPassword);
                
                // 🟢 إذا تطابقت، نقوم بتشفيرها فوراً وحفظها (Auto-Upgrade)
                if (isMatch) {
                    const hashedPass = await bcrypt.hash(password, 12);
                    await Admin.updateOne({ _id: admin._id }, { webPassword: hashedPass });
                }
            }

            if (isMatch) {
                req.session.isLoggedIn = true;
                req.session.adminId = admin._id;
                req.session.adminName = admin.name;
                req.session.adminRole = admin.role || 'admin';
                return req.session.save(() => res.redirect('/'));
            }
        }

        return res.render('login', { error: 'بيانات الدخول غير صحيحة.' });

    } catch (error) {
        console.error("Admin Login Error: ", error);
        return res.render('login', { error: 'حدث خطأ داخلي في الخادم.' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// =======================================================
// 📊 لوحة الإدارة الرئيسية
// =======================================================
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

        const usersCount = await User.countDocuments();
        const companiesCount = await ClientBot.countDocuments();
        const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' });
        const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } });
        const completedTxs = await Transaction.countDocuments({ status: 'completed', updatedAt: { $gte: startOfDay } });

        res.render('index', { 
            activePage: 'dashboard', adminName: req.session.adminName || 'مدير عام', role: req.session.adminRole || 'master',
            usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs
        });
    } catch (error) { res.status(500).send('Server Error'); }
});

// =======================================================
// 🖼️ مسار الجلب الوسيط (Proxy) لصور الإثبات في لوحة الإدارة
// =======================================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], isAuthenticated, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        
        if (tx.proofImages && tx.proofImages.length > index) {
            photoId = tx.proofImages[index];
        } else if (tx.proofImage && index === 0) {
            photoId = tx.proofImage; 
        }

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        let tokensToTry = [];
        if (process.env.ADMIN_BOT_TOKEN) tokensToTry.push(process.env.ADMIN_BOT_TOKEN);
        if (process.env.CLIENT_BOT_TOKEN) tokensToTry.push(process.env.CLIENT_BOT_TOKEN);

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

module.exports = router;