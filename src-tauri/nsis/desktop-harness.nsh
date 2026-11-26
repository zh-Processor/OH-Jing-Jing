!define OHJINGJING_DESKTOP_HARNESS_BUNDLE "$%OHJINGJING_DESKTOP_HARNESS_BUNDLE%"

!macro OHJINGJING_DESKTOP_HARNESS_EXTRACTOR
  InitPluginsDir
  File /oname=$PLUGINSDIR\desktop-harness-package.mjs "${OHJINGJING_DESKTOP_HARNESS_BUNDLE}\desktop-harness-package.mjs"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OHJINGJING_DESKTOP_HARNESS_EXTRACTOR
  File /oname=$PLUGINSDIR\desktop-sdk.zip "${OHJINGJING_DESKTOP_HARNESS_BUNDLE}\desktop-sdk.zip"
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$PLUGINSDIR\desktop-harness-package.mjs" install "$INSTDIR" "$PLUGINSDIR\desktop-sdk.zip"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not install the desktop runtime dependencies." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\dsh-sdk\.ohjingjing-managed"
    !insertmacro OHJINGJING_DESKTOP_HARNESS_EXTRACTOR
    nsExec::ExecToLog '"$INSTDIR\node.exe" "$PLUGINSDIR\desktop-harness-package.mjs" uninstall "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Could not remove the desktop runtime dependencies." /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend
