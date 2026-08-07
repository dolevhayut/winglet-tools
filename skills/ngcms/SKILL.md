---
name: ngcms
description: Move hard-coded text out of a Next.js site and into a CMS the site owner can edit themselves, so changing a sentence never costs another agent run. Use when a Next.js App Router project has copy, prices, hours or contact details written directly in JSX, when the user says the client keeps asking them for text changes, or when they ask for a CMS, content management, or an editable site.
---

# Content for a site you built

## When to use this

Reach for this when a Next.js App Router project has content baked into
components — a hero headline, product prices, opening hours, a phone number —
and a non-technical person is going to want to change it later.

The point is not the CMS. The point is that after this, **the owner edits their
own text in a browser** and nobody has to run an agent to fix a typo.

Do **not** use this for a site with no human owner (an internal tool, a
throwaway demo), or for data that belongs in a real database (orders, users,
inventory). This holds editorial content, not application state.

## What you get

One command creates a live content project with no signup, no browser and no
credit card. It writes `.env.local`, generates types, seeds four content types,
and prints one link the owner clicks to start editing.

```bash
npx ngcms init
```

Exit codes: `0` ok · `1` error · `2` not a Next.js App Router project · `3`
rate-limited or network. There are **no interactive prompts** — every option is
a flag, so it is safe to run unattended.

## The four content types

Fixed in v1. Do not try to invent new ones; put anything extra under `custom`.

| Type | Fields |
|---|---|
| `page` | `title`, `slug`, `sections` (blocks), `seo`, `custom` |
| `post` | `title`, `slug`, `excerpt`, `body` (richtext), `cover`, `publishedAt`, `tags`, `seo`, `custom` |
| `product` | `title`, `slug`, `description` (richtext), `price` (number), `currency`, `images`, `inStock`, `seo`, `custom` |
| `collection` | `title`, `slug`, `items` (references), `description`, `custom` |

`custom` is a plain object and it is the right home for anything the schema does
not cover — `hours`, `phone`, `weight`, an image path. Reaching for it is normal,
not a workaround.

## Migrating an existing page

Work one page at a time and keep the site building between steps.

1. **Read the page and list every string a human might want to change.** A
   headline is content. A CSS class is not. An `aria-label` usually is not.
2. **Pick the type.** A marketing page is a `page`. A shop item is a `product`.
   An article is a `post`.
3. **Create the document** with the real current copy, so nothing changes
   visually on the first pass.
4. **Replace the literals with a typed read:**

```tsx
import { getPage } from '@ngcms/next'

export default async function Home() {
  const home = await getPage('home')
  return <h1>{home?.title ?? ''}</h1>
}
```

5. **Build.** The generated types are strict — if `sections` is optional, handle
   it. A compile error here is the types doing their job.
6. **Tell the owner the link.** `init` printed one. Nothing you built matters if
   they never open it.

## Reading content

Server components only. The key is server-side and must never reach the browser.

```ts
import { getPage, getPost, getPosts, getProduct, getProducts, getAll } from '@ngcms/next'

const home     = await getPage('home')          // one document, or null
const posts    = await getPosts({ limit: 10, tag: 'ai' })
const products = await getProducts()
const payload  = await getAll()                 // everything, for a static build
```

A missing document returns `null` — it does not throw. Auth and transport
failures do throw.

Documents come back flattened, with metadata under underscored keys:

```ts
home.title        // a content field
home._status      // 'draft' | 'published'
home._updatedAt
home.custom?.hours
```

## Publishing and freshness

Reads are cached and tagged, so a published change invalidates them. `init`
mounts a revalidate route in the app; the publish webhook calls it. If content
looks stale in development, Next's fetch cache is persistent — clear `.next`
before assuming the CMS is wrong.

Content is fetched at **build time**, not per request. The site keeps serving
whatever it last built even if the CMS is unreachable. Do not convert reads to
runtime fetches to "keep them fresh" — that trades the site's independence for
nothing.

## Editing content as an agent

An MCP server exposes `list_documents`, `get_document`, `create_document`,
`update_document` and `publish`. Prefer it over raw HTTP when it is available:
it is typed, and it keeps the write key out of your context.

`create_document` and `update_document` write a **draft**. Nothing reaches the
live site until `publish`.

## Things that will bite you

- **Do not commit `.env.local`.** `init` adds it to `.gitignore`; check that it did.
- **The write key is not a read key.** Never put a write key in client code or
  in a `NEXT_PUBLIC_` variable.
- **An unclaimed project cannot upload images** and expires after 14 days. Tell
  the owner to open the claim link — that is what makes the project theirs.
- **The free plan is one site.** A second site needs an upgrade; the link is not
  consumed by the refusal, so they can upgrade and claim afterwards.
- **Do not add a content type.** v1's four are fixed. Use `custom`.
