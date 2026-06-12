// models/Settings.js
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    rateLevel1: { type: Number, default: 6.40 },
    rateLevel2: { type: Number, default: 6.45 },
    rateLevel3: { type: Number, default: 6.50 },
    isManualClosed: { type: Boolean, default: false },
    openingTime: { type: String, default: '09:00' },
    closingTime: { type: String, default: '23:59' },
    closedMessage: { type: String, default: 'النظام مغلق حالياً.' },
    termsMessage: { type: String, default: 'شروط التحويل...' },
    supportContact: { type: String, default: '@AhramSupport' },
    welcomeMessage: { type: String, default: 'مرحباً بك' },
    execExcelTitleBg: { type: String, default: '#4B0082' },
    execExcelHeaderBg: { type: String, default: '#800080' },
    execExcelTotalBg: { type: String, default: '#E2EFDA' },
    execExcelFontSize: { type: Number, default: 11 },
    execExcelColWidth: { type: Number, default: 16 },
    execExcelRowHeight: { type: Number, default: 25 },
    execExcelAlignment: { type: String, default: 'center' },
    execExcelMainTitle: { type: String, default: 'سـجـل الـتـنـفـيـذ والـعـمـلـيـات - شـركـة الأهرام' },
    execExcelColNames: { type: String, default: 'رقم الطلب,اسم المنفذ,الرقم / الحساب,المبلغ (EGP),حالة الطلب,تاريخ الإنشاء' },
    execExcelColKeys: { type: String, default: 'id,employee,phone,amount,status,date' },
    execExcelSummaryNames: { type: String, default: 'إجمالي المحول (EGP),القيمة السابقة,المسدد (إيداعات),المجموع الكلي (الرصيد)' },
    execExcelSummaryKeys: { type: String, default: 'totalEGP,prevValue,paid,grandTotal' },
    
    // 🚀 الحقول الجديدة الخاصة بمحرك التوجيه التلقائي
    autoRouteEnabled: { type: Boolean, default: false },
    autoRouteBotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorBot', default: null }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);