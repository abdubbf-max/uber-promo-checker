# ═══════════════════════════════════════════════════════════════
#  Installe le GitHub Actions Self-Hosted Runner sur ce PC
#  Lance ce script une seule fois — le runner tourne ensuite
#  automatiquement comme service Windows (démarre avec le PC).
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== Installation du GitHub Actions Runner ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Ce runner permet a GitHub de lancer les verifications"
Write-Host "de promos directement depuis TON PC (ta vraie IP)."
Write-Host ""

# ── TOKEN ───────────────────────────────────────────────────────
Write-Host "Étape 1 : Récupère ton token sur GitHub" -ForegroundColor Yellow
Write-Host "  → Va sur : https://github.com/abdubbf-max/uber-promo-checker/settings/actions/runners/new"
Write-Host "  → Sélectionne : Windows / x64"
Write-Host "  → Copie le token qui commence par 'AABB...'"
Write-Host ""
$token = Read-Host "Colle le token ici"
if ($token -notmatch '^[A-Z0-9]+$') {
    Write-Host "❌ Token invalide. Recommence." -ForegroundColor Red
    exit 1
}

# ── DOSSIER ─────────────────────────────────────────────────────
$runnerDir = "C:\actions-runner"
if (-not (Test-Path $runnerDir)) {
    New-Item -ItemType Directory -Path $runnerDir | Out-Null
}

Write-Host ""
Write-Host "Étape 2 : Téléchargement du runner..." -ForegroundColor Yellow

$version = "2.317.0"
$archive = "$runnerDir\runner.zip"
$url = "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-x64-$version.zip"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    Write-Host "Téléchargement OK" -ForegroundColor Green
} catch {
    Write-Host "❌ Téléchargement échoué: $_" -ForegroundColor Red
    exit 1
}

Write-Host "Extraction..." -ForegroundColor Yellow
Expand-Archive -Path $archive -DestinationPath $runnerDir -Force
Remove-Item $archive

# ── CONFIGURATION ───────────────────────────────────────────────
Write-Host ""
Write-Host "Étape 3 : Configuration du runner..." -ForegroundColor Yellow
Set-Location $runnerDir

& "$runnerDir\config.cmd" `
    --url "https://github.com/abdubbf-max/uber-promo-checker" `
    --token $token `
    --name "mon-pc-windows" `
    --labels "self-hosted,windows" `
    --work "_work" `
    --unattended `
    --replace

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Configuration échouée." -ForegroundColor Red
    exit 1
}

# ── SERVICE WINDOWS ─────────────────────────────────────────────
Write-Host ""
Write-Host "Étape 4 : Installation en tant que service Windows..." -ForegroundColor Yellow
Write-Host "(démarre automatiquement avec le PC, même sans connexion)"

& "$runnerDir\svc.cmd" install
& "$runnerDir\svc.cmd" start

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✅ Runner installé et démarré !" -ForegroundColor Green
Write-Host ""
Write-Host "  GitHub va maintenant exécuter les vérifications"
Write-Host "  de promos sur TON PC toutes les 4 heures."
Write-Host ""
Write-Host "  Pour vérifier : https://github.com/abdubbf-max/uber-promo-checker/actions"
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
