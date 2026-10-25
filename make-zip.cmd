@echo off
setlocal
cd /d "%~dp0"
rem Build the zip for Azure App Service (see docs/DEPLOY.md).
rem Uses tar.exe (bundled with Windows 10+) so entries use forward slashes, which Linux App Service needs.
rem Only the listed folders are included; node_modules, .env, data, .git and .claude are left out (App Service runs npm install).
rem ASCII only: Shift-JIS text breaks cmd parsing.
rem runtime\node (the official Linux Node.js, from "node tools\fetch-node-runtime.js") is included; start-azure.sh runs it.
set "OUT=packet-conquest-deploy.zip"
if "%OUT%"=="" exit /b 1
if exist "%OUT%" del /q "%OUT%"
if not exist "runtime\node\bin\node" (
  echo runtime\node\bin\node is missing. Run: node tools\fetch-node-runtime.js
  pause
  exit /b 1
)
tar.exe -a -c -f "%OUT%" --exclude=node_modules --exclude=.env --exclude=.git --exclude=.claude --exclude="%OUT%" --exclude=runtime/download CLAUDE.md README.md package.json package-lock.json server public tools test docs infra start-game.cmd make-zip.cmd start-azure.sh runtime/node
if errorlevel 1 (
  echo FAILED to create the zip.
  pause
  exit /b 1
)
for %%A in ("%OUT%") do echo created: %OUT% (%%~zA bytes)
echo Drag this zip onto "Zip Push Deploy" in Kudu (Azure portal, Advanced Tools). See docs/DEPLOY.md step 4.
pause
