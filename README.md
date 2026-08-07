# NGCMS — client tools

The open parts of an agent-first CMS: the SDK a site reads content with, the CLI
that wires a site up, the MCP server an agent edits through, and the agent skill.

The hosted service itself is closed. Everything here runs on **your** machine or
in **your** site, holds no credentials of ours, and is readable precisely because
you are the one running it.

## Install the skill

```bash
npx skills add dolevhayut/ngcms-tools
```

## Connect a site

```bash
npx ngcms init
```

Creates a content project, writes `.env.local`, generates types and prints one
link the site owner opens to start editing. No signup, no browser, no prompts —
safe to run unattended.

## Read content

```ts
import { getPage, getPosts } from '@ngcms/next'

const home = await getPage('home')
```

Server components only. Content is fetched at build time, so the site keeps
serving even when our API does not.

## Edit as an agent

An MCP server exposes `list_documents`, `get_document`, `create_document`,
`update_document` and `publish`.

```bash
claude mcp add ngcms --transport http https://mcp.ngcms.dev/mcp
```

## Layout

| Path | What |
|---|---|
| `packages/sdk` | `@ngcms/next` — typed content client and typegen |
| `packages/cli` | `npx ngcms` — init, types, pull, claim, usage, link |
| `packages/mcp` | MCP server, stdio and Streamable HTTP |
| `skills/ngcms` | The agent skill |
| `product.config.ts` | The single source of the product's identity. **Canonical copy.** |

## Development

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

`product.config.ts` lives here and nowhere else: every name, prefix and domain is
derived from one constant, and a guard fails the build if the name is ever typed
by hand.
