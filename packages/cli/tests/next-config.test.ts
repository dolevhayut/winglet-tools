import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { CLI_BIN } from '@product'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HTML_LIMITED_BOTS_SOURCE,
  ensureHtmlLimitedBots,
  htmlLimitedBotsLine,
  manualInstruction,
} from '../src/next-config'

/**
 * M21.1 — the scaffold that keeps `<title>`, description and canonical inside
 * the `<head>` for crawlers that do not run JavaScript.
 *
 * The first block is the one that matters: `htmlLimitedBots` REPLACES Next's
 * built-in list, so a value carrying only the AI crawlers would fix four bots
 * and break every social preview card. These tests assert the union in both
 * directions, because a regression there is invisible until somebody pastes a
 * link into Slack.
 */

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-nextconfig-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function run(root: string) {
  return ensureHtmlLimitedBots({ root, cliBin: CLI_BIN, display: (path) => basename(path) })
}

const BOTS = new RegExp(HTML_LIMITED_BOTS_SOURCE, 'i')

/* ── the regex itself ─────────────────────────────────────────────────────── */

describe('the scaffolded bot list', () => {
  /**
   * The four crawlers §9 measured landing metadata after the body. This is the
   * whole point of the milestone.
   */
  it.each(['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot'])(
    'matches the AI crawler %s',
    (agent) => {
      expect(BOTS.test(agent)).toBe(true)
    },
  )

  it.each([
    'ChatGPT-User',
    'Claude-Web',
    'Claude-User',
    'Perplexity-User',
    'Bytespider',
    'Meta-ExternalAgent',
    'Amazonbot',
    'Applebot-Extended',
    'cohere-ai',
    'Diffbot',
    'CCBot',
  ])('matches the AI crawler %s', (agent) => {
    expect(BOTS.test(agent)).toBe(true)
  })

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. `htmlLimitedBots` overrides rather than
   * extends, so every one of Next's own entries has to survive in our value or
   * the option silently un-fixes them.
   */
  it.each([
    'Bingbot',
    'BingPreview',
    'Twitterbot',
    'facebookexternalhit',
    'LinkedInBot',
    'Slackbot',
    'Discordbot',
    'WhatsApp',
    'SkypeUriPreview',
    'DuckDuckBot',
    'Slurp',
    'yandex',
    'baiduspider',
    'redditbot',
    'Chrome-Lighthouse',
    'AdsBot-Google',
    'Google-InspectionTool',
  ])('keeps Next’s own entry %s', (agent) => {
    expect(BOTS.test(agent)).toBe(true)
  })

  /**
   * Plain Googlebot is absent from Next's list on purpose — it executes
   * JavaScript, so streamed metadata reaches it. Matching it would cost a
   * blocking render for the largest crawler on the web and buy nothing.
   */
  it('leaves plain Googlebot streaming, as Next does', () => {
    expect(BOTS.test('Googlebot/2.1')).toBe(false)
  })

  it('is a valid regular expression source', () => {
    expect(() => new RegExp(HTML_LIMITED_BOTS_SOURCE, 'i')).not.toThrow()
  })

  it('does not match an ordinary browser', () => {
    expect(BOTS.test('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe(false)
  })
})

/* ── creating a config ────────────────────────────────────────────────────── */

describe('when the project has no Next config', () => {
  it('writes a TypeScript config when the project is TypeScript', () => {
    const root = scratch()
    writeFileSync(join(root, 'tsconfig.json'), '{}\n')

    const result = run(root)
    expect(result.outcome).toBe('created')
    expect(result.label).toBe('next.config.ts')

    const source = readFileSync(result.path, 'utf8')
    expect(source).toContain('import type { NextConfig } from \'next\'')
    expect(source).toContain(htmlLimitedBotsLine().trim())
  })

  it('writes a .mjs config when the project is not TypeScript', () => {
    const result = run(scratch())
    expect(result.outcome).toBe('created')
    expect(result.label).toBe('next.config.mjs')
    expect(readFileSync(result.path, 'utf8')).toContain('@type {import(\'next\').NextConfig}')
  })
})

/* ── merging into a config the customer owns ──────────────────────────────── */

describe('merging into an existing config', () => {
  function withConfig(name: string, source: string): string {
    const root = scratch()
    writeFileSync(join(root, name), source)
    return root
  }

  it('merges into a named const that the default export names', () => {
    const root = withConfig(
      'next.config.ts',
      [
        'import type { NextConfig } from \'next\'',
        '',
        'const nextConfig: NextConfig = {',
        '  reactStrictMode: true,',
        '}',
        '',
        'export default nextConfig',
        '',
      ].join('\n'),
    )

    const result = run(root)
    expect(result.outcome).toBe('updated')

    const source = readFileSync(result.path, 'utf8')
    expect(source).toContain(htmlLimitedBotsLine())
    // Nothing of theirs is lost or reordered.
    expect(source).toContain('reactStrictMode: true,')
    expect(source).toContain('export default nextConfig')
  })

  it('merges into an inline default export', () => {
    const root = withConfig('next.config.mjs', 'export default {\n  reactStrictMode: true,\n}\n')
    expect(run(root).outcome).toBe('updated')
    expect(readFileSync(join(root, 'next.config.mjs'), 'utf8')).toContain(htmlLimitedBotsLine())
  })

  /** The shape the demo site actually had, and the only one we reformat. */
  it('splits a one-line config rather than sharing a row with it', () => {
    const root = withConfig(
      'next.config.ts',
      [
        'import type { NextConfig } from \'next\'',
        'const config: NextConfig = { reactStrictMode: true }',
        'export default config',
        '',
      ].join('\n'),
    )

    const source = readFileSync(run(root).path, 'utf8')
    expect(source).toContain(
      ['const config: NextConfig = {', htmlLimitedBotsLine(), '  reactStrictMode: true }'].join('\n'),
    )
  })

  it('merges into module.exports', () => {
    const root = withConfig('next.config.js', 'module.exports = {\n  reactStrictMode: true,\n}\n')
    expect(run(root).outcome).toBe('updated')
    expect(readFileSync(join(root, 'next.config.js'), 'utf8')).toContain(htmlLimitedBotsLine())
  })

  /**
   * The shape every plugin's README produces. The export names a wrapper, so the
   * identifiers are tried in order and the one with an object literal wins —
   * which is the config, never the plugin.
   */
  it('merges into the config a plugin wrapper is applied to', () => {
    const root = withConfig(
      'next.config.mjs',
      [
        'import createMDX from \'@next/mdx\'',
        '',
        'const withMDX = createMDX({ extension: /\\.mdx?$/ })',
        '',
        'const nextConfig = {',
        '  pageExtensions: [\'ts\', \'tsx\', \'mdx\'],',
        '}',
        '',
        'export default withMDX(nextConfig)',
        '',
      ].join('\n'),
    )

    const result = run(root)
    expect(result.outcome).toBe('updated')

    const source = readFileSync(result.path, 'utf8')
    // Landed in the Next config, NOT in the MDX plugin's options object.
    const injected = source.indexOf('htmlLimitedBots')
    expect(injected).toBeGreaterThan(source.indexOf('const nextConfig = {'))
    expect(source).toContain('createMDX({ extension: /\\.mdx?$/ })')
  })

  it('picks the exported const, not merely the first object literal in the file', () => {
    const root = withConfig(
      'next.config.mjs',
      [
        'const securityHeaders = {',
        '  \'x-frame-options\': \'DENY\',',
        '}',
        '',
        'const nextConfig = {',
        '  reactStrictMode: true,',
        '}',
        '',
        'export default nextConfig',
        '',
      ].join('\n'),
    )

    const source = readFileSync(run(root).path, 'utf8')
    expect(source.indexOf('htmlLimitedBots')).toBeGreaterThan(source.indexOf('const nextConfig = {'))
    expect(source).toContain('\'x-frame-options\': \'DENY\',\n}')
  })
})

/* ── refusing to guess ────────────────────────────────────────────────────── */

describe('when the config shape is not safe to edit', () => {
  it('keeps a config that already sets the option, whatever its value', () => {
    const root = scratch()
    const path = join(root, 'next.config.ts')
    const mine = 'export default {\n  htmlLimitedBots: /MyOwnBot/,\n}\n'
    writeFileSync(path, mine)

    const result = run(root)
    expect(result.outcome).toBe('unchanged')
    expect(result.manual).toBeUndefined()
    // Their tuning survives. Ours is not layered on top of it.
    expect(readFileSync(path, 'utf8')).toBe(mine)
  })

  /**
   * An object literal passed straight to a wrapper is ambiguous: it is as likely
   * to be the plugin's options as the config. Injecting there fails SILENTLY —
   * Next never reads it — so this refuses and hands the line to the human.
   */
  it('refuses an object literal passed directly to a plugin, and prints the line', () => {
    const root = scratch()
    const path = join(root, 'next.config.mjs')
    const theirs = 'import withPWA from \'next-pwa\'\n\nexport default withPWA({\n  dest: \'public\',\n})\n'
    writeFileSync(path, theirs)

    const result = run(root)
    expect(result.outcome).toBe('kept')
    expect(readFileSync(path, 'utf8')).toBe(theirs)

    expect(result.manual).toBe(htmlLimitedBotsLine())
    const instruction = manualInstruction(result)
    expect(instruction).toContain('htmlLimitedBots')
    expect(instruction).toContain('next.config.mjs')
  })

  it('refuses a function-form config', () => {
    const root = scratch()
    const theirs = 'export default (phase) => ({\n  reactStrictMode: true,\n})\n'
    writeFileSync(join(root, 'next.config.mjs'), theirs)

    const result = run(root)
    expect(result.outcome).toBe('kept')
    expect(result.manual).toBe(htmlLimitedBotsLine())
    expect(readFileSync(join(root, 'next.config.mjs'), 'utf8')).toBe(theirs)
  })

  it('says nothing to do by hand when the merge succeeded', () => {
    const root = scratch()
    writeFileSync(join(root, 'next.config.mjs'), 'export default {}\n')
    expect(manualInstruction(run(root))).toBeUndefined()
  })
})

/* ── idempotence, which is what makes a second `init` meaningful ──────────── */

describe('running twice', () => {
  it('adds the option once', () => {
    const root = scratch()
    writeFileSync(join(root, 'next.config.mjs'), 'export default {\n  reactStrictMode: true,\n}\n')

    expect(run(root).outcome).toBe('updated')
    expect(run(root).outcome).toBe('unchanged')

    const source = readFileSync(join(root, 'next.config.mjs'), 'utf8')
    expect(source.match(/htmlLimitedBots/g)).toHaveLength(1)
  })

  it('leaves a config it created alone on the second run', () => {
    const root = scratch()
    writeFileSync(join(root, 'tsconfig.json'), '{}\n')

    const first = run(root)
    const written = readFileSync(first.path, 'utf8')

    expect(run(root).outcome).toBe('unchanged')
    expect(readFileSync(first.path, 'utf8')).toBe(written)
  })
})
