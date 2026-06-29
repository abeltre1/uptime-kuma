# Uptime Kuma Helm chart

A Helm chart to deploy [Uptime Kuma](https://github.com/louislam/uptime-kuma) on
Kubernetes, with **optional automated monitor seeding** so you can add the things
you want to monitor without clicking through the dashboard.

> [!IMPORTANT]
> This chart is **deployment tooling for your own use**. The upstream Uptime Kuma
> project deliberately keeps Helm out of its main repo and points users to a
> community chart (`dirsigler/uptime-kuma-helm`). It also has a strict anti-"AI
> slop" policy (see `CLAUDE.md` in this repo). **Do not open a pull request that
> adds this chart to `louislam/uptime-kuma`** — it would be both unwanted and a
> ban risk. Keep it in your fork / a private chart repo.

Tested against Uptime Kuma **2.4.0** (`appVersion`).

## TL;DR

```bash
# from the repo root
helm upgrade --install kuma ./helm/uptime-kuma \
  --namespace monitoring --create-namespace \
  --set seed.adminPassword='SomethingStrong!23'

# watch the seeder create your monitors
kubectl -n monitoring logs job/kuma-uptime-kuma-seed -f

# open the UI
kubectl -n monitoring port-forward svc/kuma-uptime-kuma 3001:3001
# http://localhost:3001  (log in with seed.adminUsername / seed.adminPassword)
```

## What gets created

| Resource | Purpose |
| --- | --- |
| Deployment (1 replica, `Recreate`) | Runs the Uptime Kuma container on port 3001 |
| Service (ClusterIP) | Exposes the app on `service.port` (3001) |
| PersistentVolumeClaim | `/app/data` (SQLite DB, uploads, TLS certs) |
| Ingress *(optional)* | External access (WebSocket-friendly) |
| Route *(optional)* | External access on OpenShift (`route.openshift.io/v1`) |
| ConfigMap + Secret *(seeding)* | The monitor list + admin credentials |
| Job *(seeding, Helm hook)* | Creates the admin user + monitors via the API |

## Why a single replica?

Uptime Kuma is single-instance. With SQLite the DB file can't be shared; with an
external DB, every replica would still run **all** monitors, causing duplicate
checks and duplicate notifications. Scale up only if you really know you want that.

## Database

- **SQLite (default).** Stored on the PVC. The chart sets `UPTIME_KUMA_DB_TYPE=sqlite`,
  which also **skips the interactive first-run database wizard** so the pod boots
  headlessly (and the seed Job can reach it).
- **External MariaDB/MySQL.** Set `externalDatabase.enabled=true` and the
  connection fields. Supply the password inline or via `externalDatabase.existingSecret`.

```yaml
externalDatabase:
  enabled: true
  host: mariadb.db.svc.cluster.local
  database: kuma
  username: kuma
  existingSecret: kuma-db
  existingSecretPasswordKey: password
```

## Automated monitor seeding (the "no dashboard" part)

Uptime Kuma has **no REST API and no config-as-code**, and the JSON backup-import
was removed in 2.x. The supported way to script it is its **Socket.io API**. This
chart ships a tiny seeder that runs as a Kubernetes Job using the *same image*
(so the bundled, version-matched `socket.io-client` is reused — no extra
dependencies, no version-mismatch risk). On `helm install`/`helm upgrade` it:

1. creates the first **admin user** if the instance is brand new,
2. logs in,
3. creates every monitor in `seed.monitors` that doesn't already exist
   (idempotent — matched by `name`).

List monitors in `values.yaml`; fields mirror the dashboard's *Add Monitor* form,
and only `type` + `name` are required:

```yaml
seed:
  enabled: true
  adminUsername: admin
  existingAdminSecret: kuma-admin   # recommended (keys: username, password)
  monitors:
    - name: "Public site"
      type: http
      url: https://example.com
      interval: 60
    - name: "Internal API"
      type: http
      url: http://my-api.default.svc.cluster.local:8080/health
      accepted_statuscodes: ["200-299"]
      interval: 30
      maxretries: 2
    - name: "Redis"
      type: port
      hostname: redis.default.svc.cluster.local
      port: 6379
```

Common monitor `type`s: `http`, `port` (TCP), `ping`, `dns`, `keyword`,
`json-query`, `grpc-keyword`, `docker`, `push`. For type-specific fields, add the
same field name the *Add Monitor* form uses (e.g. `keyword`, `hostname`, `port`,
`dns_resolve_type`).

> "Models to monitor": if you mean LLM/API endpoints, monitor them as `http`
> monitors against their health/inference URL (optionally `keyword` or
> `json-query` to assert on the response body). It's the same mechanism.

### Seeding caveats

- `seed.adminPassword` must not be "Too weak" (needs upper/lower/number/symbol).
- If the instance already exists, `adminPassword` must match the real password.
- The admin account must **not** have 2FA enabled (the Job logs in headlessly).
- Re-running `helm upgrade` only **adds** new monitors; it does not update or
  delete existing ones (idempotent by name).
- Disable it entirely with `seed.enabled=false` and configure via the UI.

## Exposing the service

Pick whichever fits your platform (both are off by default):

- **Ingress** (plain Kubernetes) — `ingress.enabled=true`.
- **OpenShift Route** (`route.openshift.io/v1`) — `route.enabled=true`. The
  HAProxy router passes WebSocket upgrades for edge/passthrough routes, so live
  updates work.

```yaml
route:
  enabled: true
  # host: uptime-kuma.apps.my-cluster.example.com   # omit to let OpenShift assign one
  tls:
    enabled: true
    termination: edge                 # edge | passthrough | reencrypt
    insecureEdgeTerminationPolicy: Redirect
```

```bash
oc get route kuma-uptime-kuma -o jsonpath='{.spec.host}{"\n"}'
```

### WebSockets

Uptime Kuma uses WebSockets for live updates. ingress-nginx, Traefik, and the
OpenShift router pass the `Upgrade` header by default. For long-lived connections
you may want longer proxy timeouts (see commented annotations in `values.yaml`).

## Validate locally

```bash
helm lint ./helm/uptime-kuma
helm template kuma ./helm/uptime-kuma | less          # SQLite + seeding
helm template kuma ./helm/uptime-kuma --set seed.enabled=false
helm template kuma ./helm/uptime-kuma --set externalDatabase.enabled=true
```

## Uninstall

```bash
helm uninstall kuma -n monitoring
# the PVC (your data) is retained by design; delete it manually if you want:
# kubectl -n monitoring delete pvc kuma-uptime-kuma
```
