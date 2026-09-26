export const SAMPLE_BASE = `{
  "app": "demo-service",
  "version": "1.2.0",
  "replicas": 2,
  "features": {
    "auth": true,
    "cache": false,
    "logging": { "level": "info", "format": "json" }
  },
  "tags": ["web", "api"],
  "database": { "host": "db.internal", "port": 5432, "pool": 10 },
  "deprecated": { "oldApi": true }
}`;

export const SAMPLE_OURS = `{
  "app": "demo-service",
  "version": "1.3.0",
  "replicas": 2,
  "features": {
    "auth": true,
    "cache": true,
    "logging": { "level": "debug", "format": "json" }
  },
  "tags": ["web", "api"],
  "database": { "host": "db.internal", "port": 5432, "pool": 20 },
  "owner": "team-a"
}`;

export const SAMPLE_THEIRS = `{
  "app": "demo-service",
  "version": "1.3.0",
  "replicas": 2,
  "features": {
    "auth": true,
    "cache": false,
    "logging": { "level": "warn", "format": "json" }
  },
  "tags": ["web", "api", "v2"],
  "database": { "host": "db.internal", "port": 5433, "pool": 50 },
  "deprecated": { "oldApi": false },
  "region": "cn-east"
}`;

// RFC 6902 补丁模式示例：应用到 SAMPLE_BASE 后分别得到 SAMPLE_OURS / SAMPLE_THEIRS
export const SAMPLE_OURS_PATCH = `[
  { "op": "test", "path": "/version", "value": "1.2.0" },
  { "op": "replace", "path": "/version", "value": "1.3.0" },
  { "op": "replace", "path": "/features/cache", "value": true },
  { "op": "replace", "path": "/features/logging/level", "value": "debug" },
  { "op": "replace", "path": "/database/pool", "value": 20 },
  { "op": "add", "path": "/owner", "value": "team-a" },
  { "op": "remove", "path": "/deprecated" }
]`;

export const SAMPLE_THEIRS_PATCH = `[
  { "op": "test", "path": "/app", "value": "demo-service" },
  { "op": "replace", "path": "/version", "value": "1.3.0" },
  { "op": "replace", "path": "/features/logging/level", "value": "warn" },
  { "op": "add", "path": "/tags/-", "value": "v2" },
  { "op": "replace", "path": "/database/port", "value": 5433 },
  { "op": "replace", "path": "/database/pool", "value": 50 },
  { "op": "replace", "path": "/deprecated/oldApi", "value": false },
  { "op": "add", "path": "/region", "value": "cn-east" }
]`;
