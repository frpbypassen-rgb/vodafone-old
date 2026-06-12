// routes/settings.js
const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const ExecutorBot = require('../models/ExecutorBot');
const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { requireAuth, requireMaster } = require('../middlewares/auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({});
    // نمرر البوتات لكي تظهر في القائمة المنسدلة لاختيار بوت التوجيه
    const executorBots = await ExecutorBot.find({ status: 'active', isManagerBot: false });
    res.render('settings', { settings, executorBots });
});

router.post('/update', async (req, res) => {
    const data = req.body;
    data.isManualClosed = data.isManualClosed === 'true';
    await Settings.updateOne({}, data, { upsert: true });
    res.redirect('/settings');
});

// 🚀 المسار الجديد للتحكم في التوجيه التلقائي عبر الـ AJAX من الموقع
router.post('/toggle-auto-route', async (req, res) => {
    try {
        const { isEnabled, botId } = req.body;
        const set = await Settings.findOne({}) || await Settings.create({});
        
        set.autoRouteEnabled = isEnabled;
        if (botId) set.autoRouteBotId = botId;

        await set.save();
        res.json({ success: true, isEnabled: set.autoRouteEnabled });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء الحفظ' });
    }
});

router.get('/content', async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({});
    res.render('content_settings', { settings });
});

router.post('/content/update', async (req, res) => {
    await Settings.updateOne({}, req.body, { upsert: true });
    res.redirect('/settings/content');
});

router.get('/excel', async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({});
    res.render('excel_settings', { settings });
});

router.post('/excel/update', async (req, res) => {
    await Settings.updateOne({}, req.body, { upsert: true });
    res.redirect('/settings/excel');
});

router.get('/bots', async (req, res) => {
    const executorBots = await ExecutorBot.find({});
    const clientBots = await ClientBot.find({});
    res.render('bots', { executorBots, clientBots });
});

router.post('/bots/add-executor', async (req, res) => {
    try { 
        const { name, botType, token, apiUrl, apiToken } = req.body; 
        
        let newBotData = {
            name: name,
            status: 'active'
        };

        if (botType === 'api') {
            newBotData.isApiBot = true;
            newBotData.apiUrl = apiUrl;
            newBotData.apiToken = apiToken;
            newBotData.token = `API_DUMMY_${Date.now()}`; 
        } else if (botType === 'manager') {
            newBotData.isManagerBot = true;
            newBotData.token = token;
        } else {
            newBotData.token = token;
        }

        await ExecutorBot.create(newBotData); 
        res.redirect('/settings/bots'); 
    } catch (e) { 
        console.error(e);
        res.redirect('/settings/bots'); 
    }
});

router.post('/bots/add-client', async (req, res) => {
    try { await ClientBot.create(req.body); res.redirect('/settings/bots'); } catch (e) { res.redirect('/settings/bots'); }
});

router.get('/clients-web', async (req, res) => {
    const users = await User.find({ status: 'active' });
    const companies = await ClientBot.find({ status: 'active' });
    const allClientEmployees = await ClientEmployee.find({ status: 'active' });
    const webUsers = await User.find({ webUsername: { $exists: true, $nin: [null, ""] } });
    const webEmployeesRaw = await ClientEmployee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('clientBotId');
    const webEmployees = webEmployeesRaw.map(e => ({
        _id: e._id, name: e.name, role: e.role, webUsername: e.webUsername, webPassword: e.webPassword, companyName: e.clientBotId ? e.clientBotId.name : 'شركة محذوفة', status: e.status
    }));
    res.render('settings_clients_web', { users, companies, allClientEmployees, webUsers, webEmployees, query: req.query });
});

router.post('/clients-web/add', async (req, res) => {
    try {
        const { accountType, accountId, employeeId, webUsername, webPassword } = req.body;
        const user = webUsername.trim().toLowerCase();
        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, { webUsername: user, webPassword: webPassword.trim() }, { strict: false });
        } else {
            if (employeeId) await ClientEmployee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: webPassword.trim() });
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (e) { res.redirect('/settings/clients-web?error=true'); }
});

router.post('/clients-web/edit', async (req, res) => {
    try {
        const { accountType, accountId, webUsername, webPassword } = req.body;
        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, { webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim() }, { strict: false });
        } else if (accountType === 'employee') {
            await ClientEmployee.findByIdAndUpdate(accountId, { webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim() });
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

router.post('/clients-web/delete', async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } }, { strict: false });
        } else if (accountType === 'employee') {
            await ClientEmployee.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } });
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

router.post('/clients-web/toggle', async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') {
            const account = await User.findById(accountId);
            if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); }
        } else if (accountType === 'employee') {
            const account = await ClientEmployee.findById(accountId);
            if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); }
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) { res.redirect('/settings/clients-web?error=true'); }
});

router.get('/executors-web', async (req, res) => {
    try {
        const employees = await Employee.find({ status: 'active' }).populate('botId');
        const webExecutors = await Employee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('botId');
        res.render('settings_executors_web', { employees, webExecutors, query: req.query });
    } catch (e) { res.redirect('/'); }
});

router.post('/executors-web/add', async (req, res) => {
    try {
        const { employeeId, webUsername, webPassword } = req.body;
        const user = webUsername.trim().toLowerCase();
        await Employee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: webPassword.trim() });
        res.redirect('/settings/executors-web?success=true');
    } catch (e) { res.redirect('/settings/executors-web?error=true'); }
});

router.post('/executors-web/delete', async (req, res) => {
    try {
        const { employeeId } = req.body;
        await Employee.findByIdAndUpdate(employeeId, { $unset: { webUsername: "", webPassword: "" } });
        res.redirect('/settings/executors-web?success=true');
    } catch (e) { res.redirect('/settings/executors-web?error=true'); }
});

router.get('/users', requireMaster, async (req, res) => {
    const webAdmins = await Admin.find({ webUsername: { $exists: true, $ne: null } }).sort({ createdAt: -1 });
    res.render('settings_users', { webAdmins });
});

router.post('/users/add', requireMaster, async (req, res) => {
    try {
        const { name, webUsername, webPassword } = req.body;
        const dummyId = `WEB_${Date.now()}`; 
        await Admin.create({ telegramId: dummyId, name: name.trim(), webUsername: webUsername.trim().toLowerCase(), webPassword: webPassword.trim(), role: 'admin' });
        res.redirect('/settings/users');
    } catch (e) { res.redirect('/settings/users'); }
});

router.post('/users/delete/:id', requireMaster, async (req, res) => {
    try {
        await Admin.findByIdAndDelete(req.params.id);
        res.redirect('/settings/users');
    } catch(e) { res.redirect('/settings/users'); }
});

module.exports = router;