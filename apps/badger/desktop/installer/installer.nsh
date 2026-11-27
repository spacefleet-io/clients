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
; While the app window runs, its runtime guardian restarts a runtime that dies
; (about 10 ms later, from the same install dir). So the runtime alone is
; stopped only when the window is gone; with the window up, the window goes
; first and its runtime after it, or the runtime comes straight back and keeps
; the install dir busy (windows-installed 0.1.90: the silent uninstall left the
; install dir behind after its runtime was killed and restarted).
;
; Defining customCheckAppRunning makes electron-builder skip its own
; `!include "getProcessInfo.nsh"` + `Var pid` (both only happen while the macro
; is undefined), and the stock _CHECK_APP_RUNNING needs them, so declare them.
!include "getProcessInfo.nsh"
Var pid
Var badgerCloseFirst

; Stops everything that runs from $INSTDIR, the app window first so its runtime
; guardian cannot restart the runtime, and waits until nothing runs there
; (500 ms steps, at most 60 s).
!macro badgerStopAllUnderInstDir
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$m = '$INSTDIR\${APP_EXECUTABLE_FILENAME}'; foreach ($$i in 1..120) { $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$p.Count -eq 0) { exit 0 }; $$p | Sort-Object { $$_.ExecutablePath -ne $$m } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }; exit 1"`
  Pop $0
!macroend

!macro customCheckAppRunning
  ; Interactive or an update: the app keeps its prompt or its graceful quit;
  ; only a runtime that outlived its window is stopped here. An explicit silent
  ; run (`/S`): the stock check closes the app without asking anyway; close it
  ; here in the right order and wait for it.
  StrCpy $badgerCloseFirst "0"
  ${if} ${Silent}
    ${ifNot} ${isUpdated}
      StrCpy $badgerCloseFirst "1"
    ${endIf}
  ${endIf}
  ${if} $badgerCloseFirst == "1"
    !insertmacro badgerStopAllUnderInstDir
  ${else}
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$m = '$INSTDIR\${APP_EXECUTABLE_FILENAME}'; $$a = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath }); if (-not ($$a | Where-Object { $$_.ExecutablePath -eq $$m })) { $$a | Where-Object { $$_.ExecutablePath.StartsWith('$INSTDIR\resources\runtime\', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
    Pop $0
    Sleep 500
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  ; The stock check closes the window and the runtime together; a runtime the
  ; guardian restarted in between still holds files. Stop it and wait.
  !insertmacro badgerStopAllUnderInstDir
!macroend
