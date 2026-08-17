import type { Metadata } from 'next'

import { ENV } from '@product'

import type { EnvSource } from './config'
import { imageProps } from './image'
import type { ImageRef, SeoFields } from './types'

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
  const props = imageProps(image, {
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

/** What a caller renders. `null` when the required properties are not present. */
export type BusinessJsonLd = Readonly<Record<string, unknown>>

export function businessJsonLd(
  document: SeoDocument | null | undefined,
  options: BusinessJsonLdOptions = {},
): BusinessJsonLd | null {
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
export function jsonLdHtml(value: BusinessJsonLd | null): string | null {
  if (value === null) return null
  return JSON.stringify(value).replace(/</gu, '\\u003c')
}
