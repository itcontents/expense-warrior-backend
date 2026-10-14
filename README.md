# Expense Warrior Backend

This folder is the independently deployable Expense Warrior API and database service. It owns petty-cash workflows and payment-link state in its own PostgreSQL database. It must not connect directly to ITC's database. ITC integration uses authenticated, versioned APIs for identity and finance/ledger operations.

## Current state and Phase 1

The folder now contains a standalone Express API foundation with health/readiness routes, dedicated PostgreSQL configuration, a guarded explicit migration runner, and an ITC session client/middleware module. Request/category/approval routes and the ITC finance service contract are still in progress. The local `.env` and PawaPay signing keys are private and ignored by Git. No Expense Warrior or ITC database migration has been applied and no provider call has been made.

ITC's existing finance routes use user JWT authentication; no reviewed inbound Expense Warrior finance service contract exists yet. ITC's PawaPay client has request-signing and callback-verification behavior but no wallet-balance operation. ITC's Cloudinary image asset module returns shared asset URLs and is not the private evidence service. See the architecture spec and integration contract requirements before implementing those later phases.

See [PLAN.md](PLAN.md) for boundaries, data model, provider contract, security, and delivery phases. See the [Phase 1 implementation plan](../docs/superpowers/plans/2026-10-15-expense-warrior-phase-1.md) for the build sequence. The API listens on port `3100`. Startup requires configured dedicated database credentials; `/api/v1/ready` reports `503` if the configured database cannot be reached.

# expense-warrior-backend
