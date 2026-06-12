const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const ClientBot = require('../../../models/ClientBot');
const Admin = require('../../../models/Admin');
const User = require('../../../models/User');

const editPrompt = async (ctx, text, markup = {}) => {
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

const editAmountWizard = new Scenes.WizardScene(
    'EDIT_AMOUNT_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        ctx.wizard.state.promptMsgId = ctx.scene.state.promptMsgId;
        const tx = await Transaction.findById(ctx.wizard.state.txId);
        await editPrompt(ctx, `✏️ <b>تعديل المبلغ (تحويل جزئي)</b>\n\nالمبلغ الأصلي: <b>${tx.amount} EGP</b>\n\nالرجاء إرسال المبلغ الجديد (الذي تم تحويله فعلياً):`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'edit_back') {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            const execMsg = `⚙️ <b>أنت الآن تقوم بتنفيذ هذا الطلب!</b>\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>رقم المحفظة:</b> <code>${tx.vodafoneNumber}</code>\n💵 <b>المبلغ المطلوب:</b> ${tx.amount} EGP\n${tx.notes ? `📝 <b>الملاحظة:</b> ${tx.notes}\n` : ''}━━━━━━━━━━━━━━`;
            await editPrompt(ctx, execMsg, Markup.inlineKeyboard([
                [Markup.button.callback('✅ تم التحويل (إرفاق الإثبات)', `done_task_${tx._id}`)],
                [Markup.button.callback('✏️ تعديل المبلغ المحول', `editAmount_${tx._id}`)],
                [Markup.button.callback('❌ إلغاء الحوالة (يوجد مشكلة)', `cancelExec_${tx._id}`)]
            ]));
            return ctx.scene.leave();
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            const newAmount = parseFloat(ctx.message.text?.trim());
            if (isNaN(newAmount) || newAmount <= 0) {
                await editPrompt(ctx, '⚠️ <b>مبلغ غير صالح!</b>\nالرجاء كتابة رقم صحيح:', Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
                return;
            }

            ctx.wizard.state.newAmount = newAmount;
            await editPrompt(ctx, `✅ تم حفظ المبلغ الجديد: <b>${newAmount} EGP</b>\n\n📸 الرجاء إرسال صورة الإثبات الآن:`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'edit_back') {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            await editPrompt(ctx, `✏️ <b>تعديل المبلغ (تحويل جزئي)</b>\n\nالمبلغ الأصلي: <b>${tx.amount} EGP</b>\n\nالرجاء إرسال المبلغ الجديد (الذي تم تحويله فعلياً):`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_scene')]]));
            ctx.wizard.selectStep(1);
            return;
        }
        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            if (!ctx.message.photo) {
                await editPrompt(ctx, '⚠️ <b>يجب إرسال صورة.</b>\nالرجاء إرسال صورة الإثبات:', Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
                return;
            }

            await editPrompt(ctx, '⏳ <i>جاري معالجة الإثبات وإغلاق الطلب وإشعار الإدارة...</i>');
            const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            
            try {
                const tx = await Transaction.findById(ctx.wizard.state.txId);
                const oldAmount = tx.amount;
                const oldLYD = tx.costLYD;
                const newAmount = ctx.wizard.state.newAmount;
                
                const newLYD = parseFloat((newAmount / tx.exchangeRate).toFixed(3));
                const refundLYD = oldLYD - newLYD;

                tx.amount = newAmount;
                tx.costLYD = newLYD;
                
                const fileLink = await ctx.telegram.getFileLink(photoId);
                tx.proofImage = fileLink.href;
                tx.status = 'completed';
                tx.notes = (tx.notes ? tx.notes + ' | ' : '') + `تعديل مبلغ من ${oldAmount} إلى ${newAmount}`;
                await tx.save();

                let imageBuffer = null;
                try {
                    const response = await fetch(fileLink.href);
                    imageBuffer = Buffer.from(await response.arrayBuffer());
                } catch (fetchErr) {}

                if (refundLYD > 0) {
                    if (tx.clientBotId) await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: refundLYD } });
                    else await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: refundLYD } });
                }

                let clientAPI;
                if (tx.clientBotId) {
                    const comp = await ClientBot.findById(tx.clientBotId);
                    if (comp) clientAPI = new Telegram(comp.token);
                }
                if (!clientAPI) clientAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                
                const clientMsg = `✅ <b>تم تنفيذ طلبك جزئياً!</b>\n\n🧾 الطلب: <code>${tx.customId || tx._id}</code>\n⚠️ <b>ملاحظة:</b> تم التحويل بمبلغ ${newAmount} EGP (بدلاً من ${oldAmount} EGP)\n💰 <b>تم إرجاع الفارق:</b> ${refundLYD.toFixed(2)} دينار لحسابك.\n\n<i>مرفق الإثبات أدناه.</i>`;
                
                try { 
                    if (imageBuffer) {
                        await clientAPI.sendPhoto(tx.userId, { source: imageBuffer }, { caption: clientMsg, parse_mode: 'HTML' }); 
                    } else {
                        await clientAPI.sendMessage(tx.userId, clientMsg, { parse_mode: 'HTML' });
                    }
                } catch(e){}

                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const adminMsg = `⚠️ <b>تم تنفيذ حوالة بنجاح (مع تعديل المبلغ)!</b>\n\n` +
                                 `👤 <b>الجهة/العميل:</b> ${tx.companyName || 'عميل فردي'}\n` +
                                 `👤 <b>اسم المرسل:</b> ${tx.employeeName || 'غير مسجل'}\n` +
                                 `🤖 <b>بواسطة بوت:</b> ${tx.executorBotName || 'غير محدد'}\n` +
                                 `👨‍💻 <b>الموظف المنفذ:</b> ${tx.executorName || 'غير محدد'}\n` +
                                 `━━━━━━━━━━━━━━\n` +
                                 `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                 `📞 <b>الرقم المحول إليه:</b> <code>${tx.vodafoneNumber}</code>\n` +
                                 `💵 <b>المبلغ الجديد:</b> ${newAmount} EGP (كان ${oldAmount})\n` +
                                 `💰 <b>تم إرجاع:</b> ${refundLYD.toFixed(2)} LYD للعميل.`;

                const allAdmins = await Admin.find({});
                for (const admin of allAdmins) {
                    try {
                        if (imageBuffer) {
                            await adminAPI.sendPhoto(admin.telegramId, { source: imageBuffer }, { caption: adminMsg, parse_mode: 'HTML' });
                        } else {
                            await adminAPI.sendMessage(admin.telegramId, adminMsg, { parse_mode: 'HTML' });
                        }
                    } catch (adminErr) {}
                }

                await editPrompt(ctx, `✅ <b>اكتملت العملية بنجاح!</b>\n\nتم تنفيذ الطلب بمبلغ ${newAmount} واسترجاع الفارق للعميل، وتم الإرسال للإدارة.`, {});

            } catch (e) {}
            return ctx.scene.leave();
        }
    }
);
module.exports = editAmountWizard;