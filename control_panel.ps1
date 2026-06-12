Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 🟢 إعداد مظهر الشاشة
$form = New-Object System.Windows.Forms.Form
$form.Text = "AHRAM-PAY | لوحة تحكم الخادم"
$form.Size = New-Object System.Drawing.Size(480, 520)
$form.StartPosition = "CenterScreen"
$form.BackColor = [System.Drawing.Color]::FromArgb(15, 15, 18)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false

# 🟢 ترويسة اللوحة
$headerPanel = New-Object System.Windows.Forms.Panel
$headerPanel.Size = New-Object System.Drawing.Size(480, 80)
$headerPanel.Location = New-Object System.Drawing.Point(0, 0)
$headerPanel.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 30)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "AHRAM-PAY"
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 26, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(212, 175, 55) # لون ذهبي
$titleLabel.Size = New-Object System.Drawing.Size(480, 45)
$titleLabel.Location = New-Object System.Drawing.Point(0, 10)
$titleLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Text = "لوحة التحكم بالسيرفر والعمليات"
$subtitleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$subtitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(160, 160, 175)
$subtitleLabel.Size = New-Object System.Drawing.Size(480, 20)
$subtitleLabel.Location = New-Object System.Drawing.Point(0, 55)
$subtitleLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$headerPanel.Controls.Add($titleLabel)
$headerPanel.Controls.Add($subtitleLabel)
$form.Controls.Add($headerPanel)

# 🟢 شاشة حالة السيرفر (في المنتصف)
$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Size = New-Object System.Drawing.Size(400, 90)
$statusPanel.Location = New-Object System.Drawing.Point(40, 100)
$statusPanel.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 32)

$statusTitle = New-Object System.Windows.Forms.Label
$statusTitle.Text = "حالة خادم النظام"
$statusTitle.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$statusTitle.ForeColor = [System.Drawing.Color]::FromArgb(180, 180, 190)
$statusTitle.Size = New-Object System.Drawing.Size(400, 25)
$statusTitle.Location = New-Object System.Drawing.Point(0, 10)
$statusTitle.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "جاري التحقق..."
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 24, [System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(212, 175, 55)
$statusLabel.Size = New-Object System.Drawing.Size(400, 45)
$statusLabel.Location = New-Object System.Drawing.Point(0, 35)
$statusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$statusPanel.Controls.Add($statusTitle)
$statusPanel.Controls.Add($statusLabel)
$form.Controls.Add($statusPanel)

# 🟢 الألوان والأنماط للأزرار
$greenColor = [System.Drawing.Color]::FromArgb(0, 230, 118)
$greenHover = [System.Drawing.Color]::FromArgb(20, 60, 35)

$redColor = [System.Drawing.Color]::FromArgb(255, 23, 68)
$redHover = [System.Drawing.Color]::FromArgb(65, 20, 30)

$blueColor = [System.Drawing.Color]::FromArgb(41, 182, 246)
$blueHover = [System.Drawing.Color]::FromArgb(20, 50, 75)

$grayColor = [System.Drawing.Color]::FromArgb(207, 216, 220)
$grayHover = [System.Drawing.Color]::FromArgb(55, 71, 79)

$orangeColor = [System.Drawing.Color]::FromArgb(255, 87, 34)
$orangeHover = [System.Drawing.Color]::FromArgb(90, 35, 20)

# 🟢 دالة لإنشاء الأزرار بشكل عصري
function Create-ModernButton($text, $x, $y, $w, $h, $borderColor, $hoverColor, $action) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $text
    $btn.Size = New-Object System.Drawing.Size($w, $h)
    $btn.Location = New-Object System.Drawing.Point($x, $y)
    $btn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $btn.FlatAppearance.BorderSize = 1
    $btn.FlatAppearance.BorderColor = $borderColor
    $btn.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 30)
    $btn.ForeColor = [System.Drawing.Color]::White
    $btn.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
    
    $btn.Add_MouseEnter({ $this.BackColor = $hoverColor })
    $btn.Add_MouseLeave({ $this.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 30) })
    $btn.Add_Click($action)
    return $btn
}

# 🟢 تعريف منطق التحكم بالسيرفر
$startAction = {
    if ($global:ServerProc -and -not $global:ServerProc.HasExited) {
        [System.Windows.Forms.MessageBox]::Show("السيرفر يعمل بالفعل!", "تنبيه", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
        return
    }
    
    if (-not (Test-Path "$PSScriptRoot\system.log")) { New-Item -Path "$PSScriptRoot\system.log" -ItemType File -Force | Out-Null }
    if (-not (Test-Path "$PSScriptRoot\error.log")) { New-Item -Path "$PSScriptRoot\error.log" -ItemType File -Force | Out-Null }
    
    try {
        $global:ServerProc = Start-Process -FilePath "node" -ArgumentList "app.js" -WorkingDirectory $PSScriptRoot -NoNewWindow -RedirectStandardOutput "$PSScriptRoot\system.log" -RedirectStandardError "$PSScriptRoot\error.log" -PassThru
        Update-Status "يعمل"
    } catch {
        Update-Status "خطأ"
        [System.Windows.Forms.MessageBox]::Show("فشل تشغيل السيرفر. تأكد من تثبيت Node.js وجودة مسار المشروع.`n`nالخطأ: $_", "خطأ", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
}

$stopAction = {
    if ($global:ServerProc -and -not $global:ServerProc.HasExited) {
        try {
            $global:ServerProc.Kill()
            $global:ServerProc.WaitForExit(2000)
        } catch {}
    }
    Update-Status "متوقف"
}

$restartAction = {
    &$stopAction
    Start-Sleep -Milliseconds 600
    &$startAction
}

$logsAction = {
    $logPath = "$PSScriptRoot\system.log"
    if (Test-Path $logPath) {
        Start-Process "notepad.exe" $logPath
    } else {
        [System.Windows.Forms.MessageBox]::Show("سجل الحركات فارغ أو لم يتم إنشاؤه بعد.", "تنبيه")
    }
}

$errorAction = {
    $errPath = "$PSScriptRoot\error.log"
    if (Test-Path $errPath) {
        Start-Process "notepad.exe" $errPath
    } else {
        [System.Windows.Forms.MessageBox]::Show("سجل الأخطاء فارغ أو لم يتم إنشاؤه بعد.", "تنبيه")
    }
}

# 🟢 دالة لتحديث حالة السيرفر بصرياً
function Update-Status($status) {
    switch ($status) {
        "يعمل" {
            $statusLabel.Text = "يعمل"
            $statusLabel.ForeColor = $greenColor
            $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(20, 40, 25)
        }
        "خطأ" {
            $statusLabel.Text = "خطأ"
            $statusLabel.ForeColor = $redColor
            $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(45, 15, 20)
        }
        default {
            $statusLabel.Text = "متوقف"
            $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(158, 158, 158)
            $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 32)
        }
    }
}

# 🟢 إنشاء الأزرار وإضافتها للنموذج
$btnStart = Create-ModernButton "تشغيل السيرفر" 40 210 190 45 $greenColor $greenHover $startAction
$btnStop = Create-ModernButton "إيقاف السيرفر" 250 210 190 45 $redColor $redHover $stopAction
$btnRestart = Create-ModernButton "إعادة تشغيل السيرفر" 40 265 400 45 $blueColor $blueHover $restartAction
$btnLogs = Create-ModernButton "سجل الحركات" 40 320 190 45 $grayColor $grayHover $logsAction
$btnErrors = Create-ModernButton "سجل الأخطاء" 250 320 190 45 $orangeColor $orangeHover $errorAction

$form.Controls.Add($btnStart)
$form.Controls.Add($btnStop)
$form.Controls.Add($btnRestart)
$form.Controls.Add($btnLogs)
$form.Controls.Add($btnErrors)

# 🟢 تذييل الشاشة (معلومات المطور)
$footerPanel = New-Object System.Windows.Forms.Panel
$footerPanel.Size = New-Object System.Drawing.Size(480, 110)
$footerPanel.Location = New-Object System.Drawing.Point(0, 375)
$footerPanel.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 24)

$divider = New-Object System.Windows.Forms.Panel
$divider.Size = New-Object System.Drawing.Size(480, 1)
$divider.Location = New-Object System.Drawing.Point(0, 0)
$divider.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 48)
$footerPanel.Controls.Add($divider)

$footerLabel1 = New-Object System.Windows.Forms.Label
$footerLabel1.Text = "تمت برمجة المشروع لشركة الأهرام"
$footerLabel1.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$footerLabel1.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 245)
$footerLabel1.Size = New-Object System.Drawing.Size(480, 25)
$footerLabel1.Location = New-Object System.Drawing.Point(0, 12)
$footerLabel1.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$footerLabel2 = New-Object System.Windows.Forms.Label
$footerLabel2.Text = "ENG.MUHAMMED ALI"
$footerLabel2.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$footerLabel2.ForeColor = [System.Drawing.Color]::FromArgb(212, 175, 55) # لون ذهبي
$footerLabel2.Size = New-Object System.Drawing.Size(480, 25)
$footerLabel2.Location = New-Object System.Drawing.Point(0, 37)
$footerLabel2.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$footerLabel3 = New-Object System.Windows.Forms.Label
$footerLabel3.Text = "0940719000"
$footerLabel3.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$footerLabel3.ForeColor = [System.Drawing.Color]::FromArgb(0, 229, 255) # لون سماوي
$footerLabel3.Size = New-Object System.Drawing.Size(480, 25)
$footerLabel3.Location = New-Object System.Drawing.Point(0, 62)
$footerLabel3.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

$footerPanel.Controls.Add($footerLabel1)
$footerPanel.Controls.Add($footerLabel2)
$footerPanel.Controls.Add($footerLabel3)
$form.Controls.Add($footerPanel)

# 🟢 مؤقت الفحص الدوري لحالة السيرفر (كل 1 ثانية)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if ($global:ServerProc -and -not $global:ServerProc.HasExited) {
        Update-Status "يعمل"
    } else {
        if ($global:ServerProc -and $global:ServerProc.ExitCode -ne 0 -and $global:ServerProc.ExitCode -ne 123456) {
            Update-Status "خطأ"
        } else {
            Update-Status "متوقف"
        }
    }
})

# 🟢 عند تحميل الواجهة، قم بتشغيل السيرفر تلقائياً وتفعيل المؤقت
$form.Add_Load({
    &$startAction
    $timer.Start()
})

# 🟢 عند إغلاق الواجهة، قم بإنهاء السيرفر تلقائياً لتفادي بقاء عمليات معلقة
$form.Add_FormClosing({
    if ($global:ServerProc -and -not $global:ServerProc.HasExited) {
        try { $global:ServerProc.Kill() } catch {}
    }
    $timer.Stop()
})

# 🟢 إظهار الشاشة الرسومية
[System.Windows.Forms.Application]::Run($form)
