@echo off
REM Verify and install dsh-agent-plugin-research into the default web profile.
REM Requires Node.js and pnpm (or `npx @deepseek-ai/dsh`).
cd /d "%~dp0"

echo [1/2] Running node --test ...
call node --test
if errorlevel 1 (
  echo Tests failed. Abort.
  exit /b 1
)

echo [2/2] Installing into dsh web profile ...
where dsh >nul 2>nul
if errorlevel 1 (
  call npx @deepseek-ai/dsh plugin --profile web add .
) else (
  call dsh plugin --profile web add .
)
if errorlevel 1 (
  echo Install failed. See pnpm output above.
  exit /b 1
)

echo Done. Restart dsh web to load the plugin.
