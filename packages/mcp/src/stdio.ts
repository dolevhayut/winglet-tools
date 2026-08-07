#!/usr/bin/env node
import { ENV } from '@product'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { buildServer, configFromEnv } from './server'

/**
 * The stdio transport: what a local agent (Claude Code, Claude Desktop, Cursor)
 * launches as a child process.
 *
 * The key comes from the environment, which is exactly where the CLI already
 * wrote it — so a project that ran init needs no second configuration step.
 *
 * Anything printed on stdout here would corrupt the protocol stream, so every
 * diagnostic goes to stderr. That is not a style choice; stdout IS the transport.
 */

const config = configFromEnv()

if (config === null) {
  process.stderr.write(
    `Missing ${ENV.writeKey}. Run the init command in your project first, ` +
      `or pass the variable when launching this server.\n`,
  )
  process.exit(2)
}

void serveStdio(() => buildServer(config))
process.stderr.write(`serving over stdio · api ${config.apiBaseUrl}\n`)
