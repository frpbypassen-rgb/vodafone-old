// bots/executor/manager.js
const { Telegraf, Markup, session, Scenes, Telegram } = require('telegraf');
const ExcelJS = require('exceljs');

const ExecutorBot = require('../../models/ExecutorBot');
const Transaction = require('../../models/Transaction');
const Employee = require('../../models/Employee');
const Admin = require('../../models/Admin'); 
const Settings = require('../../models/Settings'); 
const ClientBot = require('../../models/ClientBot'); 

const proofWizard = require('./scenes/proofScene');
const employeeRegisterWizard = require('./scenes/employeeRegisterScene');
const financialClosingWizard = require('./scenes/financialClosingScene');
const resolveComplaintWizard = require('./scenes/resolveComplaintScene');
const cancelExecWizard = require('./scenes/cancelExecScene'); 
const editAmountWizard = require('./scenes/editAmountScene'); 
const provideSenderPhoneWizard = require('./scenes/provideSenderPhoneScene'); 
const settleChildWizard = require('./scenes/settleChildScene'); 
const supportWizard = require('./scenes/supportScene');

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
const activeBots = new Map();

const broadcastToAdmins = async (msgText, msgMarkup = { parse_mode: 'HTML' }) => {
    try {
        const allAdmins = await Admin.find({});
        allAdmins.forEach(admin => adminBotAPI.sendMessage(admin.telegramId, msgText, msgMarkup).catch(()=>{}));
    } catch (e) { }
};

const getArgb = (hex) => 'FF' + (hex || '#FFFFFF').replace('#', '').toUpperCase();

const buildExecutorInvoiceSheet = (sheet, botName, dateLabel, txs, prevValue, totalEGP, paid, grandTotal, set) => {
    sheet.views = [{ rightToLeft: true }];
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const thickBorder = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };

    const titleBgColor = getArgb(set.execExcelTitleBg || '#4B0082');
    const headerBgColor = getArgb(set.execExcelHeaderBg || '#800080');
    const totalBgColor = getArgb(set.execExcelTotalBg || '#E2EFDA');
    const mainFontSize = set.execExcelFontSize || 11;
    const colWidth = set.execExcelColWidth || 16;
    const rowHeight = set.execExcelRowHeight || 25;
    const cellAlign = set.execExcelAlignment || 'center';
    const mainTitle = set.execExcelMainTitle || 'سـجـل الـتـنـفـيـذ والـعـمـلـيـات - شـركـة الأهرام';
    
    const colNames = (set.execExcelColNames || 'رقم الطلب,اسم المنفذ,الرقم / الحساب,المبلغ (EGP),حالة الطلب,تاريخ الإنشاء').split(',');
    const colKeys = (set.execExcelColKeys || 'id,employee,phone,amount,status,date').split(',');
    const totalCols = colKeys.length;

    const sumNames = (set.execExcelSummaryNames || 'إجمالي المحول (EGP),القيمة السابقة,المسدد (إيداعات),المجموع الكلي (الرصيد)').split(',');
    const sumKeys = (set.execExcelSummaryKeys || 'totalEGP,prevValue,paid,grandTotal').split(',');

    sheet.properties.defaultRowHeight = rowHeight;

    sheet.mergeCells(1, 1, 2, totalCols);
    const titleCell = sheet.getCell('A1');
    titleCell.value = mainTitle;
    titleCell.font = { size: mainFontSize + 5, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: titleBgColor } }; 
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    titleCell.border = thickBorder;

    sheet.mergeCells(3, 1, 3, totalCols);
    const subCell = sheet.getCell('A3');
    subCell.value = `البوت: ${botName}   |   تاريخ التقرير: ${dateLabel}`;
    subCell.font = { bold: true, size: mainFontSize };
    subCell.alignment = { vertical: 'middle', horizontal: 'center' };
    subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    subCell.border = borderStyle;

    sheet.addRow([]);

    const headerRow = sheet.addRow(colNames);
    headerRow.height = rowHeight;
    headerRow.eachCell(c => {
        c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: mainFontSize };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerBgColor } }; 
        c.border = borderStyle;
        c.alignment = { vertical: 'middle', horizontal: cellAlign };
    });

    txs.forEach(t => {
        let statusAr = 'معلق';
        if (t.status === 'completed') statusAr = 'مكتمل';
        else if (t.status === 'rejected') statusAr = 'مرفوض/ملغى';
        else if (t.status === 'accepted') statusAr = 'قيد العمل';
        else if (t.status === 'processing') statusAr = 'بانتظار السحب';
        else if (t.status === 'deposit') statusAr = 'تسديد/إيداع';
        else if (t.status === 'deduction') statusAr = 'خصم';

        const rowData = colKeys.map(key => {
            switch(key) {
                case 'id': return t.customId || t._id.toString().slice(-6);
                case 'employee': return t.executorName || 'الإدارة';
                case 'phone': return t.vodafoneNumber || t.accountNumber || '---';
                case 'amount': return t.amount;
                case 'status': return statusAr;
                case 'date': return t.updatedAt.toLocaleDateString('en-GB');
                default: return '-';
            }
        });

        const dataRow = sheet.addRow(rowData);
        dataRow.height = rowHeight;
        dataRow.eachCell(c => { 
            c.border = borderStyle; 
            c.alignment = { vertical: 'middle', horizontal: cellAlign }; 
            c.font = { size: mainFontSize }; 
        });
    });

    sheet.addRow([]); 
    
    const addSummaryRow = (label, value, color = 'FFF2F2F2') => {
        const row = sheet.addRow([]);
        row.height = rowHeight;
        if (totalCols > 2) sheet.mergeCells(row.number, 1, row.number, totalCols - 2);
        const labelCell = row.getCell(totalCols > 2 ? totalCols - 1 : 1);
        const valueCell = row.getCell(totalCols);
        labelCell.value = label;
        valueCell.value = value;
        labelCell.font = { bold: true, size: mainFontSize };
        labelCell.alignment = { vertical: 'middle', horizontal: 'right' }; 
        labelCell.border = borderStyle;
        labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        valueCell.font = { bold: true, size: mainFontSize, color: { argb: 'FF000000' } };
        valueCell.alignment = { vertical: 'middle', horizontal: cellAlign };
        valueCell.border = borderStyle;
        return row;
    };

    const summaryData = {
        'totalEGP': { val: totalEGP.toFixed(2), bg: 'FFFFE699' },
        'prevValue': { val: prevValue.toFixed(2), bg: 'FFF2F2F2' },
        'paid': { val: paid.toFixed(2), bg: 'FFD9EAD3' },
        'grandTotal': { val: grandTotal.toFixed(2), bg: totalBgColor.replace('FF', '') }
    };

    sumKeys.forEach((key, index) => {
        if (!summaryData[key]) return;
        const item = summaryData[key];
        const row = addSummaryRow(sumNames[index], item.val, item.bg);
        if (key === 'grandTotal') {
            const finalValCell = row.getCell(totalCols);
            row.getCell(totalCols > 2 ? totalCols - 1 : 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalBgColor } };
            if (grandTotal < 0) {
                finalValCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
                finalValCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: mainFontSize + 1 };
            } else {
                finalValCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
                finalValCell.font = { bold: true, color: { argb: 'FF000000' }, size: mainFontSize + 1 }; 
            }
            finalValCell.border = thickBorder;
        }
    });
    sheet.columns.forEach(col => col.width = colWidth);
};

const sendDailyAutoClosing = async (botData) => {
    try {
        const now = new Date();
        const startDate = new Date(now); startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(now); endDate.setHours(23, 59, 59, 999);
        const dateLabel = now.toLocaleDateString('en-GB');

        const set = await Settings.findOne({}) || await Settings.create({});
        const managers = await Employee.find({ botId: botData._id, role: 'manager', status: 'active' });
        if (managers.length === 0) return;

        const botAPI = new Telegram(botData.token);

        if (botData.isManagerBot) {
            const childBots = await ExecutorBot.find({ parentBotId: botData._id });
            let globalEGP = 0, globalPaid = 0, globalPrev = 0;

            for (const cBot of childBots) {
                const cPrevTxs = await Transaction.find({ executorBotId: cBot._id, status: 'completed', updatedAt: { $lt: startDate } });
                const cPeriodTxs = await Transaction.find({ executorBotId: cBot._id, status: { $in: ['completed', 'processing', 'accepted', 'deposit'] }, updatedAt: { $gte: startDate, $lte: endDate } }).sort({ updatedAt: 1 });

                let cPrevValue = 0; cPrevTxs.forEach(t => cPrevValue -= t.amount);
                let cTotalEGP = 0, cPaid = 0; 
                cPeriodTxs.forEach(t => { 
                    if (t.status === 'completed') cTotalEGP += t.amount; 
                    if (t.status === 'deposit') cPaid += t.amount;
                });

                globalPrev += cPrevValue;
                globalEGP += cTotalEGP;

                if (cPeriodTxs.length > 0) {
                    const cWb = new ExcelJS.Workbook();
                    buildExecutorInvoiceSheet(cWb.addWorksheet('سجل البوت'), cBot.name, dateLabel, cPeriodTxs, cPrevValue, cTotalEGP, cPaid, (cPrevValue - cTotalEGP + cPaid), set);
                    const cBuffer = await cWb.xlsx.writeBuffer();
                    
                    for (const mgr of managers) {
                        await botAPI.sendDocument(mgr.telegramId, { source: cBuffer, filename: `AutoClose_${cBot.name.replace(/\s+/g, '_')}_${dateLabel.replace(/\//g, '-')}.xlsx` }, { caption: `📁 **تقفيل منفصل: ${cBot.name}**\nإجمالي تحويلاته: ${cTotalEGP} EGP` }).catch(()=>{});
                    }
                }
            }

            const mgrPrevTxs = await Transaction.find({ executorBotId: botData._id, status: { $in: ['deposit', 'deduction'] }, updatedAt: { $lt: startDate } });
            const mgrPeriodTxs = await Transaction.find({ executorBotId: botData._id, status: { $in: ['deposit', 'deduction'] }, updatedAt: { $gte: startDate, $lte: endDate } });

            mgrPrevTxs.forEach(t => { if(t.status==='deposit') globalPrev+=t.amount; else globalPrev-=Math.abs(t.amount); });
            mgrPeriodTxs.forEach(t => { if(t.status==='deposit') globalPaid+=t.amount; else globalPaid-=Math.abs(t.amount); });

            const allMgrTxs = await Transaction.find({
                $or: [ { managerBotId: botData._id }, { executorBotId: botData._id, status: { $in: ['deposit', 'deduction'] } } ],
                updatedAt: { $gte: startDate, $lte: endDate }
            }).sort({ updatedAt: 1 });

            const finalGrandTotal = globalPrev - globalEGP + globalPaid;

            const mWb = new ExcelJS.Workbook();
            buildExecutorInvoiceSheet(mWb.addWorksheet('التقرير الشامل'), botData.name, dateLabel, allMgrTxs, globalPrev, globalEGP, globalPaid, finalGrandTotal, set);
            const mBuffer = await mWb.xlsx.writeBuffer();
            
            for (const mgr of managers) {
                await botAPI.sendDocument(mgr.telegramId, { source: mBuffer, filename: `Master_AutoClose_${dateLabel.replace(/\//g, '-')}.xlsx` }, { caption: `📊 **التقفيل الشامل التلقائي للوكالة**\nإجمالي المبالغ: ${globalEGP} EGP\nالرصيد الختامي: ${finalGrandTotal.toFixed(2)}` }).catch(()=>{});
            }
        } else {
            let queryFilterPrev = { executorBotId: botData._id, status: { $in: ['completed', 'deposit', 'deduction'] }, updatedAt: { $lt: startDate } };
            let queryFilterPeriod = { executorBotId: botData._id, status: { $in: ['completed', 'deposit', 'deduction', 'processing', 'accepted'] }, updatedAt: { $gte: startDate, $lte: endDate } };

            const prevTxs = await Transaction.find(queryFilterPrev);
            let prevValue = 0;
            prevTxs.forEach(t => {
                if (t.status === 'completed') prevValue -= t.amount;
                else if (t.status === 'deposit') prevValue += t.amount;
                else if (t.status === 'deduction') prevValue -= Math.abs(t.amount);
            });

            const periodTxs = await Transaction.find(queryFilterPeriod).sort({ updatedAt: 1 });
            let totalEGP = 0; let paid = 0;
            periodTxs.forEach(t => {
                if (t.status === 'completed') totalEGP += t.amount;
                else if (t.status === 'deposit') paid += t.amount;
                else if (t.status === 'deduction') paid -= Math.abs(t.amount);
            });

            const grandTotal = prevValue - totalEGP + paid;

            const wb = new ExcelJS.Workbook();
            buildExecutorInvoiceSheet(wb.addWorksheet('إغلاق اليوم'), botData.name, dateLabel, periodTxs, prevValue, totalEGP, paid, grandTotal, set);
            const buffer = await wb.xlsx.writeBuffer();

            for (const mgr of managers) {
                await botAPI.sendDocument(
                    mgr.telegramId,
                    { source: buffer, filename: `Auto_Close_${dateLabel.replace(/\//g, '-')}.xlsx` },
                    { caption: `⏰ <b>الإغلاق اليومي التلقائي</b>\n\n📊 <b>بوت:</b> ${botData.name}\n📅 <b>اليوم:</b> ${dateLabel}\n💰 <b>رصيد ختامي:</b> ${grandTotal.toFixed(2)} EGP`, parse_mode: 'HTML' }
                ).catch(() => {});
            }
        }
    } catch (e) {
        console.error('Auto Close Error:', e);
    }
};

const launchExecutorBot = (botData) => {
    try {
        if (activeBots.has(botData.token)) return;
        const bot = new Telegraf(botData.token);
        
        const stage = new Scenes.Stage([proofWizard, employeeRegisterWizard, financialClosingWizard, resolveComplaintWizard, cancelExecWizard, editAmountWizard, provideSenderPhoneWizard, settleChildWizard, supportWizard]);
        
        bot.use(session());
        bot.use(async (ctx, next) => {
            if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
            if (ctx.message && ctx.message.text === '/cancel') {
                if (ctx.scene) await ctx.scene.leave(); 
                ctx.session = {}; 
                await ctx.reply('✅ تم إنهاء العملية.');
                return; 
            }
            return next();
        });

        bot.use(stage.middleware());

        const showExecutorDashboard = async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const emp = await Employee.findOne({ telegramId, botId: botData._id });
            const set = await Settings.findOne({}) || await Settings.create({}); 
            const currentBot = await ExecutorBot.findById(botData._id);

            if (!emp) return ctx.scene.enter('EMP_REGISTER_SCENE', { botData: currentBot });
            if (emp.status === 'pending') return ctx.reply(set.executorPendingMessage || '⏳ حسابك قيد المراجعة في انتظار موافقة الإدارة.');
            if (emp.status === 'banned') return ctx.reply(set.executorBannedMessage || '⛔️ تم حظر حسابك.');

            let keyboard = [];
            
            if (emp.role === 'operator') {
                keyboard = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], ['🎧 الدعم الفني وتواصل معنا']];
                await ctx.reply(`🤖 أهلاً بك يا ${emp.name}`, Markup.keyboard(keyboard).resize());
            } else if (emp.role === 'manager') {
                const toggleBtn = currentBot.status === 'paused' ? '🔴 استئناف عمل البوت' : '🟢 إيقاف مؤقت للبوت';
                const statusTxt = currentBot.status === 'paused' ? '🔴 موقوف مؤقتاً (مخفي من الإدارة)' : '🟢 يعمل ويستقبل طلبات';
                
                if (currentBot.isManagerBot) {
                    keyboard = [[toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
                    await ctx.reply(`🏢 **لوحة الوكالة - ${currentBot.name}**\nأهلاً بك يا ${emp.name}\n📊 حالة الوكالة: ${statusTxt}`, Markup.keyboard(keyboard).resize());
                } else {
                    keyboard = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], [toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
                    await ctx.reply(`👨‍💼 **لوحة المدير - ${currentBot.name}**\nأهلاً بك يا ${emp.name}\n📊 حالة البوت: ${statusTxt}`, Markup.keyboard(keyboard).resize());
                }
            }
        };

        bot.start(showExecutorDashboard);

        bot.hears('🏠 القائمة الرئيسية (تحديث)', async (ctx) => {
            if (ctx.scene) await ctx.scene.leave();
            await showExecutorDashboard(ctx);
        });

        bot.hears('🎧 الدعم الفني وتواصل معنا', (ctx) => {
            ctx.scene.enter('SUPPORT_SCENE', { botData });
        });

        bot.hears('🟢 إيقاف مؤقت للبوت', async (ctx) => {
            const emp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
            if (!emp || emp.role !== 'manager') return;
            
            await ExecutorBot.findByIdAndUpdate(botData._id, { status: 'paused' });
            await ctx.reply('⏸ <b>تم إيقاف البوت مؤقتاً!</b>\nلن يظهر البوت الآن في قائمة التحويل الخاصة بالإدارة.', { parse_mode: 'HTML' });
            await showExecutorDashboard(ctx);
        });

        bot.hears('🔴 استئناف عمل البوت', async (ctx) => {
            const emp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
            if (!emp || emp.role !== 'manager') return;
            
            await ExecutorBot.findByIdAndUpdate(botData._id, { status: 'active' });
            await ctx.reply('▶️ <b>تم استئناف عمل البوت!</b>\nالبوت الآن ظاهر ومتاح للإدارة ويستقبل تحويلات جديدة.', { parse_mode: 'HTML' });
            await showExecutorDashboard(ctx);
        });

        bot.action(/mgrApproveEmp_(.+)/, async (ctx) => {
            const empId = ctx.match[1];
            const emp = await Employee.findById(empId);
            if (!emp || emp.status !== 'pending') return ctx.editMessageText('⚠️ تمت معالجة هذا الطلب مسبقاً.');
            
            emp.status = 'active';
            await emp.save();
            await ctx.editMessageText(`✅ <b>تم قبول الموظف:</b> ${emp.name} بنجاح.`, {parse_mode:'HTML'});
            await ctx.telegram.sendMessage(emp.telegramId, `🎉 <b>مبارك!</b>\nقام المدير بالموافقة على انضمامك لفريق العمل.\n\nاضغط /start لفتح اللوحة وبدء العمل.`, {parse_mode:'HTML'}).catch(()=>{});
        });

        bot.action(/mgrRejectEmp_(.+)/, async (ctx) => {
            const empId = ctx.match[1];
            const emp = await Employee.findById(empId);
            if (!emp || emp.status !== 'pending') return ctx.editMessageText('⚠️ تمت معالجة هذا الطلب مسبقاً.');
            
            await Employee.findByIdAndDelete(empId);
            await ctx.editMessageText(`❌ تم رفض وحذف طلب الموظف: ${emp.name}.`);
            await ctx.telegram.sendMessage(emp.telegramId, `❌ عذراً، تم رفض طلب انضمامك من قبل المدير.`, {parse_mode:'HTML'}).catch(()=>{});
        });

        bot.hears('🟠 الطلبات المعلقة', async (ctx) => {
            if (botData.isManagerBot) return;
            const empOp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
            if (empOp && empOp.status === 'suspended') return ctx.reply('⛔️ حسابك موقوف (أنت خارج الشفت).');

            const pendingTxs = await Transaction.find({ executorBotId: botData._id, status: 'processing' });
            if (pendingTxs.length === 0) return ctx.reply('✅ لا توجد أي طلبات معلقة بانتظار التنفيذ.');

            for (const tx of pendingTxs) {
                let typeLabel = 'فودافون كاش';
                if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

                const textMsg = `🔔 <b>طلب معلق (${typeLabel}):</b>\n${accDetails}\n💵 المبلغ: ${tx.amount} EGP\n🧾 الطلب: <code>${tx.customId || tx._id}</code>`;
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🤝 قبول المهمة', `accept_task_${tx._id}`)], [Markup.button.callback('❌ رفض', `reject_task_${tx._id}`)]]);

                let sentMsg;
                if (tx.transferType === 'post_card' && tx.idCardImage) {
                     let idUrl = tx.idCardImage;
                     try {
                         let cToken = process.env.CLIENT_BOT_TOKEN;
                         if (tx.clientBotId) {
                             const comp = await ClientBot.findById(tx.clientBotId);
                             if (comp) cToken = comp.token;
                         }
                         const tempApi = new Telegram(cToken);
                         idUrl = (await tempApi.getFileLink(tx.idCardImage)).href;
                     } catch(e){}
                     sentMsg = await ctx.replyWithPhoto({ url: idUrl }, { caption: textMsg, parse_mode: 'HTML', ...keyboard }).catch(() => ctx.reply(textMsg, { parse_mode: 'HTML', ...keyboard }));
                } else {
                     sentMsg = await ctx.reply(textMsg, { parse_mode: 'HTML', ...keyboard });
                }

                tx.broadcastMessages.push({ telegramId: ctx.from.id.toString(), messageId: sentMsg.message_id });
                await tx.save();
            }
        });

        // 🛡️ القبول الذري للمهمة في التليجرام (Atomic Accept) لمنع التضارب
        bot.action(/accept_task_(.+)/, async (ctx) => {
            if (botData.isManagerBot) return;
            
            const empOp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
            if (empOp && empOp.status === 'suspended') return ctx.answerCbQuery('⛔️ حسابك موقوف (خارج الشفت).', {show_alert: true});

            const txId = ctx.match[1];
            try {
                // التحديث لا يتم إلا إذا كانت المهمة لا تزال processing
                const tx = await Transaction.findOneAndUpdate(
                    { _id: txId, status: 'processing' },
                    { $set: { status: 'accepted', operatorId: ctx.from.id.toString(), executorName: empOp ? empOp.name : ctx.from.first_name, emergencyAlert: undefined } },
                    { new: true }
                );

                if (!tx) return ctx.answerCbQuery('⚠️ هذا الطلب تم قبوله أو معالجته مسبقاً!', { show_alert: true });

                let typeLabel = 'فودافون كاش';
                if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

                const execMsg = `⚙️ <b>أنت الآن تقوم بتنفيذ هذا الطلب! (${typeLabel})</b>\n\n` + 
                                `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` + 
                                accDetails + 
                                `💵 <b>المبلغ المطلوب:</b> ${tx.amount} EGP\n` + 
                                `${tx.notes ? `📝 <b>ملاحظة العميل:</b> ${tx.notes}\n` : ''}━━━━━━━━━━━━━━`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ تم التحويل (ارفق الإثبات)', `done_task_${txId}`)],
                    [Markup.button.callback('✏️ تعديل المبلغ (مع ذكر السبب)', `editAmount_${txId}`)],
                    [Markup.button.callback('❌ إلغاء الحوالة (يوجد مشكلة)', `cancelExec_${txId}`)]
                ]);

                let savedMsgId = null;
                if (ctx.callbackQuery.message.photo) {
                    const updatedMsg = await ctx.editMessageCaption(execMsg, { parse_mode: 'HTML', ...keyboard }).catch(()=>{});
                    if(updatedMsg) savedMsgId = updatedMsg.message_id;
                } else {
                    const updatedMsg = await ctx.editMessageText(execMsg, { parse_mode: 'HTML', ...keyboard }).catch(()=>{});
                    if(updatedMsg) savedMsgId = updatedMsg.message_id;
                }

                if (tx.broadcastMessages && tx.broadcastMessages.length > 0) {
                    const otherMsg = `🔒 <b>الطلب قيد التنفيذ الآن!</b>\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n👨‍💻 <b>تم القبول بواسطة:</b> ${tx.executorName}`;
                    for (const msg of tx.broadcastMessages) {
                        if (msg.telegramId === ctx.from.id.toString()) continue; 
                        try {
                            if (tx.transferType === 'post_card' && tx.idCardImage) {
                                await ctx.telegram.editMessageCaption(msg.telegramId, msg.messageId, null, otherMsg, { parse_mode: 'HTML' });
                            } else {
                                await ctx.telegram.editMessageText(msg.telegramId, msg.messageId, null, otherMsg, { parse_mode: 'HTML' });
                            }
                        } catch (e) {} 
                    }
                }
                
                if (savedMsgId) {
                    let newBroadcasts = tx.broadcastMessages.filter(m => m.telegramId !== ctx.from.id.toString());
                    newBroadcasts.push({ telegramId: ctx.from.id.toString(), messageId: savedMsgId });
                    tx.broadcastMessages = newBroadcasts;
                    await tx.save();
                } else {
                    await tx.save();
                }

            } catch (err) {}
        });

        bot.action(/reject_task_(.+)/, async (ctx) => {
            if (botData.isManagerBot) return;
            const txId = ctx.match[1];
            try {
                const tx = await Transaction.findById(txId);
                if (!tx || tx.status !== 'processing') return ctx.answerCbQuery('⚠️ الطلب غير متاح.');
                tx.status = 'pending'; tx.executorBotId = null; tx.broadcastMessages = []; await tx.save();
                
                if (ctx.callbackQuery.message.photo) {
                    await ctx.editMessageCaption('❌ تم رفض الطلب وإرجاعه للإدارة المركزية.').catch(()=>{});
                } else {
                    await ctx.editMessageText('❌ تم رفض الطلب وإرجاعه للإدارة المركزية.').catch(()=>{});
                }
                broadcastToAdmins(`⚠️ <b>تنبيه!</b> تم إرجاع الطلب <code>${tx.customId}</code> من الموظفين لعدم المقدرة على تنفيذه.`, {parse_mode: 'HTML'});
            } catch (e) {}
        });

        bot.action(/^providePhone_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(()=>{});
            ctx.scene.enter('PROVIDE_SENDER_PHONE_SCENE', { txId: ctx.match[1], promptMsgId: ctx.callbackQuery.message.message_id });
        });

        bot.action(/^editAmount_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(()=>{});
            ctx.scene.enter('EDIT_AMOUNT_SCENE', { txId: ctx.match[1] });
        });

        bot.action(/^done_task_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(()=>{});
            ctx.scene.enter('PROOF_SCENE', { txId: ctx.match[1], promptMsgId: ctx.callbackQuery.message.message_id });
        });

        bot.action(/^cancelExec_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(()=>{});
            ctx.scene.enter('CANCEL_EXEC_SCENE', { txId: ctx.match[1], promptMsgId: ctx.callbackQuery.message.message_id });
        });

        bot.hears('🟡 طلبات قيد التنفيذ', async (ctx) => {
            if (botData.isManagerBot) return;
            const myTxs = await Transaction.find({ executorBotId: botData._id, operatorId: ctx.from.id.toString(), status: 'accepted' });
            if (myTxs.length === 0) return ctx.reply('✅ ليس لديك أي طلبات قيد التنفيذ حالياً.');

            for (const tx of myTxs) {
                let typeLabel = 'فودافون كاش';
                if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
                if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

                const execMsg = `⚙️ <b>تذكير: هذا الطلب بانتظار إكمالك! (${typeLabel})</b>\n\n` + 
                                `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` + 
                                accDetails + 
                                `💵 <b>المبلغ المطلوب:</b> ${tx.amount} EGP\n` + 
                                `${tx.notes ? `📝 <b>ملاحظة العميل:</b> ${tx.notes}\n` : ''}━━━━━━━━━━━━━━`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ تم التحويل (ارفق الإثبات)', `done_task_${tx._id}`)],
                    [Markup.button.callback('✏️ تعديل المبلغ (مع ذكر السبب)', `editAmount_${tx._id}`)],
                    [Markup.button.callback('❌ إلغاء الحوالة (يوجد مشكلة)', `cancelExec_${tx._id}`)]
                ]);

                if (tx.transferType === 'post_card' && tx.idCardImage) {
                    let idUrl = tx.idCardImage;
                    try {
                        let cToken = process.env.CLIENT_BOT_TOKEN;
                        if (tx.clientBotId) {
                            const comp = await ClientBot.findById(tx.clientBotId);
                            if (comp) cToken = comp.token;
                        }
                        const tempApi = new Telegram(cToken);
                        idUrl = (await tempApi.getFileLink(tx.idCardImage)).href;
                    } catch(e){}
                    await ctx.replyWithPhoto({ url: idUrl }, { caption: execMsg, parse_mode: 'HTML', ...keyboard }).catch(() => ctx.reply(execMsg, { parse_mode: 'HTML', ...keyboard }));
                } else {
                    await ctx.reply(execMsg, { parse_mode: 'HTML', ...keyboard });
                }
            }
        });

        bot.on('message', async (ctx) => {
            if (ctx.message.reply_to_message && ctx.message.reply_to_message.text && ctx.message.reply_to_message.text.includes('الرقم الذي تم إرسال الحوالة منه')) return;

            if (ctx.message.text && ctx.message.text.startsWith('comp_')) {
                const txId = ctx.message.text.split('_')[1];
                const emp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
                if (!emp || emp.role !== 'manager') return;

                const tx = await Transaction.findById(txId);
                if (!tx || !tx.complaintText) return ctx.reply('❌ هذه الشكوى غير موجودة أو تم حلها مسبقاً.');

                ctx.scene.enter('RESOLVE_COMPLAINT_SCENE', { tx, botData });
                return;
            }

            if (!ctx.message.text?.startsWith('/')) {
                const emp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
                if (!emp) return ctx.scene.enter('EMP_REGISTER_SCENE', { botData });
            }
        });

        bot.launch().then(() => {
            console.log(`🚀 تم تشغيل بوت التنفيذ [${botData.name}] بنجاح`);
            activeBots.set(botData.token, bot);
        }).catch(err => {
            console.error(`⚠️ فشل تشغيل البوت [${botData.name}]:`, err.message);
        });

    } catch (e) {
        console.error('Error launching executor bot:', e);
    }
};

const startAllExecutorBots = async () => {
    try {
        const bots = await ExecutorBot.find({ status: { $in: ['active', 'paused'] } });
        bots.forEach(bot => launchExecutorBot(bot));
    } catch (e) {
        console.error('Error starting all executor bots:', e);
    }
};

module.exports = {
    startAllExecutorBots,
    launchExecutorBot,
    sendDailyAutoClosing
};