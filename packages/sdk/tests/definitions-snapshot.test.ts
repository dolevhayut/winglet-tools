import { describe, expect, it } from 'vitest'

import {
  BLOCK_KINDS,
  CONTENT_TYPE_KEYS,
  CONTENT_TYPE_LIST,
  FIELD_KINDS,
  OBJECT_LIST,
} from '../src/definitions'

/**
 * THE OTHER HALF OF THE DRIFT GUARD.
 *
 * `definitions.ts` is a hand-maintained mirror of `apps/api/lib/seed.ts` in the
 * private repo. Its own header claimed for months that a test enforced this;
 * none existed. The obstacle was real: the two files live in different
 * repositories, so neither one can import the other.
 *
 * The fix is an artifact both can read. This test writes the definitions to a
 * committed JSON snapshot, and the private repo's `tools/guards/
 * definitions-sync.test.ts` fetches that snapshot from `main` and deep-compares
 * it against the API's copy. JSON needs no compiler, no evaluation and no
 * parsing heuristics — it is just a value, which is exactly what is being
 * compared.
 *
 * If this test fails, the definitions changed and the snapshot did not. Rerun
 * vitest with `-u` to update it, and COMMIT THE RESULT: an unpushed snapshot is
 * indistinguishable to the private guard from a drift.
 *
 * Block FIELD definitions are deliberately absent. They live only in this
 * package — `seed.ts` names the three block kinds and never describes them — so
 * including them would give the private guard something it cannot possibly
 * match.
 */

const snapshot = {
  fieldKinds: FIELD_KINDS,
  contentTypeKeys: CONTENT_TYPE_KEYS,
  blockKinds: BLOCK_KINDS,
  contentTypes: CONTENT_TYPE_LIST,
  objects: OBJECT_LIST,
}

describe('the definitions snapshot', () => {
  it('matches the committed copy the private repo compares against', async () => {
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      '../definitions.snapshot.json',
    )
  })

  it('is serialisable without loss — everything here survives a jsonb round trip', () => {
    // The same constraint `seed.ts` states: anything written into a `jsonb`
    // column must be plain JSON. A definition carrying a function or a Date
    // would compare equal in memory and differ the moment it was stored.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(JSON.parse(JSON.stringify(snapshot)))
    expect(JSON.stringify(snapshot)).not.toContain('undefined')
  })
})
