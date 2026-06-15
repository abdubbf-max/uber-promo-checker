@echo off
cd /d "%~dp0"
echo =====================================
echo   UberEats Promo Checker
echo =====================================
echo.

:: Verifier si Node.js est installe
node -v >nul 2>&1
if errorlevel 1 (
    echo ERREUR: Node.js n'est pas installe !
    echo Telecharge-le sur https://nodejs.org
    pause
    exit /b 1
)

:: Installer / verifier les dependances
echo Installation des dependances...
cd scripts
set PUPPETEER_SKIP_DOWNLOAD=1
npm install --silent
cd ..
echo.

:: Demarrer le serveur de sync en arriere-plan (si pas deja actif)
echo Demarrage du serveur sync (port 3001)...
powershell -Command "try { Invoke-WebRequest http://127.0.0.1:3001/ping -TimeoutSec 1 | Out-Null; Write-Host 'Serveur deja actif.' } catch { Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden }"
timeout /t 2 /nobreak >nul

:: Lancer le checker
echo.
echo Verification des promos en cours...
node scripts\index.js
if errorlevel 1 (
    echo.
    echo ERREUR lors de la verification des promos.
    pause
    exit /b 1
)

:: Push vers GitHub
echo.
echo Mise a jour de GitHub...
git add promos.json
git diff --staged --quiet
if errorlevel 1 (
    git commit -m "promos: update %date% %time%"
    git pull --rebase origin main
    git push origin main
    echo Promos mis a jour sur GitHub!
) else (
    echo Aucun changement detecte.
)

echo.
echo =====================================
echo   Termine!
echo =====================================
