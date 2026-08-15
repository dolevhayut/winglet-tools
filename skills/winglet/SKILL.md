---
name: winglet
description: Move hard-coded text out of a Next.js site and into a CMS the site owner can edit themselves, so changing a sentence never costs another agent run. Use when a Next.js App Router project has copy, prices, hours or contact details written directly in JSX, when the user says the client keeps asking them for text changes, when they ask for a CMS, content management, or an editable site, or when they want an existing site's content moved into one.
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
credit card. It writes `.env.local`, generates types, seeds a starting content
model, and prints one link the owner clicks to take ownership.

```bash
npx winglet init
```

Exit codes: `0` ok · `1` error · `2` not a Next.js App Router project · `3`
rate-limited or network. There are **no interactive prompts** — every option is
a flag, so it is safe to run unattended.

## The claim link is the point of the whole first run

`init` prints a link. **Give it to the human, and say what it does.** It is not
an afterthought and not a warning — it is the entire onboarding:

> The project you just created has no owner. Whoever opens that link becomes the
> owner: they get an account, the project transfers to it, and from then on they
> edit their own content in the browser without you.

Facts that matter when you explain it:

- Ownership genuinely transfers, and the token is **destroyed** on use — the
  link cannot be reused to get back into their site afterwards.
- **The link is valid for 14 days, and there is no way to issue another.** It is
  written once at creation and nulled on use; no endpoint reissues it. After 14
  days the project can never be claimed, and nothing deletes it — it simply
  stays unclaimable. Hand the link over in the session that created it.
- Until it is claimed, the project **cannot upload images** and is capped at 25
  documents. An unclaimed project is a trial, not a site.
- The free plan is one site. A second one is refused with an upgrade link, and
  the refusal **does not consume the claim link** — they can upgrade and claim
  afterwards.
- You cannot reprint the link from the server: it is stored there only as a
  hash, deliberately. It lives in the terminal that ran `init` and in the local
  config. `winglet claim` reprints it from there.

If you finish a session without handing over that link, nothing you built is
usable by the person who asked for it.

## The content model is defined per project — including by you

`init` seeds four types (`page`, `post`, `product`, `collection`) and two shared
shapes (`faq`, `galleryImage`). **These are a starting point, not a limit.**
Types, fields and shapes are project data, created at runtime, with no migration
and no deploy.

### Start from a template, not from an empty project

```bash
npx winglet templates list                 # what each one defines
npx winglet templates apply hospitality    # adds its types and objects
```

| Template | For |
|---|---|
| `hospitality` | guest houses: accommodations, price list, stay rules, promotions, testimonials, area guides |
| `clinic` | practitioners, treatments, opening hours |
| `restaurant` | menus, dishes, opening hours |
| `portfolio` | projects, services, testimonials |

Do this **before** inventing types by hand. A template is a model somebody
thought about and validated against a real site; an empty project gets whatever
you guessed at 2am. Templates only add what is missing, so applying one over a
seeded project is safe.

`init --template <name>` does it in the same run.

### Defining types yourself

```bash
npx winglet types list                     # what this project defines, as JSON
npx winglet types add                      # define a content type
npx winglet types set                      # extend one
npx winglet objects list                   # reusable field shapes
npx winglet objects add                    # register one
```

Read `types list` before writing anything. It is the project's real model and it
is the only authority — do not assume the seeded four.

**Changes are additive only, and that is a hard rule, not a convention.** A
field can be added; nothing can be removed or retyped. Retire a field by marking
it `deprecated`. `types rm` is refused while documents of that type exist, and
`objects rm` is refused while any type still points at the shape. This is what
makes it safe for you to extend a model the owner is already using.

`object` fields point at a shared shape, which is how a price row, an FAQ entry
or a gallery image is defined once and reused. Objects may contain objects.

After any model change, regenerate the types file:

```bash
npx winglet types
```

`custom` is still there and still fine for genuinely one-off values. But if the
owner will edit it, or there is more than one of it, it wants a real field — a
`custom` blob shows up in the studio as far less than a typed field does.

## Moving an existing site's content in

Two paths, and they are not the same job.

**From another CMS** — one command, content and images together:

```bash
npx winglet import ./export --from sanity --dry-run
npx winglet import ./export --from sanity --titles @titles.json
```

The model is inferred from the documents, because a schema lives in the other
CMS's own repo and the people leaving it do not have that repo. The one thing
data cannot carry is a **type's human-readable name** — `--titles` supplies it,
and the report lists every type still wearing its key.

**From a live website** — that one is yours to read, not ours to scrape. The
order matters:

1. `winglet templates apply <closest match>` — get a real model first.
2. Read the site and map its content onto that model. Extend with `types set`
   where the site genuinely needs a field the template lacks.
3. `winglet create` each document, then `winglet publish`.
4. Hand over the claim link.

Do **not** derive a content model from HTML structure. Pages describe layout;
types describe meaning, and the two are not the same shape. A model invented
from markup is the one thing here that cannot be undone cheaply, because
removing a type is refused once documents exist.

## Reading content

Server components only. The key is server-side and must never reach the browser.

The four seeded types have named accessors:

```ts
import { getPage, getPost, getPosts, getProduct, getProducts, getAll } from '@winglet/next'

const home     = await getPage('home')          // one document, or null
const posts    = await getPosts({ limit: 10, tag: 'ai' })
const payload  = await getAll()                 // everything, for a static build
```

**Every other type goes through a client**, and it is typed from the generated
types file without a type argument:

```ts
import { createClient } from '@winglet/next'

const client = createClient()

const room  = await client.get('accommodation', 'cabin-3')
const rooms = await client.list('accommodation', { limit: 20 })
```

Do not reach for `custom` because you could not find a named accessor. If
`types list` shows the type, `client.get` reads it.

A missing document returns `null` — it does not throw. Auth and transport
failures do throw. Documents come back flattened, with metadata under
underscored keys:

```ts
home.title        // a content field
home._status      // 'draft' | 'published'
home._updatedAt
```

## Publishing and freshness

Reads are cached with `force-cache` and tagged, so a published change
invalidates exactly them. `init` mounts a revalidate route in the app; the
publish webhook calls it.

**Be precise about what that does and does not buy**, because it is easy to
overstate. The cache means the site does not call us on every visit. It does
**not** mean the site is independent of us: a cache entry is per-deployment and
evictable, the publish webhook empties it on purpose, and on a miss with the API
unreachable the SDK throws `TransportError` rather than degrading — only
`PROJECT_NOT_FOUND` is swallowed to `null`. A page that misses the cache while
we are down is an error page.

So: prefer static rendering, and do not reach for `export const dynamic =
'force-dynamic'` to "keep content fresh". Publishing already refreshes it, and
force-dynamic gives up the cache that keeps visitors off our servers.

A site that must not depend on us at all is a different build: `winglet pull`
brings the content down to local JSON and you build from that. It brings the
documents, not the images.

If content looks stale in development, Next's fetch cache is persistent: clear
`.next` before assuming the CMS is wrong.

## Editing content as an agent

An MCP server exposes `list_documents`, `list_content_types`, `get_document`,
`create_document`, `update_document` and `publish`. Prefer it over raw HTTP when
it is available: it is typed, and it keeps the write key out of your context.

Call `list_content_types` first. It is how you learn what this project actually
defines rather than assuming.

`create_document` and `update_document` write a **draft**. Nothing reaches the
live site until `publish`.

`update_document` is a patch keyed by dot path — `{"custom.hours": "…",
"seo.title": "…"}`. Pass only what you are changing; everything you do not name
is left exactly as it was. Never send a whole document to change one field.

A type may be a **singleton**. `create_document` is refused for one that already
holds a document — find it with `list_documents` and update it instead.

## Checking your work

```bash
npx winglet lint
```

Reports broken internal links and images published with no description. It is
tuned to stay silent when unsure, so a finding is worth acting on. Run it after
a bulk import — that is what it was built for.

## Things that will bite you

- **Do not commit `.env.local`.** `init` adds it to `.gitignore`; check that it did.
- **The write key is not a read key.** Never put a write key in client code or
  in a `NEXT_PUBLIC_` variable.
- **Hand over the claim link.** See above. It is the most common way a session
  ends with nothing usable.
- **Read `types list` before assuming a model.** The seeded four are a start,
  and most real projects have moved past them.
- **Model changes are additive.** Plan a field before adding it; you cannot take
  it back once documents exist.
