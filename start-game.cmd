@echo off
setlocal
cd /d "%~dp0"

rem パケット陣取り / Packet Conquest を手元で起動する。
rem ダブルクリックすると、サーバーの窓が開き、ブラウザで http://localhost:3000 が開く。
rem 止めるときはサーバーの窓を閉じる(または窓で Ctrl + C)。
rem 別のポートで動かすときは、先に  set PORT=3001  としてから実行する。
rem このファイルは Shift-JIS で保存すること(日本語の表示のため)。

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org から LTS 版を入れてから、もう一度実行してください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 初回のため、必要なパッケージを入れています...
  call npm.cmd install
  if errorlevel 1 (
    echo パッケージの取得に失敗しました。インターネット接続を確認してください。
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000

start "パケット陣取り サーバー (この窓を閉じると止まります)" cmd /k "set PORT=%PORT% && echo サーバーを起動しています。この窓を閉じると止まります。 && node server\index.js"

rem サーバーが聞き始めるのを少し待ってからブラウザを開く
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"
exit /b 0
