; Custom NSIS hooks for the per-user Badger installer (included via nsis.include).
;
; The runtime is a detached child process that deliberately outlives the app
; window, and its binary sits inside the install directory
; (<install>\resources\runtime\runtime.exe). electron-builder's stock
; "is the app running" check only knows the main executable, so without this
; the runtime keeps its image locked and an update/reinstall/uninstall fails to
; replace or remove files. Stop it first, for install, update and uninstall
; alike (the same macro backs all three).
;
; Defining customCheckAppRunning makes electron-builder skip its own
; `!include "getProcessInfo.nsh"` + `Var pid` (both only happen while the macro
; is undefined), and the stock _CHECK_APP_RUNNING needs them, so declare them.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR\resources\runtime\', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 500
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
