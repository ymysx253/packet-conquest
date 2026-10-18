@echo off
setlocal
cd /d "%~dp0"
rem Build the zip for Azure App Service (see docs/DEPLOY.md).
rem Uses tar.exe (bundled with Windows 10+) so entries use forward slashes, which Linux App Service needs.
rem Only the listed folders are included; node_modules, .env, data, .git and .claude are left out (App Service runs npm install).
rem ASCII only: Shift-JIS text breaks cmd parsing.
set "OUT=packet-conquest-deploy.zip"
if "%OUT%"=="" exit /b 1
if exist "%OUT%" del /q "%OUT%"
tar.exe -a -c -f "%OUT%" --exclude=node_modules --exclude=.env --exclude=.git --exclude=.claude --exclude="%OUT%" CLAUDE.md README.md package.json package-lock.json server public tools test docs infra start-game.cmd make-zip.cmd
if errorlevel 1 (
  echo FAILED to create the zip.
  pause
  exit /b 1
)
for %%A in ("%OUT%") do echo created: %OUT% (%%~zA bytes)
echo Drag this zip onto "Zip Push Deploy" in Kudu (Azure portal, Advanced Tools). See docs/DEPLOY.md step 4.
pause
