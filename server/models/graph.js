// Graph model: maps between a `graphs` table row (snake_case columns) and
// the plain domain shape the rest of this server (and, eventually, an API
// layer) works with. A pure mapping module — no I/O, no SQL — kept
// separate from graphRepository.js so the *shape* of a graph and the
// *queries* that produce it can change independently.
//
// `params` here is exactly the shape src/anglePlot/graph.js's
// graphParamsFromSequence produces and graphHasher.js's hashGraph consumes
// — the same five fields, the same names — so a graph computed in the
// browser and a graph row in this table are never subtly different
// shapes of "the same thing."

// The metadata fields below (title/description/ownerName/maxBounces/
// graphColorHex/tags/favorite/visibility/notes/currentVersion/deletedAt)
// were added in the RDS Phase 1 migration (0008) to bring this table up to
// the metadata surface src/graphLibrary/browserGraphDatabaseStore.js
// already has locally — see that migration's own comment. Both mappers
// below include them: `undefined`-safe fallbacks (`?? ...`) so a row
// fetched before that migration ran (or a fake test row that only sets the
// original columns) still maps to a valid model instead of throwing or
// silently producing `undefined` fields.

/** @returns {{id, hash, params, algorithmVersion, ownerUserId, ownerName, title, description, maxBounces, graphColorHex, tags, favorite, visibility, notes, currentVersion, deletedAt, createdAt, updatedAt}} */
export const graphRowToModel = (row) => ({
  id: row.id,
  hash: row.hash,
  params: {
    sequenceText: row.sequence_text,
    angleA: row.angle_a,
    angleB: row.angle_b,
    angleStepInput: row.angle_step_input,
    baseLength: row.base_length,
  },
  algorithmVersion: row.algorithm_version,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name ?? null,
  title: row.title ?? '',
  description: row.description ?? '',
  maxBounces: row.max_bounces ?? null,
  graphColorHex: row.graph_color_hex ?? null,
  tags: row.tags ?? [],
  favorite: row.favorite ?? false,
  visibility: row.visibility ?? 'private',
  notes: row.notes ?? '',
  currentVersion: row.current_version ?? 1,
  deletedAt: row.deleted_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Maps a row from GraphRepository's queryGraphs (graphs LEFT JOIN
 * graph_geometry — see that method's own comment) into the metadata-only
 * shape the shared library's browse/search/recent endpoints return.
 * Deliberately excludes `points` (or any geometry at all) — browsing must
 * never ship full geometry (see this phase's own "never download geometry
 * while browsing"); only getGraphWithGeometry's own model shape does that,
 * for the one-graph-at-a-time download path.
 *
 * `hasExactGeometry`/`pointCount` reflect the LEFT JOIN: a graph row with
 * no matching graph_geometry row (shouldn't normally happen — see
 * uploadExactGraphIfMissing, which always writes both together) still
 * appears in listings, correctly reported as not having exact geometry
 * yet, rather than being silently dropped.
 *
 * @returns {{hash, params, algorithmVersion, ownerUserId, createdAt,
 *   updatedAt, pointCount, hasExactGeometry, geometryUpdatedAt,
 *   downloadCount, lastAccessedAt}}
 */
export const graphMetadataRowToModel = (row) => ({
  id: row.id,
  hash: row.hash,
  params: {
    sequenceText: row.sequence_text,
    angleA: row.angle_a,
    angleB: row.angle_b,
    angleStepInput: row.angle_step_input,
    baseLength: row.base_length,
  },
  algorithmVersion: row.algorithm_version,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name ?? null,
  title: row.title ?? '',
  description: row.description ?? '',
  maxBounces: row.max_bounces ?? null,
  graphColorHex: row.graph_color_hex ?? null,
  tags: row.tags ?? [],
  favorite: row.favorite ?? false,
  visibility: row.visibility ?? 'private',
  notes: row.notes ?? '',
  currentVersion: row.current_version ?? 1,
  deletedAt: row.deleted_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  pointCount: row.point_count ?? 0,
  hasExactGeometry: row.has_exact_geometry,
  geometryUpdatedAt: row.geometry_updated_at ?? null,
  downloadCount: row.download_count,
  lastAccessedAt: row.last_accessed_at,
  // Only present on ADMIN_METADATA_SELECT's own join (see graphRepository.js) —
  // undefined on every ordinary (non-admin) listing, so this mapper stays the
  // one shared shape for both rather than forking into a second model.
  ownerEmail: row.owner_email ?? null,
  ownerDisplayName: row.owner_display_name ?? null,
});

/**
 * Maps a `graph_versions` row (see migration 0009) into the domain shape
 * the Admin Dashboard's version history / restore views work with — a full
 * metadata+geometry snapshot, never a diff (mirrors graphRowToModel's own
 * "never recompute" principle for the live/current row).
 */
export const graphVersionRowToModel = (row) => ({
  id: row.id,
  graphId: row.graph_id,
  versionNumber: row.version_number,
  title: row.title,
  tags: row.tags,
  notes: row.notes,
  graphColorHex: row.graph_color_hex,
  visibility: row.visibility,
  favorite: row.favorite,
  points: row.points,
  pointCount: row.point_count,
  changeReason: row.change_reason,
  changedByUserId: row.changed_by_user_id,
  createdAt: row.created_at,
});
