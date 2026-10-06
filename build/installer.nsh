; Uninstall removes LOGIN_ITEM_NAME. Upgrade uninstall preserves it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChattyPop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ChattyPop"
  ${endIf}
!macroend