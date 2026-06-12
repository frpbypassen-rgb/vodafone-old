// bots/admin/scenes/rechargeCompanyScene.js
const { Scenes, Markup } = require('telegraf');
const ClientBot = require('../../../models/ClientBot');
const { recordBalanceAdjustment, parseSignedAmount } = require('../../../services/balanceAdjustmentService');

const rechargeCompanyWizard = new Scenes.WizardScene(
    'RECHARGE_COMPANY_SCENE',
    
    // 📍 الخطوة الأولى: عرض الشركات
    async (ctx) => {
        try {
            const companies = await ClientBot.find({});
            if (companies.length === 0) {
                await ctx.reply('❌ لا توجد شركات (بوتات عملاء) مسجلة في النظام حتى الآن.');
                return ctx.scene.leave();
            }

            // توليد أزرار بأسماء الشركات مع الرصيد الحالي
            const buttons = companies.map(c => [Markup.button.callback(`🏢 ${c.name} (رصيد: ${c.balance})`, `chargeComp_${c._id}`)]);
            buttons.push([Markup.button.callback('🔙 إلغاء ورجوع', 'cancel_recharge')]);

            await ctx.reply('👇 <b>اختر الشركة التي تريد إضافة رصيد لها:</b>', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            });
            return ctx.wizard.next();
        } catch (err) {
            console.error(err);
            return ctx.scene.leave();
        }
    },

    // 📍 الخطوة الثانية: استقبال اختيار الشركة وطلب المبلغ
    async (ctx) => {
        if (!ctx.callbackQuery) return; 
        
        if (ctx.callbackQuery.data === 'cancel_recharge') {
            await ctx.editMessageText('✅ تم إلغاء عملية الشحن والرجوع للقائمة.');
            return ctx.scene.leave();
        }

        if (ctx.callbackQuery.data.startsWith('chargeComp_')) {
            const companyId = ctx.callbackQuery.data.replace('chargeComp_', '');
            ctx.wizard.state.companyId = companyId;

            const company = await ClientBot.findById(companyId);
            if (!company) {
                await ctx.editMessageText('❌ لم يتم العثور على هذه الشركة.');
                return ctx.scene.leave();
            }

            await ctx.editMessageText(
                `🏢 <b>الشركة:</b> ${company.name}\n💰 <b>الرصيد الحالي:</b> ${company.balance} دينار\n\n💸 <b>الرجاء إرسال المبلغ المراد إضافته (بالأرقام):</b>`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء ورجوع', 'cancel_recharge')]])
                }
            );
            return ctx.wizard.next();
        }
    },

    // 📍 الخطوة الثالثة: استقبال المبلغ وتنفيذ الشحن والتوثيق
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_recharge') {
            await ctx.editMessageText('✅ تم إلغاء عملية الشحن والرجوع للقائمة.');
            return ctx.scene.leave();
        }

        if (!ctx.message || !ctx.message.text) return;
        let amount;
        try {
            amount = parseSignedAmount(ctx.message.text);
        } catch (_) {
            return ctx.reply('❌ مبلغ غير صالح! يرجى إرسال رقم صحيح.');
        }
        if (amount <= 0) return ctx.reply('❌ مبلغ غير صالح! يرجى إرسال رقم صحيح.');

        try {
            const company = await ClientBot.findById(ctx.wizard.state.companyId);
            if (!company) return ctx.scene.leave();

            const result = await recordBalanceAdjustment({
                entityModel: 'ClientBot',
                entityId: company._id,
                amount,
                transactionData: {
                    userId: ctx.from.id.toString(),
                    clientBotId: company._id,
                    vodafoneNumber: '01000000000',
                    companyName: company.name,
                    employeeName: 'الإدارة (إيداع)'
                },
                description: `إيداع رصيد شركة ${company.name} من بوت الإدارة`
            });
            company.balance = result.balanceAfter;

            await ctx.reply(`✅ <b>تم الشحن وتوثيق العملية بنجاح!</b>\n\n🏢 <b>الشركة:</b> ${company.name}\n➕ <b>المبلغ المضاف:</b> ${amount} دينار\n💰 <b>الرصيد الجديد:</b> ${company.balance} دينار`, { parse_mode: 'HTML' });

        } catch (error) {
            console.error('Recharge Error:', error);
            await ctx.reply('❌ حدث خطأ داخلي أثناء الحفظ.');
        }
        return ctx.scene.leave();
    }
);

module.exports = rechargeCompanyWizard;
