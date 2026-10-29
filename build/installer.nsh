; Registers the `cm` command (user PATH + App Paths for the Explorer address bar) and removes it
; again on uninstall. cm.exe does the registry work itself, see src/launcher/cm.cs.

!macro customInstall
  ExecWait '"$INSTDIR\bin\cm.exe" --cm-register'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new version registers again right after.
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\bin\cm.exe" --cm-unregister'
  ${endIf}
!macroend
