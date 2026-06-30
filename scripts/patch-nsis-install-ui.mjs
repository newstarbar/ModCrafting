#!/usr/bin/env node
/**
 * Patch electron-builder NSIS templates for install progress + file details.
 * - Show file list during install (SetDetailsPrint both)
 * - Use Nsis7z::ExtractWithCallback for determinate progress bar
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const tpl = join(process.cwd(), 'node_modules', 'app-builder-lib', 'templates', 'nsis')

const installSectionPath = join(tpl, 'installSection.nsh')
let installSection = readFileSync(installSectionPath, 'utf8')
if (installSection.includes('SetDetailsPrint none')) {
  installSection = installSection.replace('SetDetailsPrint none', 'SetDetailsPrint both')
  writeFileSync(installSectionPath, installSection)
  console.log('[nsis] installSection.nsh: SetDetailsPrint -> both')
}

const extractPath = join(tpl, 'include', 'extractAppPackage.nsh')
const extractMacro = `!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\\7z-out"
  GetFunctionAddress $R0 ModCrafting_7zExtractCallback
  Nsis7z::ExtractWithCallback "\${FILE}" $R0
  Pop $R0
  SetOutPath $R0

  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint \`Can't modify "\${PRODUCT_NAME}"'s files.\`
    \${if} $R1 < 5
      Goto RetryExtract7za
    \${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    \${endIf}

    RMDir /r "$PLUGINSDIR\\7z-out"
    GetFunctionAddress $R0 ModCrafting_7zExtractCallback
    Nsis7z::ExtractWithCallback "\${FILE}" $R0
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend`

let extractContent = readFileSync(extractPath, 'utf8')
const macroStart = extractContent.indexOf('!macro extractUsing7za FILE')
const macroEnd = extractContent.indexOf('!macroend', macroStart) + '!macroend'.length
if (macroStart === -1 || macroEnd === -1) {
  console.warn('[nsis] extractUsing7za macro not found — skip extract patch')
} else if (!extractContent.includes('ModCrafting_7zExtractCallback')) {
  const callbackFn = `
!ifndef MODCRAFTING_7Z_CALLBACK
!define MODCRAFTING_7Z_CALLBACK

Function ModCrafting_7zExtractCallback
  Pop $R8
  Pop $R9
  \${If} $R9 == 0
    Goto mc7z_done
  \${EndIf}
  IntOp $R7 $R8 * 100
  IntOp $R7 $R7 / $R9
  FindWindow $0 "#32770" "" $HWNDPARENT
  \${If} $0 <> 0
    GetDlgItem $0 $0 1004
    \${If} $0 <> 0
      SendMessage $0 0x0402 $R7 0
    \${EndIf}
  \${EndIf}
  SetDetailsPrint textonly
  DetailPrint "正在解压组件… $R7%"
  SetDetailsPrint listonly
  DetailPrint "已解压 $R8 / $R9 字节"
  mc7z_done:
FunctionEnd
!endif
`
  extractContent =
    extractContent.slice(0, macroStart) +
    extractMacro +
    extractContent.slice(macroEnd) +
    callbackFn
  writeFileSync(extractPath, extractContent)
  console.log('[nsis] extractAppPackage.nsh: ExtractWithCallback + progress callback')
}

export default async function beforePack() {
  // electron-builder beforePack hook entry
}
