@echo off
REM Manual install without pnpm/Git Bash.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found on PATH. Install Node.js 22+ first.
  exit /b 1
)
node install-manually.mjs %*
