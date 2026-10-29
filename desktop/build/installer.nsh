; The app used to be called Flex Drafter and was installed in Programs\flex-drafter. An
; update installs into the folder of the version it replaces, so the old name would stay
; forever: always install into Programs\Itachio instead. The old version is removed by its
; own uninstaller during the update, as usual.
!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Itachio"
!macroend
