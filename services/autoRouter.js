// services/autoRouter.js
const { Telegram } = require('telegraf');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ExecutorBot = require('../models/ExecutorBot');
const Employee = require('../models/Employee');
const { updateClientTracking } = require('./clientTrackingService');

const processAutoRoute = async (txId) => {
    try {
        // 1. فحص هل ميزة التوجيه التلقائي مفعلة
        const settings = await Settings.findOne({});
        if (!settings || !settings.autoRouteEnabled || !settings.autoRouteBotId) return false;

        // 2. فحص العملية والبوت التنفيذي
        const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') return false;

        const execBot = await ExecutorBot.findById(settings.autoRouteBotId);
        if (!execBot || execBot.status !== 'active') {
            console.warn('⚠️ [Auto-Router]: البوت الهدف غير نشط. تم إيقاف التوجيه التلقائي لهذه العملية.');
            return false;
        }

        // 3. تحديث حالة العملية لـ Processing وإسنادها للبوت
        tx.status = 'processing';
        tx.executorBotId = execBot._id;
        tx.executorBotName = execBot.name;
        tx.managerBotId = execBot.parentBotId || null;
        tx.broadcastMessages = [];
        
        // مسح رسائل الإدارة إن وُجدت (لأنها ذهبت للتنفيذ فوراً)
        if (tx.adminMessages && tx.adminMessages.length > 0) {
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            for (const msg of tx.adminMessages) {
                await adminAPI.deleteMessage(msg.telegramId, msg.messageId).catch(() => {});
            }
            tx.adminMessages = [];
        }

        await tx.save();
        await updateClientTracking(tx._id, 'processing'); // تحديث لوحة العميل

        // 4. بث الرسالة للموظفين داخل هذا البوت التنفيذي
        const execBotAPI = new Telegram(execBot.token);
        const activeStaff = await Employee.find({ botId: execBot._id, status: 'active' });
        
        if (activeStaff.length === 0) return true; // لا يوجد موظفين حالياً ولكن تم التوجيه

        let typeLabel = tx.transferType === 'post_account' ? '📮 حساب بريد' : (tx.transferType === 'post_card' ? '💳 بطاقة عميل' : '📱 فودافون كاش');
        let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
        const noteDisplay = tx.notes ? `\n📝 <b>الملاحظة:</b> ${tx.notes}` : '';
        const msg = `⚡ <b>توجيه تلقائي من النظام! (${typeLabel})</b>\n\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>${noteDisplay}`;

        for (const member of activeStaff) {
            try {
                const isManager = member.role === 'manager';
                const btnText = isManager ? '🤝 قبول المهمة (كمدير)' : '🤝 قبول المهمة';
                const markup = { inline_keyboard: [[{ text: btnText, callback_data: `accept_task_${tx._id}` }]] };
                
                const sentMsg = await execBotAPI.sendMessage(member.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup });
                if (sentMsg) tx.broadcastMessages.push({ telegramId: member.telegramId, messageId: sentMsg.message_id });
            } catch (err) {}
        }
        
        await tx.save();
        console.log(`🚀 [Auto-Router]: تم توجيه الطلب ${tx.customId} تلقائياً إلى بوت ${execBot.name}`);
        return true;

    } catch (error) {
        console.error('🚨 [Auto-Router Error]:', error.message);
        return false;
    }
};

module.exports = { processAutoRoute };