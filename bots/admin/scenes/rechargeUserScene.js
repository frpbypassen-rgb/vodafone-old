// bots/admin/scenes/rechargeUserScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const User = require('../../../models/User');
const { recordBalanceAdjustment, parseSignedAmount } = require('../../../services/balanceAdjustmentService');

const clientBotAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);

const rechargeUserWizard = new Scenes.WizardScene(
    'RECHARGE_USER_SCENE',
    
    // 📍 الخطوة 1: طلب رقم هاتف العميل
    async (ctx) => {
        await ctx.reply(
            '💳 <b>شحن رصيد عميل فردي</b>\n\n📞 من فضلك أرسل <b>رقم هاتف العميل</b> المسجل في النظام:',
            { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء الإجراء', 'cancel_recharge')]])
            }
        );
        return ctx.wizard.next();
    },

    // 📍 الخطوة 2: البحث عن العميل وطلب المبلغ
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_recharge') {
            await ctx.answerCbQuery().catch(() => {});
            await ctx.editMessageText('❌ تم إلغاء عملية الشحن.');
            return ctx.scene.leave();
        }

        const phone = ctx.message?.text?.trim();
        if (!phone) return ctx.reply('⚠️ يرجى كتابة رقم الهاتف بشكل صحيح:');

        // البحث عن العميل في قاعدة البيانات
        const user = await User.findOne({ phone: phone });
        
        if (!user) {
            await ctx.reply('❌ <b>لم يتم العثور على عميل بهذا الرقم!</b>\nتأكد من الرقم وحاول مجدداً، أو اضغط إلغاء.', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء', 'cancel_recharge')]])
            });
            return; // البقاء في نفس الخطوة حتى يدخل رقماً صحيحاً
        }

        ctx.wizard.state.user = user;

        await ctx.reply(
            `👤 <b>بيانات العميل:</b>\nالاسم: ${user.name}\nالرصيد الحالي: ${user.balance.toFixed(2)} دينار\n\n💰 <b>أرسل الآن المبلغ المراد إيداعه (بالدينار):</b>`,
            { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء الإجراء', 'cancel_recharge')]])
            }
        );
        return ctx.wizard.next();
    },

    // 📍 الخطوة 3: تنفيذ الإيداع، حفظ التقرير، وإشعار العميل
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_recharge') {
            await ctx.answerCbQuery().catch(() => {});
            await ctx.editMessageText('❌ تم إلغاء عملية الشحن.');
            return ctx.scene.leave();
        }

        let amount;
        try {
            amount = parseSignedAmount(ctx.message?.text);
        } catch (_) {
            return ctx.reply('⚠️ يرجى إدخال مبلغ صحيح (أرقام فقط أكبر من الصفر):');
        }
        if (amount <= 0) return ctx.reply('⚠️ يرجى إدخال مبلغ صحيح (أرقام فقط أكبر من الصفر):');

        const user = ctx.wizard.state.user;

        try {
            await ctx.reply('⏳ جاري إضافة الرصيد وتوثيق العملية...');

            const result = await recordBalanceAdjustment({
                entityModel: 'User',
                entityId: user._id,
                amount,
                transactionData: {
                    userId: user.telegramId,
                    clientBotId: null,
                    exchangeRate: 1,
                    vodafoneNumber: 'إيداع نقدي',
                    companyName: 'عميل فردي',
                    employeeName: 'الإدارة (إيداع)'
                },
                description: 'إيداع نقدي لعميل فردي من بوت الإدارة'
            });
            user.balance = result.balanceAfter;
            const depositTx = result.transaction;

            const notifyMsg = `💰 <b>إشعار إيداع نقدي</b>\n\n` +
                              `مرحباً <b>${user.name}</b>،\n` +
                              `✅ تم سداد وإيداع مبلغ <b>${amount.toFixed(2)} دينار</b> في حسابك بنجاح.\n\n` +
                              `💳 <b>رصيدك الحالي أصبح:</b> ${user.balance.toFixed(2)} دينار\n` +
                              `🧾 <b>رقم الإيصال:</b> <code>${depositTx.customId}</code>\n\n` +
                              `شكراً لثقتك بمنظومة الأهرام 🚀`;
                              
            await clientBotAPI.sendMessage(user.telegramId, notifyMsg, { parse_mode: 'HTML' }).catch(() => {
                console.error(`Failed to notify user ${user.telegramId}`);
            });

            await ctx.reply(
                `✅ <b>تم شحن الرصيد بنجاح!</b>\n\n` +
                `👤 العميل: ${user.name}\n` +
                `💵 المبلغ المضاف: ${amount.toFixed(2)}\n` +
                `💳 الرصيد الجديد: ${user.balance.toFixed(2)}\n` +
                `📱 تم إرسال إشعار للعميل.`,
                { parse_mode: 'HTML' }
            );

        } catch (error) {
            console.error('Recharge Error:', error);
            await ctx.reply('❌ حدث خطأ فني أثناء عملية الشحن.');
        }

        return ctx.scene.leave();
    }
);

module.exports = rechargeUserWizard;
