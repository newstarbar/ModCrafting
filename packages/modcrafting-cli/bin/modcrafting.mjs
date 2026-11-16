#!/usr/bin/env node
/** ModCrafting installer entry point. Zero dependencies, no build step. */
import { CliError, EXIT, HELP, cliVersion, exitFor, parseArgs } from '../lib/args.mjs'
import { renderError, renderHuman } from '../lib/report.mjs'
import * as commands from '../lib/commands.mjs'

const argv = process.argv.slice(2)
const wantsJson = argv.includes('--json')

function finish(result) {
  if (wantsJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${renderHuman(result)}\n`)
  process.exitCode = result.ok === false ? EXIT.CONFIG : EXIT.OK
}

function fail(error) {
  process.stderr.write(`${renderError(error, { json: wantsJson })}\n`)
  process.exitCode = exitFor(error)
}

async function main() {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${renderError(error, { json: wantsJson })}\n`)
    process.exitCode = error.exitCode ?? EXIT.USAGE
    return
  }

  if (options.flags.has('help') || options.positionals[0] === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (options.flags.has('cli-version') || options.positionals[0] === 'version') {
    process.stdout.write(`${cliVersion()}\n`)
    return
  }

  const command = options.positionals.shift() ?? 'help'
  try {
    switch (command) {
      case 'help': process.stdout.write(HELP); return
      case 'install': return finish(await commands.install(options))
      case 'mcp': return finish(await commands.mcp(options))
      case 'skills': return finish(await commands.skills(options))
      case 'doctor': return finish(await commands.doctor(options))
      case 'update': return finish(await commands.update(options))
      case 'uninstall': return finish(commands.uninstall(options))
      case 'versions': return finish(commands.versions())
      case 'verify': return finish(commands.verify(options))
      default:
        throw new CliError(`未知命令：${command}\n\n${HELP}`, { code: 'USAGE' })
    }
  } catch (error) {
    fail(error)
  }
}

await main()
