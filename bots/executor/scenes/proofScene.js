// bots/executor/scenes/proofScene.js
const { Scenes, Telegram, Markup } = require('telegraf');
const https = require('https');
const Transaction = require('../../../models/Transaction');
const ExecutorBot = require('../../../models/ExecutorBot');
const ClientBot = require('../../../models/ClientBot');
const ClientEmployee = require('../../../models/ClientEmployee'); 
const Admin = require('../../../models/Admin');
const Employee = require('../../../models/Employee'); 

const fetchBuffer = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
};

const proofWizard = new Scenes.WizardScene(
    'PROOF_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId; 
        ctx.wizard.state.promptMsgId = ctx.scene.state.promptMsgId; 

        const tx = await Transaction.findById(ctx.wizard.state.txId);
        if (!tx) {
            await ctx.reply('❌ الطلب غير موجود.');
            return ctx.scene.leave();
        }
        
        const promptMsg = await ctx.reply(
            '📸 <b>الرجاء إرسال صور الإثبات (إيصالات التحويل) الآن:</b>\n\n' +
            '<i>يمكنك إرسال صورة واحدة، أو عدة صور كألبوم دفعة واحدة.</i>\n' +
            'عند الانتهاء من رفع جميع الصور المطلوبة، <b>اضغط على "✅ تأكيد إرسال الإثباتات"</b>.\n\n' +
            '(لإلغاء العملية أرسل /cancel)', 
            { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '✅ تأكيد إرسال الإثباتات', callback_data: 'confirm_photos' }]]
                }
            }
        );
        ctx.wizard.state.askMsgId = promptMsg.message_id; 
        ctx.wizard.state.photoIds = []; 
        ctx.wizard.state.photoMsgIds = [];
        
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message && ctx.message.text === '/cancel') {
            await ctx.reply('✅ تم الإلغاء.');
            if (ctx.wizard.state.askMsgId) await ctx.deleteMessage(ctx.wizard.state.askMsgId).catch(()=>{});
            return ctx.scene.leave();
        }
        
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'confirm_photos') {
            if (ctx.wizard.state.photoIds.length === 0) {
                await ctx.answerCbQuery('⚠️ الرجاء إرسال صورة واحدة على الأقل قبل التأكيد!', { show_alert: true });
                return;
            }
            await ctx.answerCbQuery('✅ تم استلام الصور.');
            if (ctx.wizard.state.askMsgId) await ctx.deleteMessage(ctx.wizard.state.askMsgId).catch(()=>{});

            const phoneMsg = await ctx.reply(
                `✅ <b>تم استلام (${ctx.wizard.state.photoIds.length}) صور للإثبات بنجاح.</b>\n\n` +
                '✍️ الرجاء كتابة <b>رقم هاتف المرسل</b> (الرقم الذي تم إرسال الحوالة منه):\n\n' +
                '<i>(هذه الخطوة اختيارية، يمكنك تخطيها بالضغط على الزر أدناه)</i>',
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⏭️ تخطي', 'skip_sender_phone')]])
                }
            );
            ctx.wizard.state.phoneMsgId = phoneMsg.message_id;
            return ctx.wizard.next();
        }

        if (ctx.message && ctx.message.photo) {
            const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            ctx.wizard.state.photoIds.push(photoId); 
            ctx.wizard.state.photoMsgIds.push(ctx.message.message_id);
            return; 
        } else if (ctx.message && !ctx.message.text?.startsWith('/')) {
            await ctx.reply('⚠️ الرجاء إرسال "صور" فقط للإثبات أو الضغط على زر التأكيد في الأعلى.');
            return;
        }
    },
    async (ctx) => {
        if (ctx.message && ctx.message.text === '/cancel') {
            await ctx.reply('✅ تم الإلغاء.');
            if (ctx.wizard.state.phoneMsgId) await ctx.deleteMessage(ctx.wizard.state.phoneMsgId).catch(()=>{});
            return ctx.scene.leave();
        }

        let senderPhone = '';
        let lastUserMsgId = null;

        if (ctx.callbackQuery && ctx.callbackQuery.data === 'skip_sender_phone') {
            await ctx.answerCbQuery('تم التخطي').catch(()=>{});
            senderPhone = 'غير محدد';
        } else if (ctx.message && ctx.message.text) {
            senderPhone = ctx.message.text;
            lastUserMsgId = ctx.message.message_id; 
        } else {
            await ctx.reply('⚠️ الرجاء كتابة الرقم كنص أو الضغط على زر تخطي.');
            return;
        }

        const photoIds = ctx.wizard.state.photoIds;
        const txId = ctx.wizard.state.txId;
        const promptMsgId = ctx.wizard.state.promptMsgId;

        try {
            const tx = await Transaction.findById(txId);
            if (!tx) {
                await ctx.reply('❌ الطلب غير موجود.');
                return ctx.scene.leave();
            }

            let photoBuffers = [];
            for (let pid of photoIds) {
                try {
                    const url = (await ctx.telegram.getFileLink(pid)).href;
                    const buffer = await fetchBuffer(url);
                    photoBuffers.push(buffer);
                } catch (e) { console.error("Buffer fetch error", e); }
            }

            let typeLabel = 'فودافون كاش';
            if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
            if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

            const execBot = await ExecutorBot.findById(tx.executorBotId);
            let managerBot = null;
            let isLinkedToManager = false;

            if (execBot && execBot.parentBotId) {
                managerBot = await ExecutorBot.findById(execBot.parentBotId);
                if (managerBot) {
                    isLinkedToManager = true;
                    tx.managerBotId = managerBot._id; 
                }
            }

            tx.status = 'completed';
            tx.proofImage = photoIds[0]; 
            tx.proofImages = photoIds;   
            tx.senderPhone = senderPhone;
            await tx.save(); 

            // 🛡️ الخصم الذري لعهدة بوت التنفيذ لحماية الرصيد
            if (isLinkedToManager) {
                await ExecutorBot.findByIdAndUpdate(managerBot._id, { $inc: { balance: -tx.amount } });
                await ExecutorBot.findByIdAndUpdate(execBot._id, { $inc: { balance: -tx.amount } });
            } else if (execBot) {
                await ExecutorBot.findByIdAndUpdate(execBot._id, { $inc: { balance: -tx.amount } });
            }

            const senderPhoneDisplay = senderPhone !== 'غير محدد' ? `\n📲 <b>رقم المرسل:</b> <code>${senderPhone}</code>` : '';
            let clientNoteDisplay = tx.notes ? `\n📝 <b>ملاحظتك:</b> ${tx.notes}` : '';
            let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
            if (tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

            // =====================================
            // إرسال الإشعار للعميل / الشركة كألبوم
            // =====================================
            try {
                const companyMsg = `✅ <b>تـم تـنـفـيـذ طـلـبـكـم بـنـجـاح! (${typeLabel})</b> 🎉\n\n` +
                                   `👨‍💻 <b>صاحب الطلب:</b> ${tx.employeeName}\n` +
                                   `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                   accDetails +
                                   `💵 <b>المبلغ:</b> ${tx.amount} EGP` +
                                   senderPhoneDisplay +
                                   clientNoteDisplay + `\n\n👇 <b>إثباتات التحويل:</b>`;
                                   
                const clientMsg = `✅ <b>تـم تـنـفـيـذ طـلـبـك بـنـجـاح! (${typeLabel})</b> 🎉\n\n` +
                                  `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                  accDetails +
                                  `💵 <b>المبلغ:</b> ${tx.amount} EGP` +
                                  senderPhoneDisplay +
                                  clientNoteDisplay + `\n\n👇 <b>إثباتات التحويل:</b>`;

                if (tx.clientBotId) {
                    const company = await ClientBot.findById(tx.clientBotId);
                    if (company && company.status === 'active') {
                        const clientBotAPI = new Telegram(company.token);
                        const employees = await ClientEmployee.find({ clientBotId: company._id, status: 'active' });
                        
                        let mediaGroup = photoBuffers.map((buf, i) => ({
                            type: 'photo', media: { source: buf }, caption: i === 0 ? companyMsg : '', parse_mode: 'HTML'
                        }));

                        for (const emp of employees) {
                            if (mediaGroup.length === 1) {
                                await clientBotAPI.sendPhoto(emp.telegramId, mediaGroup[0].media, { caption: companyMsg, parse_mode: 'HTML' }).catch(()=>{});
                            } else if (mediaGroup.length > 1) {
                                await clientBotAPI.sendMediaGroup(emp.telegramId, mediaGroup).catch(()=>{});
                            }
                        }
                    }
                } else {
                    const clientBotAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                    let mediaGroup = photoBuffers.map((buf, i) => ({
                        type: 'photo', media: { source: buf }, caption: i === 0 ? clientMsg : '', parse_mode: 'HTML'
                    }));

                    if (mediaGroup.length === 1) {
                        await clientBotAPI.sendPhoto(tx.userId, mediaGroup[0].media, { caption: clientMsg, parse_mode: 'HTML' }).catch(()=>{});
                    } else if (mediaGroup.length > 1) {
                        await clientBotAPI.sendMediaGroup(tx.userId, mediaGroup).catch(()=>{});
                    }
                }
            } catch(e) { console.error('Error sending to client/company:', e); }

            // =====================================
            // إرسال الإشعار للإدارة العليا كألبوم
            // =====================================
            try {
                let idCardBuffer = null;
                if (tx.transferType === 'post_card' && tx.idCardImage) {
                    try {
                        let cToken = process.env.CLIENT_BOT_TOKEN;
                        if (tx.clientBotId) {
                            const comp = await ClientBot.findById(tx.clientBotId);
                            if (comp) cToken = comp.token;
                        }
                        const tempApi = new Telegram(cToken);
                        const idCardUrl = (await tempApi.getFileLink(tx.idCardImage)).href;
                        idCardBuffer = await fetchBuffer(idCardUrl);
                    } catch(e){}
                }

                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const admins = await Admin.find({});
                
                const sourceInfo = tx.clientBotId 
                    ? `🏢 <b>الشركة:</b> ${tx.companyName}\n👤 <b>الموظف المحول:</b> ${tx.employeeName}` 
                    : `👤 <b>العميل الفردي:</b> ${tx.employeeName}`;
                
                const adminNoteDisplay = tx.notes ? `\n📝 <b>ملاحظة العميل:</b> <i>${tx.notes}</i>` : '';
                let accDetailsAdmin = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                if (tx.accountName) accDetailsAdmin += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

                const adminMsg = `✅ <b>تم تنفيذ طلب تحويل (${typeLabel}) بنجاح!</b>\n\n` +
                                 `${sourceInfo}\n` +
                                 `━━━━━━━━━━━━━━\n` +
                                 `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                 accDetailsAdmin +
                                 `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                                 `🇱🇾 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD\n` +
                                 `👨‍💻 <b>المنفذ:</b> ${tx.executorName}\n` +
                                 `🤖 <b>البوت التنفيذي:</b> ${execBot ? execBot.name : 'غير محدد'}` +
                                 senderPhoneDisplay +
                                 `${adminNoteDisplay}\n\n` +
                                 `👇 <b>المرفقات:</b>`;
                
                let mediaGroupAdmin = photoBuffers.map((buf, i) => ({
                    type: 'photo', media: { source: buf }, caption: i === 0 ? adminMsg : '', parse_mode: 'HTML'
                }));
                
                if (idCardBuffer) {
                    mediaGroupAdmin.unshift({ type: 'photo', media: { source: idCardBuffer }, caption: '🪪 صورة البطاقة الخاصة بالعميل', parse_mode: 'HTML' });
                }

                for (const admin of admins) {
                    if (admin.telegramId && !admin.webUsername) { 
                        if (mediaGroupAdmin.length === 1) {
                            await adminAPI.sendPhoto(admin.telegramId, mediaGroupAdmin[0].media, { caption: mediaGroupAdmin[0].caption, parse_mode: 'HTML' }).catch(()=>{});
                        } else if (mediaGroupAdmin.length > 1) {
                            await adminAPI.sendMediaGroup(admin.telegramId, mediaGroupAdmin).catch(()=>{});
                        }
                    }
                }
            } catch(e) { console.error('Error sending to admins:', e); }

            // =====================================
            // إرسال الإشعار لوكالة الإدارة التنفيذية
            // =====================================
            if (isLinkedToManager && managerBot && managerBot.status === 'active') {
                try {
                    const managerAPI = new Telegram(managerBot.token);
                    const agentStaff = await Employee.find({ botId: managerBot._id, status: 'active' });
                    let accDetailsAgent = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                    if (tx.accountName) accDetailsAgent += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

                    const agentMsg = `✅ <b>إشعار للوكالة: تم إنجاز مهمة بنجاح! (${typeLabel})</b>\n\n` +
                                     `🤖 <b>تم التنفيذ عبر بوت:</b> ${execBot.name}\n` +
                                     `👨‍💻 <b>بواسطة الموظف:</b> ${tx.executorName}\n` +
                                     `━━━━━━━━━━━━━━\n` +
                                     `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                     accDetailsAgent +
                                     `💵 <b>المبلغ:</b> ${tx.amount} EGP` +
                                     senderPhoneDisplay + `\n` +
                                     `💰 <b>تم إضافة المديونية.</b>`;

                    for (const staff of agentStaff) {
                        await managerAPI.sendMessage(staff.telegramId, agentMsg, { parse_mode: 'HTML' }).catch(()=>{});
                    }
                } catch (e) {}
            }

            // تنظيف الرسائل القديمة
            if (promptMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, promptMsgId).catch(()=>{});
            if (ctx.wizard.state.phoneMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, ctx.wizard.state.phoneMsgId).catch(()=>{});
            for (let mid of ctx.wizard.state.photoMsgIds) await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(()=>{});
            if (lastUserMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, lastUserMsgId).catch(()=>{});

            // رسالة الإكمال الموحدة
            const execTime = new Date().toLocaleString('en-GB');
            const miniReceipt = `✅ <b>تـم الـتـنـفـيـذ بـنـجـاح</b>\n\n` +
                                `نوع العملية: ${typeLabel}\n` +
                                `🧾 <b>الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n` +
                                `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                                `👨‍💻 <b>المنفذ:</b> ${tx.executorName}` +
                                senderPhoneDisplay + `\n` +
                                `⏱️ <b>الوقت:</b> ${execTime}`;

            await ctx.reply(miniReceipt, { parse_mode: 'HTML' });

            const completionMsg = `✅ <b>تـم الـتـنـفـيـذ بـنـجـاح</b>\n\n` +
                                  `🧾 <b>الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                  `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n` +
                                  `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                                  `👨‍💻 <b>المنفذ:</b> ${tx.executorName}` +
                                  senderPhoneDisplay + `\n` +
                                  `⏱️ <b>الوقت:</b> ${execTime}`;

            if (tx.broadcastMessages && tx.broadcastMessages.length > 0) {
                const execAPI = new Telegram(execBot.token); 
                for (const msg of tx.broadcastMessages) {
                    const targetChatId = msg.telegramId || msg.chatId;
                    if (targetChatId.toString() === ctx.from.id.toString()) continue;
                    try { 
                        await execAPI.callApi('editMessageText', { chat_id: targetChatId, message_id: msg.messageId, text: completionMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }});
                    } catch(e) {
                        try { await execAPI.callApi('editMessageCaption', { chat_id: targetChatId, message_id: msg.messageId, caption: completionMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (err) {} 
                    }
                }
                tx.broadcastMessages = []; 
            }

            if (tx.adminMessages && tx.adminMessages.length > 0) {
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                for (const msg of tx.adminMessages) {
                    const targetAdminId = msg.telegramId || msg.chatId;
                    try {
                        await adminAPI.callApi('editMessageText', { chat_id: targetAdminId, message_id: msg.messageId, text: completionMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                    } catch (e) {
                        try { await adminAPI.callApi('editMessageCaption', { chat_id: targetAdminId, message_id: msg.messageId, caption: completionMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (err) {}
                    }
                }
                tx.adminMessages = []; 
            }
            
            return ctx.scene.leave();

        } catch (error) {
            console.error(error);
            await ctx.reply('❌ حدث خطأ أثناء معالجة الإثبات.');
            return ctx.scene.leave();
        }
    }
);

module.exports = proofWizard;