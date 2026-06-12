// bots/executor/scenes/employeeRegisterScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Employee = require('../../../models/Employee');
const Admin = require('../../../models/Admin'); 

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

const employeeRegisterWizard = new Scenes.WizardScene(
    'EMP_REGISTER_SCENE',
    async (ctx) => {
        await ctx.reply('مرحباً بك في نظام التنفيذ الآلي 🛡️\n\n📝 <b>للتسجيل، يرجى إرسال اسمك الثلاثي:</b>', {parse_mode: 'HTML'});
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const name = ctx.message.text;
        
        if (name.split(' ').length < 2) {
            await ctx.reply('❌ يرجى كتابة اسمك بشكل كامل (ثنائي على الأقل):');
            return;
        }

        ctx.wizard.state.name = name;
        await ctx.reply(
            `أهلاً بك يا ${name} 🤝\n\n📱 <b>للتحقق من هويتك:</b> يرجى الضغط على الزر بالأسفل لمشاركة رقم هاتفك المربوط بحساب تليجرام هذا:`,
            {
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    [Markup.button.contactRequest('📱 مشاركة رقم الهاتف للتحقق')]
                ]).oneTime().resize()
            }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.contact) {
            await ctx.reply('❌ يجب عليك استخدام الزر الموجود بالأسفل لمشاركة رقمك الفعلي.');
            return;
        }

        const contact = ctx.message.contact;

        if (contact.user_id !== ctx.from.id) {
            await ctx.reply('❌ عذراً، لا يمكنك مشاركة رقم شخص آخر! يجب مشاركة رقم حسابك الحالي.');
            return;
        }

        const telegramId = ctx.from.id.toString();
        const phone = contact.phone_number;
        const botData = ctx.scene.state.botData; 

        try {
            // تسجيل الموظف في قاعدة البيانات
            const newEmp = await Employee.create({
                telegramId,
                name: ctx.wizard.state.name,
                phone,
                botId: botData._id,
                role: 'operator', // الحالة الافتراضية
                status: 'pending', 
                adminMessages: [] 
            });

            await ctx.reply(
                '✅ <b>تم استلام بياناتك بنجاح.</b>\n\n' +
                '⏳ حسابك الآن <b>قيد المراجعة</b>. سيصلك إشعار فور قبولك وتحديد صلاحياتك (مدير/منفذ).',
                { parse_mode: 'HTML', ...Markup.removeKeyboard() }
            );

            // 1️⃣ إرسال التنبيه لمديري هذا البوت التنفيذي المباشرين (للموظفين العاديين)
            const managers = await Employee.find({ botId: botData._id, role: 'manager', status: 'active' });
            const mgrMsgText = `🚨 <b>تنبيه عاجل | طلب تسجيل موظف جديد</b>\n\n` +
                            `👤 <b>الاسم:</b> ${ctx.wizard.state.name}\n` +
                            `📱 <b>الهاتف:</b> <code>${phone}</code>\n` +
                            `🆔 <b>الأيدي:</b> <code>${telegramId}</code>`;
                            
            const mgrKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ قبول الموظف', `mgrApproveEmp_${newEmp._id}`)],
                [Markup.button.callback('⛔️ حظر ورفض', `mgrRejectEmp_${newEmp._id}`)]
            ]);

            for (const mgr of managers) {
                try {
                    await ctx.telegram.sendMessage(mgr.telegramId, mgrMsgText, { parse_mode: 'HTML', ...mgrKeyboard });
                } catch (e) { } 
            }

            // 2️⃣ 🟢 إرسال الإشعار للإدارة العليا مع أزرار التحكم الشاملة (مدير / منفذ)
            const admins = await Admin.find({ telegramId: { $exists: true, $ne: null } });
            const adminMsgText = `🚨 <b>تنبيه | طلب انضمام لفريق التنفيذ</b>\n\n` +
                            `🤖 <b>البوت:</b> ${botData.name}\n` +
                            `👤 <b>الاسم:</b> ${ctx.wizard.state.name}\n` +
                            `📱 <b>الهاتف:</b> <code>${phone}</code>\n` +
                            `🆔 <b>الأيدي:</b> <code>${telegramId}</code>`;

            const adminKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('👨‍💼 قبول كمدير (وكيل)', `empRoleMgr_${newEmp._id}`)],
                [Markup.button.callback('✅ قبول كموظف عادي', `empRoleOp_${newEmp._id}`)],
                [Markup.button.callback('⛔️ رفض وحظر', `empBan_${newEmp._id}`)]
            ]);

            for (const admin of admins) {
                try {
                    const sentMsg = await adminBotAPI.sendMessage(admin.telegramId, adminMsgText, { parse_mode: 'HTML', ...adminKeyboard });
                    newEmp.adminMessages.push({
                        telegramId: admin.telegramId,
                        messageId: sentMsg.message_id
                    });
                } catch (e) { } 
            }
            
            await newEmp.save();

        } catch (error) {
            console.error(error);
            await ctx.reply('❌ حدث خطأ، ربما أنت مسجل بالفعل في النظام.', Markup.removeKeyboard());
        }

        return ctx.scene.leave();
    }
);

module.exports = employeeRegisterWizard;