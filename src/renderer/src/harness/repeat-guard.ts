const BUILD_RUN_COMMAND_RE = /gradlew|gradle|build|runClient|runDatagen|runServer|\btest\b/i

/** Tools subject to same-args repeat-success loop guard (exploration/write loops, not build/run). */
export function isRepeatGuardedToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name === 'trigger_build') return false
  if (name === 'run_command') {
    const command = String(args.command || '')
    if (BUILD_RUN_COMMAND_RE.test(command)) return false
    return true
  }
  return [
    'list_directory', 'read_file', 'write_file', 'read_error_log',
    'fabric_docs_search', 'fabric_javadoc_lookup', 'vanilla_mc_wiki_query',
    'fabric_meta_version_check', 'fabric_mod_json_validate'
  ].includes(name)
}
