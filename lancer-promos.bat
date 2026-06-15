@echo off
cd /d "%~dp0"
echo === Verification des promos UberEats ===
echo.

cd scripts
if not exist node_modules (
    echo Installation des dependances...
    npm install
)
cd ..

echo Lancement du checker...
node scripts/index.js
if errorlevel 1 (
    echo ERREUR lors de l'execution du script
    pause
    exit /b 1
)

echo.
echo Push vers GitHub...
git add promos.json
git diff --staged --quiet
if errorlevel 1 (
    git commit -m "promos: update %date% %time%"
    git push origin main
    echo Promos mis a jour sur GitHub!
) else (
    echo Aucun changement detecte.
)

echo.
echo === Termine! ===
