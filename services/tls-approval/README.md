# TLS approval

Every syntactically valid domain is approved without enrollment, an allowlist,
a suffix blocklist, cooldowns, or approval budgets. The service listens only on
`127.0.0.1:3001`; Caddy uses `ask http://127.0.0.1:3001/` for on-demand TLS.
Caddy and the certificate authority still handle domain validation, certificate
issuance, retries, and their own limits. Approval does not guarantee issuance.

`GET /?domain=example.com` returns 200. `server_name` is also accepted, and
uppercase names are normalized. Missing or malformed domains return 400;
IP addresses, wildcards, single-label names, and trailing dots are rejected.
Use ASCII punycode for international names. Non-GET requests return 405 and
unknown routes return 404. `/health` and `/ready` return `oki` without reading
any policy or ledger files.

`TLS_POLICY_PATH` and `TLS_APPROVAL_STATE_PATH` are no longer used. Existing
policy and ledger files can be left in place; they have no effect. Preserve
Caddy's certificate storage when deploying, then restart `tls-approval`.

`/metrics` requires a bearer credential matching `TLS_METRICS_TOKEN` (at least
32 characters); without one it returns 403. It contains only process start
time and aggregate approved/invalid-domain counts, with no domain names or
request details. Scrape it directly over loopback.
