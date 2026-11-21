# Storage, sync & inventory

## Architecture
- **Public GitHub Pages = code only.** The app never ships household data.
- **Data** lives in IndexedDB (`be-food-scan` v2) on each phone and is synced via an adapter:
  - now: private repo `VLjoris/food-scan-data`, written through the GitHub Contents API with a fine-grained PAT;
  - later: a self-hosted zero-dependency Node server behind `tailscale serve` (HTTPS, needed for the camera). It uses the HTTP adapter: `GET /api/events`, `PUT /api/events/:deviceId`, `PUT /api/feed`.
- IDB stores: `products` (OFF cache by EAN, not synced), `events` (synced), `meta` (`deviceId`, `seq`, sync config).

## Why an event log
Two phones doing +1 offline would clobber each other with "store the current list". Instead every change is an immutable event. Each device writes only its own file `events/<deviceId>.json`, so there are no write conflicts. State = reduce(union of all events, deduplicated by `id`): order-independent, offline-safe, trivially mergeable. A 409/422 sha conflict is refetched and retried once.

## Event shapes
```json
{ "id": "<deviceId>:<seq>", "t": 1720000000000, "dev": "<deviceId>", "type": "stock", "item": "5449000133335", "delta": 1 }
{ "id": "...", "t": 0, "dev": "...", "type": "name", "item": "5449000133335", "name": "Cola Zero 1,5L", "category": "drinks" }
```
- `item` is the EAN, or `x:<slug(name)>` for non-barcode items (defined by a `name` event).
- **Name priority:** override (`name` event) > product cache (OFF/manual) > EAN. Overrides are last-writer-wins by `(t, dev)`; an empty name clears the override. Category: override > coarse OFF category > "other".
- **Stock** = sum of deltas, shown as `max(0, sum)`; the UI blocks −1 at 0. "Remove all" = delta −count.

## Backup v2
`{ "version": 2, "products": [...], "events": [...] }`. Restore still accepts the old v1 array. Old manual product names are migrated to `name` events once.

## Inventory feed
After a successful push the app best-effort writes `feed/inventory.json` (derived snapshot of the stock list) to the data repo, for use by scripts or an LLM. The Stock tab can also copy/share a menu-ideas prompt and copy/download the same JSON.

## Create the access token (GitHub PAT)
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. **Expiration:** set one (e.g. 90 days to 1 year) and note the renewal date.
3. **Repository access:** *Only select repositories* → `VLjoris/food-scan-data`.
4. **Permissions → Repository → Contents: Read and write.** Nothing else.
5. Generate, copy the token.
6. On each phone: open the app → **History → Sync settings**, enter owner `VLjoris`, repo `food-scan-data` and the token, then **Sync now**.

iOS Safari and the Home Screen app have **separate storage**: enter the token (and expect separate data) in the one you actually use, normally the installed Home Screen app.

## Privacy
- The token is stored in IndexedDB on the device only; keep it scoped to the single data repo. All rendering uses `textContent`, so there is no XSS path to it.
- The data repo is private. Household data must not go into the public Pages repo: anyone can read it, including history.
- The self-hosted server (later) keeps data fully on your own hardware.

## Limits / later
- Event-log compaction (snapshot + truncate) once files reach ~1 MB.
- Expiry dates and locations, LLM API call, grouping OFF names across sizes.
- Self-hosted `server/` over Tailscale, optionally serving the app too.
