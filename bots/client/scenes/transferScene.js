// bots/client/scenes/transferScene.js
const { Scenes, Telegram, Markup } = require('telegraf');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');
const ClientEmployee = require('../../../models/ClientEmployee');
const Transaction = require('../../../models/Transaction');
const Settings = require('../../../models/Settings');
const Admin = require('../../../models/Admin');
const Counter = require('../../../models/Counter'); // 🟢 إضافة العداد الذكي

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

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

const transferWizard = new Scenes.WizardScene(
    'TRANSFER_SCENE',
    
    // 1️⃣ الخطوة الأولى: التحقق من الشروط وطلب رقم الهاتف
    async (ctx) => {
        ctx.wizard.state.botData = ctx.scene.state.botData;
        ctx.wizard.state.isMainBot = ctx.scene.state.isMainBot;
        
        ctx.wizard.state.phoneAttempts = 0;
        ctx.wizard.state.amountAttempts = 0;

        try {
            const set = await Settings.findOne({}) || await Settings.create({});
            const now = new Date();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            
            if (set.isManualClosed || currentTime < set.openingTime || currentTime > set.closingTime) {
                await ctx.reply(`⚠️ <b>نعتذر منك:</b>\n\n${set.closedMessage}`, { parse_mode: 'HTML' });
                return ctx.scene.leave();
            }

            const termsMsg = set.termsMessage || '1. يرجى التأكد من الرقم قبل الإرسال.\n2. التحويل يتم خلال دقائق.';
            await ctx.reply(`⚠️ <b>شروط وقواعد التحويل:</b>\n\n${termsMsg}`, { parse_mode: 'HTML' });
        } catch (error) {}

        const text = '📞 <b>تحويل إلى مصر</b>\n\nالرجاء إرسال رقم المحفظة في مصر (11 رقم):';
        const markup = Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]]);
        
        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
        ctx.wizard.state.promptMsgId = sent.message_id;

        return ctx.wizard.next();
    },

    // 2️⃣ الخطوة الثانية: استقبال رقم الهاتف والتحقق منه
    async (ctx) => {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery().catch(() => {});
            if (ctx.callbackQuery.data === 'cancel_transfer') {
                await editPrompt(ctx, '❌ تم إلغاء العملية والعودة للقائمة الرئيسية.', {});
                return ctx.scene.leave();
            }
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{}); 
            
            const number = ctx.message.text?.trim();
            const isValidPhone = number && /^01[0125]\d{8}$/.test(number);

            if (!isValidPhone) {
                ctx.wizard.state.phoneAttempts += 1; 
                
                if (ctx.wizard.state.phoneAttempts >= 2) {
                    await editPrompt(ctx, '❌ لقد قمت بإدخال رقم هاتف غير صحيح مرتين متتاليتين.\nتم إلغاء العملية لحماية النظام، يمكنك المحاولة من جديد لاحقاً من القائمة الرئيسية.', Markup.inlineKeyboard([]));
                    return ctx.scene.leave(); 
                } else {
                    await editPrompt(ctx, '⚠️ <b>رقم الهاتف المدخل غير صحيح!</b>\nيرجى التأكد من كتابة 11 رقماً ويبدأ بـ 01 <b>(تتبقى لك محاولة واحدة)</b>:', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]]));
                    return; 
                }
            }

            ctx.wizard.state.phoneAttempts = 0; 
            ctx.wizard.state.vodafoneNumber = number;
            
            await editPrompt(ctx, `✅ تم حفظ الرقم: <code>${number}</code>\n\n💸 الرجاء إرسال المبلغ المراد تحويله (بالجنيه المصري):`, Markup.inlineKeyboard([
                [Markup.button.callback('🔙 تعديل الرقم', 'back_to_step_1')],
                [Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]
            ]));
            return ctx.wizard.next();
        }
    },

    // 3️⃣ الخطوة الثالثة: استقبال المبلغ والتحقق المبدئي منه
    async (ctx) => {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery().catch(() => {});
            if (ctx.callbackQuery.data === 'cancel_transfer') {
                await editPrompt(ctx, '❌ تم إلغاء العملية.', {});
                return ctx.scene.leave();
            }
            if (ctx.callbackQuery.data === 'back_to_step_1') {
                ctx.wizard.state.phoneAttempts = 0; 
                await editPrompt(ctx, '📞 <b>تحويل إلى مصر</b>\n\nالرجاء إرسال رقم المحفظة في مصر (11 رقم):', Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]]));
                ctx.wizard.selectStep(1);
                return;
            }
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{}); 
            
            const amountEGP = parseFloat(ctx.message.text?.trim());
            
            if (isNaN(amountEGP) || amountEGP <= 0) {
                ctx.wizard.state.amountAttempts += 1; 
                
                if (ctx.wizard.state.amountAttempts >= 2) {
                    await editPrompt(ctx, '❌ لقد قمت بإدخال مبلغ غير صالح مرتين متتاليتين.\nتم إلغاء العملية لحماية النظام.', Markup.inlineKeyboard([]));
                    return ctx.scene.leave(); 
                } else {
                    await editPrompt(ctx, '⚠️ <b>مبلغ غير صالح!</b>\nأدخل رقماً صحيحاً أكبر من الصفر <b>(تتبقى لك محاولة واحدة)</b>:', Markup.inlineKeyboard([[Markup.button.callback('🔙 عودة', 'back_to_step_1')]]));
                    return; 
                }
            }

            ctx.wizard.state.amountAttempts = 0; 

            let clientTier = 1;
            let safeBalance = 0;
            let safeCreditLimit = 0;

            if (ctx.wizard.state.isMainBot) {
                const user = await User.findOne({ telegramId: ctx.from.id.toString() });
                if (user) {
                    clientTier = user.tier || 1;
                    safeBalance = parseFloat(user.balance) || 0;
                    safeCreditLimit = Math.abs(parseFloat(user.creditLimit) || 0);
                }
            } else {
                const company = await ClientBot.findById(ctx.wizard.state.botData._id);
                if (company) {
                    clientTier = company.tier || 1;
                    safeBalance = parseFloat(company.balance) || 0;
                    safeCreditLimit = Math.abs(parseFloat(company.creditLimit) || 0);
                }
            }

            const availableFunds = safeBalance + safeCreditLimit;
            const set = await Settings.findOne({}) || await Settings.create({});
            let currentExchangeRate = set.rateLevel1 || 6.40;
            if (clientTier === 2) currentExchangeRate = set.rateLevel2 || 6.45;
            if (clientTier === 3) currentExchangeRate = set.rateLevel3 || 6.50;
            
            const amountLYD = parseFloat((amountEGP / currentExchangeRate).toFixed(3));
            
            if (amountLYD > availableFunds) {
                await editPrompt(ctx, 
                    `❌ <b>عذراً، لا يمكن تنفيذ العملية لتجاوز الحد الأقصى للمديونية!</b>\n\n` +
                    `💰 <b>المتاح كلياً:</b> ${availableFunds.toFixed(2)} دينار\n` +
                    `📉 <b>تكلفة الحوالة:</b> ${amountLYD.toFixed(2)} دينار\n\n` +
                    `يرجى تسديد المديونية للمتابعة.`,
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 تعديل المبلغ', 'back_to_step_1')]])
                );
                return; 
            }

            ctx.wizard.state.amountEGP = amountEGP;
            ctx.wizard.state.amountLYD = amountLYD;
            ctx.wizard.state.exchangeRate = currentExchangeRate;

            await editPrompt(ctx, 
                `📝 <b>إضافة ملاحظة (اختياري):</b>\n\n` +
                `هل تود إضافة ملاحظة مع هذه الحوالة؟ (مثال: اسم صاحب المحفظة أو سبب التحويل)\n` +
                `👉 <b>أرسل الملاحظة الآن في رسالة، أو اضغط "تخطي".</b>`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('⏭️ تخطي (بدون ملاحظة)', 'skip_note')],
                    [Markup.button.callback('🔙 تعديل المبلغ', 'back_to_step_2')],
                    [Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]
                ])
            );
            return ctx.wizard.next();
        }
    },

    // 4️⃣ الخطوة الرابعة: استقبال الملاحظة ومراجعة الطلب
    async (ctx) => {
        let action = ctx.callbackQuery?.data;
        let note = null;

        if (ctx.callbackQuery) {
            await ctx.answerCbQuery().catch(()=>{});
            if (action === 'cancel_transfer') {
                await editPrompt(ctx, '❌ تم إلغاء العملية بنجاح.', {});
                return ctx.scene.leave();
            }
            if (action === 'back_to_step_2') {
                ctx.wizard.state.amountAttempts = 0; 
                await editPrompt(ctx, `✅ تم حفظ الرقم: <code>${ctx.wizard.state.vodafoneNumber}</code>\n\n💸 الرجاء إرسال المبلغ المراد تحويله (بالجنيه المصري):`, Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 تعديل الرقم', 'back_to_step_1')],
                    [Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]
                ]));
                ctx.wizard.selectStep(2);
                return;
            }
            if (action === 'skip_note') {
                note = null;
            }
        } else if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            note = ctx.message.text?.trim();
        }

        if (note === undefined) return; 

        ctx.wizard.state.transferNote = note;
        const { vodafoneNumber, amountEGP, amountLYD, exchangeRate } = ctx.wizard.state;
        
        const noteDisplay = note ? `\n📝 <b>الملاحظة:</b> ${note}` : '\n📝 <b>الملاحظة:</b> <i>لا توجد</i>';

        await editPrompt(ctx, 
            `📊 <b>مراجعة وتأكيد الطلب:</b>\n\n` +
            `📞 <b>الرقم المحول إليه:</b> <code>${vodafoneNumber}</code>\n` +
            `🇪🇬 <b>المبلغ المطلوب:</b> ${amountEGP} جنيه\n` +
            `🇱🇾 <b>التكلفة:</b> ${amountLYD.toFixed(2)} دينار\n` +
            `💱 <b>سعر الصرف:</b> 1 دينار = ${exchangeRate} جنيه` +
            `${noteDisplay}\n\n` +
            `هل تريد تأكيد العملية وإرسال التحويل؟`,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ إرسال التحويل', 'confirm_transfer')],
                [Markup.button.callback('🔙 تعديل الملاحظة', 'back_to_note')],
                [Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]
            ])
        );
        return ctx.wizard.next();
    },

    // 5️⃣ الخطوة الخامسة: تأكيد الإرسال (محمي بالخصم الذري 🛡️)
    async (ctx) => {
        if (!ctx.callbackQuery) {
            if (ctx.message) await ctx.deleteMessage().catch(()=>{});
            return;
        }
        
        const action = ctx.callbackQuery.data;

        if (action === 'cancel_transfer') {
            await ctx.answerCbQuery().catch(()=>{});
            await editPrompt(ctx, '❌ تم إلغاء عملية التحويل بنجاح.', {});
            return ctx.scene.leave();
        }

        if (action === 'back_to_note') {
            await ctx.answerCbQuery().catch(()=>{});
            await editPrompt(ctx, 
                `📝 <b>إضافة ملاحظة (اختياري):</b>\n\nأرسل الملاحظة الآن في رسالة، أو اضغط "تخطي".`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('⏭️ تخطي', 'skip_note')],
                    [Markup.button.callback('🔙 تعديل المبلغ', 'back_to_step_2')]
                ])
            );
            ctx.wizard.selectStep(3); 
            return;
        }

        if (action === 'confirm_transfer') {
            await ctx.answerCbQuery('⏳ جاري معالجة الطلب...').catch(()=>{});

            const telegramId = ctx.from.id.toString();
            const { isMainBot, botData, amountEGP, amountLYD, exchangeRate, vodafoneNumber, transferNote } = ctx.wizard.state;
            
            const filter = isMainBot ? { userId: telegramId, clientBotId: null } : { clientBotId: botData._id };
            filter.vodafoneNumber = vodafoneNumber;

            // 🛡️ الحماية ضد الحوالات المكررة (Spam Protection)
            const lastTx = await Transaction.findOne(filter).sort({ createdAt: -1 });
            if (lastTx) {
                const diffSeconds = (Date.now() - lastTx.createdAt.getTime()) / 1000;
                if (lastTx.amount === amountEGP && diffSeconds < 300) {
                    const waitTime = Math.ceil(300 - diffSeconds);
                    await editPrompt(ctx, `⚠️ <b>تحذير أمني:</b> لقد قمت بإرسال نفس الحوالة مؤخراً.\n⏳ يرجى الانتظار <b>${waitTime} ثانية</b>.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'back_to_step_1')]]));
                    ctx.wizard.selectStep(2); return; 
                } else if (diffSeconds < 60) {
                    const waitTime = Math.ceil(60 - diffSeconds);
                    await editPrompt(ctx, `⚠️ <b>تحذير أمني:</b> الرجاء الانتظار <b>${waitTime} ثانية</b> قبل إرسال حوالة أخرى لنفس الرقم.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'back_to_step_1')]]));
                    ctx.wizard.selectStep(2); return; 
                }
            }

            const requiredLYD = amountLYD;
            let TargetModel = isMainBot ? User : ClientBot;
            let targetFilter = isMainBot ? { telegramId } : { _id: botData._id };
            let employeeName = ctx.from.first_name;

            try {
                // جلب البيانات الأساسية واسم الموظف
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
                const minRequiredBalance = requiredLYD - creditLimit;

                // 🛡️ الخصم الذري لحماية الرصيد ومنع السحب المزدوج نهائياً
                const updatedAccount = await TargetModel.findOneAndUpdate(
                    { ...targetFilter, balance: { $gte: minRequiredBalance } },
                    { $inc: { balance: -requiredLYD } },
                    { new: true }
                );

                if (!updatedAccount) {
                    await editPrompt(ctx, '❌ <b>فشلت العملية!</b> الرصيد غير كافٍ أو هناك عملية أخرى قيد التنفيذ استهلكت رصيدك.', {});
                    return ctx.scene.leave();
                }

                // 🟢 توليد رقم تسلسلي فريد وغير قابل للتكرار باستخدام Counter
                const counter = await Counter.findOneAndUpdate(
                    { name: 'transaction' }, { $inc: { value: 1 } }, { upsert: true, new: true }
                );
                const yy = new Date().getFullYear().toString().slice(-2);
                const mm = (new Date().getMonth() + 1).toString().padStart(2, '0');
                const customOrderId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`;

                // حفظ العملية في قاعدة البيانات
                const transaction = await Transaction.create({
                    userId: telegramId,
                    amount: amountEGP, 
                    costLYD: requiredLYD,
                    exchangeRate: exchangeRate,
                    vodafoneNumber: vodafoneNumber,
                    notes: transferNote, 
                    status: 'pending',
                    customId: customOrderId,
                    clientBotId: isMainBot ? null : botData._id,
                    companyName: isMainBot ? 'عميل فردي' : botData.name,
                    employeeName: employeeName
                });

                const clientNoteDisplay = transferNote ? `📝 <b>الملاحظة:</b> ${transferNote}\n` : '';

                await editPrompt(ctx, 
                    `✅ <b>تم إرسال طلبك بنجاح!</b>\n\n` +
                    `🧾 <b>رقم الطلب:</b> <code>${transaction.customId}</code>\n` +
                    `📞 <b>الرقم:</b> <code>${vodafoneNumber}</code>\n` +
                    `🇪🇬 <b>المبلغ:</b> ${amountEGP} جنيه\n` +
                    `💰 <b>تم خصم:</b> ${requiredLYD.toFixed(2)} دينار\n` +
                    `${clientNoteDisplay}\n` +
                    `⏳ الطلب الآن "قيد التنفيذ".`,
                    {} 
                );

                // إشعار باقي موظفي الشركة (إن وجدت)
                if (!isMainBot) {
                    try {
                        const companyBotAPI = new Telegram(botData.token);
                        const colleagues = await ClientEmployee.find({ clientBotId: botData._id, status: 'active', telegramId: { $ne: telegramId } });
                        if (colleagues.length > 0) {
                            const broadcastMsg = `📢 <b>إشعار للشركة: تم إرسال طلب جديد</b>\n\n👨‍💻 <b>بواسطة الموظف:</b> ${employeeName}\n━━━━━━━━━━━━━━\n🧾 <b>رقم الطلب:</b> <code>${transaction.customId}</code>\n📞 <b>الرقم المحول إليه:</b> <code>${vodafoneNumber}</code>\n🇪🇬 <b>المبلغ:</b> ${amountEGP} جنيه\n💰 <b>تم خصم:</b> ${requiredLYD.toFixed(2)} دينار\n${clientNoteDisplay}`;
                            for (const col of colleagues) {
                                await companyBotAPI.sendMessage(col.telegramId, broadcastMsg, { parse_mode: 'HTML' }).catch(()=>{});
                            }
                        }
                    } catch(e) {}
                }

                // إرسال الإشعار للإدارة العليا مع أزرار التحكم
                const sourceHeader = isMainBot ? `👤 <b>عميل فردي:</b> ${employeeName}` : `🏢 <b>الشركة:</b> ${botData.name}\n👨‍💻 <b>الموظف:</b> ${employeeName}`;
                const adminNoteDisplay = transferNote ? `\n📝 <b>ملاحظة العميل:</b> <i>${transferNote}</i>` : '';
                
                const msgText = `🔔 <b>طلب تحويل فودافون كاش!</b>\n\n${sourceHeader}\n📞 <b>الرقم:</b> <code>${transaction.vodafoneNumber}</code>\n🇪🇬 <b>المبلغ المطلوب:</b> ${transaction.amount} EGP\n🇱🇾 <b>الدفع:</b> ${transaction.costLYD.toFixed(2)} LYD (سعر: ${exchangeRate})\n🧾 <b>رقم الطلب:</b> <code>${transaction.customId}</code>${adminNoteDisplay}`; 
                
                const msgMarkup = {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🤖 تحويل لبوت تنفيذي', `forward_${transaction._id}`)],
                        [Markup.button.callback('❌ إلغاء العملية', `cancelReq_${transaction._id}`)]
                    ])
                };

                const allAdmins = await Admin.find({});
                let savedAdminMsgs = [];
                for (const admin of allAdmins) {
                    if (admin.telegramId && !admin.webUsername) {
                        try {
                            const sentMsg = await adminBotAPI.sendMessage(admin.telegramId, msgText, msgMarkup);
                            if(sentMsg) savedAdminMsgs.push({ telegramId: admin.telegramId, messageId: sentMsg.message_id });
                        } catch (err) {}
                    }
                }
                
                if (savedAdminMsgs.length > 0) {
                    transaction.adminMessages = savedAdminMsgs;
                    await transaction.save();
                }
                    
            } catch (error) {
                console.error(error);
                await editPrompt(ctx, 'حدث خطأ داخلي أثناء حفظ المعاملة.', {});
            }
            return ctx.scene.leave();
        }
    }
);

module.exports = transferWizard;