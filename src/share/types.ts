import { randomUUID } from "node:crypto"
import { NativeContractError, boundedNativeCapability, boundedNativeId, boundedNativeList, boundedNativeOptionalText, boundedNativeText, nativeInvalid, requireNativeInteger, requireNativeTimestamp } from "../native/errors.ts"

export type ShareMode = "local-export" | "encrypted-invite" | "read-only-live" | "collaborative" | "artifact-only"
export type ShareRole = "owner" | "editor" | "reviewer" | "viewer"
export type ShareStatus = "active" | "revoked" | "expired"
export type SharePayloadKind = "none" | "encrypted-transcript" | "encrypted-artifact"

export interface SharePayloadPolicy {
  readonly kind: SharePayloadKind
  readonly encrypted: boolean
  readonly retentionSeconds?: number
}

export interface ShareReference {
  readonly shareId: string
  readonly taskId: string
  readonly ownerId: string
  readonly mode: ShareMode
  readonly role: ShareRole
  readonly status: ShareStatus
  readonly createdAt: number
  readonly expiresAt?: number
  readonly payload: SharePayloadPolicy
  readonly eventCursor: number
  readonly revision: number
}

export interface ShareArtifactReference {
  readonly id: string
  readonly relativePath: string
  readonly digest: string
  readonly bytes: number
  readonly mediaType?: string
}

export interface ShareBundle {
  readonly contractVersion: 1
  readonly share: ShareReference
  readonly taskDigest: string
  readonly artifacts: readonly ShareArtifactReference[]
  readonly encryptedPayload?: {
    readonly algorithm: string
    readonly keyReference: string
    readonly digest: string
    readonly bytes: number
  }
}

export interface ShareAccessGrant {
  readonly grantId: string
  readonly shareId: string
  readonly subjectId: string
  readonly role: ShareRole
  readonly createdAt: number
  readonly expiresAt?: number
  readonly revoked: boolean
}

export interface ShareCommand {
  readonly commandId: string
  readonly shareId: string
  readonly actorId: string
  readonly action: "revoke" | "grant" | "cursor.advance"
  readonly idempotencyKey: string
  readonly requestedAt: number
  readonly expectedRevision: number
}

export interface ShareStore {
  get(shareId: string): Promise<ShareReference | undefined> | ShareReference | undefined
  put(share: ShareReference): Promise<void> | void
  list(taskId?: string): Promise<readonly ShareReference[]> | readonly ShareReference[]
  grants(shareId: string): Promise<readonly ShareAccessGrant[]> | readonly ShareAccessGrant[]
  putGrant(grant: ShareAccessGrant): Promise<void> | void
}

export class ShareError extends Error {
  constructor(readonly code: ShareErrorCode, reason: string) {
    super(`${code}: ${reason.slice(0, 512).replace(/[\r\n\0]/g, " ")}`)
    this.name = "ShareError"
  }
}

export type ShareErrorCode = "SHARE_INVALID" | "SHARE_LIMIT" | "SHARE_NOT_FOUND" | "SHARE_REVOKED" | "SHARE_EXPIRED" | "SHARE_ACCESS_DENIED" | "SHARE_CONFLICT" | "SHARE_CRYPTO_REQUIRED"

export class InMemoryShareStore implements ShareStore {
  private readonly shares = new Map<string, ShareReference>()
  private readonly grantMap = new Map<string, ShareAccessGrant[]>()
  private readonly maxShares: number

  constructor(options: { readonly maxShares?: number } = {}) {
    const maxShares = options.maxShares ?? 4_096
    if (!Number.isSafeInteger(maxShares) || maxShares < 1 || maxShares > 65_536) throw new ShareError("SHARE_LIMIT", "share limit is invalid")
    this.maxShares = maxShares
  }

  get(shareId: string): ShareReference | undefined {
    return this.shares.get(boundedNativeId(shareId, "share id", 256))
  }

  put(share: ShareReference): void {
    const parsed = parseShareReference(share)
    if (!this.shares.has(parsed.shareId) && this.shares.size >= this.maxShares) throw new ShareError("SHARE_LIMIT", "share store is full")
    this.shares.set(parsed.shareId, parsed)
  }

  list(taskId?: string): readonly ShareReference[] {
    const selected = taskId === undefined ? undefined : boundedNativeId(taskId, "task id")
    return Object.freeze([...this.shares.values()].filter((share) => selected === undefined || share.taskId === selected).sort((left, right) => right.createdAt - left.createdAt || left.shareId.localeCompare(right.shareId)))
  }

  grants(shareId: string): readonly ShareAccessGrant[] {
    return Object.freeze([...(this.grantMap.get(boundedNativeId(shareId, "share id", 256)) ?? [])])
  }

  putGrant(grant: ShareAccessGrant): void {
    const parsed = parseShareAccessGrant(grant)
    // A copy, published only once it passes: a refused grant must not stay behind and let its subject in.
    const list = [...(this.grantMap.get(parsed.shareId) ?? [])]
    const index = list.findIndex((item) => item.grantId === parsed.grantId)
    if (index >= 0) list[index] = parsed
    else list.push(parsed)
    if (list.length > 256) throw new ShareError("SHARE_LIMIT", "share has too many grants")
    this.grantMap.set(parsed.shareId, list)
  }
}

export function createShareReference(input: {
  readonly taskId: string
  readonly ownerId: string
  readonly mode: ShareMode
  readonly role?: ShareRole
  readonly payload?: SharePayloadPolicy
  readonly expiresAt?: number
  readonly now?: number
}): ShareReference {
  const now = input.now ?? Date.now()
  requireNativeTimestamp(now, "share timestamp")
  const expiresAt = input.expiresAt === undefined ? undefined : requireNativeTimestamp(input.expiresAt, "share expiry")
  if (expiresAt !== undefined && expiresAt <= now) throw new ShareError("SHARE_INVALID", "share expiry must be in the future")
  const payload = parseSharePayload(input.payload ?? { kind: "none", encrypted: false })
  return Object.freeze({
    shareId: `share-${randomUUID()}`,
    taskId: boundedNativeId(input.taskId, "task id"),
    ownerId: boundedNativeId(input.ownerId, "owner id", 256),
    mode: parseMode(input.mode),
    role: parseRole(input.role ?? "owner"),
    status: "active",
    createdAt: now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    payload,
    eventCursor: -1,
    revision: 0,
  })
}

/** A share past its expiry is expired whatever its stored status still says. */
export function assertShareLive(share: ShareReference, now = Date.now()): void {
  if (share.status === "revoked") throw new ShareError("SHARE_REVOKED", "share is not active")
  if (share.status === "expired" || (share.expiresAt !== undefined && share.expiresAt <= now)) throw new ShareError("SHARE_EXPIRED", "share is not active")
}

export function advanceShareCursor(share: ShareReference, actorId: string, nextCursor: number, expectedRevision: number, now = Date.now()): ShareReference {
  const parsed = parseShareReference(share)
  assertShareLive(parsed, now)
  if (boundedNativeId(actorId, "actor id", 256) !== parsed.ownerId) throw new ShareError("SHARE_ACCESS_DENIED", "only the share owner may advance its cursor")
  if (expectedRevision !== parsed.revision) throw new ShareError("SHARE_CONFLICT", "share revision is stale")
  if (!Number.isSafeInteger(nextCursor) || nextCursor < parsed.eventCursor) throw new ShareError("SHARE_INVALID", "share cursor is invalid")
  return Object.freeze({ ...parsed, eventCursor: nextCursor, revision: parsed.revision + 1 })
}

export function revokeShare(share: ShareReference, actorId: string, expectedRevision: number): ShareReference {
  const parsed = parseShareReference(share)
  if (boundedNativeId(actorId, "actor id", 256) !== parsed.ownerId) throw new ShareError("SHARE_ACCESS_DENIED", "only the share owner may revoke")
  if (expectedRevision !== parsed.revision) throw new ShareError("SHARE_CONFLICT", "share revision is stale")
  if (parsed.status === "revoked") return parsed
  return Object.freeze({ ...parsed, status: "revoked", revision: parsed.revision + 1 })
}

export function createContentFreeShareBundle(share: ShareReference, taskDigest: string, artifacts: readonly ShareArtifactReference[] = []): ShareBundle {
  const parsedShare = parseShareReference(share)
  if (parsedShare.payload.kind !== "none") throw new ShareError("SHARE_CRYPTO_REQUIRED", "payload-bearing shares require encrypted payload metadata")
  const digest = boundedNativeText(taskDigest, "task digest", 128)
  const parsedArtifacts = artifacts.map(parseShareArtifact)
  if (parsedArtifacts.length > 128) throw new ShareError("SHARE_LIMIT", "share has too many artifacts")
  return Object.freeze({ contractVersion: 1, share: parsedShare, taskDigest: digest, artifacts: Object.freeze(parsedArtifacts) })
}

export function parseShareReference(value: unknown): ShareReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ShareError("SHARE_INVALID", "share reference is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["shareId", "taskId", "ownerId", "mode", "role", "status", "createdAt", "expiresAt", "payload", "eventCursor", "revision"])
  const shareId = boundedNativeId(record.shareId, "share id", 256)
  const taskId = boundedNativeId(record.taskId, "task id")
  const ownerId = boundedNativeId(record.ownerId, "owner id", 256)
  const mode = parseMode(record.mode)
  const role = parseRole(record.role)
  const status = parseStatus(record.status)
  const createdAt = requireNativeTimestamp(record.createdAt, "share createdAt")
  const expiresAt = record.expiresAt === undefined ? undefined : requireNativeTimestamp(record.expiresAt, "share expiry")
  if (expiresAt !== undefined && expiresAt <= createdAt) throw new ShareError("SHARE_INVALID", "share expiry is invalid")
  const payload = parseSharePayload(record.payload)
  if (!Number.isSafeInteger(record.eventCursor) || (record.eventCursor as number) < -1) throw new ShareError("SHARE_INVALID", "share cursor is invalid")
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) throw new ShareError("SHARE_INVALID", "share revision is invalid")
  return Object.freeze({ shareId, taskId, ownerId, mode, role, status, createdAt, ...(expiresAt === undefined ? {} : { expiresAt }), payload, eventCursor: record.eventCursor as number, revision: record.revision as number })
}

export function parseShareAccessGrant(value: unknown): ShareAccessGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ShareError("SHARE_INVALID", "share grant is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["grantId", "shareId", "subjectId", "role", "createdAt", "expiresAt", "revoked"])
  const grantId = boundedNativeId(record.grantId, "grant id", 256)
  const shareId = boundedNativeId(record.shareId, "share id", 256)
  const subjectId = boundedNativeId(record.subjectId, "subject id", 256)
  const role = parseRole(record.role)
  const createdAt = requireNativeTimestamp(record.createdAt, "grant createdAt")
  const expiresAt = record.expiresAt === undefined ? undefined : requireNativeTimestamp(record.expiresAt, "grant expiry")
  if (expiresAt !== undefined && expiresAt <= createdAt) throw new ShareError("SHARE_INVALID", "grant expiry is invalid")
  const revoked = record.revoked
  if (typeof revoked !== "boolean") throw new ShareError("SHARE_INVALID", "grant revoked flag is invalid")
  return Object.freeze({ grantId, shareId, subjectId, role, createdAt, ...(expiresAt === undefined ? {} : { expiresAt }), revoked })
}

/**
 * The grant that lets `subjectId` into a live share now, or SHARE_ACCESS_DENIED. A revoked or
 * expired grant, or one for another share, lets no one in.
 */
export function requireShareGrant(share: ShareReference, grants: readonly ShareAccessGrant[], subjectId: string, now = Date.now()): ShareAccessGrant {
  const parsed = parseShareReference(share)
  assertShareLive(parsed, now)
  const subject = boundedNativeId(subjectId, "subject id", 256)
  const grant = grants.map(parseShareAccessGrant).find((item) => item.shareId === parsed.shareId && item.subjectId === subject && !item.revoked && (item.expiresAt === undefined || item.expiresAt > now))
  if (grant === undefined) throw new ShareError("SHARE_ACCESS_DENIED", "no live grant for this subject")
  return grant
}

export function parseShareArtifact(value: unknown): ShareArtifactReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ShareError("SHARE_INVALID", "share artifact is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["id", "relativePath", "digest", "bytes", "mediaType"])
  const id = boundedNativeId(record.id, "artifact id", 256)
  const relativePath = boundedNativeText(record.relativePath, "artifact path", 512)
  if (relativePath.startsWith("/") || relativePath.split("/").some((part) => part === ".." || part.length === 0)) throw new ShareError("SHARE_INVALID", "artifact path is unsafe")
  const digest = boundedNativeText(record.digest, "artifact digest", 128)
  const bytes = requireNativeInteger(record.bytes, "artifact bytes", 0, 64 * 1024 * 1024)
  const mediaType = boundedNativeOptionalText(record.mediaType, "artifact media type", 128)
  return Object.freeze({ id, relativePath, digest, bytes, ...(mediaType === undefined ? {} : { mediaType }) })
}

function parseSharePayload(value: unknown): SharePayloadPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ShareError("SHARE_INVALID", "share payload policy is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["kind", "encrypted", "retentionSeconds"])
  if (record.kind !== "none" && record.kind !== "encrypted-transcript" && record.kind !== "encrypted-artifact") throw new ShareError("SHARE_INVALID", "share payload kind is invalid")
  if (typeof record.encrypted !== "boolean") throw new ShareError("SHARE_INVALID", "share encryption flag is invalid")
  if (record.kind !== "none" && record.encrypted !== true) throw new ShareError("SHARE_CRYPTO_REQUIRED", "payload-bearing shares must be encrypted")
  const retentionSeconds = record.retentionSeconds === undefined ? undefined : requireNativeInteger(record.retentionSeconds, "retentionSeconds", 1, 31_536_000)
  return Object.freeze({ kind: record.kind, encrypted: record.encrypted, ...(retentionSeconds === undefined ? {} : { retentionSeconds }) })
}

function parseMode(value: unknown): ShareMode {
  if (value === "local-export" || value === "encrypted-invite" || value === "read-only-live" || value === "collaborative" || value === "artifact-only") return value
  throw new ShareError("SHARE_INVALID", "share mode is invalid")
}

function parseRole(value: unknown): ShareRole {
  if (value === "owner" || value === "editor" || value === "reviewer" || value === "viewer") return value
  throw new ShareError("SHARE_INVALID", "share role is invalid")
}

function parseStatus(value: unknown): ShareStatus {
  if (value === "active" || value === "revoked" || value === "expired") return value
  throw new ShareError("SHARE_INVALID", "share status is invalid")
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new ShareError("SHARE_INVALID", "share value contains unknown fields")
}
