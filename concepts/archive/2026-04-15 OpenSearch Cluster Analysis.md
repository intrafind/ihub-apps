# OpenSearch Cluster Analysis Report

**Date:** 2026-04-15
**Cluster:** docker-cluster (`if-searchengine-0`)
**Symptom:** Query timeouts exceeding 30 seconds

---

## Executive Summary

The single-node OpenSearch cluster suffers from query latency spikes (up to 28.5s recorded) caused by two primary issues:

1. **The main `index` (236GB) sits in a single shard with 74 segments** — every query scans all 74 segment files, and k-NN vector graphs are fragmented across each segment.
2. **`index-jobstore` has 32% deleted document bloat** — heavy update/delete churn causes expensive merges that starve concurrent queries of I/O.

Both issues are fixable without data loss. Force merging provides immediate relief; reindexing with proper shard counts is the long-term solution.

---

## Cluster Overview

| Metric | Value | Assessment |
|--------|-------|------------|
| Nodes | 1 (single-node, Docker) | No high availability |
| Roles | cluster_manager, data, ingest, ml | All roles on one node |
| JVM Heap | 2.9 / 4.0 GB (71%) | Tight for 236GB of data |
| Disk | 236 / 491 GB used (48%) | Healthy |
| CPU | 9% at time of check | Normal |
| Circuit breakers | None tripped | OK |
| Hot threads | Idle at time of check | No active pressure |
| Indices | 26 total, 26 primary shards | All green |
| Total documents | 20,479,543 | |

### Disk Watermarks

| Threshold | Setting | Current Usage |
|-----------|---------|---------------|
| Low | 85% | 48% (OK) |
| High | 90% | 48% (OK) |
| Flood stage | 95% | 48% (OK) |

### Thread Pools

| Pool | Size | Queue Size | Rejected |
|------|------|------------|----------|
| search | 61 | 1,000 | 0 |
| write | — | 10,000 | 0 |

No thread pool rejections observed.

---

## Index Analysis

### Main Index: `index`

This is the dominant index, holding 99.6% of cluster data.

| Metric | Value | Recommended | Status |
|--------|-------|-------------|--------|
| Size | 236 GB | 10-50 GB per shard | CRITICAL |
| Documents | 20,325,208 live | | |
| Deleted documents | 606,320 (3% overall, up to 31% per segment) | < 10% | WARNING |
| Shards | 1 primary, 0 replicas | 5-10 shards | CRITICAL |
| Segments | 74 | < 10 per shard | CRITICAL |
| k-NN enabled | Yes (384-dim HNSW, Lucene) | | |
| Refresh interval | 10s | | OK |
| Mapped fields | 268 (137 top-level) | | OK |
| Text fields | 204 (28 without keyword sub-field) | | NOTE |
| Custom analyzers | 3 | | |

#### Search Performance

| Metric | Value |
|--------|-------|
| Total queries | 75,230 |
| Total query time | 7,824s |
| Average query latency | 104.0 ms |
| Failed queries | 18 |
| Fetch latency (avg) | 0.5 ms |

#### Query Cache Efficiency

| Metric | Value | Assessment |
|--------|-------|------------|
| Hit count | 16,719,167 | |
| Miss count | 91,486,454 | |
| **Hit rate** | **15.5%** | CRITICAL (should be > 50%) |
| Evictions | 7,086 | Cache too small or queries too varied |

#### Fielddata

| Field | Size | Note |
|-------|------|------|
| `_id` | 72 MB | Sorting/aggregation on `_id` is inefficient |
| All others | 0 MB | |

#### Segment Analysis (Top 10 by Size)

| Segment | Size | Live Docs | Deleted Docs | Delete % |
|---------|------|-----------|--------------|----------|
| `_n2t` | 6.49 GB | 290,264 | 21,586 | 7% |
| `_mic` | 6.25 GB | 272,226 | 54,415 | 17% |
| `_lr1` | 6.12 GB | 269,840 | 12,526 | 4% |
| `_mve` | 6.04 GB | 298,336 | 72,742 | 20% |
| `_mau` | 5.39 GB | 252,749 | 30,969 | 11% |
| `_pgp` | 5.36 GB | 260,145 | 13,024 | 5% |
| `_qyu` | 5.29 GB | 294,604 | 28,067 | 9% |
| `_rrz` | 5.14 GB | 263,539 | 12,506 | 5% |
| `_qe7` | 5.12 GB | 285,819 | 32,110 | 10% |
| `_o4l` | 5.07 GB | 267,793 | 14,816 | 5% |

*Plus 64 additional segments (4.7-4.9 GB each).*

#### Merge Statistics

| Metric | Value |
|--------|-------|
| Total merges | 70 |
| Total merge time | 633s |
| Throttle time | 254s |
| Current merges | 0 |

Merge throttling (254s) indicates I/O contention during merge operations.

#### k-NN Vector Field

| Property | Value |
|----------|-------|
| Field | `passages.vector` |
| Dimensions | 384 |
| Engine | Lucene HNSW |
| Space type | cosinesimil |
| k-NN requests | 65 (25 with filter) |
| Graph memory usage | 0% (graphs loaded on demand) |

With 74 segments, each segment maintains its own HNSW graph. Vector search must query all 74 graphs and merge results, multiplying latency.

---

### Job Store Index: `index-jobstore`

| Metric | Value | Recommended | Status |
|--------|-------|-------------|--------|
| Size | ~462 MB | | OK |
| Live documents | 112,655 | | |
| Deleted documents | 106,385 (32.1% bloat) | < 10% | CRITICAL |
| Segments | 19 | | WARNING |
| Shards | 1 primary, 0 replicas | | |
| k-NN enabled | Yes | Not needed | WARNING |
| Mapped fields | 68 | | OK |
| Failed indexing ops | 659,630 | | CRITICAL |

#### Search Performance

| Metric | Value |
|--------|-------|
| Total queries | 401,894 |
| Average query latency | 0.7 ms |
| Peak recorded latency | 28,548 ms |

#### Segment Bloat Detail

| Segment | Size | Live Docs | Deleted Docs | Delete % |
|---------|------|-----------|--------------|----------|
| `_aald` | 256.9 MB | 106,948 | 13,686 | 11% |
| `_a99g` | 92.8 MB | 95,943 | 16,713 | 15% |
| `_aazx` | 69.4 MB | 3,803 | 27,504 | **88%** |
| `_aadc` | 34.0 MB | 15,964 | 37,191 | **70%** |
| `_ab4t` | 8.0 MB | 1,765 | 8,534 | **83%** |
| `_aaee` | 1.1 MB | 515 | 1,407 | **73%** |
| `_ab59` | 0.3 MB | 0 | 41 | **100%** |
| `_ab5a` | 0.2 MB | 0 | 39 | **100%** |

Multiple segments contain 70-100% deleted documents. These waste I/O on every query and trigger expensive background merges.

#### Slowest Recorded Queries (from top_queries)

All three slowest queries hit `index-jobstore` at the same timestamp, suggesting a burst during merge activity:

| Latency | Query Pattern |
|---------|--------------|
| 28,548 ms | `type.keyword:counter-compact` |
| 28,548 ms | `type.keyword:com.intrafind.indexer.m365.onedrive.task.TaskDriveChildren` with context filter |
| 28,547 ms | `type.keyword:com.intrafind.indexer.m365.teams.task.TaskTeamsChannel` with context filter |

---

## Query Latency Distribution (All Recorded Queries)

| Range | Count | Percentage |
|-------|-------|------------|
| 0-100 ms | 39,140 | 98.81% |
| 100-500 ms | 299 | 0.75% |
| 500 ms - 1s | 65 | 0.16% |
| 1-5s | 69 | 0.17% |
| 5-10s | 30 | 0.08% |
| 10-30s | 7 | 0.02% |
| 30s+ | 0 | 0% |

**Percentiles:**

| Percentile | Latency |
|------------|---------|
| p50 | 3 ms |
| p75 | 6 ms |
| p90 | 13 ms |
| p95 | 27 ms |
| p99 | 789 ms |
| Max | 28,548 ms |

The p99 of 789ms with a max of 28.5s indicates severe tail latency caused by I/O contention during merge operations.

---

## Root Cause Summary

### Why Queries Hit 30s

```
Single 236GB shard (index)
  -> 74 segments per shard
    -> Every query scans 74 files
    -> k-NN searches 74 separate HNSW graphs
    -> Query cache thrashes (15% hit rate)

Heavy update churn (index-jobstore)
  -> 32% deleted doc bloat
    -> Frequent background merges
    -> Merges consume I/O bandwidth
    -> Concurrent queries starved of I/O
    -> Latency spikes to 28.5s

4GB JVM heap for 236GB data
  -> Limited query cache capacity
  -> Limited fielddata budget
  -> GC pressure under load
```

---

## Recommendations

### Immediate Actions (No Downtime)

#### 1. Force Merge `index-jobstore`

**Impact:** Eliminates 32% dead doc overhead, stops latency spikes.
**Risk:** Low. Brief I/O spike during merge.
**Duration:** Minutes.

```bash
curl -X POST "http://localhost:9200/index-jobstore/_forcemerge?max_num_segments=1"
```

#### 2. Force Merge `index`

**Impact:** Reduces segments from 74 to 5. Cuts average query latency 5-10x. Consolidates k-NN graphs.
**Risk:** Low, but I/O intensive.
**Duration:** Hours (236GB of data to rewrite).

```bash
# Monitor with: curl -s "http://localhost:9200/_cat/tasks?v&detailed"
curl -X POST "http://localhost:9200/index/_forcemerge?max_num_segments=5"
```

#### 3. Disable k-NN on `index-jobstore`

**Impact:** Removes unnecessary vector search overhead from a job scheduling index.
**Risk:** None if no k-NN queries target this index.

```bash
curl -X PUT "http://localhost:9200/index-jobstore/_settings" -H 'Content-Type: application/json' -d '{
  "index.knn": false
}'
```

### Short-Term Actions (Brief Restart)

#### 4. Increase JVM Heap to 8-16 GB

**Impact:** More room for query cache, fielddata, and GC headroom.
**Rule:** Never exceed 50% of system RAM or 32GB (compressed oops limit).

```yaml
# Docker / Kubernetes environment variable
OPENSEARCH_JAVA_OPTS: "-Xms8g -Xmx8g"
```

### Medium-Term Actions (Planned Maintenance)

#### 5. Split `index` to 5 Shards (Preserves Mappings, Settings, Analyzers)

**Impact:** Enables shard-level parallelism. Each shard becomes ~47GB.
**Approach:** Use the `_split` API (faster than reindex, preserves everything automatically) followed by `_clone` to reclaim the original index name.

##### Disk Budget

| Step | Indices on Disk | Disk Used | Available | % Used | Status |
|------|----------------|-----------|-----------|--------|--------|
| Start | `index` (236GB) | 236 GB | 254 GB | 48% | OK |
| After split | `index` + `index-v2` | **~472 GB** | ~19 GB | **96%** | EXCEEDS flood_stage (95%) |
| After delete `index` | `index-v2` (236GB) | 236 GB | 254 GB | 48% | OK |
| After clone | `index-v2` + `index` | ~236 GB | ~254 GB | 48% | OK (`_clone` uses hard-links) |
| After delete `index-v2` | `index` (236GB) | 236 GB | 254 GB | 48% | OK |

**Peak disk at step 2 is ~472GB (96%), exceeding the flood_stage watermark (95%).** To proceed safely, the flood_stage must be temporarily raised, or free space must be reclaimed first.

##### Pre-Requisites (Choose One or Combine)

**Option A:** Temporarily raise the flood stage watermark:

```bash
curl -X PUT "http://localhost:9200/_cluster/settings" -H 'Content-Type: application/json' -d '{
  "persistent": {
    "cluster.routing.allocation.disk.watermark.flood_stage": "97%"
  }
}'
```

**Option B:** Force merge `index` first to reclaim ~7GB from 606K deleted docs, bringing peak to ~94.7%:

```bash
curl -X POST "http://localhost:9200/index/_forcemerge?max_num_segments=5"
# Wait for completion (hours), then proceed with split
```

**Option C:** Combine both for maximum safety margin.

##### Procedure

```bash
# 0. Backup settings + mapping (safety net)
curl -s "http://localhost:9200/index/_settings?pretty" > index-settings-backup.json
curl -s "http://localhost:9200/index/_mapping?pretty" > index-mapping-backup.json

# 1. Block writes on source index
curl -X PUT "http://localhost:9200/index/_settings" -H 'Content-Type: application/json' -d '{
  "index.blocks.write": true
}'

# 2. Split into 5 shards (preserves all mappings, settings, analyzers)
curl -X POST "http://localhost:9200/index/_split/index-v2" -H 'Content-Type: application/json' -d '{
  "settings": {
    "index.number_of_shards": 5,
    "index.blocks.write": true
  }
}'

# 3. Wait for green and verify doc count matches
curl -s "http://localhost:9200/_cluster/health/index-v2?wait_for_status=green&timeout=30m"
curl -s "http://localhost:9200/_cat/indices/index,index-v2?v&h=index,health,docs.count,store.size"
# STOP if doc counts don't match!

# 4. Delete the original index (frees 236GB, name becomes available)
curl -X DELETE "http://localhost:9200/index"

# 5. Clone index-v2 back to original name (hard-links, near-instant, ~0 extra disk)
curl -X POST "http://localhost:9200/index-v2/_clone/index" -H 'Content-Type: application/json' -d '{
  "settings": {
    "index.blocks.write": true
  }
}'

# 6. Wait for green and verify doc count
curl -s "http://localhost:9200/_cluster/health/index?wait_for_status=green&timeout=30m"
curl -s "http://localhost:9200/_cat/indices/index,index-v2?v&h=index,health,docs.count,store.size"
# STOP if doc counts don't match!

# 7. Delete the temporary index
curl -X DELETE "http://localhost:9200/index-v2"

# 8. Remove write block
curl -X PUT "http://localhost:9200/index/_settings" -H 'Content-Type: application/json' -d '{
  "index.blocks.write": false
}'

# 9. Reset flood stage watermark (if raised in pre-requisites)
curl -X PUT "http://localhost:9200/_cluster/settings" -H 'Content-Type: application/json' -d '{
  "persistent": {
    "cluster.routing.allocation.disk.watermark.flood_stage": null
  }
}'

# 10. Verify final state
curl -s "http://localhost:9200/_cat/indices/index?v"
curl -s "http://localhost:9200/_cat/shards/index?v"
```

##### Why `_split` + `_clone` Instead of `_reindex`

| | `_split` + `_clone` | `_reindex` |
|---|---|---|
| **Preserves mappings** | Automatic | Must copy manually |
| **Preserves settings** | Automatic | Must copy manually |
| **Preserves analyzers** | Automatic | Must copy manually |
| **Speed** | Fast (hard-links segments) | Slow (re-indexes every doc) |
| **Risk of data loss** | Low (atomic operations) | Medium (mapping mismatch possible) |
| **Disk overhead** | Same peak (~236GB extra) | Same peak (~236GB extra) |

#### 6. Investigate Fielddata on `_id`

Find and fix queries that sort or aggregate on `_id`. Use `_doc` sort for scroll queries or `keyword` fields for aggregations.

#### 7. Investigate 659K Failed Indexing Operations

The `index-jobstore` has 659,630 failed indexing operations. Check application logs for mapping conflicts, version conflicts, or bulk rejections.

#### 8. Clean Up Stale `top_queries` Indices

Eight `top_queries-*` indices from January 2026 consume resources. Delete or set up ISM:

```bash
curl -X DELETE "http://localhost:9200/top_queries-2026.01.*"
```

### Long-Term Considerations

#### 9. Add a Second Node

A single-node cluster has no redundancy. Adding a second data node enables:
- Replica shards (fault tolerance)
- Search parallelism across nodes
- Better resource isolation (queries vs. merges)

#### 10. Implement Index Lifecycle Management (ISM)

Set up ISM policies to:
- Automatically force merge indices after bulk indexing completes
- Roll over large indices based on size thresholds
- Delete or archive old `top_queries` indices

---

## Priority Matrix

| # | Action | Effort | Impact | Downtime | Priority |
|---|--------|--------|--------|----------|----------|
| 1 | Force merge `index-jobstore` | 5 min | High | None | **P0** |
| 2 | Force merge `index` | Hours (I/O) | High | None | **P0** |
| 3 | Disable k-NN on jobstore | 1 min | Low-Med | None | **P1** |
| 4 | Increase heap to 8GB | Config change | Medium | Restart | **P1** |
| 5 | Split to 5 shards (_split + _clone) | Hours + ~236GB peak disk | Very High | Write-block | **P2** |
| 6 | Fix `_id` fielddata queries | Investigation | Low-Med | None | **P2** |
| 7 | Investigate failed indexing | Investigation | Medium | None | **P2** |
| 8 | Clean up top_queries | 1 min | Low | None | **P3** |
| 9 | Add second node | Infrastructure | High | Planned | **P3** |
| 10 | Implement ISM | Configuration | Medium | None | **P3** |
