// bots/admin/scenes/cancelReasonScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');

const cancelReasonScene = new Scenes.WizardScene(
    'CANCEL_REASON_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        await ctx.reply(
            '⚠️ <b>إلغاء الطلب وحذفه نهائياً</b>\n\n📝 الرجاء كتابة سبب الإلغاء لإرساله للعميل:', 
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_action')]]) }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_action') {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText('✅ تم التراجع عن الإلغاء.');
            return ctx.scene.leave();
        }

        const reason = ctx.message?.text?.trim();
        if (!reason) return ctx.reply('⚠️ يرجى كتابة السبب في رسالة نصية.');

        try {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            if (!tx) {
                await ctx.reply('❌ الطلب غير موجود أو تم حذفه مسبقاً.');
                return ctx.scene.leave();
            }

            // 🚀 1. إرجاع الرصيد بصمت للعميل (لأنه خُصم منه وقت الطلب)
            if (tx.clientBotId) {
                await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: tx.costLYD } });
            } else {
                await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.costLYD } });
            }

            const displayId = tx.customId || tx._id.toString();

            // 🚀 2. إرسال إشعار للعميل بالسبب
            const msgToClient = `❌ <b>تم إلغاء طلب التحويل الخاص بك!</b>\n\n` +
                                `🧾 <b>رقم الطلب:</b> <code>${displayId}</code>\n` +
                                `📞 <b>الرقم المحول له:</b> <code>${tx.vodafoneNumber}</code>\n` +
                                `💰 <b>المبلغ المسترجع:</b> ${tx.costLYD.toFixed(2)} دينار\n\n` +
                                `📝 <b>سبب الإلغاء:</b> ${reason}`;

            if (tx.clientBotId) {
                const comp = await ClientBot.findById(tx.clientBotId);
                if (comp) {
                    const compAPI = new Telegram(comp.token);
                    await compAPI.sendMessage(tx.userId, msgToClient, { parse_mode: 'HTML' }).catch(()=>{});
                }
            } else {
                const clientBotAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
                await clientBotAPI.sendMessage(tx.userId, msgToClient, { parse_mode: 'HTML' }).catch(()=>{});
            }

            // 🚀 3. مسح العملية نهائياً من قاعدة البيانات
            await Transaction.findByIdAndDelete(tx._id);

            await ctx.reply(`✅ <b>تم إلغاء الطلب وحذفه من السجلات نهائياً، وتم إشعار العميل.</b>\n\n📝 السبب: ${reason}`, { parse_mode: 'HTML' });

        } catch (err) {
            console.error(err);
            await ctx.reply('❌ حدث خطأ فني أثناء الإلغاء.');
        }
        return ctx.scene.leave();
    }
);

module.exports = cancelReasonScene;