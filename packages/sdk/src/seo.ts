import type { Metadata } from 'next'

import { ENV } from '@product'

import { createClient } from './client'
import type { EnvSource } from './config'
import { imageProps } from './image'
import type { BuildPayload, ImageRef, SeoFields } from './types'

/**
 * M21.2 — a site's `<head>` comes from the document the owner edits.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `SeoFields` has been stored, editable in the studio and patchable over MCP
 * since the schema was written, and had ZERO consumers: nothing turned it into
 * HTML. Every site typed its own title into its own code, which is the exact
 * phone call this product exists to prevent — the owner changes the page title
 * in the studio and nothing happens until a developer edits a file.
 *
 *   import { metadataFor } from '<the SDK package>/seo'
 *   export const generateMetadata = metadataFor(() => getPage('home'))
 *
 * SERVER ONLY, like everything that reads a key: `generateMetadata` runs on the
 * server, which is where content is read anyway.
 */

/* ── the OG image, and the decision behind it ─────────────────────────────── */

/**
 * The card size every social network and every AI crawler preview expects.
 * 1.91:1, cropped rather than letterboxed — an OG image is a fixed frame, so a
 * `max` fit would leave the network to pad it and pick its own background.
 */
const OG_WIDTH = 1200
const OG_HEIGHT = 630

/**
 * WHY THE OG IMAGE URL IS SAFE TO CACHE FOREVER — AND WHERE THE EXPIRY IS NOT
 * ---------------------------------------------------------------------------
 * A social network fetches an OG image once and caches the card, sometimes for
 * years. If that URL expires, every share saved today becomes a broken preview
 * later, and it cannot be repaired after the fact: the post is already out
 * there. So this was checked rather than assumed, and the answer is worth
 * writing down because the obvious reading of the code is wrong.
 *
 * There are two asset URLs in this product, and only one of them expires:
 *
 *   · `GET /v1/assets/:id/file` answers `302` to a presigned store URL with a
 *     15-minute lifetime (M19). It also serves the ORIGINAL bytes — a phone
 *     photograph of several megabytes, at whatever shape it was shot.
 *   · `GET /v1/img/:id?w&h&fit&q&s` — what `imageUrl` builds, and what this
 *     uses. `s` is an HMAC over the asset id and the transform parameters and
 *     over NOTHING else: no timestamp, no expiry, no nonce. The server answers
 *     the bytes directly under `cache-control: public, max-age=31536000,
 *     immutable`.
 *
 * So the derivative URL is permanent by construction, and an OG image needed no
 * new public route, no world-readable bucket and no long-lived token. The
 * rejected alternatives were exactly those three, and each would have made
 * every derivative in the project reachable without a signature in order to fix
 * one tag.
 *
 * THE ONE COST, recorded here because this is the only place it surfaces:
 * rotating the project's read key invalidates every OG URL ever shared, since
 * the signing key is that key's digest. Rotation already invalidates every
 * `<img>` on the site, which is what rotation is for — but an `<img>` is
 * re-rendered on the next build and a card sitting in someone's timeline is
 * not. Rotate the read key and the old cards stay broken.
 */
function openGraphImage(
  image: ImageRef | string | null | undefined,
  env: EnvSource | undefined,
): { readonly url: string; readonly width: number; readonly height: number; readonly alt: string } | null {
  // Routed through `imageProps` rather than `imageUrl` so that the OG image and
  // the same picture on the page can never disagree: one place decides which
  // asset a ref points at and where its alt text comes from. The `srcSet` it
  // also computes is discarded, which costs six HMACs and buys that guarantee.
  /*
   * Wrapped, because `imageProps` signs the URL and signing needs the project's
   * read key — so a project whose environment is incomplete throws here rather
   * than returning null. Every caller of this is metadata or JSON-LD, and this
   * module's own rule is that neither may take down a page whose body renders
   * perfectly well. A missing image is a missing card; a thrown one is a 500.
   */
  let props: ReturnType<typeof imageProps>
  try {
    props = imageProps(image, {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fit: 'crop',
      // Explicit, not the server's default. A social scraper is the least
      // capable HTTP client that will ever touch this product, and several still
      // fail on WebP — the format that makes the on-page image worth serving is
      // the wrong bet on a card that has to render everywhere or not at all.
      format: 'jpeg',
      ...(env === undefined ? {} : { env }),
    })
  } catch {
    return null
  }
  if (props === null) return null

  return { url: props.src, width: OG_WIDTH, height: OG_HEIGHT, alt: props.alt }
}

/* ── the origin, and the canonical URL built against it ───────────────────── */

/**
 * The site's public origin.
 *
 * Falls back to Vercel's own production domain, which is the deployment's
 * stable public host and is present in the build environment without anyone
 * configuring it. A PREVIEW deployment's URL is deliberately not used: its
 * canonical would name a throwaway host, and telling a crawler that the real
 * page lives at a URL that stops resolving is worse than saying nothing.
 *
 * Returns `undefined` when nothing is configured, and the caller then omits the
 * canonical entirely. A canonical pointing at the wrong origin actively
 * de-indexes the right one; no canonical merely leaves the crawler to work it
 * out, which it is good at.
 */
function readOrigin(env: EnvSource, explicit: string | undefined): string | undefined {
  const configured = explicit ?? env[ENV.siteOrigin] ?? productionUrl(env)
  if (configured === undefined) return undefined

  const trimmed = configured.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return undefined

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    // A malformed origin would throw inside `new URL()` in `metadataBase` and
    // take down the render of a page whose content is perfectly fine.
    return undefined
  }
}

function productionUrl(env: EnvSource): string | undefined {
  const host = env['VERCEL_PROJECT_PRODUCTION_URL']
  return host === undefined || host.length === 0 ? undefined : host
}

/**
 * The path a document is served at.
 *
 * `/{slug}`, except that the slug `home` is the site root. That is not a guess:
 * it is the convention this package seeds, prints in `init`'s own output
 * (`getPage('home')`) and ships in every template. Any site that routes
 * differently passes `path`, which is why the option exists.
 */
const HOME_SLUG = 'home'

function defaultPath(slug: string | undefined): string | undefined {
  if (slug === undefined || slug.length === 0) return undefined
  if (slug === HOME_SLUG) return '/'
  return `/${slug.replace(/^\/+/, '')}`
}

/* ── reading fields off a document of any shape ───────────────────────────── */

/**
 * Any document, of any shape.
 *
 * `object` and NOT `Readonly<Record<string, unknown>>`, which is what this was
 * first written as and what it still behaves like. A TypeScript interface has
 * no implicit index signature, so every site that declares its own document
 * shape — which every site does, and which the demo does on all five of its
 * types — failed to compile against the record form. The parameter type must
 * accept the shapes customers actually write, and the reading below is by key
 * and defensive regardless.
 *
 * M11 made the content model fully dynamic, so a document's type may be one
 * this package has never heard of. Nothing here relies on a compile-time shape.
 */
export type SeoDocument = object

/** A keyed view of a document. Every read below narrows before trusting it. */
function fields(document: SeoDocument): Readonly<Record<string, unknown>> {
  return document as Readonly<Record<string, unknown>>
}

function readString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function readSeo(data: Readonly<Record<string, unknown>>): SeoFields {
  const value = data['seo']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as SeoFields
}

/** An `image` field, which is an object the API wrote, or nothing. */
function readImage(
  data: Readonly<Record<string, unknown>>,
  key: string,
): ImageRef | undefined {
  const value = data[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as ImageRef
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/**
 * Where the title falls back to when the owner left `seo.title` empty.
 *
 * NOT read from the type's `titleField` in the project's model, though the
 * model does carry one. Learning it means fetching the model, and this code
 * runs inside `generateMetadata` on every page — an extra API round trip per
 * render, across an ocean, to discover a value that is `title` for all four
 * seeded types and for all seventeen types in every template this product
 * ships. `titleField` is the option for the site that needs it.
 */
const TITLE_FIELDS = ['title', 'name'] as const

function fallbackTitle(
  data: Readonly<Record<string, unknown>>,
  field: string | undefined,
): string | undefined {
  if (field !== undefined) return readString(data, field)
  for (const key of TITLE_FIELDS) {
    const value = readString(data, key)
    if (value !== undefined) return value
  }
  return undefined
}

/* ── options ──────────────────────────────────────────────────────────────── */

export interface MetadataOptions {
  /**
   * The site's origin, overriding the environment. Useful for a build script
   * that renders several projects.
   */
  readonly origin?: string | undefined
  /**
   * The page's path, when it is not `/{slug}`.
   *
   * `false` means this document does not own a URL, and suppresses both the
   * canonical and `og:url`. That is what a ROOT LAYOUT wants: it reads a
   * settings singleton for the site-wide title, and that singleton's slug
   * (`settings`) is not a page — deriving a canonical from it would stamp every
   * page on the site with the same wrong URL, which is the one metadata mistake
   * that actively removes pages from an index.
   */
  readonly path?: string | false | undefined
  /** The document field the title falls back to. Defaults to `title`. */
  readonly titleField?: string | undefined
  /** Used when the document carries neither `seo.title` nor a title field. */
  readonly fallbackTitle?: string | undefined
  /** `og:site_name`. */
  readonly siteName?: string | undefined
  /** `og:locale`. The studio is Hebrew-first, but the site decides. */
  readonly locale?: string | undefined
  /** `og:type`. Defaults to `website`. */
  readonly type?: 'website' | 'article' | undefined
  /** Overrides the environment, for tests and multi-tenant build scripts. */
  readonly env?: EnvSource | undefined
}

/* ── the mapping ──────────────────────────────────────────────────────────── */

/**
 * One document to Next `Metadata`.
 *
 * Exported separately from `metadataFor` because it is a pure function of the
 * document: a caller that already holds one — a build script, a page that read
 * it for its own body — should not have to hand back a loader to reach the
 * mapping, and a pure function is the half worth testing exhaustively.
 *
 * Absent fields are OMITTED rather than emitted empty. `<title></title>` is not
 * a neutral default; it is a title, and it is worse than the one Next would
 * have inherited from the layout.
 */
export function metadataFrom(
  document: SeoDocument | null | undefined,
  options: MetadataOptions = {},
): Metadata {
  if (document === null || document === undefined) return {}

  const env = options.env ?? process.env
  const data = fields(document)
  const seo = readSeo(data)

  const title = trimmed(seo.title) ?? fallbackTitle(data, options.titleField) ?? trimmed(options.fallbackTitle)
  const description = trimmed(seo.description)
  const image = openGraphImage(seo.image, options.env)

  const origin = readOrigin(env, options.origin)
  const path =
    options.path === false ? undefined : (options.path ?? defaultPath(readString(data, 'slug')))

  // `openGraph` is only worth emitting when something fills it. An empty object
  // renders no tags but does make Next warn about a missing `metadataBase`.
  const openGraph =
    title === undefined && description === undefined && image === null
      ? undefined
      : {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(image === null ? {} : { images: [image] }),
          ...(options.siteName === undefined ? {} : { siteName: options.siteName }),
          ...(options.locale === undefined ? {} : { locale: options.locale }),
          type: options.type ?? ('website' as const),
          ...(origin === undefined || path === undefined ? {} : { url: path }),
        }

  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    // Set whenever the origin is known, so that the relative `canonical` and
    // `og:url` above resolve to absolute URLs — which the OG spec requires and
    // Next will otherwise warn about on every build.
    ...(origin === undefined ? {} : { metadataBase: new URL(origin) }),
    ...(origin === undefined || path === undefined ? {} : { alternates: { canonical: path } }),
    ...(openGraph === undefined ? {} : { openGraph }),
  }
}

/* ── the `generateMetadata` factory ───────────────────────────────────────── */

/**
 * The props Next hands `generateMetadata`. Both members are optional so that a
 * loader ignoring them — the common case, a fixed page — needs no annotation.
 */
export interface MetadataProps {
  readonly params?: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>
  readonly searchParams?: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>
}

export type DocumentLoader<TProps> = (
  props: TProps,
) => Promise<SeoDocument | null | undefined> | SeoDocument | null | undefined

/**
 * A `generateMetadata` that reads the owner's `seo` fields.
 *
 *   export const generateMetadata = metadataFor(() => getPage('home'))
 *
 *   export const generateMetadata = metadataFor(
 *     async ({ params }) => getPost((await params).slug),
 *   )
 *
 * The loader is the caller's, not a slug this package resolves for them: a site
 * reads its documents through `getPage`, `client.get`, or a function of its own
 * that expands references, and inventing a fifth way to fetch would only be a
 * fifth way to miss a cache tag.
 *
 * A missing document yields `{}` — the layout's own metadata, unchanged. It
 * does NOT throw, because a `generateMetadata` that throws takes down a page
 * whose body may be perfectly renderable, and because the page's own `notFound`
 * is the right place for that decision.
 */
export function metadataFor<TProps = MetadataProps>(
  load: DocumentLoader<TProps>,
  options: MetadataOptions = {},
): (props: TProps) => Promise<Metadata> {
  return async (props: TProps): Promise<Metadata> => metadataFrom(await load(props), options)
}

/* ── JSON-LD (M21.3) ──────────────────────────────────────────────────────── */

/**
 * A business, as `LocalBusiness` or one of its subtypes.
 *
 * WHY THIS TYPE AND NOT FAQPage, WHICH THE PLAN ASKED FOR FIRST.
 * `FAQPage` was removed from Google Search on 15 June 2026, and before that it
 * had been narrowed to authoritative government and health sites, so no
 * customer of this product was ever eligible. `Review` and `AggregateRating`
 * are worse than useless here: a business that controls the reviews about
 * itself is explicitly ineligible for the star feature, and every testimonial
 * in this product is collected by the business about itself. `LocalBusiness`
 * is what survived, and it wants exactly two properties this model already
 * holds. See `research/geo-2026.md` in the private repo.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not read the project's model to
 * discover which type is the business, and it does not guess from field kinds.
 * There is one business per site and the layout that renders this knows which
 * document it is; a stored `schemaType` earns its place when many types need
 * telling apart, not here. And a guessed type is worse than none — structured
 * data is a public assertion a machine reads, and Google's own guidance is that
 * markup which does not match the page is a reason to discount the page's
 * markup entirely.
 */
export interface BusinessJsonLdOptions {
  /**
   * A schema.org type. `LocalBusiness` is the safe default; a guest house is
   * more precisely `LodgingBusiness`, a clinic `MedicalBusiness`, a restaurant
   * `Restaurant`. Any subtype inherits every property emitted here.
   */
  readonly type?: string | undefined
  /** The site's origin, overriding the environment. */
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  /**
   * Field names, when the project's differ from the templates'.
   *
   * The defaults are the names every template this product ships uses. A
   * customer who renamed a field gets LESS markup rather than wrong markup,
   * which is the only safe direction to be wrong in.
   */
  readonly fields?:
    | {
        readonly name?: string | undefined
        readonly address?: string | undefined
        readonly telephone?: string | undefined
        readonly image?: string | undefined
      }
    | undefined
}

/** What a caller renders. `null` when the emitter has nothing truthful to say. */
export type JsonLd = Readonly<Record<string, unknown>>
/** @deprecated The name from when this module emitted only a business. */
export type BusinessJsonLd = JsonLd

export function businessJsonLd(
  document: SeoDocument | null | undefined,
  options: BusinessJsonLdOptions = {},
): JsonLd | null {
  if (document === null || document === undefined) return null

  const data = fields(document)
  const named = options.fields ?? {}

  const name = readString(data, named.name ?? 'title') ?? readString(data, 'name')
  const address = readString(data, named.address ?? 'address')

  /*
   * `name` and `address` are the two REQUIRED properties, and an item missing a
   * required property is not eligible for anything. Emitting it anyway would
   * publish an incomplete entity claim in exchange for nothing, so this returns
   * null and the caller renders no script at all.
   */
  if (name === undefined || address === undefined) return null

  const env = options.env ?? process.env
  const seo = readSeo(data)
  const telephone = readString(data, named.telephone ?? 'phone')
  const origin = readOrigin(env, options.origin)
  // Through the same helper the Open Graph tag uses, so the logo a share card
  // shows and the logo the knowledge panel is offered cannot disagree.
  const image = openGraphImage(readImage(data, named.image ?? 'logo'), options.env)

  return {
    '@context': 'https://schema.org',
    '@type': options.type ?? 'LocalBusiness',
    name,
    /*
     * A string is legal for `address`, but Google asks for a `PostalAddress`
     * and gives more for one. The model holds a single free-text field, so the
     * whole of it becomes `streetAddress` rather than being split on commas —
     * a split guesses which fragment is the city and gets it wrong for exactly
     * the addresses that are not a street and a number, which in this market is
     * most of them.
     */
    address: { '@type': 'PostalAddress', streetAddress: address },
    ...(telephone === undefined ? {} : { telephone }),
    ...(origin === undefined ? {} : { url: origin }),
    ...(seo.description === undefined ? {} : { description: seo.description }),
    ...(image === null ? {} : { image: image.url }),
  }
  /*
   * OPENING HOURS ARE DELIBERATELY ABSENT, and this is the interesting omission.
   * Templates store them as `{ day, hours }` with both values written by the
   * owner in their own language — "ראשון", "09:00-17:00" and, in real data,
   * "א׳-ה׳" and "סגור". `openingHoursSpecification` needs a schema.org
   * `dayOfWeek` and two `hh:mm` times, and every route from the first to the
   * second is a guess about a string a human typed. The same reasoning that
   * withdrew three of `lint`'s five checks in M16 applies exactly: a wrong
   * opening hour published as machine-readable fact is worse than no opening
   * hour, because a customer is turned away by it rather than merely not helped.
   * A structured hours field would fix this, and that is a model change.
   */
}

/**
 * The JSON, escaped so it is safe inside a script tag.
 *
 * `</script>` inside owner-authored content would otherwise close the tag and
 * everything after it becomes markup — the plainest XSS in the product, in a
 * field an owner is invited to type prose into. Escaping `<` as `<` is
 * valid JSON, parses identically, and cannot terminate the element. `JSON.parse`
 * on the other side is unaffected.
 */
export function jsonLdHtml(value: JsonLd | null): string | null {
  if (value === null) return null
  return JSON.stringify(value).replace(/</gu, '\\u003c')
}

/* ── sitemap and robots (M21.4) ───────────────────────────────────────────── */

/**
 * Where a type's documents live on the site.
 *
 * A string for a singleton that owns one fixed path, a function for a type with
 * one page per document, and absence for a type that has no page of its own —
 * a stay rule and a testimonial are read on other pages and have no URL to give.
 *
 * THIS IS NOT INFERRED, AND THAT IS THE WHOLE DESIGN. A slug is not a route:
 * `bikta-marva` is served at `/accommodations/bikta-marva`, and the CMS cannot
 * know the difference because the routing lives in the customer's app. Guessing
 * `/{typeKey}/{slug}` would be right for the demo and wrong for the next site,
 * and a sitemap full of URLs that 404 is worse than no sitemap: it teaches a
 * crawler that this host lies about what it has.
 */
export type SitemapRoute<TDocument = SeoDocument> =
  | string
  | ((document: TDocument) => string | null | undefined)

export interface SitemapOptions {
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  /**
   * Per type. Types not named here are omitted.
   *
   * Omitted entirely, the seeded `page` type is used at `/{slug}` with `home`
   * at the root — the same convention `metadataFrom` already relies on, seeded
   * by this package and shipped in every template.
   */
  readonly routes?: Readonly<Record<string, SitemapRoute>> | undefined
  /** The client to read through. Defaults to the configured one. */
  readonly client?: { readonly getAll: () => Promise<BuildPayload> } | undefined
  /**
   * Paths that are not documents.
   *
   * Every site has some: an `/about` written in JSX, a `/contact`, or a page
   * that lists a type without being one of it — the demo's `/area` renders
   * every area guide and is itself no document, so nothing in `routes` could
   * ever name it. Found by shipping a sitemap that quietly omitted a real page.
   */
  readonly extra?: readonly string[] | undefined
}

interface SitemapEntry {
  readonly url: string
  readonly lastModified?: Date | undefined
}

function resolveRoute(route: SitemapRoute, document: SeoDocument): string | undefined {
  const path = typeof route === 'string' ? route : route(document)
  if (path === null || path === undefined) return undefined
  const trimmedPath = path.trim()
  return trimmedPath.length === 0 ? undefined : trimmedPath
}

function lastModified(document: SeoDocument): Date | undefined {
  const value = fields(document)['_updatedAt']
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * A sitemap, from one request.
 *
 * `getAll` rather than a call per type: it is the endpoint M13 built for
 * exactly this, and it carries the project cache tag, so the publish webhook
 * that already purges the site's pages purges the sitemap with them. Next
 * caches `sitemap.ts` by default, which means without that tag a sitemap would
 * be generated once at build and then quietly describe an older site forever.
 * No `revalidate` interval is needed and none is set: an interval would be a
 * guess about how often someone publishes, and the tag is the fact.
 *
 * Returns an empty array rather than throwing when the API is unreachable. A
 * sitemap that 500s is removed from Search Console as broken; an empty one is
 * merely uninformative, and the next revalidation repairs it.
 */
export function sitemapFrom(options: SitemapOptions = {}): () => Promise<SitemapEntry[]> {
  return async (): Promise<SitemapEntry[]> => {
    const origin = readOrigin(options.env ?? process.env, options.origin)
    // Every URL in a sitemap must be absolute and on this host. Without an
    // origin there is nothing truthful to emit.
    if (origin === undefined) return []

    /*
     * A client of its own rather than the one `index.ts` memoises: that one is
     * private to that module, and importing it here would pull the whole
     * top-level surface into this entry point to reach a single function. A
     * build script that called `configure()` passes its client instead, which
     * is what the option is for.
     */
    const client = options.client ?? createClient()
    let payload: BuildPayload
    try {
      payload = await client.getAll()
    } catch {
      return []
    }

    const routes: Readonly<Record<string, SitemapRoute>> = options.routes ?? {
      page: (document) => defaultPath(readString(fields(document), 'slug')),
    }

    const entries: SitemapEntry[] = []
    const seen = new Set<string>()

    for (const path of options.extra ?? []) {
      const url = new URL(path, origin).toString()
      if (seen.has(url)) continue
      seen.add(url)
      // No `lastModified`: the page is code, and its content changes when the
      // documents it renders change, which this cannot see. A made-up date is
      // worse than none — a crawler that is told a page is fresh and finds it
      // unchanged learns to discount the signal for the whole host.
      entries.push({ url })
    }

    for (const [typeKey, route] of Object.entries(routes)) {
      const documents: readonly SeoDocument[] =
        typeKey in payload.documents
          ? (payload.documents[typeKey as keyof BuildPayload['documents']] as readonly SeoDocument[])
          : (payload.documentsByType[typeKey] ?? [])

      for (const document of documents) {
        const path = resolveRoute(route, document)
        if (path === undefined) continue

        const url = new URL(path, origin).toString()
        // A singleton route given as a string yields the same URL for every
        // document of that type, and a duplicate <loc> is a validation error.
        if (seen.has(url)) continue
        seen.add(url)

        const modified = lastModified(document)
        entries.push(modified === undefined ? { url } : { url, lastModified: modified })
      }
    }

    return entries
  }
}

/**
 * Crawlers that are named because naming them is a decision.
 *
 * `robots.txt` allows everything by default, so listing these grants nothing
 * that was not already granted. What it does is put the choice somewhere a
 * human can see and reverse — a site that decides its content should not train
 * a model edits one line here, rather than discovering there was never a line.
 *
 * Google's own guidance is that `robots.txt` is how AI crawler access is
 * managed, and that no `llms.txt` is needed for AI Overviews or AI Mode.
 */
export const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'Amazonbot',
  'Bytespider',
  'Meta-ExternalAgent',
  'cohere-ai',
  'CCBot',
]

export interface RobotsOptions {
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  /** Set false to disallow the crawlers in `AI_CRAWLERS`. */
  readonly allowAi?: boolean | undefined
  readonly disallow?: readonly string[] | undefined
}

export interface RobotsResult {
  readonly rules: ReadonlyArray<{
    readonly userAgent: string | readonly string[]
    readonly allow?: string | undefined
    readonly disallow?: string | readonly string[] | undefined
  }>
  readonly sitemap?: string | undefined
}

export function robotsFrom(options: RobotsOptions = {}): RobotsResult {
  const origin = readOrigin(options.env ?? process.env, options.origin)
  const disallow = options.disallow ?? []

  const rules: RobotsResult['rules'] = [
    { userAgent: '*', allow: '/', ...(disallow.length === 0 ? {} : { disallow }) },
    options.allowAi === false
      ? { userAgent: [...AI_CRAWLERS], disallow: '/' }
      : { userAgent: [...AI_CRAWLERS], allow: '/' },
  ]

  // Omitted rather than guessed. A `Sitemap:` line pointing at a host that is
  // not this one sends every crawler that reads it somewhere wrong.
  return origin === undefined
    ? { rules }
    : { rules, sitemap: new URL('/sitemap.xml', origin).toString() }
}

/* ── llms.txt (M21.9) ─────────────────────────────────────────────────────── */

/**
 * A page named in `llms.txt` that is not a document.
 *
 * A bare path is accepted and yields a link whose text IS the path, which is
 * exactly as informative as the `sitemap.xml` line for the same page — so it
 * is worth supplying a title. The whole reason this file exists alongside a
 * sitemap is that it carries names and sentences rather than URLs.
 */
export type LlmsExtra = string | { readonly path: string; readonly title: string; readonly description?: string | undefined }

export interface LlmsTxtOptions {
  /** The site's name. The H1, and the only genuinely required value. */
  readonly title: string
  /** One sentence, rendered as the blockquote the format calls a summary. */
  readonly summary?: string | undefined
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  /** Per type, exactly as `sitemapFrom` takes them — same rule, same reason. */
  readonly routes?: Readonly<Record<string, SitemapRoute>> | undefined
  /** The heading each type's pages are listed under. Defaults to the type key. */
  readonly headings?: Readonly<Record<string, string>> | undefined
  /**
   * The heading `extra` is listed under.
   *
   * It has a default and the default is English, which is wrong for most sites
   * this serves — the first Hebrew site to ship this got a file whose sections
   * read העמוד הראשי, המתחמים, then "Other pages". A generated file that
   * changes language halfway through is the jargon this product does not do,
   * so the option exists and every Hebrew site should pass it.
   */
  readonly extraHeading?: string | undefined
  readonly client?: { readonly getAll: () => Promise<BuildPayload> } | undefined
  readonly extra?: readonly LlmsExtra[] | undefined
}

/** `[` and `]` end a markdown link's text; a newline ends the list item. */
function inline(value: string): string {
  return value.replace(/[[\]]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * `llms.txt`, and an honest account of what it is worth.
 *
 * IT IS ALMOST CERTAINLY NOT READ. Google's own wording is that neither special
 * schema nor an `llms.txt` is needed to appear in AI Overviews or AI Mode,
 * OpenAI's crawler documentation does not mention the file, and the measured
 * figure at the time of writing is that 97% of published ones receive zero AI
 * requests. It ships because it is a few lines and costs nothing to keep true —
 * not because anything is known to consume it, and the landing page must not
 * claim otherwise.
 *
 * What it does carry that `sitemap.xml` cannot: a NAME and a SENTENCE per page,
 * taken from the same `seo` fields the owner already edits and the same
 * fallbacks `metadataFrom` uses. If some reader does arrive, it reads the
 * owner's words rather than a list of URLs.
 *
 * There is no Next convention for this file — no `llms.ts` the way there is a
 * `sitemap.ts` — so this returns the text and the app mounts it:
 *
 *     // app/llms.txt/route.ts
 *     const body = llmsTxtFrom({ title: '…', routes: { … } })
 *     export async function GET() {
 *       return new Response(await body(), {
 *         headers: { 'content-type': 'text/plain; charset=utf-8' },
 *       })
 *     }
 *
 * Absolute URLs, and therefore nothing at all without an origin: a relative
 * link in a file a machine fetched from an unknown base resolves to nothing.
 * Unreachable API yields the header alone rather than throwing, for the same
 * reason `sitemapFrom` returns an empty array.
 */
export function llmsTxtFrom(options: LlmsTxtOptions): () => Promise<string> {
  return async (): Promise<string> => {
    const origin = readOrigin(options.env ?? process.env, options.origin)
    const header = [`# ${inline(options.title)}`]
    const summary = trimmed(options.summary)
    if (summary !== undefined) header.push('', `> ${inline(summary)}`)
    if (origin === undefined) return `${header.join('\n')}\n`

    const lines = [...header]
    const seen = new Set<string>()

    const item = (path: string, title: string, description: string | undefined): string | undefined => {
      const url = new URL(path, origin).toString()
      if (seen.has(url)) return undefined
      seen.add(url)
      const suffix = description === undefined ? '' : `: ${inline(description)}`
      return `- [${inline(title)}](${url})${suffix}`
    }

    const extras = (options.extra ?? [])
      .map((entry) =>
        typeof entry === 'string'
          ? item(entry, entry, undefined)
          : item(entry.path, entry.title, trimmed(entry.description)),
      )
      .filter((line): line is string => line !== undefined)

    let payload: BuildPayload | undefined
    try {
      payload = await (options.client ?? createClient()).getAll()
    } catch {
      payload = undefined
    }

    const routes = options.routes ?? {
      page: (document) => defaultPath(readString(fields(document), 'slug')),
    }

    for (const [typeKey, route] of Object.entries(routes)) {
      if (payload === undefined) break
      const documents: readonly SeoDocument[] =
        typeKey in payload.documents
          ? (payload.documents[typeKey as keyof BuildPayload['documents']] as readonly SeoDocument[])
          : (payload.documentsByType[typeKey] ?? [])

      const section: string[] = []
      for (const document of documents) {
        const path = resolveRoute(route, document)
        if (path === undefined) continue
        const data = fields(document)
        const seo = readSeo(data)
        // The same resolution `metadataFrom` performs, so a page's name here and
        // its <title> cannot disagree — two sources for one name is how they do.
        const title = trimmed(seo.title) ?? fallbackTitle(data, undefined)
        if (title === undefined) continue
        const line = item(path, title, trimmed(seo.description))
        if (line !== undefined) section.push(line)
      }

      if (section.length === 0) continue
      lines.push('', `## ${inline(options.headings?.[typeKey] ?? typeKey)}`, '', ...section)
    }

    // Last, because these are the pages the app knows about and the CMS does
    // not, and a reader that stops early should have read the content first.
    if (extras.length > 0) {
      lines.push('', `## ${inline(options.extraHeading ?? 'Other pages')}`, '', ...extras)
    }

    return `${lines.join('\n')}\n`
  }
}

/* ── Article, BreadcrumbList (M21.5) ──────────────────────────────────────── */

export interface ArticleJsonLdOptions {
  /**
   * Who wrote it. REQUIRED HERE THOUGH GOOGLE DOES NOT REQUIRE IT, because the
   * model cannot supply it: the seeded `post` type has `title`, `excerpt`,
   * `body`, `cover`, `publishedAt` and `tags`, and no author at all. Rather
   * than emit an article with no attribution, the caller names one — usually
   * the business, which is the truth of who published it.
   */
  readonly author: string
  readonly path?: string | false | undefined
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  readonly fields?:
    | {
        readonly headline?: string | undefined
        readonly datePublished?: string | undefined
        readonly image?: string | undefined
      }
    | undefined
}

/**
 * An article.
 *
 * `Article` has NO required properties — "there are no required properties;
 * instead, add the properties that apply to your content" is Google's wording,
 * and the earlier research in this project said otherwise and was wrong. So the
 * gate here is only a headline, which every type in every template has, and
 * everything else appears when the document holds it.
 */
export function articleJsonLd(
  document: SeoDocument | null | undefined,
  options: ArticleJsonLdOptions,
): JsonLd | null {
  if (document === null || document === undefined) return null

  const data = fields(document)
  const named = options.fields ?? {}
  const seo = readSeo(data)
  const headline =
    readString(data, named.headline ?? 'title') ?? trimmed(seo.title)
  if (headline === undefined) return null

  const env = options.env ?? process.env
  const origin = readOrigin(env, options.origin)
  const published = readString(data, named.datePublished ?? 'publishedAt')
  const modified = readString(data, '_updatedAt')
  const image = openGraphImage(readImage(data, named.image ?? 'cover'), options.env)
  const path =
    options.path === false ? undefined : (options.path ?? defaultPath(readString(data, 'slug')))
  const url = origin === undefined || path === undefined ? undefined : new URL(path, origin).toString()

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline,
    // An Organization rather than a Person: a business publishing its own
    // journal is the case this model serves, and claiming a named human who is
    // not in the content would be inventing an entity.
    author: { '@type': 'Organization', name: options.author },
    ...(published === undefined ? {} : { datePublished: published }),
    ...(modified === undefined ? {} : { dateModified: modified }),
    ...(seo.description === undefined ? {} : { description: seo.description }),
    ...(image === null ? {} : { image: image.url }),
    ...(url === undefined ? {} : { mainEntityOfPage: url }),
  }
}

/** One step of a trail. The last one is the current page and needs no path. */
export interface BreadcrumbStep {
  readonly name: string
  readonly path?: string | undefined
}

/**
 * A breadcrumb trail.
 *
 * SUPPLIED, NOT DERIVED. A document knows its slug and nothing about what
 * contains it — `bikta-marva` does not know it lives under `/accommodations`,
 * and splitting a URL on slashes recovers the segments but not their names, so
 * the trail would read "accommodations" where the site says "המתחמים". The page
 * rendering the breadcrumb already knows both, because it renders both.
 */
export function breadcrumbJsonLd(
  trail: readonly BreadcrumbStep[],
  options: { readonly origin?: string | undefined; readonly env?: EnvSource | undefined } = {},
): JsonLd | null {
  // One step is the page itself, which is not a trail and produces a
  // single-item list that says nothing a crawler did not already know.
  if (trail.length < 2) return null

  const origin = readOrigin(options.env ?? process.env, options.origin)

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      ...(step.path === undefined || origin === undefined
        ? {}
        : { item: new URL(step.path, origin).toString() }),
    })),
  }
}

/* ── Product and Offer (M21.6) ────────────────────────────────────────────── */

export interface ProductJsonLdOptions {
  /**
   * ISO 4217, and REQUIRED, because the model does not carry it. Only the
   * seeded `product` type has a `currency` field; every `price` in every
   * template is a bare number, and an `Offer` without `priceCurrency` is an
   * incomplete offer. Defaulting to ILS would be a guess that is wrong the
   * first time this ships outside Israel, and wrong silently.
   */
  readonly currency: string
  readonly path?: string | false | undefined
  readonly origin?: string | undefined
  readonly env?: EnvSource | undefined
  readonly fields?:
    | {
        readonly name?: string | undefined
        readonly price?: string | undefined
        readonly image?: string | undefined
      }
    | undefined
}

/**
 * A product, with its offer.
 *
 * Returns null without a price. `Product` on its own is legal, but the reason
 * to emit one is the price and availability a comparison engine reads; a
 * Product with no Offer occupies the markup budget and answers nothing.
 */
export function productJsonLd(
  document: SeoDocument | null | undefined,
  options: ProductJsonLdOptions,
): JsonLd | null {
  if (document === null || document === undefined) return null

  const data = fields(document)
  const named = options.fields ?? {}
  const name = readString(data, named.name ?? 'title')
  const price = data[named.price ?? 'price']
  if (name === undefined || typeof price !== 'number' || !Number.isFinite(price)) return null

  const env = options.env ?? process.env
  const origin = readOrigin(env, options.origin)
  const seo = readSeo(data)
  const image = openGraphImage(readImage(data, named.image ?? 'heroImage'), options.env)
  const path =
    options.path === false ? undefined : (options.path ?? defaultPath(readString(data, 'slug')))
  const url = origin === undefined || path === undefined ? undefined : new URL(path, origin).toString()

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    ...(seo.description === undefined ? {} : { description: seo.description }),
    ...(image === null ? {} : { image: image.url }),
    offers: {
      '@type': 'Offer',
      price,
      priceCurrency: options.currency,
      /*
       * `InStock` is NOT assumed. This model has no availability for a template
       * price — a guest house room may be booked and a treatment may be
       * withdrawn — and telling a comparison engine that something is available
       * when it is not is the one wrong answer that costs a real customer a
       * real journey. `inStock` on the seeded product type is a boolean this
       * reads when it is there.
       */
      ...(typeof data['inStock'] === 'boolean'
        ? {
            availability: `https://schema.org/${data['inStock'] ? 'InStock' : 'OutOfStock'}`,
          }
        : {}),
      ...(url === undefined ? {} : { url }),
    },
  }
}

/* ── ImageObject (M21.7) ──────────────────────────────────────────────────── */

/**
 * An image, described.
 *
 * `alt` becomes `name` and the caption becomes `caption`, which is the
 * distinction schema.org draws and the one the model already stores separately:
 * alt describes what is in the picture for someone who cannot see it, a caption
 * explains why it is on the page. Both are read by AI systems, and this product
 * is one of the few CMSs that has the first as a required field.
 *
 * No `creator` and no `license`: nothing in the model records either, and an
 * unattributed licence claim is worse than none.
 */
export function imageObjectJsonLd(
  item: { readonly image?: unknown; readonly alt?: unknown; readonly caption?: unknown } | null | undefined,
  options: { readonly env?: EnvSource | undefined } = {},
): JsonLd | null {
  if (item === null || item === undefined) return null

  const image = openGraphImage((item.image ?? null) as ImageRef | null, options.env)
  if (image === null) return null

  const alt = typeof item.alt === 'string' ? trimmed(item.alt) : undefined
  const caption = typeof item.caption === 'string' ? trimmed(item.caption) : undefined

  return {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    contentUrl: image.url,
    width: image.width,
    height: image.height,
    ...(alt === undefined ? {} : { name: alt }),
    ...(caption === undefined ? {} : { caption }),
  }
}
