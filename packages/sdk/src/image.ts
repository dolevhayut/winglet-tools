import { createHash, createHmac } from 'node:crypto'

import type { EnvSource } from './config'
import { readClientConfig } from './config'
import type { ImageRef } from './types'

/**
 * M12 (PRD-v2 §4.3) — building a URL for a rendition, and the props that make
 * one correct.
 *
 * WHY THIS IS A URL BUILDER AND NOT A COMPONENT
 * ---------------------------------------------
 * This package has no React dependency and cannot grow one: it is imported by
 * build scripts, by the CLI's own tests, and by Node with no JSX anywhere.
 * `imageProps()` returns exactly what `next/image` and a bare `<img>` both
 * accept, so a customer writes one line either way:
 *
 *   <Image {...imageProps(page.hero, { width: 1600, height: 1000, fit: 'crop' })} />
 *
 * The alternative — shipping a component — would force a peer dependency on
 * React for the sake of six attributes, and would still not know whether the
 * customer wanted `next/image`'s loader or a plain tag.
 *
 * SERVER ONLY. Signing needs the read key, and the read key must never reach a
 * browser. Every call site is a Server Component or a build script, which is
 * where content is read anyway.
 */

export const IMAGE_FITS = ['crop', 'max'] as const
export type ImageFit = (typeof IMAGE_FITS)[number]

export const IMAGE_FORMATS = ['webp', 'jpeg', 'png'] as const
export type ImageFormat = (typeof IMAGE_FORMATS)[number]

export interface ImageOptions {
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly fit?: ImageFit | undefined
  readonly format?: ImageFormat | undefined
  /** 1..100. The server defaults to 80, which is where WebP stops being worth it. */
  readonly quality?: number | undefined
  /** Overrides the environment, for tests and multi-tenant build scripts. */
  readonly env?: EnvSource | undefined
}

/**
 * The widths a `srcset` offers.
 *
 * SIX, AND NOT MORE, because the server budgets twelve renditions per asset and
 * one `<img>` must not spend the whole budget. These are the common device
 * widths at 1x and 2x, and a browser picks exactly one — the others are never
 * fetched and therefore never rendered, so the budget is only spent on sizes
 * real visitors on real screens actually ask for.
 */
const SRCSET_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const

/** Matches the server's `MAX_DIMENSION`. Asking beyond it is a 422. */
const MAX_DIMENSION = 4000

/**
 * The signing key: the digest of the project's read key.
 *
 * The server stored exactly this in `api_keys.key_hash` at project creation, so
 * nothing new is transmitted, nothing new is stored, and there is no fourth
 * secret in `.env.local`. Rotating the read key invalidates every URL signed
 * with the old one, which is what rotation is for.
 */
function signingKey(readKey: string): string {
  return createHash('sha256').update(readKey, 'utf8').digest('hex')
}

/**
 * The canonical parameter string. Must match the server's `canonicalise`
 * byte for byte — it is what both sides sign, and a difference of one character
 * is a 404 on every image.
 */
function canonicalise(options: {
  readonly w?: number | undefined
  readonly h?: number | undefined
  readonly fit: ImageFit
  readonly fm?: ImageFormat | undefined
  readonly q: number
}): string {
  const parts: string[] = []
  if (options.w !== undefined) parts.push(`w=${String(options.w)}`)
  if (options.h !== undefined) parts.push(`h=${String(options.h)}`)
  parts.push(`fit=${options.fit}`)
  if (options.fm !== undefined) parts.push(`fm=${options.fm}`)
  parts.push(`q=${String(options.q)}`)
  return parts.join('&')
}

function sign(key: string, assetId: string, canonical: string): string {
  return createHmac('sha256', key).update(`${assetId}?${canonical}`, 'utf8').digest('hex').slice(0, 32)
}

/** The asset id inside an `image` field, whichever shape it arrived in. */
function assetIdOf(ref: ImageRef | string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null
  if (typeof ref === 'string') return ref.length > 0 ? ref : null
  if (ref.assetId !== undefined && ref.assetId.length > 0) return ref.assetId

  // A field written before assets carried an id, or by hand, may hold only a
  // URL. The id is the last path segment of `/v1/assets/:id/file`.
  const url = ref.url
  if (url === undefined) return null
  const match = /\/assets\/([0-9a-f-]{36})\//i.exec(url)
  return match?.[1] ?? null
}

export interface ImageUrlOptions extends ImageOptions {
  readonly assetId: string
}

/**
 * One signed rendition URL.
 *
 * Exported because a `srcset` is not the only thing anybody builds — an OG tag,
 * a CSS `background-image` and an email all need one URL and no props.
 */
export function imageUrl(options: ImageUrlOptions): string {
  const config = readClientConfig(options.env ?? process.env)
  const width = clamp(options.width)
  const height = clamp(options.height)
  const fit = options.fit ?? 'max'
  const quality = options.quality ?? 80

  const canonical = canonicalise({
    ...(width === undefined ? {} : { w: width }),
    ...(height === undefined ? {} : { h: height }),
    fit,
    ...(options.format === undefined ? {} : { fm: options.format }),
    q: quality,
  })

  const signature = sign(signingKey(config.readKey), options.assetId, canonical)
  return `${config.apiBaseUrl}/img/${options.assetId}?${canonical}&s=${signature}`
}

function clamp(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const rounded = Math.round(value)
  if (!Number.isFinite(rounded) || rounded < 1) return undefined
  return Math.min(rounded, MAX_DIMENSION)
}

export interface ImageProps {
  readonly src: string
  readonly srcSet: string
  readonly sizes: string
  readonly alt: string
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly loading: 'lazy' | 'eager'
  readonly decoding: 'async'
  /** `next/image` reads this; a bare `<img>` ignores it harmlessly. */
  readonly placeholder?: 'blur' | undefined
  readonly blurDataURL?: string | undefined
  readonly fetchPriority?: 'high' | undefined
}

export interface ImagePropsOptions extends ImageOptions {
  /**
   * Above the fold. Turns off lazy loading and asks the browser to prioritise
   * it — the single biggest lever on LCP, and the one thing a developer cannot
   * infer from the image itself.
   */
  readonly priority?: boolean | undefined
  /** The `sizes` attribute. Defaults to full-width, which is right for a hero. */
  readonly sizes?: string | undefined
  /** Overrides the asset's own alt text. */
  readonly alt?: string | undefined
}

/**
 * Everything an `<img>` needs to be fast and correct, from one content field.
 *
 * `alt` comes from the ASSET by default, which is the whole reason alt text is
 * stored there: the owner writes it once in the media library and every page
 * that uses the image inherits it. A developer who omits it does not get an
 * accessibility hole, which is what happens with every API that makes alt a
 * required prop the caller has to invent.
 *
 * Returns `null` for an absent image, so a caller writes
 * `props && <Image {...props} />` rather than guarding four fields.
 */
export function imageProps(
  ref: ImageRef | string | null | undefined,
  options: ImagePropsOptions = {},
): ImageProps | null {
  const assetId = assetIdOf(ref)
  if (assetId === null) return null

  const shared: ImageUrlOptions = {
    assetId,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.fit === undefined ? {} : { fit: options.fit }),
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }

  // The aspect ratio the caller asked for is preserved across the srcset. A
  // `fit=crop` at 1600x1000 must stay 16:10 at every width, or the browser
  // swaps in a differently-shaped image on resize and the page reflows.
  const ratio =
    options.width !== undefined && options.height !== undefined
      ? options.height / options.width
      : null

  const candidates = SRCSET_WIDTHS.filter(
    (width) => options.width === undefined || width <= options.width * 2,
  )
  const widths = candidates.length > 0 ? candidates : [SRCSET_WIDTHS[0]]

  const srcSet = widths
    .map((width) => {
      const url = imageUrl({
        ...shared,
        width,
        ...(ratio === null ? {} : { height: Math.round(width * ratio) }),
      })
      return `${url} ${String(width)}w`
    })
    .join(', ')

  const alt = options.alt ?? (typeof ref === 'string' ? '' : (ref?.alt ?? ''))
  const blur = typeof ref === 'string' ? undefined : ref?.lqip

  return {
    src: imageUrl(shared),
    srcSet,
    sizes: options.sizes ?? '100vw',
    alt,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    loading: options.priority === true ? 'eager' : 'lazy',
    decoding: 'async',
    ...(blur === undefined || blur.length === 0
      ? {}
      : { placeholder: 'blur' as const, blurDataURL: blur }),
    ...(options.priority === true ? { fetchPriority: 'high' as const } : {}),
  }
}
