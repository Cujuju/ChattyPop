; Removes the sign-in entry (main/desktop.ts LOGIN_ITEM_NAME) when ChattyPop is uninstalled, but not when an update
; runs the old version's uninstaller.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChattyPop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ChattyPop"
  ${endIf}
!macroend