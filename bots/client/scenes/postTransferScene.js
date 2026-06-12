// bots/client/scenes/postTransferScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Settings = require('../../../models/Settings');
const User = require('../../../models/User');
const ClientEmployee = require('../../../models/ClientEmployee');
const ClientBot = require('../../../models/ClientBot');
const Transaction = require('../../../models/Transaction');
const Admin = require('../../../models/Admin');
const Counter = require('../../../models/Counter'); // 🟢 إضافة العداد الذكي

const editPrompt = async (ctx, text, markup) => {
    try {
        if (ctx.wizard.state.promptMsgId) {
            await ctx.telegram.editMessageText(ctx.chat.id, ctx.wizard.state.promptMsgId, null, text, { parse_mode: 'HTML', ...markup });
        } else {
            const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
            ctx.wizard.state.promptMsgId = sent.message_id;
        }
    } catch (e) {
        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
        ctx.wizard.state.promptMsgId = sent.message_id;
    }
};

const postTransferWizard = new Scenes.WizardScene(
    'POST_TRANSFER_SCENE',
    
    // الخطوة 1: تحديد النوع
    async (ctx) => {
        ctx.wizard.state.isMainBot = ctx.scene.state.isMainBot;
        ctx.wizard.state.botData = ctx.scene.state.botData;
        
        const text = '📮 <b>تحديد نوع تحويل البريد:</b>\n\nيرجى اختيار الطريقة التي تريد التحويل بها:';
        const markup = Markup.inlineKeyboard([
            [Markup.button.callback('📥 تحويل إلى حساب بريد', 'post_account')],
            [Markup.button.callback('💳 تحويل إلى بطاقة عميل', 'post_card')],
            [Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]
        ]);

        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
        ctx.wizard.state.promptMsgId = sent.message_id;
        
        return ctx.wizard.next();
    },

    // الخطوة 2: استقبال اختيار النوع
    async (ctx) => {
        if (!ctx.callbackQuery) {
            if (ctx.message) await ctx.deleteMessage().catch(()=>{});
            return;
        }
        await ctx.answerCbQuery().catch(()=>{});

        const choice = ctx.callbackQuery.data;
        if (choice === 'cancel_tx') {
            await editPrompt(ctx, '✅ تم إلغاء عملية التحويل.', {});
            return ctx.scene.leave();
        }

        ctx.wizard.state.transferType = choice;

        if (choice === 'post_account') {
            await editPrompt(ctx, '📝 <b>تحويل إلى حساب بريد:</b>\n\nالرجاء إدخال **رقم الحساب** المكون من (16 رقم):', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_account_number';
        } else if (choice === 'post_card') {
            await editPrompt(ctx, '💳 <b>تحويل إلى بطاقة عميل:</b>\n\nالرجاء إدخال **الاسم رباعي** للمستلم:', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_card_name';
        }
        return ctx.wizard.next();
    },

    // الخطوة 3: استقبال مدخلات العميل والتحقق منها
    async (ctx) => {
        if (ctx.callbackQuery) {
            if (ctx.callbackQuery.data === 'cancel_tx') {
                await ctx.answerCbQuery().catch(()=>{});
                await editPrompt(ctx, '✅ تم الإلغاء.', {});
                return ctx.scene.leave();
            }
        }

        const text = ctx.message?.text;
        if (ctx.message) await ctx.deleteMessage().catch(()=>{}); 
        
        if (!text && !ctx.message?.photo) {
            await editPrompt(ctx, '⚠️ الرجاء إدخال بيانات صحيحة.', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            return;
        }
        
        if (text === '/cancel' || text === '🏠 القائمة الرئيسية (ابدأ)') {
            await editPrompt(ctx, '✅ تم الإلغاء.', {});
            return ctx.scene.leave();
        }

        if (ctx.wizard.state.step === 'awaiting_account_number') {
            if(!text || !/^\d{16}$/.test(text.trim())) {
                return editPrompt(ctx, '⚠️ **رقم الحساب غير صحيح!**\nيجب أن يتكون رقم حساب البريد من **16 رقم بالتمام**.\n\nالرجاء إعادة الإدخال بشكل صحيح:', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            }
            ctx.wizard.state.accountNumber = text.trim();
            await editPrompt(ctx, `✅ الحساب: <code>${text.trim()}</code>\n\n👤 ممتاز، الآن الرجاء إدخال **اسم صاحب الحساب**:`, Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_account_name';
            return;
        }

        if (ctx.wizard.state.step === 'awaiting_account_name') {
            if(!text) return editPrompt(ctx, '⚠️ الرجاء إرسال الاسم كنص.', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.accountName = text;
            await editPrompt(ctx, `✅ الاسم: ${text}\n\n💵 أخيراً، الرجاء إدخال **المبلغ المراد تحويله (بالجنيه المصري)**:`, Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_amount';
            return;
        }

        if (ctx.wizard.state.step === 'awaiting_card_name') {
            const nameParts = text ? text.trim().split(/\s+/) : [];
            if(nameParts.length < 4) {
                return editPrompt(ctx, '⚠️ **الاسم غير مكتمل!**\nالرجاء إدخال **الاسم رباعي** (4 مقاطع على الأقل):\n\nمثال: <i>أحمد محمد علي محمود</i>', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            }
            ctx.wizard.state.accountName = text.trim();
            await editPrompt(ctx, `✅ الاسم: ${text.trim()}\n\n🔢 الرجاء إدخال **الرقم القومي** (14 رقم):`, Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_national_id';
            return;
        }

        if (ctx.wizard.state.step === 'awaiting_national_id') {
            if(!text || !/^\d{14}$/.test(text.trim())) {
                return editPrompt(ctx, '⚠️ **الرقم القومي غير صحيح!**\nيجب أن يتكون الرقم القومي من **14 رقم بالتمام**.\n\nالرجاء إعادة إدخاله بشكل صحيح:', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            }
            ctx.wizard.state.nationalId = text.trim();
            await editPrompt(ctx, `✅ الرقم القومي: <code>${text.trim()}</code>\n\n📍 الرجاء إدخال **اسم المحافظة**:`, Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_governorate';
            return;
        }

        if (ctx.wizard.state.step === 'awaiting_governorate') {
            if(!text) return editPrompt(ctx, '⚠️ الرجاء إرسال اسم المحافظة كنص.', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.governorate = text.trim();
            await editPrompt(ctx, `✅ المحافظة: ${text.trim()}\n\n📸 <b>الرجاء إرسال صورة واضحة لبطاقة العميل (وجه أو وجهين):</b>`, Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_card_image';
            return;
        }

        if (ctx.wizard.state.step === 'awaiting_card_image') {
            if (!ctx.message.photo) return editPrompt(ctx, '⚠️ الرجاء إرسال "صورة" البطاقة (وليس ملفاً أو نصاً).', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.idCardImage = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            await editPrompt(ctx, '✅ تم استلام صورة البطاقة!\n\n💵 الآن، الرجاء إدخال **المبلغ المراد تحويله (بالجنيه المصري)**:', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            ctx.wizard.state.step = 'awaiting_amount';
            return;
        }

        // حساب المبالغ والفروق
        if (ctx.wizard.state.step === 'awaiting_amount') {
            if(!text) return editPrompt(ctx, '⚠️ الرجاء إدخال المبلغ بالأرقام.', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) return editPrompt(ctx, '⚠️ الرجاء إدخال مبلغ صحيح بالأرقام الإنجليزية.', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_tx')]]));

            ctx.wizard.state.amount = amount;
            
            const telegramId = ctx.from.id.toString();
            let tier = 1, currentBalance = 0, creditLimit = 0;
            const set = await Settings.findOne({}) || await Settings.create({});

            if (ctx.wizard.state.isMainBot) {
                const user = await User.findOne({ telegramId });
                tier = user.tier || 1;
                currentBalance = user.balance || 0;
                creditLimit = user.creditLimit || 0;
            } else {
                const company = await ClientBot.findById(ctx.wizard.state.botData._id);
                tier = company.tier || 1;
                currentBalance = company.balance || 0;
                creditLimit = company.creditLimit || 0;
            }

            let baseRate = set.rateLevel1 || 6.40;
            if (tier === 2) baseRate = set.rateLevel2 || 6.45;
            if (tier === 3) baseRate = set.rateLevel3 || 6.50;

            let finalRate = baseRate;
            if (ctx.wizard.state.transferType === 'post_account') {
                finalRate = baseRate - 0.05; 
            } else if (ctx.wizard.state.transferType === 'post_card') {
                finalRate = baseRate - 0.15; 
            }

            if (finalRate <= 0) finalRate = baseRate;

            const costLYD = parseFloat((amount / finalRate).toFixed(3));
            ctx.wizard.state.costLYD = costLYD;
            ctx.wizard.state.finalRate = finalRate;

            const availableFunds = currentBalance + creditLimit;

            if (costLYD > availableFunds) {
                await editPrompt(ctx, 
                    `❌ <b>رصيدك غير كافٍ.</b>\n\n` +
                    `💰 رصيدك الحالي: ${currentBalance.toFixed(2)} دينار\n` +
                    `💳 الحد الائتماني (السلفة): ${creditLimit.toFixed(2)} دينار\n` +
                    `🟢 إجمالي المتاح: ${availableFunds.toFixed(2)} دينار\n\n` +
                    `⚠️ بينما تكلفة التحويل: ${costLYD} دينار.`, 
                    {}
                );
                return ctx.scene.leave();
            }

            let summaryType = ctx.wizard.state.transferType === 'post_account' ? 'حساب بريد' : 'بطاقة عميل';
            let summaryMsg = `🧾 <b>مراجعة تفاصيل التحويل (${summaryType}):</b>\n\n`;
            
            if (ctx.wizard.state.transferType === 'post_account') {
                summaryMsg += `📞 <b>رقم الحساب:</b> <code>${ctx.wizard.state.accountNumber}</code>\n`;
                summaryMsg += `👤 <b>اسم صاحب الحساب:</b> ${ctx.wizard.state.accountName}\n`;
            } else {
                summaryMsg += `👤 <b>الاسم رباعي:</b> ${ctx.wizard.state.accountName}\n`;
                summaryMsg += `🆔 <b>الرقم القومي:</b> <code>${ctx.wizard.state.nationalId}</code>\n`;
                summaryMsg += `📍 <b>المحافظة:</b> ${ctx.wizard.state.governorate}\n`;
            }
            
            summaryMsg += `💵 <b>المبلغ:</b> ${amount} EGP\n`;
            summaryMsg += `💱 <b>سعر الصرف (بعد الخصم):</b> ${finalRate.toFixed(2)}\n`;
            summaryMsg += `💰 <b>التكلفة الإجمالية:</b> ${costLYD} دينار\n\n`;
            
            if (costLYD > currentBalance) {
                summaryMsg += `⚠️ <b>ملاحظة:</b> سيتم سحب جزء من هذا المبلغ من حدك الائتماني.\n\n`;
            }

            summaryMsg += `هل ترغب في تأكيد التحويل وإرسال الطلب للإدارة؟`;

            await editPrompt(ctx, summaryMsg, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ تأكيد التحويل', 'confirm_post_tx')],
                    [Markup.button.callback('❌ إلغاء', 'cancel_tx')]
                ])
            );
            return ctx.wizard.next();
        }
    },

    // الخطوة 4: تأكيد الإرسال (محمي بالخصم الذري 🛡️)
    async (ctx) => {
        if (!ctx.callbackQuery) {
            if (ctx.message) await ctx.deleteMessage().catch(()=>{});
            return;
        }
        await ctx.answerCbQuery('⏳ جاري إرسال الطلب للإدارة...').catch(()=>{});

        if (ctx.callbackQuery.data === 'cancel_tx') {
            await editPrompt(ctx, '✅ تم الإلغاء.', {});
            return ctx.scene.leave();
        }

        if (ctx.callbackQuery.data === 'confirm_post_tx') {
            try {
                const { isMainBot, botData, transferType, accountName, accountNumber, idCardImage, amount, costLYD, finalRate, nationalId, governorate } = ctx.wizard.state;
                const telegramId = ctx.from.id.toString();

                let TargetModel = isMainBot ? User : ClientBot;
                let targetFilter = isMainBot ? { telegramId } : { _id: botData._id };
                let employeeName = ctx.from.first_name;
                let companyName = isMainBot ? 'عميل فردي' : botData.name;
                let clientBotIdForTx = isMainBot ? null : botData._id;

                let accountDoc = await TargetModel.findOne(targetFilter);
                if (!accountDoc) {
                    await editPrompt(ctx, '❌ الحساب غير موجود.', {});
                    return ctx.scene.leave();
                }

                if (isMainBot) {
                    employeeName = accountDoc.name;
                } else {
                    const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                    if (emp) employeeName = emp.name;
                }

                const creditLimit = accountDoc.creditLimit || 0;
                const minRequiredBalance = costLYD - creditLimit;

                // 🛡️ الخصم الذري لحماية الرصيد ومنع السحب المزدوج
                const updatedAccount = await TargetModel.findOneAndUpdate(
                    { ...targetFilter, balance: { $gte: minRequiredBalance } },
                    { $inc: { balance: -costLYD } },
                    { new: true }
                );

                if (!updatedAccount) {
                    await editPrompt(ctx, '❌ <b>فشلت العملية!</b> الرصيد غير كافٍ أو هناك عملية أخرى قيد التنفيذ استهلكت رصيدك.', {});
                    return ctx.scene.leave();
                }

                // 🟢 توليد رقم تسلسلي فريد
                const counter = await Counter.findOneAndUpdate(
                    { name: 'transaction' }, { $inc: { value: 1 } }, { upsert: true, new: true }
                );
                const yy = new Date().getFullYear().toString().slice(-2); 
                const mm = (new Date().getMonth() + 1).toString().padStart(2, '0');
                const customOrderId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`; 

                let dbAccountName = accountName;
                if (transferType === 'post_card') {
                    dbAccountName = `${accountName}\n🆔 الرقم القومي: <code>${nationalId}</code>\n📍 المحافظة: ${governorate}`;
                }

                const newTx = await Transaction.create({
                    customId: customOrderId,
                    userId: telegramId, clientBotId: clientBotIdForTx, companyName, employeeName,
                    transferType, accountName: dbAccountName, accountNumber, idCardImage,
                    amount, costLYD, exchangeRate: finalRate, status: 'pending'
                });

                await editPrompt(ctx, `✅ <b>تم خصم ${costLYD} دينار من رصيدك وإرسال الطلب للإدارة بنجاح.</b>\nرقم الطلب: <code>${customOrderId}</code>`, {});

                try {
                    const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                    const admins = await Admin.find({});
                    
                    let typeLabel = transferType === 'post_account' ? 'حساب بريد' : 'بطاقة عميل';
                    let accDetails = `📞 الرقم/الحساب: <code>${accountNumber || '---'}</code>`;
                    if (dbAccountName) accDetails += `\n👤 الاسم: ${dbAccountName}`; 
                    
                    const adminMsgText = `🔔 <b>طلب تحويل جديد استلم الآن (${typeLabel}):</b>\n🏢 الجهة: ${companyName}\n👨‍💻 الموظف: ${employeeName}\n${accDetails}\n💵 المبلغ: ${amount} EGP\n💰 التكلفة: ${costLYD} LYD\n🧾 رقم الطلب: <code>${customOrderId}</code>`;
                    
                    const inlineKb = {
                        inline_keyboard: [
                            [{ text: '🤖 تحويل لبوت تنفيذي', callback_data: `forward_${newTx._id}` }],
                            [{ text: '❌ إلغاء العملية', callback_data: `cancelReq_${newTx._id}` }]
                        ]
                    };

                    let idUrl = null;
                    if (transferType === 'post_card' && idCardImage) {
                        try {
                            let cToken = process.env.CLIENT_BOT_TOKEN;
                            if (botData && botData.token) cToken = botData.token;
                            const tempApi = new Telegram(cToken);
                            idUrl = (await tempApi.getFileLink(idCardImage)).href;
                        } catch(e){}
                    }

                    let savedAdminMsgs = [];
                    for (const admin of admins) {
                        if (admin.telegramId && !admin.webUsername) {
                            if (idUrl) {
                                const sentMsg = await adminAPI.sendPhoto(admin.telegramId, { url: idUrl }, { caption: adminMsgText, parse_mode: 'HTML', reply_markup: inlineKb }).catch(()=>{});
                                if (sentMsg) savedAdminMsgs.push({ telegramId: admin.telegramId, messageId: sentMsg.message_id });
                            } else {
                                const sentMsg = await adminAPI.sendMessage(admin.telegramId, adminMsgText, { parse_mode: 'HTML', reply_markup: inlineKb }).catch(()=>{});
                                if (sentMsg) savedAdminMsgs.push({ telegramId: admin.telegramId, messageId: sentMsg.message_id });
                            }
                        }
                    }
                    if(savedAdminMsgs.length > 0) {
                        newTx.adminMessages = savedAdminMsgs;
                        await newTx.save();
                    }
                } catch(err) {}

            } catch (error) {
                console.error(error);
                await editPrompt(ctx, '❌ حدث خطأ أثناء المعالجة.', {});
            }
            return ctx.scene.leave();
        }
    }
);

module.exports = postTransferWizard;