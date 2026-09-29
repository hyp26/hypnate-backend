# Admin Panel API

Backend for the Hypnate admin panel (`/api/admin/*`). All routes below require admin authentication unless marked public.

## Setup

```bash
npm run migrate          # applies prisma/migrations/20260929120000_add_admin_panel
npm run generate         # regenerates the Prisma client with admin models
npm run seed:admin       # creates/updates the SUPER_ADMIN account (ADMIN_EMAIL / ADMIN_PASSWORD)
```

## Authentication

Admin auth is fully separate from seller auth:

- Access token: 15-minute JWT (`{ sub, admin: true, role }`) delivered as an HttpOnly `adminAccessToken` cookie (also returned in the JSON body so API clients can use `Authorization: Bearer`).
- Refresh token: 48-byte random token, SHA-256 hashed in `AdminSession`, delivered as an HttpOnly `adminRefreshToken` cookie scoped to `/api/admin/auth/refresh`.
- Suspended/INACTIVE admins are rejected on every request, and suspending an account revokes its sessions.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/admin/auth/login` | public | Login `{email, password}` → admin + cookies |
| POST | `/api/admin/auth/refresh` | refresh cookie | Rotate the access token |
| POST | `/api/admin/auth/logout` | admin | Revoke session + clear cookies |
| GET | `/api/admin/auth/profile` | admin | Current admin account |
| POST | `/api/admin/auth/change-password` | admin | Change password (revokes all sessions) |

## Roles & permissions

| Permission | SUPER_ADMIN | ADMIN | SUPPORT |
|---|:-:|:-:|:-:|
| VIEW_ADMIN_USERS | ✔ | ✔ | – |
| CREATE_ADMIN | ✔ | – | – |
| CREATE_SUPPORT | ✔ | ✔ | – |
| DELETE_ADMIN | ✔ | – | – |
| DELETE_SUPPORT | ✔ | ✔ | – |
| CHANGE_ADMIN_ROLE | ✔ | (support only) | – |
| CHANGE_SUPPORT_ROLE | ✔ | ✔ | – |
| CHANGE_ADMIN_STATUS | ✔ | – | – |

Additional guardrails (enforced server-side, mirroring the frontend store):

- Nobody can manage a `SUPER_ADMIN` account (only `seed:admin` creates/updates it).
- Nobody can change or delete their own account.
- `ADMIN` can only manage `SUPPORT` accounts.
- SUPER_ADMIN-only: seller suspension, order status changes, subscription changes, ticket deletion, audit log access.

## Endpoints

All list endpoints use `?page=&limit=` (default 20, max 100) and return `{ data, page, limit, total, totalPages }`.

### Admin users (`require VIEW_ADMIN_USERS` for listing)

- `GET /api/admin/users` — list admin accounts
- `POST /api/admin/users` — `{email, firstName, lastName, role: ADMIN|SUPPORT, password}`
- `PATCH /api/admin/users/:id/role` — `{role}`
- `PATCH /api/admin/users/:id/status` — `{status: ACTIVE|INACTIVE|SUSPENDED}`
- `DELETE /api/admin/users/:id`

### Sellers

- `GET /api/admin/sellers` — `?search=&status=ACTIVE|INACTIVE|SUSPENDED|TRIALING&plan=&sort=createdAt_desc|createdAt_asc|revenue_desc`
- `GET /api/admin/sellers/:id` — detail with metrics + recent orders
- `PATCH /api/admin/sellers/:id/status` (SUPER_ADMIN/ADMIN) — `{status}`; non-ACTIVE also revokes the seller users' refresh sessions

### Customers

- `GET /api/admin/customers` — `?search=&sellerId=`

### Orders

- `GET /api/admin/orders` — `?search=&status=&paymentStatus=&sellerId=` (also returns `statusBreakdown`)
- `GET /api/admin/orders/:id`
- `PATCH /api/admin/orders/:id/status` (SUPER_ADMIN/ADMIN) — `{status}`

### Subscriptions (id = seller id)

- `GET /api/admin/subscriptions` — `?plan=&status=`
- `PATCH /api/admin/subscriptions/:id` (SUPER_ADMIN/ADMIN) — `{plan?, status?}`

### Tickets

- `GET /api/admin/tickets` — `?search=&status=&priority=&assignedToAdminId=` (also returns `statusBreakdown`)
- `GET /api/admin/tickets/:id` — accepts the ticket number (`TKT-2026-000123`) or numeric id, includes messages
- `POST /api/admin/tickets` — `{subject, description?, priority?, category?, sellerId?, customerId?, tags?}`
- `PATCH /api/admin/tickets/:id` — any of `{subject, description, status, priority, category, tags, assignedToAdminId}`
- `POST /api/admin/tickets/:id/messages` — `{body, isInternal?}`
- `DELETE /api/admin/tickets/:id` (SUPER_ADMIN/ADMIN)

SUPPORT staff may only view, message, and update tickets assigned to them; they cannot reassign or delete.

### Announcements

- `GET /api/admin/announcements` — `?status=&type=`
- `POST /api/admin/announcements` — `{title, content, type?, status?, priority?, targetAudience?, startsAt?, endsAt?}`
- `PATCH /api/admin/announcements/:id` — same fields
- `DELETE /api/admin/announcements/:id`

### FAQ

- `GET /api/admin/faq` — `?category=`
- `POST /api/admin/faq` — `{question, answer, category?, tags?, order?, isPublished?}`
- `PATCH /api/admin/faq/:id` — same fields
- `DELETE /api/admin/faq/:id`

### Content pages

- `GET /api/admin/content` — `?status=`
- `POST /api/admin/content` — `{slug, title, body, status?}`
- `PATCH /api/admin/content/:id` — same fields
- `DELETE /api/admin/content/:id`

### Audit logs (SUPER_ADMIN/ADMIN)

- `GET /api/admin/audit-logs` — `?action=&adminUserId=&entityType=&search=`

Every privileged mutation (and login/logout) writes an immutable `AuditLog` entry with old/new values and the request IP/user agent.

### Settings & feature flags

- `GET /api/admin/settings` — general settings + feature flags
- `PUT /api/admin/settings` — partial `{siteName?, siteDescription?, logoUrl?, faviconUrl?, defaultCurrency?, defaultTimezone?, supportEmail?}`
- `GET /api/admin/feature-flags`
- `PUT /api/admin/feature-flags` — partial `{maintenanceMode?, newUserRegistration?, emailNotifications?, analyticsDashboard?, subscriptionUpgrades?}`

Stored in the `AdminSetting` key/value table and merged over defaults.

### Stats & analytics

- `GET /api/admin/stats` — dashboard totals matching the frontend `Stats` shape
- `GET /api/admin/stats/charts?days=30` — daily revenue/orders as `ChartData`
- `GET /api/admin/analytics` — 12-month growth series, plan distribution, order/ticket status breakdowns

## New database models

`AdminUser`, `AdminSession`, `SupportTicket`, `TicketMessage`, `Announcement`, `FAQItem`, `ContentPage`, `AuditLog`, `AdminSetting` — plus a `status` column on `Seller` for platform-level suspension.

## Frontend wiring notes

The current admin frontend (`hypnateui/src/admin`) authenticates against a localStorage store with a hardcoded super admin. To switch it to this backend:

1. Replace `useAdminStore.login` with `POST /api/admin/auth/login` (cookies are set by the backend; also store the returned `admin` object).
2. Point `hasPermission` at the same permission matrix (or expose `GET /api/admin/auth/profile` + embed permissions server-side).
3. Load AdminUsers, Settings, and Feature Flags pages from their endpoints instead of the persisted store.
4. Call `POST /api/admin/auth/refresh` when receiving `401` from admin endpoints (same pattern as the seller app).
