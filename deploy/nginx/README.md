# Staging Nginx route

`expense-warrior-api-location.conf` is a location snippet, not a complete virtual host. Include it inside the existing TLS `server` block for `node.itcontents.com`; retain that host's existing certificates, TLS settings, and other locations. Do not replace the ITC `/api/v1/auth` routes.

The Expense Warrior API must be running on the same host and listening only on `127.0.0.1:3100`. Keep port 3100 blocked from public ingress. The snippet forwards `/api/v1/expense-warrior/...` unchanged, allows the existing 5 MiB evidence upload plus multipart overhead, and gives long provider-status requests up to 190 seconds.

After installing the snippet, run `nginx -t` and reload Nginx using the server's normal deployment procedure. Verify the API directly on the host at `http://127.0.0.1:3100/api/v1/health`, then verify the routed public endpoint. The public `/api/v1/health` remains owned by the existing ITC route; it does not verify the standalone Expense Warrior API.

The staging frontend uses `front/.env.staging` via `npm run build:staging`. It calls ITC at `https://node.itcontents.com/api/v1` and the Expense Warrior API at `https://node.itcontents.com/api/v1/expense-warrior`. Set `EXPENSE_WARRIOR_BROWSER_ORIGINS` on the Expense Warrior API to the exact HTTPS origin that serves the frontend, and allow that origin in ITC's session CORS configuration. The frontend host is not configured in this repository, so do not guess that origin.
