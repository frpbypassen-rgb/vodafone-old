// bots/admin/actions/assignTask.js
const { Telegram, Markup } = require('telegraf'); 
const Transaction = require('../../../models/Transaction');
const ExecutorBot = require('../../../models/ExecutorBot');
const Employee = require('../../../models/Employee');
const ClientBot = require('../../../models/ClientBot'); // 🟢 جلب نموذج بوت العميل لسحب صورة البطاقة إن وجدت

module.exports = async (ctx) => {
    try {
        const txId = ctx.match[1];
        const botId = ctx.match[2];

        const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') {
            return ctx.answerCbQuery('❌ الطلب غير متاح.', { show_alert: true });
        }

        const execBot = await ExecutorBot.findById(botId);
        if (!execBot) {
            return ctx.answerCbQuery('❌ البوت التنفيذي غير موجود.', { show_alert: true });
        }

        tx.status = 'processing';
        tx.executorBotId = execBot._id;
        tx.broadcastMessages = []; 

        if (tx.adminMessages && tx.adminMessages.length > 0) {
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            for (const adminMsg of tx.adminMessages) {
                await adminAPI.deleteMessage(adminMsg.telegramId, adminMsg.messageId).catch(() => {});
            }
            tx.adminMessages = [];
        }

        await tx.save();

        const execBotAPI = new Telegram(execBot.token);
        const displayId = tx.customId || tx._id.toString();

        const allEmployees = await Employee.find({});
        const activeStaff = allEmployees.filter(emp => 
            emp.botId && 
            emp.botId.toString() === execBot._id.toString() && 
            emp.status === 'active'
        );

        const managers = activeStaff.filter(emp => emp.role === 'manager' || emp.role === 'Manager');
        const operators = activeStaff.filter(emp => emp.role === 'operator' || emp.role === 'Operator');
        const allStaff = [...managers, ...operators];

        if (allStaff.length === 0) {
            return ctx.answerCbQuery('⚠️ البوت سليم لكن لم نجد أي مدير أو موظف مفعل داخله!', { show_alert: true });
        }

        let successCount = 0;

        // 🟢 تجهيز البيانات بناءً على نوع التحويل لترسل للمنفذ
        let typeLabel = '📱 فودافون كاش';
        if(tx.transferType === 'post_account') typeLabel = '📮 حساب بريد';
        if(tx.transferType === 'post_card') typeLabel = '💳 بطاقة عميل';

        let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
        if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;
        const noteDisplay = tx.notes ? `\n📝 <b>الملاحظة:</b> ${tx.notes}` : '';

        const msg = `🔔 <b>مهمة تحويل جديدة من الإدارة! (${typeLabel})</b>\n\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🧾 <b>رقم الطلب:</b> <code>${displayId}</code>${noteDisplay}`;

        // 🟢 سحب صورة البطاقة (إن وجدت) لكي يتم إرسالها للمنفذ
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

        for (const member of allStaff) {
            try {
                const isManager = managers.some(m => m.telegramId === member.telegramId);
                const btnText = isManager ? '🤝 قبول المهمة (كمدير)' : '🤝 قبول المهمة';
                const markup = { inline_keyboard: [[{ text: btnText, callback_data: `accept_task_${tx._id}` }]] };

                let sentMsg;
                // 🟢 إرسال الطلب للموظف كصورة (إن كانت بطاقة بريد) أو نص عادي
                if (idUrl) {
                    sentMsg = await execBotAPI.sendPhoto(member.telegramId, { url: idUrl }, { caption: msg, parse_mode: 'HTML', reply_markup: markup }).catch(() => execBotAPI.sendMessage(member.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup }));
                } else {
                    sentMsg = await execBotAPI.sendMessage(member.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup });
                }

                if (sentMsg) {
                    tx.broadcastMessages.push({
                        telegramId: member.telegramId, 
                        messageId: sentMsg.message_id
                    });
                    successCount++;
                }
            } catch (err) {}
        }

        await tx.save();

        await ctx.answerCbQuery(`✅ تم التحويل بنجاح لبوت: ${execBot.name}\n🔔 تم إشعار ${successCount} موظف.`, { show_alert: true });

        // 🟢 إخفاء الطلب من الإدارة لمنع الضغط المزدوج مع تحديث نوع الطلب في الإشعار
        await ctx.editMessageText(
            `✅ <b>تـم تـحـويـل الـطـلـب! (${typeLabel})</b>\n\n` +
            `🧾 <b>رقم الطلب:</b> <code>${displayId}</code>\n` +
            `🤖 <b>أرسل إلى بوت:</b> [ ${execBot.name} ]\n` +
            `👨‍💻 <b>بواسطة الإداري:</b> ${ctx.from.first_name}`,
            { parse_mode: 'HTML' }
        ).catch(()=>{});

    } catch (error) {
        console.error('[Assign Task Error]:', error);
        ctx.answerCbQuery('❌ حدث خطأ فني.', { show_alert: true });
    }
};