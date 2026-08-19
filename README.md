# Winglet — client tools

![Winglet — build once, let owners edit](docs/media/banner.jpg)

The open parts of an agent-first CMS: the SDK a site reads content with, the CLI
that wires a site up, the MCP server an agent edits through, and the agent skill
that teaches an agent to use all three.

The hosted service itself is closed. Everything here runs on **your** machine or
in **your** site, holds no credentials of ours, and is readable precisely because
you are the one running it.

## Install the skill

```bash
npx skills add dolevhayut/winglet-tools
```

Teaches an agent the content schema and which tool to reach for — CLI for setup
and batch work, MCP for in-conversation edits. Nothing to configure.

## Connect a site

<img src="docs/media/cli-connect.jpg" alt="Live before signup. Owner control after launch." width="640">

```bash
npx winglet init
```

Creates a content project, writes `.env.local`, generates types and prints one
link the site owner opens to start editing. No signup, no browser, no prompts —
safe to run unattended, and the only channel that works in CI, where there is no
conversation for an agent to have.

## Read content

<img src="docs/media/sdk-read.jpg" alt="Build once. Let owners edit." width="640">

```ts
import { getPage, getPosts } from '@winglet/next'

const home = await getPage('home')
```

Server components only. Content is fetched at build time, so the site keeps
serving even when our API does not.

## Edit as an agent

<img src="docs/media/mcp-agent.jpg" alt="Publish without calling the agent back." width="640">

An MCP server exposes `list_documents`, `get_document`, `create_document`,
`update_document` and `publish` — five tools an agent can call mid-conversation,
without knowing any command syntax and without the site's repository checked out
on that machine. It costs context on every turn the tools are resident, which is
the trade-off against the CLI: reach for MCP for a point edit, the CLI for setup
or batch work.

```bash
claude mcp add winglet --transport http https://mcp.winglet.cloud/mcp
```

## Layout

| Path | What |
|---|---|
| `packages/sdk` | `@winglet/next` — typed content client and typegen |
| `packages/cli` | `npx winglet` — init, types, pull, claim, usage, link |
| `packages/mcp` | MCP server, stdio and Streamable HTTP |
| `skills/winglet` | The agent skill |
| `product.config.ts` | The single source of the product's identity. **Canonical copy.** |

## Development

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

`product.config.ts` lives here and nowhere else: every name, prefix and domain is
derived from one constant, and a guard fails the build if the name is ever typed
by hand.

## Licence, and where these come from

MIT. Each package carries its own copy.

They are **not on npm yet**, so `init` wires a project to the
[v0.1.0 release](https://github.com/dolevhayut/winglet-tools/releases/tag/v0.1.0)
tarballs. A tarball is the one form every package manager accepts — npm and yarn
cannot resolve a git subpath, and pnpm refuses a git package's build script
without an `onlyBuiltDependencies` allowlist. The tarball needs neither, because
`dist` is already inside it.

To pin one by hand:

```jsonc
{
  "dependencies": {
    "@winglet/next": "https://github.com/dolevhayut/winglet-tools/releases/download/v0.1.0/winglet-next-0.1.0.tgz"
  }
}
```

The version lives in the URL rather than a semver range. That goes away on
publication.

## Two tracks

These tools are the free half and they always will be. The service they talk to
comes two ways: a studio you host yourself, or a managed cloud at $49/year per
site that gets every new feature first. Same repository, same CLI — the cloud
asks for a token.
