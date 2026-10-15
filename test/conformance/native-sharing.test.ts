import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  FileShareStore,
  InMemoryShareStore,
  ShareError,
  advanceShareCursor,
  assertShareLive,
  createContentFreeShareBundle,
  createShareReference,
  parseShareAccessGrant,
  parseShareReference,
  requireShareGrant,
  revokeShare,
} from "../../src/share/index.ts"

test("native sharing defaults to content-free bundles and supports revoke/cursor conflict", () => {
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "read-only-live", now: 100 })
  const store = new InMemoryShareStore()
  store.put(share)
  const advanced = advanceShareCursor(share, "user-1", 4, 0)
  store.put(advanced)
  expect(advanced).toMatchObject({ eventCursor: 4, revision: 1, status: "active" })
  expect(createContentFreeShareBundle(advanced, "task-digest")).toMatchObject({ share: { shareId: share.shareId }, taskDigest: "task-digest", artifacts: [] })
  expect(() => advanceShareCursor(advanced, "user-1", 5, 0)).toThrow("SHARE_CONFLICT")
  const revoked = revokeShare(advanced, "user-1", 1)
  store.put(revoked)
  expect(store.get(share.shareId)).toMatchObject({ status: "revoked", revision: 2 })
  expect(() => advanceShareCursor(revoked, "user-1", 6, 2)).toThrow("SHARE_REVOKED")
})

test("native sharing refuses unencrypted payloads, unsafe artifacts, and unauthorized mutation", () => {
  expect(() => createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "encrypted-invite", payload: { kind: "encrypted-transcript", encrypted: false }, now: 100 })).toThrow("SHARE_CRYPTO_REQUIRED")
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "local-export", now: 100 })
  expect(() => createContentFreeShareBundle(share, "digest", [{ id: "a", relativePath: "../secret", digest: "d", bytes: 1 }])).toThrow(ShareError)
  expect(() => revokeShare(share, "other-user", 0)).toThrow("SHARE_ACCESS_DENIED")
  expect(() => parseShareReference({ ...share, secret: "must not be accepted" })).toThrow("SHARE_INVALID")
})

test("shares saved at the same moment are all kept on disk, with no drafts left behind", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-share-store-"))
  try {
    const store = new FileShareStore({ root })
    const shares = Array.from({ length: 10 }, (_, index) => createShareReference({ taskId: `task-${String(index)}`, ownerId: "user-1", mode: "read-only-live", now: 100 }))
    await Promise.all(shares.map((share) => store.put(share)))
    expect((await new FileShareStore({ root }).list()).length).toBe(10)
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a share past its expiry is expired, whatever its stored status says", () => {
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "read-only-live", now: 100, expiresAt: 200 })
  expect(() => assertShareLive(share, 150)).not.toThrow()
  expect(() => assertShareLive(share, 200)).toThrow("not active")
  expect(() => advanceShareCursor(share, "user-1", 1, 0, 250)).toThrow("not active")
})

test("a grant lets in only its subject, only while neither it nor its share has expired or been revoked", () => {
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "read-only-live", now: 100, expiresAt: 1_000 })
  const grant = (id: string, extra: Record<string, unknown> = {}) => parseShareAccessGrant({ grantId: id, shareId: share.shareId, subjectId: "viewer", role: "viewer", createdAt: 100, revoked: false, ...extra })
  expect(requireShareGrant(share, [grant("g1")], "viewer", 150).grantId).toBe("g1")
  expect(() => requireShareGrant(share, [grant("g1")], "someone-else", 150)).toThrow("no live grant")
  expect(() => requireShareGrant(share, [grant("g2", { revoked: true })], "viewer", 150)).toThrow("no live grant")
  expect(() => requireShareGrant(share, [grant("g3", { expiresAt: 200 })], "viewer", 250)).toThrow("no live grant")
  expect(() => requireShareGrant(share, [grant("g1", { shareId: "other-share" })], "viewer", 150)).toThrow("no live grant")
  expect(() => requireShareGrant(share, [grant("g1")], "viewer", 1_000)).toThrow("not active")
  expect(() => grant("g4", { expiresAt: 100 })).toThrow("grant expiry is invalid")
})

test("a grant refused at the limit is not kept and lets no one in", () => {
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "read-only-live", now: 100 })
  const store = new InMemoryShareStore()
  store.put(share)
  for (let index = 0; index < 256; index += 1) store.putGrant({ grantId: `grant-${index}`, shareId: share.shareId, subjectId: `subject-${index}`, role: "viewer", createdAt: 100, revoked: false })
  expect(() => store.putGrant({ grantId: "grant-over", shareId: share.shareId, subjectId: "subject-over", role: "viewer", createdAt: 100, revoked: false })).toThrow("SHARE_LIMIT")
  expect(store.grants(share.shareId)).toHaveLength(256)
  expect(() => requireShareGrant(share, store.grants(share.shareId), "subject-over", 200)).toThrow("SHARE_ACCESS_DENIED")
  // Replacing a grant already there is still allowed at the limit.
  store.putGrant({ grantId: "grant-0", shareId: share.shareId, subjectId: "subject-0", role: "viewer", createdAt: 100, revoked: true })
  expect(store.grants(share.shareId).find((grant) => grant.grantId === "grant-0")?.revoked).toBe(true)
})
