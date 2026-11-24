# Belgian Food Scanner: cloud evolution roadmap

Goal: evolve the local-first PWA into a multi-user, publicly reachable app on Oracle Cloud Always Free, as a vehicle for learning Docker, Linux, PostgreSQL, CI/CD, observability and Kubernetes. One developer, low traffic for the first year.

The Oracle limits quoted here (A1 up to 4 OCPU / 24 GB, 200 GB block storage, ~10 TB egress) are from memory; verify them on Oracle's Always Free page before committing.

## 1. Product evolution

The scanning feature is done. The product risk is whether a household keeps its stock accurate for weeks. The existing append-only event log (commuting +1/−1 stock events, last-writer-wins names, idempotent ids) is already the right shape for a server, so the server is a **sync hub**, not a rewrite.

| Version | Theme | Adds | Stays local | Server-backed |
|---|---|---|---|---|
| v1 | Accounts + sync hub | Register/login, one household per user, server event log, server-side OFF cache, import of the existing GitHub events, export/delete | Camera, ZXing decode, IndexedDB events + outbox, all reads | Identity, event hub, catalogue cache, backups |
| v2 | Households that work | Invite codes, multiple members, expiry date per scan-in ("use soon"), "used up" → shopping list, low-stock threshold, menu prompt from server inventory | Same | Membership, invites, balances projection |
| v3 | Smarter catalogue | Item aliases (same product, different store EANs), Web Push for expiring items, optional LLM menu call with the user's own key | Alias resolution in client reducer | Alias table, push subscriptions |

Users and households:
- A user belongs to 1..n households. A household has one inventory and one override set.
- Roles: `owner`, `member`. No finer RBAC.
- Overrides are per household, not global (no moderation, no leaks). Non-barcode items stay `x:<slug>`, so existing events import 1:1.

Not built: global crowdsourced names, receipt OCR, nutrition scoring, recipes engine, social features, native apps, server-side barcode decoding (the server only sees EAN strings).

## 2. Architecture

Principles: same origin for PWA and API (no CORS, cookie sessions); local-first stays; one VM and one DB until a number forces otherwise.

Initial (v1, one A1 VM):

```
 iPhone PWA (IndexedDB: events, outbox, products; ZXing on device)
        │ HTTPS, cookie session
        ▼
 Cloudflare DNS (proxied)  ── domain ~€10/yr (the only unavoidable cost)
        │ 443 only from Cloudflare ranges
        ▼
 ┌────────────── OCI A1 VM (Ubuntu 24.04 arm64, Frankfurt) ─────────────┐
 │  Docker Compose                                                       │
 │   caddy :443 ──┬── / ........ static PWA (read-only volume)           │
 │                └── /api/* ──► api (FastAPI, 2 uvicorn workers)         │
 │                                  │            │                       │
 │                                  ▼            ▼                       │
 │                            postgres:16     Open Food Facts (server-   │
 │                            /srv/pgdata      side, cached, 1 req/s)    │
 │   backup (cron): pg_dump ► age ► restic ► OCI Object Storage + Pi     │
 └──────────────────────────────────────────────────────────────────────┘
 SSH closed to the internet (Tailscale only). Uptime ping: Healthchecks.io
```

Future (after observability and k3s):

```
 PWA ─► Cloudflare ─► OCI NLB / reserved IP ─► Traefik Ingress (cert-manager)
        ┌──── k3s cluster (2 A1 nodes: server + agent) ───────────────┐
        │ ns app:    Deployment api (2 replicas, HPA), Service, web     │
        │            CronJob backup / off-refresh, Job migrate          │
        │ ns data:   CloudNativePG Cluster (1 primary, PVC)             │
        │ ns obs:    Prometheus, Grafana, Loki, Alloy, (Tempo)          │
        │ ns gitops: ArgoCD                                             │
        └───────────────────────────────────────────────────────────────┘
 GitHub: app repo ─CI(test, scan, build arm64+amd64, push GHCR)─► deploy repo
 (Helm values) ◄─ ArgoCD pulls.  Pi: staging node + off-site backups.
```

## 3. Technology choices

| Choice | Why | Trade-offs | Alternatives |
|---|---|---|---|
| FastAPI (Python 3.12, uv, SQLAlchemy 2, Alembic, Pydantic v2) | Already using uv; OpenAPI contract for free; async suits the OFF proxy | ~30 lines of reducer logic duplicated vs JS; mitigate with shared JSON test vectors | Node/Fastify/TS (can share lib.js), Go |
| PostgreSQL 16 | Learning goal: RLS, jsonb, pg_trgm, operators | SQLite + Litestream is the pragmatic answer at this traffic; Postgres costs ~400 MB and care | SQLite, MariaDB |
| Docker | Standard; k3s runs the same OCI images | Root daemon; use non-root containers, never expose the socket | Podman |
| Caddy first, Traefik at k3s | Caddy: automatic TLS in a few lines. k3s bundles Traefik, so learn it as the ingress then | The swap is a deliberate lesson | NGINX; Traefik from day one |
| Cloudflare DNS + proxy | Free WAF/DDoS, hides origin | Cloudflare terminates TLS | Tunnel (unnecessary on Oracle; use for the home Pi), direct only |
| Cookie sessions in Postgres, argon2id | Same-origin: no token in JS, easy revocation | CSRF care: custom header + JSON content type + SameSite=Lax | JWT, OIDC (add when strangers arrive), passkeys (stretch) |
| Invite-only registration | No email or abuse handling at v1; password reset by admin CLI | Add SMTP (Brevo/Resend free tier) in v2 | Open signup |
| Prometheus + Grafana + Loki + Alloy; OTel SDK; Tempo later | Standard stack; same Helm charts in k3s | ~1 GB RAM and upkeep | Grafana Cloud free tier, Netdata, SigNoz |
| OpenTofu/Terraform for OCI | Rebuild from nothing | State handling | Pulumi, console (first VM only) |
| GitHub Actions | Free on public repos, ARM runners | Public-repo limits | GitLab CI |
| SOPS + age | Encrypted secrets in git, no server | Key management | Sealed Secrets, OCI Vault, Docker secrets |
| pg_dump + age + restic | Simple and restorable; a tested restore matters most | Logical dumps only | pgBackRest / WAL for PITR later |

## 4. Oracle Always Free design

Realities:
- **Capacity:** A1 often fails with "Out of host capacity"; retry with a script. Region can't be changed later.
- **Idle reclaim:** very low utilisation can get an Always Free instance reclaimed. Upgrading to Pay As You Go while staying inside free limits is widely reported to help at €0. Set a €1 budget alert.
- **Account risk:** Oracle can terminate accounts. Keep backups off Oracle (Pi, Backblaze B2).
- **Region:** Frankfurt or Amsterdam.

Sizing:
- Node 1 (prod): A1.Flex 2 OCPU / 12 GB, Ubuntu 24.04 arm64.
- Node 2 (later k3s agent): remaining 2 OCPU / 12 GB.
- 2 × AMD micro (1 GB): external uptime prober or bastion; too small for k3s.

Storage: boot volume 50–100 GB; separate 50 GB block volume at `/srv/data` for pgdata and local backups (survives VM rebuilds); the rest unallocated.

Networking: VCN with a public subnet and reserved IP; security list 80/443 only; SSH over Tailscale. Oracle Ubuntu images ship restrictive iptables rules; manage the host firewall deliberately (ufw/nftables). Optionally restrict 443 to Cloudflare ranges.

Backups: nightly `pg_dump -Fc` → age → restic → OCI Object Storage (free 20 GB) + Pi/B2. Retention 7 daily / 4 weekly / 6 monthly. Monthly scripted restore into a scratch container with row-count checks.

Security baseline: SSH keys only, unattended-upgrades, non-root read-only containers, Postgres on the Docker network only, Trivy in CI, Dependabot, CSP and security headers in Caddy, rate limits on auth.

Memory budget (Compose stage, 12 GB VM):

| Component | MB |
|---|---|
| OS + Docker | ~600 |
| Postgres (shared_buffers 256) | ~400 |
| FastAPI, 2 workers | ~200 |
| Caddy | ~30 |
| Prometheus | ~300 |
| Grafana | ~200 |
| Loki | ~300 |
| Alloy | ~150 |
| Exporters | ~150 |
| **Total** | **~2.3 GB** |

k3s later adds ~0.6–0.8 GB (control plane) plus ArgoCD ~0.5–1 GB.

## 5. Database design (PostgreSQL)

Rules: every tenant table has `household_id`; the event log is append-only and the system of record; balances are a projection; event ids are client-generated UUIDs (idempotent retries); `item_key` (EAN or `x:slug`) is kept from the current model.

```sql
users(id uuid pk, email citext unique not null, password_hash text not null,
      display_name text, email_verified_at timestamptz, disabled_at timestamptz,
      created_at timestamptz default now())
sessions(id uuid pk, user_id fk, token_hash bytea unique, device_label text,
         created_at, last_seen_at, expires_at)
households(id uuid pk, name text, created_by fk users, created_at)
household_members(household_id fk, user_id fk, role text check (role in ('owner','member')),
                  joined_at, primary key (household_id, user_id))
household_invites(id uuid pk, household_id fk, code_hash bytea unique, expires_at,
                  max_uses int default 1, used_count int default 0, created_by fk)

products(ean text primary key check (ean ~ '^[0-9]{8}$|^[0-9]{13}$'),   -- shared catalogue cache
         name, brand, quantity, category, image_url,
         off_status text check (off_status in ('found','missing','error')),
         off_fetched_at timestamptz, completeness real, off_payload jsonb)

product_overrides(household_id fk, item_key text, name text, category text,
                  updated_by fk, updated_at, primary key (household_id, item_key))
inventory_events(id uuid primary key, household_id fk not null, seq bigserial,
                 item_key text not null, type text check (type in ('stock','name')),
                 delta int, reason text,        -- scan_in, scan_out, manual, correction
                 name text, category text, expires_on date,
                 user_id fk, device_id uuid, client_ts timestamptz,
                 server_ts timestamptz default now())
inventory_balances(household_id fk, item_key text, count int, updated_at,
                   primary key (household_id, item_key))   -- updated in the same tx as the event
devices(id uuid pk, user_id fk, label, last_seen_at, last_cursor bigint)
scans(id bigserial, user_id fk, household_id fk, ean, result, scanned_at, device_id)  -- optional, 90-day retention
item_aliases(household_id fk, item_key, canonical_key, primary key (household_id, item_key))   -- v3
push_subscriptions(id, user_id fk, endpoint, keys jsonb)                                         -- v3
audit_log(id bigserial, at timestamptz default now(), user_id, household_id, action text, meta jsonb)
```

Indexes: `inventory_events (household_id, seq)` for cursor pulls; `(household_id, item_key)`; unique `(household_id, id)`; `household_members (user_id)`; trigram GIN on `products` (unaccent). Add others only when `pg_stat_statements` shows a slow query.

Multi-tenancy: shared schema; enforced in the API via a `current_household()` dependency and in Postgres via Row-Level Security (`SET LOCAL app.household_id` per transaction). `products` is shared reference data with no personal information.

Audit: `inventory_events` is the audit trail; revoke UPDATE/DELETE on it from the app role. `audit_log` covers security events. Deleting a user nulls `user_id` on events; deleting a household cascades.

Notes: `scans` is optional (history is derivable from events + catalogue). Keep balances as a normal table updated transactionally, with a nightly job that recomputes from events and alerts on drift.

## 6. API design

Conventions: `/api/v1`, JSON, RFC 7807 errors, cursor pagination, mutating requests require `X-Requested-With: fsc` + JSON content type (on top of SameSite=Lax), rate limits per IP and per user.

Auth: opaque random session token in an httpOnly Secure SameSite=Lax cookie; only its hash is stored; 30-day sliding expiry; logout and "sign out everywhere" delete rows; argon2id; registration needs an invite code. `/metrics` and `/readyz` are internal-only.

```
POST /auth/register {email,password,invite_code}   POST /auth/login   POST /auth/logout
GET  /me                                            → user, households[], devices[]
GET  /products/{ean}?household=H    resolution: household override > catalogue > OFF (server fetch, cached, 1 req/s)
GET  /products?q=cola&household=H   search cached/household items only
POST /households {name}   POST /households/{h}/invites   POST /invites/accept {code}
GET  /households/{h}/members   DELETE /households/{h}/members/{user}
POST /households/{h}/sync   {device_id, cursor, events[]} → {accepted[], events[], cursor, balances_hash}
GET  /households/{h}/inventory       GET /households/{h}/inventory.txt (?format=json)
PUT  /households/{h}/overrides/{item_key} {name, category}
POST /households/{h}/import          bulk events from the old GitHub JSON (owner only)
GET  /me/export    DELETE /me
GET  /healthz /readyz /metrics (internal)
```

One `sync` endpoint: matches the existing `syncOnce` adapter shape, is a single round trip on flaky mobile networks, and is idempotent.

## 7. Offline-first strategy

Layers: (1) IndexedDB is the working copy (products, events, outbox, cursor); the UI reads and writes only there. (2) The server catalogue cache calls OFF once per EAN, caches misses ~24 h, and stops phones leaking scans to OFF. (3) The server event log is the single ordered stream (`seq`) all devices converge on.

Sync: triggers are app open, visibility change, 3 s after a local change, and a manual button (no reliable iOS background sync). Client POSTs the outbox and cursor; server inserts with `ON CONFLICT (id) DO NOTHING`, updates balances in the same transaction, and returns events with `seq > cursor`; `balances_hash` detects drift and triggers a full resync.

Conflicts:
- Stock: deltas commute, so none.
- Names: last-writer-wins on `(effective_ts, device_id)` with `effective_ts = min(client_ts, server_ts)`, so a wrong phone clock can't win forever.
- Negative counts: displayed as 0, server flags "needs check", a `correction` event fixes it.
- Removed member: pending events rejected with 403; the client keeps them locally for export.

Examples: two offline phones both take the last milk (−1 each) → balance −1, shown as 0 with a "check stock" hint, history shows both. Two renames race → the later effective timestamp wins everywhere; the other stays visible in history. A retried batch after a dropped connection changes nothing (idempotent).

Migration: `POST /import` with the private repo's `events/*.json` (ids preserved, device ids become `device_id`); add a `createApiAdapter` beside the existing GitHub and HTTP adapters, keeping GitHub as a fallback.

## 8. Learning roadmap

Effort: S ≈ a weekend, M ≈ 2–3 weekends, L ≈ a month of evenings.

| Phase | Deliverables | Learned | Effort | Risks |
|---|---|---|---|---|
| 1 MVP architecture | OCI account + VM (by hand once), Linux hardening, Tailscale SSH, domain + Cloudflare, FastAPI (register/login/sync/products), Postgres + Alembic, PWA `createApiAdapter`, import, backups | Linux admin, firewalls, DNS/TLS, Postgres, FastAPI, sessions | L | A1 capacity/account issues; scope creep; iOS standalone cookie behaviour (test early) |
| 2 Dockerization | Multi-stage non-root images, multi-arch (arm64+amd64), Compose with healthchecks and volumes, SOPS secrets, restore drill | Docker, buildx, Compose | M | ARM prod vs x86 dev (build in CI) |
| 3 CI/CD | Actions: tests, lint, Trivy, build/push GHCR, deploy; OpenTofu for VM/VCN/bucket; Dependabot | Actions, registries, IaC | M | Secrets in a public repo; IaC drift |
| 4 Observability | Prometheus, Grafana, Loki, Alloy; RED + DB + host dashboards; alerts; SLO "99% of syncs < 1 s"; external uptime; OTel traces | Metrics, logs, tracing, SLOs | M | Over-instrumenting; alert fatigue; stack using more RAM than the app |
| 5 Kubernetes | k3s on node 2, Helm chart, Traefik, cert-manager, CloudNativePG, ArgoCD, NetworkPolicies, migrate prod | K8s core, GitOps, operators | L | DB-move downtime (rehearse); YAML sprawl |

Ship to real users after Phase 2, not after Phase 5.

## 9. Kubernetes (k3s) migration

Preconditions: Compose deployment works, images are multi-arch, health endpoints exist, migrations run as a standalone command.

| Compose today | Kubernetes |
|---|---|
| api | Deployment (2 replicas, readiness `/readyz`, liveness `/healthz`, requests/limits) + Service + HPA |
| Caddy + static PWA | Traefik Ingress (bundled) + small nginx `web` Deployment; cert-manager for Let's Encrypt |
| Postgres | StatefulSet + PVC (local-path) first, then CloudNativePG (object-store backups, failover, upgrades) |
| `.env` / SOPS | Secrets (SOPS+age via ksops, or Sealed Secrets), ConfigMaps |
| Alembic on boot | Job (Helm pre-upgrade hook) |
| cron backup | CronJob + CNPG backups |
| Compose network | Namespaces + NetworkPolicies (api → db only) |
| Deploy script | ArgoCD reading a separate deploy repo |

Packaging: one Helm chart (`charts/food-scan`) with per-environment values; third-party charts for kube-prometheus-stack, Loki, Alloy; ArgoCD app-of-apps (infra + app); CI builds the image and bumps the tag in the deploy repo. Staging on the Pi, prod on the OCI nodes.

Cutover: stand up k3s in parallel on a new hostname → restore a recent backup into CNPG and test → short maintenance window (stop writes, final dump/restore, flip DNS) → keep the old stack stopped but intact for a week.

Architectural change: declarative reconciled config instead of scripts; explicit state (only DB + PVCs); scheduling, probes and PodDisruptionBudgets instead of "restart container". Single points of failure remain: one Postgres primary and the cloud account.

Teaches: Pods, Deployments, ReplicaSets, Services, Ingress, Secrets/ConfigMaps, PVs, StatefulSets, Jobs/CronJobs, probes, requests/limits, HPA, RBAC, NetworkPolicies, Helm, operators, GitOps, rolling updates and rollbacks. This app doesn't need Kubernetes; it is a learning goal, so don't justify it with scale.

## 10. Production readiness

Biggest risks: data loss (one VM, one DB; tested restores and an off-Oracle copy); Oracle termination/reclaim (portable IaC and backups); solo-maintainer burnout (each phase is an optional stopping point); iOS PWA quirks (separate Safari vs Home Screen storage, cookies, eviction; test on a real phone); OFF dependency (503s, uneven data; server caching, negative caching and overrides).

Bottlenecks in order: OFF 1 req/s (shared cache) → `inventory_events` growth (fine for years; later snapshot/partition per household) → single Postgres primary. None matter in year one.

Security: auth abuse (rate limit, lockout, rotate sessions on login); tenant isolation tests (user A can't read household B) plus RLS; GDPR (privacy policy, export/delete, minimal data, EU region); supply chain (pinned deps, Trivy, Dependabot); public repo (no secrets, SOPS, untracked `.env`).

Backups: daily encrypted dump, off-site copy, monthly restore test, age key stored off the VM; IaC + deploy repo are the infrastructure backup.

Monitoring minimum: external uptime check; alerts on backup age, disk > 80%, API 5xx rate, sync p95, certificate expiry, balance drift.

Postpone until real users: multi-region, read replicas, Redis, queues, service mesh, autoscaling beyond a demo HPA, WAL/PITR, SSO, mobile apps, admin UI (use a CLI), fine-grained roles, ML.

## Decisions

- **Build:** same-origin PWA (modularized) + FastAPI sync hub + Postgres; server holds accounts, households, event log, balances and a shared OFF cache; IndexedDB stays the working copy; Caddy + Compose first, Traefik + k3s later; one A1 VM; off-site backups.
- **First month:** VM + hardening + domain; Compose (Caddy, FastAPI, Postgres) + Alembic; register (invite-only), login, `/sync`, `/products/{ean}`, `/inventory`, `/me/export`; PWA `createApiAdapter` + one-time GitHub import; encrypted nightly backup with one restore test; uptime ping; CI tests; 2–5 real households.
- **Not yet:** Kubernetes/ArgoCD, full observability and tracing, aliases/push/LLM, expiry and shopping list, open signup, OIDC, email flows, Redis, admin UI, global names, server-side decoding.
