#!/usr/bin/env node
/**
 * Patch electron-builder NSIS templates for install progress + file details.
 * - Show file list during install (SetDetailsPrint both)
 * - Use Nsis7z::ExtractWithCallback only for Setup (MODCRAFTING_SETUP_PROGRESS in installer.nsh)
 * - Portable uses vanilla Extract (no custom include / callback)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const tpl = join(process.cwd(), 'node_modules', 'app-builder-lib', 'templates', 'nsis')

if (!existsSync(tpl)) {
  console.warn('[nsis] app-builder-lib templates not found — run npm install first, skip patch')
  process.exit(0)
}

const installSectionPath = join(tpl, 'installSection.nsh')
if (!existsSync(installSectionPath)) {
  console.warn('[nsis] installSection.nsh not found — skip patch')
  process.exit(0)
}

let installSection = readFileSync(installSectionPath, 'utf8')
if (installSection.includes('SetDetailsPrint none')) {
  installSection = installSection.replace('SetDetailsPrint none', 'SetDetailsPrint both')
  writeFileSync(installSectionPath, installSection)
  console.log('[nsis] installSection.nsh: SetDetailsPrint -> both')
}

const extractPath = join(tpl, 'include', 'extractAppPackage.nsh')
if (!existsSync(extractPath)) {
  console.warn('[nsis] extractAppPackage.nsh not found — skip extract patch')
  process.exit(0)
}

const extractMacro = `!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\\7z-out"
  !ifdef MODCRAFTING_SETUP_PROGRESS
  GetFunctionAddress $R0 ModCrafting_7zExtractCallback
  Nsis7z::ExtractWithCallback "\${FILE}" $R0
  !else
  Nsis7z::Extract "\${FILE}"
  !endif
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
    !ifdef MODCRAFTING_SETUP_PROGRESS
    GetFunctionAddress $R0 ModCrafting_7zExtractCallback
    Nsis7z::ExtractWithCallback "\${FILE}" $R0
    !else
    Nsis7z::Extract "\${FILE}"
    !endif
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend`

let extractContent = readFileSync(extractPath, 'utf8')

// Remove wrongly placed callback (Function cannot live in Section-included files)
const callbackStart = extractContent.indexOf('!ifndef MODCRAFTING_7Z_CALLBACK')
if (callbackStart !== -1) {
  extractContent = extractContent.slice(0, callbackStart).trimEnd() + '\n'
  console.log('[nsis] extractAppPackage.nsh: removed misplaced callback Function')
}

const macroStart = extractContent.indexOf('!macro extractUsing7za FILE')
const macroEnd = extractContent.indexOf('!macroend', macroStart) + '!macroend'.length
if (macroStart === -1 || macroEnd === -1) {
  console.warn('[nsis] extractUsing7za macro not found — skip extract patch')
} else if (!extractContent.includes('MODCRAFTING_SETUP_PROGRESS')) {
  extractContent = extractContent.slice(0, macroStart) + extractMacro + '\n' + extractContent.slice(macroEnd)
  writeFileSync(extractPath, extractContent)
  console.log('[nsis] extractAppPackage.nsh: conditional ExtractWithCallback enabled')
} else {
  writeFileSync(extractPath, extractContent)
}

export default async function beforePack() {
  // electron-builder beforePack hook — top-level code runs on import too
}
