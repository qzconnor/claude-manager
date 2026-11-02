; Registers the `cm` command (user PATH + App Paths for the Explorer address bar) and removes it
; again on uninstall. cm.exe does the registry work itself, see src/launcher/cm.cs.
; The uninstaller also removes the start with Windows (src/main/lib/login-item.ts), which the app
; registers under its AppUserModelId.

!macro customInstall
  ExecWait '"$INSTDIR\bin\cm.exe" --cm-register'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new version registers again right after.
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\bin\cm.exe" --cm-unregister'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "local.claude-manager"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "local.claude-manager"
  ${endIf}
!macroend
