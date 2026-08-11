export interface AppAutomationLaunchOptions {
  hidden: boolean
  liveProvider: boolean
  profile: string
  discovery: string
  artifacts: string
}

/** Browser-window visibility is deliberately separate from `windowsHide`: the
 * latter only suppresses the Windows console window. */
export function appAutomationLaunchArgs(options: AppAutomationLaunchOptions): string[] {
  return [
    '.',
    '--automation',
    ...(options.hidden ? ['--automation-hidden'] : []),
    '--automation-profile', options.profile,
    '--automation-discovery', options.discovery,
    '--automation-artifacts', options.artifacts,
    ...(options.liveProvider ? ['--automation-live-provider'] : [])
  ]
}

/** npm 11 may surface a forwarded `--hidden` as npm_config_hidden instead of
 * leaving it in argv. Accept both forms so `npm run test:app -- --hidden`
 * remains a supported compatibility command. */
export function isHiddenAppAutomationMode(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  return argv.includes('--hidden') || env.npm_config_hidden === 'true' || env.npm_config_hidden === ''
}
