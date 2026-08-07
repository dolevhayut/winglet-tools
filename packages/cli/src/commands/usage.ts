import { upgradeUrl } from '@product'

import { fetchContentSnapshot, fetchUsage } from '../api'
import type { UsageCounter } from '../api'
import { MARK, line } from '../io'
import type { Io } from '../io'
import type { CommonOptions } from './context'
import { emitJson, loadProjectContext } from './context'

/**
 * `usage` — §11's "מונים מול לימיטים".
 *
 * PREFERS THE SERVER, SURVIVES WITHOUT IT. §9 specifies `GET /usage`, which the
 * API has not shipped yet; a 404 there is "this deployment has no usage
 * endpoint", not "your project is gone". So the command falls back to counting
 * what it can see through the Content API and comparing that against §12's
 * published document limits, and says plainly which of the two it did.
 *
 * The fallback is honest about its blind spots: storage, bandwidth and editor
 * seats are server-side facts that no read key can observe, and they are
 * reported as unavailable rather than as zero.
 */

export interface UsageOptions extends CommonOptions {
  /** Compare against a specific plan instead of inferring one. */
  readonly plan?: string | undefined
}

/** §12's document limits, plus §14.4's tighter cap before adoption. */
const DOCUMENT_LIMITS: Readonly<Record<string, number>> = {
  anonymous: 25,
  free: 100,
  pro: 1_000,
  studio: 10_000,
}

const PLAN_NAMES = Object.keys(DOCUMENT_LIMITS)

/** Counters the Content API cannot see; only `GET /usage` can report them. */
const SERVER_ONLY = ['storage_bytes', 'bandwidth_bytes_month', 'editors'] as const

function percent(current: number, max: number | undefined): string {
  if (max === undefined || max <= 0) return ''
  return ` (${String(Math.round((current / max) * 100))}%)`
}

function counterLine(counter: UsageCounter): string {
  const limit = counter.max === undefined ? '' : ` / ${String(counter.max)}`
  return `  ${counter.name.padEnd(22)}${String(counter.current)}${limit}${percent(counter.current, counter.max)}`
}

export async function usageCommand(io: Io, options: UsageOptions): Promise<void> {
  const context = loadProjectContext(io, options)

  // The write key is the management-side credential; the read key is all an
  // unclaimed, build-only checkout has. Either is accepted.
  const key = context.writeKey ?? context.readKey
  const reported = await fetchUsage(context.apiBaseUrl, key)

  if (reported !== undefined) {
    const overLimit = reported.counters.filter(
      (counter) => counter.max !== undefined && counter.current >= counter.max,
    )

    if (options.json === true) {
      emitJson(io, {
        ok: true,
        command: 'usage',
        source: 'api',
        project: { id: context.projectId },
        plan: reported.plan ?? null,
        counters: reported.counters.map((counter) => ({
          name: counter.name,
          current: counter.current,
          max: counter.max ?? null,
        })),
        atLimit: overLimit.map((counter) => counter.name),
        upgradeUrl: upgradeUrl(context.projectId),
      })
      return
    }

    io.write(
      line(
        MARK.done,
        `Project ${context.projectId}${reported.plan === undefined ? '' : ` — plan ${reported.plan}`}`,
      ),
    )
    for (const counter of reported.counters) io.write(`${counterLine(counter)}\n`)
    if (overLimit.length > 0) {
      io.write(
        line(
          MARK.warn,
          `At the limit: ${overLimit.map((counter) => counter.name).join(', ')}. ` +
            `Writes are blocked; the published site keeps serving. ${upgradeUrl(context.projectId)}`,
        ),
      )
    }
    return
  }

  /* ── derived ────────────────────────────────────────────────────────────── */

  const snapshot = await fetchContentSnapshot(context.apiBaseUrl, context.readKey)

  // An unclaimed project still holds a live claim token, and §14.4 caps those
  // at 25 documents rather than the free plan's 100.
  const inferredPlan = context.config?.claim === undefined ? 'free' : 'anonymous'
  const plan = options.plan ?? inferredPlan
  const max = DOCUMENT_LIMITS[plan]

  const perType = [...snapshot.types].sort().map((typeKey) => ({
    name: typeKey,
    current: (snapshot.documents[typeKey] ?? []).length,
    max: undefined,
  }))

  if (options.json === true) {
    emitJson(io, {
      ok: true,
      command: 'usage',
      source: 'derived',
      note: 'GET /usage is not available on this API; counts derived from the Content API.',
      project: { id: snapshot.projectId },
      plan,
      counters: [
        { name: 'documents', current: snapshot.total, max: max ?? null },
        ...perType.map((entry) => ({ name: `documents.${entry.name}`, current: entry.current, max: null })),
      ],
      unavailable: SERVER_ONLY,
      atLimit: max !== undefined && snapshot.total >= max ? ['documents'] : [],
      upgradeUrl: upgradeUrl(snapshot.projectId),
    })
    return
  }

  io.write(line(MARK.done, `Project ${snapshot.projectId} — plan ${plan} (assumed)`))
  io.write(`${counterLine({ name: 'documents', current: snapshot.total, max })}\n`)
  for (const entry of perType) {
    io.write(`${counterLine({ name: `  ${entry.name}`, current: entry.current, max: undefined })}\n`)
  }

  if (max !== undefined && snapshot.total >= max) {
    io.write(
      line(
        MARK.warn,
        `At the document limit. Writes are blocked; the published site keeps serving (AC8). ` +
          upgradeUrl(snapshot.projectId),
      ),
    )
  }

  io.write(
    line(
      MARK.info,
      `Counts derived from the Content API — this deployment has no usage endpoint yet, so ` +
        `${SERVER_ONLY.join(', ')} are unavailable. Plans: ${PLAN_NAMES.join(', ')} (--plan).`,
    ),
  )
}
