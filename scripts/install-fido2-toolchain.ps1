# scripts/install-fido2-toolchain.ps1
#
# Попытка установить native FIDO2 toolchain для v2.2.2 (Windows).
# Скрипт идемпотентен — повторный запуск пропускает уже установленные шаги.
# В конце печатает таблицу: какие шаги прошли, какие упали, что делать дальше.
#
# Запуск:  pwsh -ExecutionPolicy Bypass -File scripts\install-fido2-toolchain.ps1
#
# WARNING: один из шагов (npm install кандидатов) почти наверняка упадёт —
# в npm registry нет maintained native FIDO2 пакета, совместимого с Node 20+
# на Windows. Скрипт это явно отметит, не маскируя ошибку.

$ErrorActionPreference = "Continue"
$results = @{}

function Step($name, $block) {
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    try {
        & $block
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            $results[$name] = "FAILED (exit $LASTEXITCODE)"
            Write-Host "[FAIL] $name (exit $LASTEXITCODE)" -ForegroundColor Red
        } else {
            $results[$name] = "OK"
            Write-Host "[OK]   $name" -ForegroundColor Green
        }
    } catch {
        $results[$name] = "FAILED ($($_.Exception.Message))"
        Write-Host "[FAIL] $name — $($_.Exception.Message)" -ForegroundColor Red
    }
    $LASTEXITCODE = 0
}

# ──────────────────────────────────────────────────────────────────────────
# Step 1: Visual Studio Build Tools (нужен MSVC для node-gyp + libfido2).
# ──────────────────────────────────────────────────────────────────────────
Step "1. Visual Studio Build Tools" {
    $vsInstaller = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsInstaller) {
        $hasVc = & $vsInstaller -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($hasVc) {
            Write-Host "Уже установлено: $hasVc"
            return
        }
    }
    Write-Host "Устанавливаю Microsoft.VisualStudio.2022.BuildTools (~5 ГБ)..."
    winget install --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

# ──────────────────────────────────────────────────────────────────────────
# Step 2: vcpkg (package manager для C/C++ библиотек на Windows).
# ──────────────────────────────────────────────────────────────────────────
Step "2. vcpkg" {
    $vcpkgRoot = "C:\vcpkg"
    if (Test-Path "$vcpkgRoot\vcpkg.exe") {
        Write-Host "Уже установлен: $vcpkgRoot"
        $env:VCPKG_ROOT = $vcpkgRoot
        return
    }
    git clone https://github.com/microsoft/vcpkg $vcpkgRoot
    if ($LASTEXITCODE -ne 0) { throw "git clone vcpkg failed" }
    & "$vcpkgRoot\bootstrap-vcpkg.bat" -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw "bootstrap-vcpkg failed" }
    [Environment]::SetEnvironmentVariable("VCPKG_ROOT", $vcpkgRoot, "User")
    $env:VCPKG_ROOT = $vcpkgRoot
}

# ──────────────────────────────────────────────────────────────────────────
# Step 3: libfido2 + транзитивные зависимости (libcbor, libusb, OpenSSL).
#         ~10 минут билда, ~500 МБ диска.
# ──────────────────────────────────────────────────────────────────────────
Step "3. libfido2 (vcpkg)" {
    if (-not $env:VCPKG_ROOT -or -not (Test-Path "$env:VCPKG_ROOT\vcpkg.exe")) {
        throw "vcpkg не установлен — Step 2 упал"
    }
    $installed = & "$env:VCPKG_ROOT\vcpkg.exe" list libfido2 2>$null
    if ($installed -match "libfido2") {
        Write-Host "Уже установлен: $installed"
        return
    }
    & "$env:VCPKG_ROOT\vcpkg.exe" install libfido2:x64-windows-static
    if ($LASTEXITCODE -ne 0) { throw "vcpkg install libfido2 failed" }
}

# ──────────────────────────────────────────────────────────────────────────
# Step 4: node-gyp (требуется для билда любого N-API binding).
# ──────────────────────────────────────────────────────────────────────────
Step "4. node-gyp config" {
    $hasGyp = Get-Command node-gyp -ErrorAction SilentlyContinue
    if (-not $hasGyp) {
        npm install -g node-gyp
        if ($LASTEXITCODE -ne 0) { throw "npm install -g node-gyp failed" }
    }
    npm config set msvs_version 2022
    if ($LASTEXITCODE -ne 0) { throw "npm config set msvs_version failed" }
}

# ──────────────────────────────────────────────────────────────────────────
# Step 5: Попытка install кандидатов FIDO2 binding'а из npm.
#         Это почти наверняка упадёт — нет maintained пакета.
#         Скрипт пробует несколько и сообщает результат каждого.
# ──────────────────────────────────────────────────────────────────────────
$candidates = @(
    "fido2-lib",       # pure JS — соберётся, но не говорит с hardware (только assertion validation)
    "fido2-net-lib",   # старая C# обёртка
    "node-webauthn"    # unmaintained native binding
)

foreach ($pkg in $candidates) {
    Step "5.$pkg" {
        $alreadyInstalled = (Get-Content package.json -Raw) -match "`"$([regex]::Escape($pkg))`""
        if ($alreadyInstalled) {
            Write-Host "Уже в package.json — пропускаю"
            return
        }
        npm install --save-optional --no-audit --no-fund $pkg
        if ($LASTEXITCODE -ne 0) { throw "npm install $pkg failed (это ожидаемый исход для unmaintained пакетов)" }
    }
}

# ──────────────────────────────────────────────────────────────────────────
# Итог
# ──────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== ИТОГ ===" -ForegroundColor Yellow
$results.GetEnumerator() | Sort-Object Key | ForEach-Object {
    $color = if ($_.Value -eq "OK") { "Green" } else { "Red" }
    Write-Host ("{0,-30} {1}" -f $_.Key, $_.Value) -ForegroundColor $color
}

Write-Host ""
Write-Host "Что делать дальше:" -ForegroundColor Yellow
$installedAny = $false
foreach ($pkg in $candidates) {
    if ($results["5.$pkg"] -eq "OK") {
        $installedAny = $true
        Write-Host "  - $pkg установлен. Добавь в src/core/nativeFido2Probe.ts:" -ForegroundColor Green
        Write-Host "      const candidates = [{ id: '$pkg', load: () => import('$pkg') }];" -ForegroundColor Gray
        Write-Host "    Затем:  npm test -- nativeFido2Probe" -ForegroundColor Gray
    }
}
if (-not $installedAny) {
    Write-Host "  - Ни один FIDO2 binding не установился." -ForegroundColor Red
    Write-Host "    Это ожидаемый результат — в npm нет maintained native FIDO2 пакета" -ForegroundColor Red
    Write-Host "    для Node 20+ на Windows. Webview путь в v2.2.1 даёт тот же outcome" -ForegroundColor Red
    Write-Host "    через Windows Hello / WebAuthn API напрямую." -ForegroundColor Red
    Write-Host ""
    Write-Host "    Если действительно нужен native binding — придётся писать свой" -ForegroundColor Yellow
    Write-Host "    N-API addon к libfido2 (1-2 недели работы); libfido2 теперь" -ForegroundColor Yellow
    Write-Host "    установлен в $env:VCPKG_ROOT\installed\x64-windows-static\." -ForegroundColor Yellow
}
