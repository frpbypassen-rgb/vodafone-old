// bots/admin/scenes/clientControlScene.js
const { Scenes, Markup } = require('telegraf');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');
const ClientEmployee = require('../../../models/ClientEmployee');
const Transaction = require('../../../models/Transaction');
const { recordBalanceAdjustment, parseSignedAmount } = require('../../../services/balanceAdjustmentService');

// 🛠️ دالة مساعدة لإنشاء الإكسيل
const buildExcelReport = async (ctx, targetId, targetType, targetName, targetPhone, reportType) => {
    const now = new Date();
    let start, end, dateLabel;
    
    if (reportType === 'daily') {
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end = new Date(now); end.setHours(23, 59, 59, 999);
        dateLabel = start.toLocaleDateString('en-GB');
    } else {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        dateLabel = `${now.getMonth() + 1}-${now.getFullYear()}`;
    }

    const filter = targetType === 'USER' ? { userId: targetId, clientBotId: null } : { clientBotId: targetId };
    
    const txs = await Transaction.find({ status: 'completed', ...filter, updatedAt: { $gte: start, $lte: end } }).sort({ updatedAt: 1 });
    const deposits = await Transaction.find({ status: 'deposit', ...filter, updatedAt: { $gte: start, $lte: end } });
    
    if (txs.length === 0 && deposits.length === 0) return ctx.reply('✅ لا توجد عمليات لهذا الحساب في هذه الفترة.');

    let totalEGP = 0, totalLYD = 0, totalDeposits = 0;
    txs.forEach(t => { totalEGP += t.amount; totalLYD += t.costLYD; });
    deposits.forEach(d => totalDeposits += d.amount);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('تقرير إداري');
    sheet.views = [{ rightToLeft: true }];
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    sheet.mergeCells('A1:G2');
    sheet.getCell('A1').value = `تقرير إداري - ${targetName}`;
    sheet.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002060' } };
    sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };

    sheet.addRow([]);
    const header = sheet.addRow(['رقم الحوالة', 'الموظف', 'رقم الهاتف', 'القيمة (EGP)', 'سعر الصرف', 'التكلفة (LYD)', 'التاريخ']);
    header.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } }; c.border = borderStyle; });

    txs.forEach(t => {
        sheet.addRow([t.customId, t.employeeName || targetName, t.vodafoneNumber, t.amount, (t.costLYD/t.amount).toFixed(3), t.costLYD, t.updatedAt.toLocaleDateString('en-GB')]).eachCell(c => { c.border = borderStyle; c.alignment = { horizontal: 'center' };});
    });

    sheet.addRow([]);
    sheet.addRow(['', '', '', '', 'إجمالي (EGP):', totalEGP]).getCell(6).font = { bold: true, color: { argb: 'FF0000FF' } };
    sheet.addRow(['', '', '', '', 'إجمالي السحوبات (LYD):', totalLYD]).getCell(6).font = { bold: true };
    sheet.addRow(['', '', '', '', 'إجمالي الإيداعات (LYD):', totalDeposits]).getCell(6).font = { bold: true };
    
    sheet.columns.forEach(col => col.width = 16);
    
    const buffer = await workbook.xlsx.writeBuffer();
    await ctx.replyWithDocument({ source: buffer, filename: `AdminReport_${targetName.replace(/\s+/g, '_')}.xlsx` }, { caption: `✅ التقرير ${reportType === 'daily' ? 'اليومي' : 'الشهري'} المطلوب.` });
};

// 🛠️ دالة بناء وعرض البطاقة (محصنة تماماً ضد أخطاء Edit)
const renderClientCard = async (ctx, targetType, targetObj, loadingMsgId = null) => {
    let name = targetObj.name;
    let phone = targetObj.phone;
    let balance = targetObj.balance;
    let limit = targetObj.creditLimit || 0;
    let tier = targetObj.tier || 1;
    let status = targetObj.status;
    
    let isBanned = status === 'banned';
    let isActive = status === 'active';

    let card = `🪪 <b>لوحة تحكم: ${targetType === 'USER' ? 'عميل فردي' : 'شركة'}</b>\n` +
               `━━━━━━━━━━━━━━\n` +
               `👤 <b>الاسم:</b> ${name}\n` +
               `📱 <b>الهاتف:</b> <code>${phone}</code>\n` +
               `💰 <b>الرصيد:</b> ${balance} دينار\n` +
               `💳 <b>الحد الائتماني:</b> ${limit} دينار\n` +
               `🎚️ <b>المستوى السري:</b> ${tier}\n` +
               `🚦 <b>الحالة:</b> ${isBanned ? '🔴 محظور' : (isActive ? '🟢 نشط' : '🟡 معلق/غير نشط')}\n`;

    if (targetType === 'COMPANY') {
        const emps = await ClientEmployee.find({ clientBotId: targetObj._id });
        card += `👥 <b>عدد الموظفين:</b> ${emps.length}\n`;
    }

    const buttons = [
        [Markup.button.callback('📱 تغيير الهاتف', 'action_phone'), Markup.button.callback('📝 تغيير الاسم', 'action_name')],
        [Markup.button.callback('🎚️ تغيير المستوى', 'action_tier'), Markup.button.callback('💳 تعديل الحد الائتماني', 'action_limit')],
        [Markup.button.callback(isActive ? '⏸️ إيقاف الحساب' : '▶️ تفعيل الحساب', 'action_toggle_status'), Markup.button.callback(isBanned ? '🔓 إلغاء الحظر' : '🚫 حظر وطرد', 'action_toggle_ban')],
        [Markup.button.callback('➕ إضافة إيداع (شحن)', 'action_deposit')],
        [Markup.button.callback('📊 تقرير يومي', 'action_report_daily'), Markup.button.callback('🗓 تقرير شهري', 'action_report_monthly')],
        [Markup.button.callback('🔍 بحث عن عميل آخر', 'action_new_search'), Markup.button.callback('🔙 إغلاق', 'action_close')]
    ];

    try {
        if (loadingMsgId) {
            // 🚀 التعديل الآمن: نعدل رسالة التحميل الخاصة بالبوت باستخدام معرفها الصريح
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsgId, null, card, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        } else if (ctx.callbackQuery) {
            // 🚀 التعديل الآمن: عند ضغط زر نقوم بتعديل نفس الرسالة التي تحوي الزر
            await ctx.editMessageText(card, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
        } else {
            // 🚀 البديل الآمن: إذا لم نتمكن من التعديل، نرسل رسالة جديدة فوراً
            await ctx.reply(card, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        }
    } catch (err) {
        console.error("Card Render Error:", err.message);
        // في حالة الفشل لأي سبب، نرسل رسالة جديدة لضمان عدم توقف النظام
        await ctx.reply(card, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
    }
};

// 🚀 المشهد الرئيسي للتحكم
const clientControlWizard = new Scenes.WizardScene(
    'CLIENT_CONTROL_SCENE',
    // الخطوة 1
    async (ctx) => {
        await ctx.reply(
            '⚙️ <b>نـظـام الـتـحـكـم فـي الـعـمـلاء والـشـركـات</b>\n\nالرجاء إرسال رقم هاتف العميل/الشركة <b>أو</b> رقم الـ ID:',
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء ورجوع', 'action_close')]]) }
        );
        return ctx.wizard.next();
    },
    // الخطوة 2
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'action_close') { await ctx.editMessageText('✅ تم الإغلاق.'); return ctx.scene.leave(); }
        
        const input = ctx.message?.text?.trim();
        if (!input) return;

        // إرسال رسالة تحميل وأخذ معرفها لكي نعدلها لاحقاً (هذا هو مفتاح حل المشكلة)
        const loadingMsg = await ctx.reply('⏳ جاري تحميل لوحة التحكم...');

        let target = await User.findOne({ $or: [{ phone: input }, { telegramId: input }] });
        let type = 'USER';

        if (!target) {
            target = await ClientBot.findOne({ phone: input });
            type = 'COMPANY';
        }
        if (!target && mongoose.Types.ObjectId.isValid(input)) {
            target = await ClientBot.findById(input);
            type = 'COMPANY';
        }
        if (!target) {
            const emp = await ClientEmployee.findOne({ $or: [{ phone: input }, { telegramId: input }] }).populate('clientBotId');
            if (emp && emp.clientBotId) {
                target = emp.clientBotId;
                type = 'COMPANY';
            }
        }

        if (!target) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, '❌ لم يتم العثور على العميل أو الشركة. تأكد من الرقم:');
            return;
        }

        ctx.wizard.state.targetId = type === 'USER' ? target.telegramId : target._id;
        ctx.wizard.state.targetType = type;
        
        // استدعاء دالة بناء البطاقة مع تمرير معرف رسالة التحميل لتعديلها
        await renderClientCard(ctx, type, target, loadingMsg.message_id);
        return ctx.wizard.next();
    },
    // الخطوة 3
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const action = ctx.callbackQuery.data;
        const { targetId, targetType } = ctx.wizard.state;

        let targetObj = targetType === 'USER' ? await User.findOne({ telegramId: targetId }) : await ClientBot.findById(targetId);
        if (!targetObj) return ctx.scene.leave();

        if (action === 'action_close') { await ctx.editMessageText('✅ تم إغلاق لوحة التحكم.'); return ctx.scene.leave(); }
        if (action === 'action_new_search') { ctx.wizard.selectStep(0); return ctx.wizard.steps[0](ctx); }

        if (action === 'action_report_daily') { await ctx.answerCbQuery('جاري التوليد...'); return buildExcelReport(ctx, targetId, targetType, targetObj.name, targetObj.phone, 'daily'); }
        if (action === 'action_report_monthly') { await ctx.answerCbQuery('جاري التوليد...'); return buildExcelReport(ctx, targetId, targetType, targetObj.name, targetObj.phone, 'monthly'); }

        if (action === 'action_toggle_status') {
            targetObj.status = targetObj.status === 'active' ? 'pending' : 'active';
            await targetObj.save();
            return renderClientCard(ctx, targetType, targetObj); // تحديث البطاقة
        }
        if (action === 'action_toggle_ban') {
            targetObj.status = targetObj.status === 'banned' ? 'active' : 'banned';
            await targetObj.save();
            return renderClientCard(ctx, targetType, targetObj); // تحديث البطاقة
        }

        const promptMap = {
            'action_phone': '📱 أرسل رقم الهاتف الجديد:',
            'action_name': '📝 أرسل الاسم الجديد:',
            'action_tier': '🎚️ أرسل رقم المستوى الجديد (1 أو 2 أو 3):',
            'action_limit': '💳 أرسل قيمة الحد الائتماني الجديد:',
            'action_deposit': '➕ أرسل قيمة الإيداع (الشحن) بالأرقام:'
        };

        if (promptMap[action]) {
            ctx.wizard.state.pendingAction = action;
            await ctx.reply(`👉 ${promptMap[action]}`, Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء الإدخال', 'cancel_input')]]));
            return ctx.wizard.next();
        }
    },
    // الخطوة 4
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_input') {
            await ctx.deleteMessage().catch(() => {});
            ctx.wizard.selectStep(2);
            return;
        }

        const input = ctx.message?.text;
        if (!input) return;

        const { targetId, targetType, pendingAction } = ctx.wizard.state;
        let targetObj = targetType === 'USER' ? await User.findOne({ telegramId: targetId }) : await ClientBot.findById(targetId);

        try {
            if (pendingAction === 'action_phone') targetObj.phone = input;
            if (pendingAction === 'action_name') targetObj.name = input;
            if (pendingAction === 'action_tier') {
                const t = parseInt(input);
                if (![1,2,3].includes(t)) return ctx.reply('❌ قيمة خاطئة. أرسل 1 أو 2 أو 3.');
                targetObj.tier = t;
            }
            if (pendingAction === 'action_limit') {
                const l = parseFloat(input);
                if (isNaN(l)) return ctx.reply('❌ رقم غير صالح.');
                targetObj.creditLimit = l;
            }
            if (pendingAction === 'action_deposit') {
                let amount;
                try {
                    amount = parseSignedAmount(input);
                } catch (_) {
                    return ctx.reply('❌ رقم غير صالح.');
                }
                if (amount <= 0) return ctx.reply('❌ رقم غير صالح.');

                const result = await recordBalanceAdjustment({
                    entityModel: targetType === 'COMPANY' ? 'ClientBot' : 'User',
                    entityId: targetObj._id,
                    amount,
                    transactionData: {
                        userId: targetType === 'COMPANY' ? ctx.from.id.toString() : targetObj.telegramId,
                        clientBotId: targetType === 'COMPANY' ? targetObj._id : null,
                        vodafoneNumber: '01000000000',
                        companyName: targetType === 'COMPANY' ? targetObj.name : 'عميل فردي',
                        employeeName: 'الإدارة العليا'
                    },
                    description: targetType === 'COMPANY' ? `إيداع رصيد شركة ${targetObj.name}` : `إيداع رصيد عميل ${targetObj.name}`
                });
                targetObj.balance = result.balanceAfter;
                await ctx.reply(`✅ تم إضافة إيداع بقيمة ${amount} بنجاح.`);
            }

            await targetObj.save();
            await ctx.reply('✅ تم حفظ التعديلات بنجاح.');
            
            ctx.wizard.selectStep(2);
            // إرسال البطاقة كرسالة جديدة في النهاية
            await renderClientCard(ctx, targetType, targetObj);

        } catch (error) {
            console.error(error);
            ctx.reply('❌ حدث خطأ أثناء الحفظ.');
        }
    }
);

module.exports = clientControlWizard;
