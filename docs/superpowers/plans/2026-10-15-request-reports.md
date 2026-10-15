# Admin Request Reports Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let admins generate audited request reports as CSV or PDF for Lusaka-local date presets and custom ranges.

**Architecture:** Add an admin-only reports route backed by a bounded PostgreSQL query over request, category, and decision records. Resolve date presets in Africa/Lusaka, produce the same filtered dataset for CSV/PDF, and record an audit event for each successful export. Add a mobile-first Reports page that downloads the selected format.

**Tech Stack:** Node 20, Express 5, PostgreSQL, Vue 3, Vite; PDF generation through a maintained Node PDF package.

**Spec:** `back/PLAN.md` (Reports/exports, audit and Africa/Lusaka window requirements), `front/PLAN.md` (Reports screen and exports).

## Global Constraints

- Admin only; requesters and managers cannot export this report.
- The window is `[start, end)` in Africa/Lusaka; UI dates are inclusive local calendar dates.
- Newest first by `submitted_at DESC, request_id DESC`.
- Bound CSV output to 10,000 rows and PDF output to 500 rows; return a clear error above the selected format's cap.
- Exports exclude request reasons, phone numbers, attachment contents, and secrets.
- Do not apply migrations or initiate provider/ledger operations.

## Review Focus

- Invalid and reversed custom date ranges return validation errors without querying the report; wide but valid ranges remain bounded by result caps.
- Lusaka midnight boundaries, including ranges spanning month/year changes, map to correct UTC instants.
- Unauthorized staff and manager calls receive 403 and create no export audit event.
- CSV cell values cannot inject spreadsheet formulas; test values beginning with `=`, `+`, `-`, and `@`.
- Oversized datasets fail before sending a partial file and are not reported as successful exports.

---

### Task 1: Report window and query contract

**Files:**
- Create: `back/src/reports/reportFilters.js`
- Create: `back/src/reports/reportRepository.js`
- Create: `back/src/db/migrations/0006_request_report_indexes.sql` (source only; not applied)
- Create: `back/tests/reportFilters.test.js`
- Create: `back/tests/reportRepository.test.js`

**Interfaces:**
- Produce `resolveReportWindow({ preset, from, to, now }) -> { start, end, fromDate, toDate }`, with UTC ISO instants and inclusive date labels.
- Produce `createReportRepository({ pool }).listRequestReport({ window, filters, limit }) -> { items, has_more }`; report rows include request ID, requester ID, category/subcategory names, amount, currency, status, submitted timestamp, and latest decision stage/action/actor/time.

- [x] Test preset windows, custom date validation, boundaries, and reversed dates.
- [x] Test query uses bounded limit, stable newest-first ordering, and filter parameters.
- [x] Run `cd back && npm test`.

### Task 2: Audited CSV/PDF export endpoint

**Files:**
- Create: `back/src/reports/reportRoutes.js`
- Create: `back/src/reports/reportService.js`
- Create: `back/src/reports/reportFormats.js`
- Create: `back/tests/reportRoutes.test.js`
- Create: `back/tests/reportService.test.js`
- Modify: `back/src/app.js`
- Modify: `back/package.json` and lockfile (PDFKit dependency only)

**Interfaces:**
- `createReportService({ pool, repository, clock })` exposes `exportRequests({ actor, query, requestId })`.
- `GET /api/v1/expense-warrior/admin/reports/requests?range=today|yesterday|this_month|last_month|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf` returns an attachment with server-generated content.

- [x] Test admin allow/manager and staff deny, successful audit metadata, error/cap behavior, CSV formula escaping, and PDF content type/disposition.
- [x] Generate exports only after validation and bounded query; insert audit event after successful rendering and before response. Cap PDF to 500 rows and CSV to 10,000 rows.
- [x] Run `cd back && npm test`.

### Task 3: Mobile request reports screen

**Files:**
- Modify: `front/src/api/expenseWarrior.js`
- Modify: `front/src/views/WorkspaceView.vue`
- Modify: `front/src/router.js` only if needed
- Modify: `front/src/styles.css`
- Modify: `front/PLAN.md`

**Interfaces:**
- Add `downloadRequestReport({ range, from, to, format })`; preserve API auth/session behavior and download using a Blob URL.
- Add admin Reports controls for Today, Yesterday, This month, Last month, Custom, CSV, and PDF. Display Africa/Lusaka and the selected date range.

- [x] Build the frontend and verify narrow-screen layout and both download requests against mocked API responses.
- [x] Update phase status accurately; wallet-history export remains incomplete pending ITC ledger-history API.
