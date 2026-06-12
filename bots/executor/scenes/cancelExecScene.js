// executor/scenes/cancelExecScene.js
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

const cancelExecWizard = new Scenes.WizardScene(
    'CANCEL_EXEC_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        ctx.wizard.state.promptMsgId = ctx.scene.state.promptMsgId;
        await editPrompt(ctx, `❌ <b>إلغاء تنفيذ الطلب</b>\n\nالرجاء كتابة سبب إلغاء الحوالة (مثال: المحفظة لا تقبل، الرقم خطأ، إلخ):`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_back')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_back') {
            await ctx.answerCbQuery().catch(()=>{});
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            const execMsg = `⚙️ <b>أنت الآن تقوم بتنفيذ هذا الطلب!</b>\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>رقم المحفظة:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ المطلوب:</b> ${tx.amount} EGP\n${tx.notes ? `📝 <b>الملاحظة:</b> ${tx.notes}\n` : ''}━━━━━━━━━━━━━━`;
            await editPrompt(ctx, execMsg, Markup.inlineKeyboard([
                [Markup.button.callback('✅ تم التحويل (إرفاق الإثبات)', `done_task_${tx._id}`)],
                [Markup.button.callback('✏️ تعديل المبلغ المحول', `editAmount_${tx._id}`)],
                [Markup.button.callback('❌ إلغاء الحوالة (يوجد مشكلة)', `cancelExec_${tx._id}`)]
            ]));
            return ctx.scene.leave();
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            const reason = ctx.message.text?.trim();
            if (!reason) {
                await editPrompt(ctx, '⚠️ <b>الرجاء كتابة السبب كنص:</b>', Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_back')]]));
                return;
            }

            await editPrompt(ctx, '⏳ <i>جاري معالجة الإلغاء...</i>');

            try {
                const tx = await Transaction.findById(ctx.wizard.state.txId);
                if(!tx) return ctx.scene.leave();
                
                tx.status = 'rejected';
                tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم الإلغاء | المنفذ: ${tx.executorName} | السبب: ${reason}]`;
                await tx.save();

                if (tx.clientBotId) await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: tx.costLYD } });
                else await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.costLYD } });

                let clientAPI;
                if (tx.clientBotId) {
                    const comp = await ClientBot.findById(tx.clientBotId);
                    if (comp) clientAPI = new Telegram(comp.token);
                }
                if (!clientAPI) clientAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                
                // إشعار العميل المفصل
                const clientMsg = `❌ <b>تم إلغاء طلب التحويل وإرجاع الرصيد!</b>\n\n👤 <b>المرسل:</b> ${tx.employeeName || 'غير محدد'}\n🧾 <b>رقم العملية:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>رقم الهاتف/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n⚠️ <b>سبب الإلغاء:</b> ${reason}`;
                
                try { await clientAPI.sendMessage(tx.userId, clientMsg, { parse_mode: 'HTML' }); } catch(e){}

                // إشعار الإدارة المفصل
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const adminMsg = `🚨 <b>تنبيه للإدارة: تم إلغاء عملية من قِبل المنفذ!</b>\n\n🏢 <b>الجهة/العميل:</b> ${tx.companyName || 'عميل فردي'}\n👤 <b>الموظف الطالب:</b> ${tx.employeeName || 'غير محدد'}\n🤖 <b>بواسطة المنفذ:</b> ${tx.executorName}\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة المسترجعة:</b> ${tx.costLYD.toFixed(2)} LYD\n⚠️ <b>سبب الإلغاء:</b> <b>${reason}</b>`;
                
                const allAdmins = await Admin.find({});
                for (const admin of allAdmins) {
                    await adminAPI.sendMessage(admin.telegramId, adminMsg, { parse_mode: 'HTML' }).catch(()=>{});
                }

                await editPrompt(ctx, `✅ <b>تم الإلغاء!</b>\n\nتم إلغاء الطلب <code>${tx.customId || tx._id}</code> بسبب: ${reason}\nوتم إشعار العميل وإرجاع الرصيد بنجاح.`, {});

            } catch (e) {
                await editPrompt(ctx, '❌ حدث خطأ فني.', {});
            }
            return ctx.scene.leave();
        }
    }
);
module.exports = cancelExecWizard;