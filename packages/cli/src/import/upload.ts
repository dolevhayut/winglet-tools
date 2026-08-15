import { createHash } from 'node:crypto'

/**
 * M19 — sending a file without sending it through the API.
 *
 * The platform caps a function's request body at 4.5MB. That is under half of
 * what a phone camera produces, so the previous transport — one multipart POST
 * to `/assets/upload` — answered a bare 413 for the ordinary case, generated
 * before our own code ran and therefore with nothing useful in it. The proxy
 * endpoint still exists and still works for small files; this is what replaces
 * it for everything.
 *
 * Three calls where there was one, and it is USUALLY FASTER, not slower:
 *
 *   1. `POST /assets/uploads` with the digest. If the project already holds
 *      these exact bytes the server says so and no ticket is minted, so a
 *      re-import of unchanged media transfers nothing at all. That is the
 *      common case when an import is run twice, which is the common case.
 *   2. `PUT` the bytes at the ticket, straight to storage.
 *   3. `POST /assets/uploads/:id/complete`, which verifies what landed against
 *      the terms the server itself minted and creates the asset row.
 *
 * The digest is SHA-256 over the bytes as sent — computed AFTER any downscale,
 * because the resized file is a different file and claiming the original's
 * identity for it would return the wrong asset.
 */

export interface UploadTarget {
  readonly apiBaseUrl: string
  readonly writeKey: string
}

export interface UploadRequest {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly filename: string
  readonly alt: string
}

export interface UploadedAsset {
  readonly id: string
  readonly bytes: number
  /** True when the project already held these bytes and nothing was transferred. */
  readonly duplicate: boolean
}

export class UploadRefused extends Error {
  override readonly name = 'UploadRefused'
}

/**
 * The type is READ OFF THE BYTES, never off the name.
 *
 * The server refuses a completion whose sniffed type disagrees with the type
 * the ticket was minted for, and it has to: the object is already lying at a
 * path chosen from the declared type and cannot be renamed afterwards. Guessing
 * from the extension would therefore turn `photo.jpg` that is secretly a PNG —
 * which is exactly what "export from a design tool and rename it" produces —
 * into a refusal at the last step, after the bytes had already crossed the
 * wire. Four signatures cost nothing to check and remove the whole class.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  const at = (index: number): number => bytes[index] ?? -1
  const ascii = (start: number, length: number): string =>
    Array.from({ length }, (_, index) => String.fromCharCode(at(start + index))).join('')

  if (at(0) === 0x89 && ascii(1, 3) === 'PNG') return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (ascii(0, 3) === 'GIF') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  return null
}

/** The extension the server would pick, so the name it stores matches its bytes. */
const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function withExtension(filename: string, mime: string): string {
  const wanted = EXTENSION[mime]
  if (wanted === undefined) return filename
  const base = filename.replace(/\.[^./\\]+$/u, '')
  return `${base}.${wanted}`
}

interface SessionResponse {
  readonly asset?: { readonly id?: string; readonly bytes?: number }
  readonly uploadId?: string
  readonly uploadUrl?: string
  readonly duplicate?: boolean
}

/** §9's envelope, or the status when the failure never reached our code. */
async function refusal(response: Response, fallback: string): Promise<UploadRefused> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') return new UploadRefused(error.message)
  }
  return new UploadRefused(`${fallback} (HTTP ${String(response.status)})`)
}

export async function uploadAsset(
  target: UploadTarget,
  request: UploadRequest,
): Promise<UploadedAsset> {
  const mime = sniffMime(request.bytes)
  if (mime === null) {
    throw new UploadRefused(
      'Not a PNG, JPEG, WebP or GIF. The file was read but its contents are not an image.',
    )
  }

  const filename = withExtension(request.filename, mime)
  const checksum = createHash('sha256').update(request.bytes).digest('hex')
  const headers = {
    authorization: `Bearer ${target.writeKey}`,
    'content-type': 'application/json',
  } as const

  const opened = await fetch(`${target.apiBaseUrl}/assets/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename,
      contentType: mime,
      bytes: request.bytes.byteLength,
      checksum,
    }),
  })
  if (!opened.ok) throw await refusal(opened, 'Could not start the upload')

  const session = (await opened.json()) as SessionResponse

  // The project already holds these bytes. Nothing to send, nothing to finish.
  if (session.asset?.id !== undefined) {
    return {
      id: session.asset.id,
      bytes: session.asset.bytes ?? request.bytes.byteLength,
      duplicate: true,
    }
  }

  const { uploadId, uploadUrl } = session
  if (uploadId === undefined || uploadUrl === undefined) {
    throw new UploadRefused('The server returned neither an existing asset nor an upload ticket.')
  }

  /*
   * Straight to storage, with no key of ours attached. The ticket carries its
   * own authority and is scoped to one path, one method, this content type and
   * this exact size — so it cannot be pointed anywhere else even if it leaks,
   * and it expires in minutes either way.
   */
  const sent = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mime },
    body: request.bytes,
  })
  if (!sent.ok) {
    throw new UploadRefused(
      `Storage refused the file (HTTP ${String(sent.status)}). The upload ticket may have expired.`,
    )
  }

  const finished = await fetch(`${target.apiBaseUrl}/assets/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request.alt.length > 0 ? { alt: request.alt } : {}),
  })
  if (!finished.ok) throw await refusal(finished, 'The upload arrived but could not be recorded')

  const outcome = (await finished.json()) as SessionResponse
  if (outcome.asset?.id === undefined) {
    throw new UploadRefused('The upload completed without returning an asset.')
  }
  return {
    id: outcome.asset.id,
    bytes: outcome.asset.bytes ?? request.bytes.byteLength,
    duplicate: outcome.duplicate === true,
  }
}
