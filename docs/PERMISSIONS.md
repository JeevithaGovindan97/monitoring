# Roles & permissions

Two roles. No public registration; administrators create accounts. Sessions are server-side, stored hashed, in an HttpOnly + SameSite=Strict cookie (Secure in production); state-changing requests also need the CSRF header.

| Capability | Admin | Manager |
|---|:--:|:--:|
| View overview, inventory, uptime, SSL, traffic, SEO, performance, forms, incidents, tasks, reports, system health | ✔ | ✔ |
| Check now (rate limited) | ✔ | ✔ |
| Acknowledge / investigate / assign / note / resolve / reopen incidents | ✔ | ✔ |
| Create tasks and comments | ✔ | ✔ |
| Edit tasks | any | only tasks assigned to them, unassigned, or created by them |
| Delete tasks | ✔ | – |
| Request and download reports | ✔ | ✔ |
| Add / edit / archive / delete websites, bulk actions, import | ✔ | – |
| Form-check and maintenance-window management | ✔ | – |
| Run PageSpeed audit, set baseline | ✔ | – |
| Integration settings and tests | ✔ | – |
| Users (create, change role, deactivate, reset password) | ✔ | – |
| Alert settings, SMTP test, e-mail delivery log, retention settings | ✔ | – |
| Audit logs | ✔ | – |
| Own notification preferences and password | ✔ | ✔ |

Permissions are enforced on the server for every endpoint; hiding a menu entry is only a convenience. Account lockout: 5 failed logins → 15 minutes. Passwords: Argon2id, minimum 12 characters. There is no self-service "forgot password"; an administrator resets it (or use the CLI `reset-password`).
