// bots/admin/index.js
const { Telegraf, Markup, session, Scenes, Telegram } = require('telegraf');
const Admin = require('../../models/Admin');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const ExecutorBot = require('../../models/ExecutorBot');
const Employee = require('../../models/Employee');
const ClientEmployee = require('../../models/ClientEmployee'); 
const ClientBot = require('../../models/ClientBot'); 
const resolveByAdminWizard = require('./scenes/resolveByAdminScene');

const rechargeUserWizard = require('./scenes/rechargeUserScene');
const assignTaskAction = require('./actions/assignTask');
const forwardTaskAction = require('./actions/forwardTask');
const activateUserAction = require('./actions/activateUser');
const manageEmployee = require('./actions/manageEmployee');
const exchangeRateWizard = require('./scenes/exchangeRateScene');
const clientTierWizard = require('./scenes/clientTierScene');
const clientControlWizard = require('./scenes/clientControlScene');
const reportsWizard = require('./scenes/reportsScene');
 
const settleExecutorWizard = require('./scenes/settleExecutorScene');
const cancelReasonScene = require('./scenes/cancelReasonScene');
const addExecutorScene = require('./scenes/addExecutorScene');
const addClientBotScene = require('./scenes/addClientBotScene'); 
const creditLimitWizard = require('./scenes/creditLimitScene');
const searchUserWizard = require('./scenes/searchUserScene'); 
const rechargeCompanyWizard = require('./scenes/rechargeCompanyScene'); 
const settingsWizard = require('./scenes/settingsScene');
const settleManagerWizard = require('./scenes/settleManagerScene'); 
const editTxRateWizard = require('./scenes/editTxRateScene'); 
const { recordBalanceAdjustment, parseSignedAmount } = require('../../services/balanceAdjustmentService');

const startAdminBot = async () => {
    
    const bot = new Telegraf(process.env.ADMIN_BOT_TOKEN);

    bot.catch((err, ctx) => {
        console.error(`🚨 [Admin Bot Error] on ${ctx.updateType}:`, err.message);
    });

    const stage = new Scenes.Stage([
        cancelReasonScene, 
        addExecutorScene, 
        addClientBotScene, 
        creditLimitWizard, 
        searchUserWizard,
        rechargeCompanyWizard,
        exchangeRateWizard,
        clientTierWizard,
        clientControlWizard,
        settingsWizard,
        reportsWizard,
        settleExecutorWizard,
        settleManagerWizard, 
        resolveByAdminWizard,
        rechargeUserWizard,
        editTxRateWizard 
    ]);
    
    bot.use(session());

    bot.use(async (ctx, next) => {
        if (!ctx.from) return;
        const telegramId = ctx.from.id.toString();
        const text = ctx.message?.text;

        const SECRET_CODE = process.env.ADMIN_SECRET_CODE || 'zone2026';

        if (text && text.startsWith('/add ')) {
            const code = text.split(' ')[1];
            if (code === SECRET_CODE) {
                const exists = await Admin.findOne({ telegramId });
                if (!exists) {
                    await Admin.create({ telegramId, name: ctx.from.first_name, role: 'admin' });
                    await ctx.reply(`✅ <b>مرحباً بك يا ${ctx.from.first_name} في فريق الإدارة!</b>\n\nلقد تم التعرف على الكود السري ومنحك صلاحيات الإدارة بنجاح.\nجاري فتح لوحة التحكم...`, { parse_mode: 'HTML' });
                } else {
                    await ctx.reply('⚠️ أنت تملك صلاحيات الإدارة بالفعل! جاري فتح اللوحة...');
                }
                return next(); 
            } else {
                return ctx.reply('❌ الكود السري غير صحيح!');
            }
        }

        const isMaster = telegramId === process.env.ADMIN_TELEGRAM_ID;
        const isAdmin = await Admin.findOne({ telegramId });

        if (isMaster || isAdmin) {
            if (isMaster && !isAdmin) {
                await Admin.create({ telegramId, name: 'المدير الأساسي', role: 'master' });
            }
            return next(); 
        } else {
            return; 
        }
    });

    bot.use(stage.middleware());

    const showAdminDashboard = async (ctx) => {
        await ctx.reply(
            `👨‍💻 <b>لوحة تحكم الإدارة العليا</b> 🛡️\nأهلاً بك يا ${ctx.from.first_name}، لديك كامل الصلاحيات.`,
            {
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    ['⚙️ تحكم في العملاء والشركات', '⏰ مواقيت العمل وحالة البوت'], 
                    ['📥 طلبات التسجيل', '💸 طلبات التحويل'],
                    ['📊 الإحصائيات', '💳 شحن رصيد أفراد'],
                    ['🤖 إنشاء بوت تنفيذي', '🤖 عمليات البوت'], 
                    ['🤖 إنشاء بوت عميل', '💰 شحن رصيد شركات'], 
                    ['💳 حدود العميل', '💎 مستويات الأسعار'], 
                    ['🔍 البحث برقم الهاتف', '💱 تعديل سعر الصرف'],
                    ['💱 تعديل سعر عملية', '📊 التقارير'], 
                    ['💵 تسديد وكالة التنفيذ', '🔗 ربط بوتات التنفيذ'],
                    ['👥 بيانات العملاء', '📊 عرض بوتات التنفيذ'], 
                    ['🏠 القائمة الرئيسية (تحديث)']
                ]).resize()
            }
        );
    };

    bot.start(showAdminDashboard);
    bot.hears(/^\/add /, showAdminDashboard); 
    
    bot.hears('🏠 القائمة الرئيسية (تحديث)', async (ctx) => {
        if (ctx.scene) await ctx.scene.leave();
        await showAdminDashboard(ctx);
    });

    bot.hears('💱 تعديل سعر عملية', (ctx) => ctx.scene.enter('EDIT_TX_RATE_SCENE')); 
    bot.hears(/تسديد وكالة التنفيذ/, (ctx) => ctx.scene.enter('SETTLE_MANAGER_SCENE'));

    bot.hears('🔗 ربط بوتات التنفيذ', async (ctx) => {
        const normalBots = await ExecutorBot.find({ isManagerBot: false, status: 'active' });
        if (normalBots.length === 0) return ctx.reply('❌ لا توجد بوتات تنفيذ عادية (للتنفيذ المباشر) في النظام.');
        
        const buttons = normalBots.map(b => [Markup.button.callback(`🤖 ${b.name}`, `linkChild_${b._id}`)]);
        await ctx.reply('👇 <b>اختر بوت التنفيذ (الفرعي) الذي تريد ربطه بوكيل:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action(/linkChild_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(()=>{});
        const childId = ctx.match[1];
        const childBot = await ExecutorBot.findById(childId);
        if (!childBot) return ctx.editMessageText('❌ البوت غير موجود.');

        const managerBots = await ExecutorBot.find({ isManagerBot: true, status: 'active' });
        if (managerBots.length === 0) return ctx.editMessageText('❌ لا توجد بوتات إدارية (وكلاء) مسجلة في النظام لربطها.');

        const buttons = managerBots.map(m => [Markup.button.callback(`🏢 وكيل: ${m.name}`, `setLink_${childId}_${m._id}`)]);
        buttons.push([Markup.button.callback('🔓 فك الارتباط (جعله مستقل)', `setLink_${childId}_none`)]);

        await ctx.editMessageText(`🔗 <b>جاري ربط:</b> [ ${childBot.name} ]\n👇 اختر البوت الإداري (الوكيل) المسؤول عنه:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action(/setLink_(.+)_(.+)/, async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري الحفظ...').catch(()=>{});
        const childId = ctx.match[1];
        const parentId = ctx.match[2];

        const childBot = await ExecutorBot.findById(childId);
        if (!childBot) return ctx.editMessageText('❌ البوت غير موجود.');

        if (parentId === 'none') {
            childBot.parentBotId = null;
            await childBot.save();
            return ctx.editMessageText(`✅ تم فك ارتباط البوت [ ${childBot.name} ] وأصبح <b>مستقلاً</b>. (التسديد سيتم له مباشرة)`, {parse_mode: 'HTML'});
        } else {
            const parentBot = await ExecutorBot.findById(parentId);
            if (!parentBot) return ctx.editMessageText('❌ البوت الإداري غير موجود.');
            childBot.parentBotId = parentId;
            await childBot.save();
            return ctx.editMessageText(`✅ تم ربط البوت [ ${childBot.name} ] بنجاح ليكون تحت إدارة الوكيل [ <b>${parentBot.name}</b> ].`, {parse_mode: 'HTML'});
        }
    });

    bot.hears(/مواقيت العمل وحالة البوت/, (ctx) => ctx.scene.enter('SETTINGS_SCENE'));
    bot.hears(/إنشاء بوت تنفيذي/, (ctx) => ctx.scene.enter('ADD_EXECUTOR_SCENE'));
    bot.hears(/إنشاء بوت عميل/, (ctx) => ctx.scene.enter('ADD_CLIENT_BOT_SCENE'));
    bot.hears(/حدود العميل/, (ctx) => ctx.scene.enter('CREDIT_LIMIT_SCENE'));
    bot.hears(/البحث برقم الهاتف/, (ctx) => ctx.scene.enter('SEARCH_USER_SCENE'));
    bot.hears(/شحن رصيد شركات/, (ctx) => ctx.scene.enter('RECHARGE_COMPANY_SCENE')); 
    bot.hears(/تعديل سعر الصرف/, (ctx) => ctx.scene.enter('EXCHANGE_RATE_SCENE'));
    bot.hears(/مستويات الأسعار/, (ctx) => ctx.scene.enter('CLIENT_TIER_SCENE'));
    bot.hears(/تحكم في العملاء والشركات/, (ctx) => ctx.scene.enter('CLIENT_CONTROL_SCENE'));
    bot.hears(/التقارير/, (ctx) => ctx.scene.enter('REPORTS_SCENE'));

    bot.hears('📊 عرض بوتات التنفيذ', async (ctx) => {
        try {
            await ctx.reply('⏳ جاري حساب وتجميع إحصائيات بوتات التنفيذ...');
            const bots = await ExecutorBot.find({});
            if (bots.length === 0) {
                return ctx.reply('❌ لا توجد بوتات تنفيذ مسجلة في النظام.');
            }

            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            let msgChunks = [];
            let currentMsg = `📋 <b>إحصائيات بوتات التنفيذ:</b>\n━━━━━━━━━━━━━━\n\n`;

            for (const bot of bots) {
                let queryFilter = {};
                if (bot.isManagerBot) {
                    queryFilter = { 
                        $or: [
                            { managerBotId: bot._id, status: 'completed' }, 
                            { executorBotId: bot._id, status: { $in: ['deposit', 'deduction'] } } 
                        ]
                    };
                } else {
                    queryFilter = { 
                        executorBotId: bot._id, 
                        status: { $in: ['completed', 'deposit', 'deduction'] } 
                    };
                }
                const allTxs = await Transaction.find(queryFilter);
                let computedBalance = 0;
                allTxs.forEach(t => {
                    if (t.status === 'completed') computedBalance -= t.amount; 
                    else if (t.status === 'deposit') computedBalance += t.amount; 
                    else if (t.status === 'deduction') computedBalance -= Math.abs(t.amount); 
                });

                let todayFilter = { 
                    status: 'completed', 
                    updatedAt: { $gte: startOfDay } 
                };
                if (bot.isManagerBot) {
                    todayFilter.managerBotId = bot._id;
                } else {
                    todayFilter.executorBotId = bot._id;
                }
                
                const todayTxs = await Transaction.find(todayFilter);
                const todayConsumed = todayTxs.reduce((sum, tx) => sum + tx.amount, 0);

                const typeText = bot.isManagerBot ? '(وكالة إدارية)' : '(بوت مباشر)';
                const botStatus = bot.status === 'active' ? '🟢 نشط' : '🔴 متوقف';
                
                let entry = `🤖 <b>البوت:</b> ${bot.name} ${typeText}\n`;
                entry += `📌 <b>الحالة:</b> ${botStatus}\n`;
                entry += `💰 <b>القيمة الإجمالية (المديونية):</b> ${Math.abs(computedBalance).toFixed(2)} EGP\n`;
                entry += `📉 <b>مستهلك اليوم:</b> ${todayConsumed.toFixed(2)} EGP\n`;
                entry += `〰️〰️〰️〰️〰️〰️〰️〰️〰️\n`;

                if ((currentMsg.length + entry.length) > 3800) {
                    msgChunks.push(currentMsg);
                    currentMsg = ``;
                }
                currentMsg += entry;
            }

            if (currentMsg.length > 0) {
                msgChunks.push(currentMsg);
            }

            for (const chunk of msgChunks) {
                await ctx.reply(chunk, { parse_mode: 'HTML' });
            }

        } catch (error) {
            console.error('[Show Executor Bots Error]:', error);
            ctx.reply('❌ حدث خطأ فني أثناء جلب إحصائيات البوتات.');
        }
    });

    bot.hears('👥 بيانات العملاء', async (ctx) => {
        try {
            await ctx.reply('⏳ جاري تجميع قائمة العملاء والشركات المعتمدة...');

            const users = await User.find({});
            const companies = await ClientBot.find({});

            if (users.length === 0 && companies.length === 0) {
                return ctx.reply('✅ لا يوجد عملاء أو شركات مسجلة في النظام حتى الآن.');
            }

            let msgChunks = [];
            let currentMsg = `📋 <b>سـجـل بـيـانـات الـعـمـلاء والـشـركـات</b>\n\n`;

            if (users.length > 0) {
                currentMsg += `👤 <b>الـعـمـلاء الأفـراد (${users.length}):</b>\n━━━━━━━━━━━━━━\n`;
                for (let i = 0; i < users.length; i++) {
                    const u = users[i];
                    const statusText = u.status === 'active' ? '✅ نشط' : (u.status === 'banned' ? '🚫 محظور' : '⏳ معلق');
                    
                    let entry = `👤 <b>الاسم:</b> ${u.name}\n`;
                    entry += `📱 <b>الهاتف:</b> <code>${u.phone}</code>\n`;
                    entry += `🆔 <b>الآي دي:</b> <code>${u.telegramId}</code>\n`;
                    entry += `💰 <b>الرصيد المتاح:</b> ${u.balance.toFixed(2)} دينار\n`;
                    entry += `📌 <b>حالة الحساب:</b> ${statusText}\n`;
                    entry += `〰️〰️〰️〰️〰️〰️〰️〰️〰️\n`;

                    if ((currentMsg.length + entry.length) > 3800) {
                        msgChunks.push(currentMsg);
                        currentMsg = ``;
                    }
                    currentMsg += entry;
                }
            }

            if (companies.length > 0) {
                let compHeader = `\n🏢 <b>شـركـات وبـوتـات الـعـمـلاء (${companies.length}):</b>\n━━━━━━━━━━━━━━\n`;
                if ((currentMsg.length + compHeader.length) > 3800) {
                    msgChunks.push(currentMsg);
                    currentMsg = compHeader;
                } else {
                    currentMsg += compHeader;
                }

                for (let i = 0; i < companies.length; i++) {
                    const c = companies[i];
                    const statusText = c.status === 'active' ? '✅ نشط' : '🚫 متوقف';
                    
                    let entry = `🏢 <b>الشركة:</b> ${c.name}\n`;
                    entry += `📱 <b>هاتف المالك:</b> <code>${c.phone}</code>\n`;
                    entry += `🆔 <b>الآي دي:</b> <code>${c._id}</code>\n`;
                    entry += `💰 <b>الرصيد المتاح:</b> ${c.balance.toFixed(2)} دينار\n`;
                    entry += `📌 <b>حالة البوت:</b> ${statusText}\n`;
                    entry += `〰️〰️〰️〰️〰️〰️〰️〰️〰️\n`;

                    if ((currentMsg.length + entry.length) > 3800) {
                        msgChunks.push(currentMsg);
                        currentMsg = ``;
                    }
                    currentMsg += entry;
                }
            }

            if (currentMsg.length > 0) {
                msgChunks.push(currentMsg);
            }

            for (const chunk of msgChunks) {
                await ctx.reply(chunk, { parse_mode: 'HTML' });
            }

        } catch (error) {
            console.error('[Clients Data Error]:', error);
            ctx.reply('❌ حدث خطأ فني أثناء جلب بيانات العملاء.');
        }
    });

    bot.hears(/الإحصائيات/, async (ctx) => {
        const users = await User.countDocuments();
        const pending = await Transaction.countDocuments({ status: 'pending' });
        ctx.reply(`📊 <b>الإحصائيات:</b>\n👥 العملاء الأفراد: ${users}\n⏳ طلبات معلقة: ${pending}`, { parse_mode: 'HTML' });
    });

    bot.hears(/طلبات التسجيل/, async (ctx) => {
        const pendingUsers = await User.find({ status: 'pending' });
        const pendingClientEmps = await ClientEmployee.find({ status: 'pending' }).populate('clientBotId');

        if (pendingUsers.length === 0 && pendingClientEmps.length === 0) {
            return ctx.reply('✅ لا توجد طلبات تسجيل معلقة.');
        }

        for (const user of pendingUsers) {
            await ctx.reply(
                `👤 <b>طلب فردي جديد:</b>\nالاسم: ${user.name}\nالهاتف: <code>${user.phone}</code>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('✅ تفعيل', `activate_${user.telegramId}`)]])
                }
            );
        }

        for (const emp of pendingClientEmps) {
            if (!emp.clientBotId) continue;
            await ctx.reply(
                `🏢 <b>طلب انضمام لشركة:</b>\n🏢 الشركة: ${emp.clientBotId.name}\n👤 الموظف: ${emp.name}\n📱 الهاتف: <code>${emp.phone}</code>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ قبول في الشركة', `acceptClientEmp_${emp._id}`)],
                        [Markup.button.callback('❌ رفض وحظر', `banClientEmp_${emp._id}`)]
                    ])
                }
            );
        }
    });

    bot.hears(/طلبات التحويل/, async (ctx) => {
        const pendingTx = await Transaction.find({ status: 'pending' });
        if (pendingTx.length === 0) return ctx.reply('✅ لا توجد طلبات تحويل معلقة.');
        for (const tx of pendingTx) {
            const displayId = tx.customId || tx._id.toString(); 
            const source = tx.companyName ? `🏢 الشركة: ${tx.companyName}\n👤 الموظف: ${tx.employeeName}` : `👤 العميل: ${tx.employeeName || 'فردي'}`;
            
            let typeLabel = 'فودافون كاش';
            if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
            if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

            let accDetails = `📞 المحفظة/الرقم: <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>`;
            if (tx.accountName) accDetails += `\n👤 الاسم: ${tx.accountName}`;

            const msgText = `🔔 <b>طلب تحويل (${typeLabel}):</b>\n${source}\n${accDetails}\n💵 المبلغ: ${tx.amount} EGP\n💰 التكلفة: ${tx.costLYD} LYD\n🧾 رقم الطلب: <code>${displayId}</code>`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🤖 تحويل لبوت تنفيذي', `forward_${tx._id}`)],
                [Markup.button.callback('❌ إلغاء العملية', `cancelReq_${tx._id}`)]
            ]);

            if (tx.transferType === 'post_card' && tx.idCardImage) {
                let idUrl = tx.idCardImage;
                try {
                    let cToken = process.env.CLIENT_BOT_TOKEN;
                    if (tx.clientBotId) {
                        const comp = await ClientBot.findById(tx.clientBotId);
                        if (comp) cToken = comp.token;
                    }
                    const tempApi = new Telegram(cToken);
                    idUrl = (await tempApi.getFileLink(tx.idCardImage)).href;
                } catch(e){}
                
                await ctx.replyWithPhoto({ url: idUrl }, { caption: msgText, parse_mode: 'HTML', ...keyboard }).catch(() => ctx.reply(msgText, { parse_mode: 'HTML', ...keyboard }));
            } else {
                await ctx.reply(msgText, { parse_mode: 'HTML', ...keyboard });
            }
        }
    });

    bot.hears(/عمليات البوت/, async (ctx) => {
        const execBots = await ExecutorBot.find({ isManagerBot: false });
        if (execBots.length === 0) return ctx.reply('❌ لا توجد بوتات تنفيذ مسجلة.');
        const buttons = execBots.map(b => [Markup.button.callback(`🤖 ${b.name}`, `adminViewBot_${b._id}`)]);
        await ctx.reply('👇 <b>اختر بوت التنفيذ لعرض عملياته:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action(/adminViewBot_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري جلب العمليات...').catch(() => {});
            const botId = ctx.match[1];
            const execBot = await ExecutorBot.findById(botId);
            if (!execBot) return ctx.reply('❌ البوت غير موجود!');

            const activeTxs = await Transaction.find({ executorBotId: botId, status: { $in: ['processing', 'accepted'] } });
            if (activeTxs.length === 0) return ctx.reply('✅ البوت مستقر، لا توجد طلبات معلقة.');

            await ctx.reply(`📊 <b>العمليات في [ ${execBot.name} ]:</b>`, { parse_mode: 'HTML' });

            const allStaff = await Employee.find({ botId: execBot._id });
            const empMap = {};
            allStaff.forEach(e => empMap[e.telegramId] = e.name);

            for (const tx of activeTxs) {
                const displayId = tx.customId || tx._id.toString();
                let statusText = tx.status === 'processing' ? '🟠 معلقة (لم يقبلها أحد)' : '🟢 قيد التنفيذ';
                let opName = tx.operatorId ? `\n👤 <b>المنفذ:</b> ${empMap[tx.operatorId] || tx.operatorId}` : '';
                
                let typeLabel = 'فودافون كاش';
                if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                await ctx.reply(
                    `🧾 <b>الطلب (${typeLabel}):</b> <code>${displayId}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n📌 <b>الحالة:</b> ${statusText}${opName}`,
                    { 
                        parse_mode: 'HTML', 
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('🚨 إرسال تنبيه طارئ (Ping)', `pingTask_${tx._id}`)],
                            [Markup.button.callback('🔙 سحب إلى بوت الإدارة', `adminPullTx_${tx._id}`)]
                        ]) 
                    }
                );
            }
        } catch (error) { console.error(error); }
    });

    bot.action(/pingTask_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري إرسال التنبيه الطارئ...').catch(() => {});
            const txId = ctx.match[1];
            const tx = await Transaction.findById(txId);

            if (!tx || !['processing', 'accepted'].includes(tx.status)) {
                return ctx.reply('❌ الطلب غير متاح للتنبيه أو تم إنهاؤه.');
            }

            const botId = tx.executorBotId;
            if (!botId) return ctx.reply('❌ هذا الطلب غير موجه لأي بوت تنفيذ بعد.');

            const execBot = await ExecutorBot.findById(botId);
            if (!execBot) return ctx.reply('❌ لم يتم العثور على بوت التنفيذ.');

            const execAPI = new Telegram(execBot.token);
            const displayId = tx.customId || tx._id.toString();
            
            const alertMsg = `🚨🚨 <b>تـنـبـيـه طـارئ مـن الإدارة الـعـلـيـا</b> 🚨🚨\n\n` +
                             `الرجاء الإسراع في تنفيذ الطلب رقم <code>${displayId}</code> فوراً للضرورة القصوى العاجلة! ⏳`;

            await Transaction.updateOne(
                { _id: tx._id }, 
                { $set: { emergencyAlert: `تنبيه عاجل من الإدارة للطلب رقم ${displayId}! يرجى سرعة التنفيذ!` } },
                { strict: false }
            );

            let notifiedCount = 0;

            if (tx.status === 'accepted' && tx.operatorId) {
                try {
                    await execAPI.sendMessage(tx.operatorId, alertMsg, { parse_mode: 'HTML' });
                    notifiedCount = 1;
                } catch (e) { console.error('Ping error:', e.message); }
            } else if (tx.status === 'processing') {
                const operators = await Employee.find({ botId: execBot._id, status: 'active' });
                for (const op of operators) {
                    try {
                        await execAPI.sendMessage(op.telegramId, alertMsg, { parse_mode: 'HTML' });
                        notifiedCount++;
                    } catch (e) { console.error('Ping error:', e.message); }
                }
            }

            if (notifiedCount > 0) {
                await ctx.reply(`✅ <b>تم التنبيه بنجاح!</b>\nطار إشعار عاجل لـ ${notifiedCount} موظف تنفيذ، وتم تفعيل السرينة الحمراء في موقع التنفيذ 🚨`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply('⚠️ تم تفعيل السرينة في الموقع، ولكن لم نتمكن من إرسال رسائل تيليجرام (لا يوجد موظفين نشطين).');
            }

        } catch (error) {
            console.error(error);
            ctx.reply('❌ حدث خطأ أثناء إرسال التنبيه.');
        }
    });

    bot.action(/adminPullTx_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري السحب...').catch(() => {});
            const txId = ctx.match[1];
            const tx = await Transaction.findById(txId);
            if (!tx || !['processing', 'accepted'].includes(tx.status)) return ctx.reply('❌ الطلب غير متاح أو تم معالجته.');

            const oldOperatorId = tx.operatorId;
            const botId = tx.executorBotId;
            const oldBroadcasts = tx.broadcastMessages || []; 

            tx.status = 'pending';
            tx.operatorId = undefined;
            tx.executorBotId = undefined;
            tx.managerBotId = undefined;
            tx.broadcastMessages = [];
            tx.adminMessages = []; 
            
            const displayId = tx.customId || tx._id.toString();

            if (botId) {
                try {
                    const execBot = await ExecutorBot.findById(botId);
                    if (execBot) {
                        const execAPI = new Telegram(execBot.token);
                        if (oldOperatorId) {
                            await execAPI.sendMessage(oldOperatorId, `⚠️ <b>تنبيه من الإدارة العليا:</b>\nتم سحب الطلب رقم <code>${displayId}</code> منك وإعادته للإدارة!`, { parse_mode: 'HTML' }).catch(()=>{});
                        }
                        for (const bMsg of oldBroadcasts) {
                            await execAPI.deleteMessage(bMsg.telegramId, bMsg.messageId).catch(()=>{});
                        }
                    }
                } catch (e) {}
            }

            const allAdmins = await Admin.find({});
            let typeLabel = 'فودافون كاش';
            if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
            if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

            const source = tx.companyName ? `🏢 الشركة: ${tx.companyName}\n👤 الموظف: ${tx.employeeName}` : `👤 العميل: ${tx.employeeName || 'فردي'}`;
            let accDetails = `📞 المحفظة/الرقم: <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>`;
            if (tx.accountName) accDetails += `\n👤 الاسم: ${tx.accountName}`;

            const msgText = `🔄 <b>تم سحب الطلب للإدارة (${typeLabel}):</b>\n${source}\n${accDetails}\n💵 المبلغ: ${tx.amount} EGP\n💰 التكلفة: ${tx.costLYD} LYD\n🧾 رقم الطلب: <code>${displayId}</code>`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🤖 تحويل لبوت تنفيذي', `forward_${tx._id}`)],
                [Markup.button.callback('❌ إلغاء العملية', `cancelReq_${tx._id}`)]
            ]);

            let idUrl = null;
            if (tx.transferType === 'post_card' && tx.idCardImage) {
                try {
                    let cToken = process.env.CLIENT_BOT_TOKEN;
                    if (tx.clientBotId) {
                        const comp = await ClientBot.findById(tx.clientBotId);
                        if (comp) cToken = comp.token;
                    }
                    const tempApi = new Telegram(cToken);
                    idUrl = (await tempApi.getFileLink(tx.idCardImage)).href;
                } catch(e){}
            }

            for (const admin of allAdmins) {
                if (admin.telegramId) {
                    let sentAdminMsg;
                    try {
                        if (idUrl) {
                            sentAdminMsg = await ctx.telegram.sendPhoto(admin.telegramId, { url: idUrl }, { caption: msgText, parse_mode: 'HTML', ...keyboard });
                        } else {
                            sentAdminMsg = await ctx.telegram.sendMessage(admin.telegramId, msgText, { parse_mode: 'HTML', ...keyboard });
                        }
                        if (sentAdminMsg) {
                            tx.adminMessages.push({ telegramId: admin.telegramId, messageId: sentAdminMsg.message_id });
                        }
                    } catch(e) {}
                }
            }
            
            await tx.save();
            await ctx.editMessageText(`✅ <b>تم سحب الطلب بنجاح!</b>\nعاد الطلب <code>${displayId}</code> للإدارة وظهر لدى جميع المديرين.\n👨‍💻 <b>السحب بواسطة:</b> ${ctx.from.first_name}`, { parse_mode: 'HTML' });
            
        } catch (error) { console.error(error); }
    });

    bot.hears('💳 شحن رصيد أفراد', (ctx) => ctx.scene.enter('RECHARGE_USER_SCENE'));

    bot.command('alert', async (ctx) => {
        const text = ctx.message.text;
        const parts = text.split(' ');
        
        if (parts.length < 3) {
            return ctx.reply('⚠️ <b>الاستخدام الصحيح:</b>\n/alert [رقم_الطلب] [رسالة الإنذار]\n\n<b>مثال:</b>\n<code>/alert ATT-2605-0001 أوقف التحويل فوراً! العميل تراجع!</code>', { parse_mode: 'HTML' });
        }

        const customId = parts[1].trim();
        const alertMessage = parts.slice(2).join(' '); 

        try {
            const tx = await Transaction.findOne({ customId: customId });
            
            if (!tx) {
                return ctx.reply('❌ <b>لم يتم العثور على طلب بهذا الرقم!</b> تأكد من رقم الطلب (مثال: ATT-2605-0001)', { parse_mode: 'HTML' });
            }

            if (tx.status === 'completed' || tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
                return ctx.reply(`⚠️ الطلب <code>${customId}</code> منتهي أو ملغي بالفعل!`, { parse_mode: 'HTML' });
            }

            await Transaction.updateOne(
                { _id: tx._id }, 
                { $set: { emergencyAlert: alertMessage } },
                { strict: false }
            );

            ctx.reply(`✅ <b>تم إطلاق الإنذار بنجاح! 🚨</b>\n\nالآن شاشة المنفذ الذي يعمل على الطلب <code>${customId}</code> تضيء باللون الأحمر مع صوت سرينة ولن تتوقف حتى ينتبه ويقوم بإيقافها بنفسه!`, { parse_mode: 'HTML' });

        } catch (error) {
            console.error('[Emergency Alert Error]:', error);
            ctx.reply('❌ حدث خطأ في النظام أثناء إرسال الإنذار.');
        }
    });

    bot.command('addbalance', async (ctx) => {
        const args = ctx.message.text.split(' ');
        if (args.length !== 3) return ctx.reply('❌ صيغة خاطئة! استخدم: /addbalance [رقم_تليجرام] [المبلغ]');
        try {
            const user = await User.findOne({ telegramId: args[1] });
            if (!user) return ctx.reply('❌ لم يتم العثور على العميل.');
            
            const amount = parseSignedAmount(args[2]);
            if (amount <= 0) return ctx.reply('❌ المبلغ يجب أن يكون أكبر من الصفر.');

            const result = await recordBalanceAdjustment({
                entityModel: 'User',
                entityId: user._id,
                amount,
                transactionData: {
                    userId: user.telegramId,
                    clientBotId: null,
                    vodafoneNumber: '01000000000',
                    companyName: 'عميل فردي',
                    employeeName: 'الإدارة (إيداع)'
                },
                description: 'إيداع رصيد عميل فردي من أمر addbalance'
            });
            user.balance = result.balanceAfter;

            ctx.reply(`✅ تم الشحن بنجاح. الرصيد الحالي للعميل: ${user.balance}`);
        } catch (err) {
            console.error(err);
            ctx.reply('❌ تعذر تنفيذ الشحن. تأكد من رقم العميل والمبلغ.');
        }
    });

    bot.command('cladd', async (ctx) => {
        if (ctx.from.id.toString() !== process.env.ADMIN_TELEGRAM_ID) {
            return ctx.reply('⛔️ هذا الأمر مخصص للمدير الأساسي فقط.');
        }

        try {
            await ctx.reply('⏳ جاري فحص السجلات وتنظيف العمليات الملغية والمرفوضة...');
            
            const result = await Transaction.deleteMany({
                status: { $in: ['rejected', 'cancelled_by_admin'] }
            });

            if (result.deletedCount === 0) {
                return ctx.reply('✅ قاعدة البيانات نظيفة تماماً، لا توجد عمليات ملغية قديمة لمسحها.');
            }

            await ctx.reply(`🧹 <b>عملية تنظيف ناجحة!</b>\n\nتم مسح <b>${result.deletedCount}</b> عملية ملغية ومرفوضة نهائياً من قاعدة البيانات، وتم تحرير المساحة بنجاح.`, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('[Clean DB Error]:', error);
            await ctx.reply('❌ حدث خطأ أثناء عملية التنظيف.');
        }
    });

    bot.command('frp', async (ctx) => {
        if (ctx.from.id.toString() !== process.env.ADMIN_TELEGRAM_ID) {
            return ctx.reply('⛔️ هذا الأمر مخصص للمدير الأساسي فقط.');
        }

        await ctx.reply(
            '⚠️ <b>تحذير شديد الخطورة!</b> ⚠️\n\n' +
            'أنت على وشك إجراء <b>(ضبط مصنع كامل)</b> للنظام.\n' +
            '❌ <b>هذا الإجراء لا يمكن التراجع عنه أبداً!</b>\n' +
            'هل أنت متأكد بنسبة 100% أنك تريد مسح كل شيء؟',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚠️ نعم، احذف كل شيء الآن!', 'confirm_frp')],
                    [Markup.button.callback('❌ تراجع وإلغاء', 'cancel_frp')]
                ])
            }
        );
    });

    bot.action('cancel_frp', async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        await ctx.editMessageText('✅ <b>تم الإلغاء.</b> النظام آمن ولم يتم حذف أي بيانات.', { parse_mode: 'HTML' });
    });

    bot.action('confirm_frp', async (ctx) => {
        await ctx.answerCbQuery('جاري مسح قاعدة البيانات بالكامل...', { show_alert: true }).catch(() => {});
        try {
            await User.deleteMany({});
            await Transaction.deleteMany({});
            await ExecutorBot.deleteMany({});
            await Employee.deleteMany({});
            await ClientBot.deleteMany({});
            await ClientEmployee.deleteMany({});

            await ctx.editMessageText(
                '💀 <b>تم مسح النظام بالكامل بنجاح!</b>\n\n' +
                '⚠️ <b>ملاحظة هامة:</b> يرجى إغلاق السيرفر وإعادة تشغيله (`node app.js`).', 
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('[FRP Error]:', error);
            await ctx.editMessageText('❌ حدث خطأ أثناء مسح البيانات.');
        }
    });

    bot.action(/acceptClientEmp_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري التفعيل...').catch(() => {});
            const empId = ctx.match[1];
            const emp = await ClientEmployee.findById(empId).populate('clientBotId');
            if (!emp) return ctx.reply('❌ الموظف غير موجود أو تمت معالجته بالفعل.');
            if (!emp.clientBotId) return ctx.reply('❌ بوت الشركة غير موجود.');
            
            emp.status = 'active';
            await emp.save();
            
            await ctx.editMessageText(`✅ <b>تم تفعيل الموظف:</b> ${emp.name}\n🏢 <b>في شركة:</b> ${emp.clientBotId.name}\n👨‍💻 <b>بواسطة الإداري:</b> ${ctx.from.first_name}`, { parse_mode: 'HTML' });
            
            const companyBotAPI = new Telegram(emp.clientBotId.token);
            companyBotAPI.sendMessage(
                emp.telegramId, 
                `🎉 <b>تمت الموافقة!</b>\nلقد تم تفعيل حسابك بنجاح للعمل على بوت شركة [ ${emp.clientBotId.name} ].\nالرجاء إرسال أمر /start لفتح لوحة التحكم الخاصة بك.`, 
                { parse_mode: 'HTML' }
            ).catch(e => console.log('Failed to message client employee'));
            
        } catch (error) {
            console.error(error);
        }
    });

    bot.action(/banClientEmp_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري الحظر...').catch(() => {});
            const empId = ctx.match[1];
            const emp = await ClientEmployee.findById(empId).populate('clientBotId');
            if (!emp) return ctx.reply('❌ الموظف غير موجود.');
            emp.status = 'banned';
            await emp.save();
            await ctx.editMessageText(`❌ <b>تم رفض وحظر الموظف:</b> ${emp.name}\n🏢 <b>من شركة:</b> ${emp.clientBotId ? emp.clientBotId.name : 'غير محدد'}\n👨‍💻 <b>بواسطة الإداري:</b> ${ctx.from.first_name}`, { parse_mode: 'HTML' });
        } catch (error) { console.error(error); }
    });

    bot.action(/compFwd_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري التحويل للمنفذ...').catch(() => {}); 
            const txId = ctx.match[1];
            const tx = await Transaction.findById(txId);
            
            if (!tx) return ctx.reply('❌ الطلب غير موجود.');
            const execBot = await ExecutorBot.findById(tx.executorBotId);
            if (!execBot) return ctx.reply('❌ لم يتم العثور على بوت التنفيذ.');

            const execAPI = new Telegram(execBot.token);
            const reason = tx.complaintText || 'غير محدد';
            
            const operator = await Employee.findOne({ telegramId: tx.operatorId, botId: tx.executorBotId });
            const opName = operator ? operator.name : tx.operatorId;

            const msg = `⚠️ <b>شكوى تقنية موجهة إليك من العميل:</b>\n\n📞 الرقم: ${tx.vodafoneNumber || tx.accountNumber}\n💵 المبلغ: ${tx.amount} EGP\n🧾 الطلب: <code>${tx.customId || tx._id}</code>\n❌ السبب: ${reason}`;

            await execAPI.sendPhoto(tx.operatorId, tx.proofImage, {
                caption: msg,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ تم حل الشكوى', `execSolved_${tx._id}`)],
                    [Markup.button.callback('🛠 مشكلة فنية', `execTech_${tx._id}`)],
                    [Markup.button.callback('🔙 إرجاع للإدارة', `execReturn_${tx._id}`)]
                ])
            });

            const managers = await Employee.find({ botId: tx.executorBotId, role: 'manager' });
            if (managers.length > 0) {
                const mgrMsg = `🚨 <b>إشعار إداري: شكوى ضد موظف بفريقك</b>\n\n` +
                               `قامت الإدارة العليا بتحويل شكوى إلى موظف في فريقك للرد عليها:\n` +
                               `👤 <b>الموظف المنفذ:</b> ${opName}\n` +
                               `━━━━━━━━━━━━━━\n` +
                               `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                               `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber}</code>\n` +
                               `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                               `⚠️ <b>سبب الشكوى:</b> ${reason}\n\n` +
                               `⏳ <i>الموظف الآن مطالب بالرد وإرفاق إثبات لحل المشكلة.</i>`;
                
                for (const mgr of managers) {
                    await execAPI.sendMessage(mgr.telegramId, mgrMsg, { parse_mode: 'HTML' }).catch(() => {});
                }
            }

            await ctx.editMessageCaption(`🔄 تم تحويل الشكوى للمنفذ [ <b>${opName}</b> ] وإشعار مدير فريقه بنجاح.\n👨‍💻 بواسطة الإداري: ${ctx.from.first_name}`, { parse_mode: 'HTML' });
            
        } catch (error) {
            console.error(error);
        }
    });

    bot.action(/compCancel_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery('⏳ جاري الإلغاء وإعادة الرصيد...').catch(() => {}); 
            const txId = ctx.match[1];
            const tx = await Transaction.findById(txId);
            if (!tx) return;

            if (tx.clientBotId) {
                const comp = await ClientBot.findById(tx.clientBotId);
                if (comp) { comp.balance += tx.costLYD; await comp.save(); }
            } else {
                const user = await User.findOne({ telegramId: tx.userId });
                if (user) { user.balance += tx.costLYD; await user.save(); }
            }

            if (tx.executorBotId) {
                const execBot = await ExecutorBot.findById(tx.executorBotId);
                if (execBot) { execBot.balance += tx.amount; await execBot.save(); }
            }

            tx.status = 'cancelled_by_admin';
            await tx.save();

            await ctx.editMessageCaption(`❌ تم إلغاء العملية، وإعادة الرصيد للعميل، وخصم المبلغ من بوت التنفيذ.\n👨‍💻 تم الإلغاء بواسطة: ${ctx.from.first_name}`, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(error);
        }
    });

    bot.action(/compSolved_(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
            const txId = ctx.match[1];
            await ctx.scene.enter('RESOLVE_BY_ADMIN_SCENE', { txId });
        } catch (error) {
            console.error(error);
        }
    });

    bot.action(/forward_(.+)/, async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري المعالجة...').catch(() => {});
        return forwardTaskAction(ctx);
    });
    bot.action(/activate_(.+)/, async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري التفعيل...').catch(() => {});
        return activateUserAction(ctx);
    });
    bot.action(/assign_([^_]+)_(.+)/, async (ctx) => {
        await ctx.answerCbQuery('⏳ جاري الإرسال للمنفذ...').catch(() => {});
        return assignTaskAction(ctx);
    });
    bot.action(/empAccept_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        return manageEmployee(ctx, 'Accept');
    });
    bot.action(/empBan_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        return manageEmployee(ctx, 'Ban');
    });
    bot.action(/empRoleOp_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        return manageEmployee(ctx, 'RoleOp');
    });
    bot.action(/empRoleMgr_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        return manageEmployee(ctx, 'RoleMgr');
    });
    bot.action(/cancelReq_(.+)/, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        ctx.scene.enter('CANCEL_REASON_SCENE', { txId: ctx.match[1] });
    });

    // 🟢 أوامر قبول ورفض طلبات الإيداع من بوت الإدارة
    bot.action(/dep_reject_(.+)/, async (ctx) => {
        ctx.session.awaitingDepReject = ctx.match[1];
        ctx.reply('❌ الرجاء كتابة سبب رفض الإيداع لكي يصل للمنفذ:');
    });

    bot.action(/dep_accept_(.+)/, async (ctx) => {
        ctx.session.awaitingDepAccept = ctx.match[1];
        ctx.reply('📸 الرجاء إرسال صورة إيصال الإيداع الآن لإتمام العملية بنجاح:');
    });

    bot.on('text', async (ctx, next) => {
        if (ctx.session.awaitingDepReject) {
            const reason = ctx.message.text;
            const txId = ctx.session.awaitingDepReject;
            ctx.session.awaitingDepReject = null;

            try {
                const tx = await Transaction.findById(txId);
                if (tx && tx.status === 'deposit_pending') {
                    tx.status = 'rejected';
                    tx.notes = `سبب الرفض: ${reason}`;
                    tx.updatedAt = new Date();
                    
                    await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'error', text: `تم رفض طلب الإيداع بقيمة ${tx.amount} EGP.<br><b>السبب:</b> ${reason}` } } }, { strict: false });
                    await tx.save();

                    const execBot = await ExecutorBot.findById(tx.executorBotId);
                    if (execBot) {
                        const execAPI = new Telegram(execBot.token);
                        await execAPI.sendMessage(tx.operatorId, `❌ <b>تم رفض طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP\nالسبب: ${reason}`, { parse_mode: 'HTML' }).catch(()=>{});
                    }
                    ctx.reply('✅ تم رفض الطلب وإشعار المنفذ بالسبب.');
                }
            } catch (e) { ctx.reply('❌ حدث خطأ.'); }
        } else { return next(); }
    });

    bot.on('photo', async (ctx, next) => {
        if (ctx.session.awaitingDepAccept) {
            const txId = ctx.session.awaitingDepAccept;
            ctx.session.awaitingDepAccept = null;

            try {
                const tx = await Transaction.findById(txId);
                if (tx && tx.status === 'deposit_pending') {
                    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                    tx.status = 'deposit';
                    tx.proofImage = fileId;
                    tx.updatedAt = new Date();
                    
                    await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع بقيمة ${tx.amount} EGP وتمت إضافة الرصيد لحسابك بنجاح.`, imageUrl: `/proxy/image/${tx._id}/0` } } }, { strict: false });
                    await tx.save();

                    const execBot = await ExecutorBot.findById(tx.executorBotId);
                    if (execBot) {
                        execBot.balance += tx.amount;
                        await execBot.save();
                        
                        const execAPI = new Telegram(execBot.token);
                        await execAPI.sendPhoto(tx.operatorId, fileId, { caption: `✅ <b>تم الموافقة على طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP`, parse_mode: 'HTML' }).catch(()=>{});
                    }
                    ctx.reply('✅ تم قبول الإيداع وإضافة الرصيد للمنفذ بنجاح!');
                }
            } catch (e) { ctx.reply('❌ حدث خطأ.'); }
        } else { return next(); }
    });

    bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log('[Admin Bot] Multi-Admin System is running with High Performance 🛡️🚀');
        bot.telegram.setMyCommands([
            { command: 'start', description: '🏠 القائمة الرئيسية (تحديث)' }
        ]).catch(()=>{});
    });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

module.exports = startAdminBot;
