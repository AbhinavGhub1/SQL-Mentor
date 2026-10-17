# SQL Mentor backend starter

This starter connects the existing SQL Mentor page to Express and MySQL. It saves attempts in a shared application database and creates one separate MySQL database per student name. The student's own tables and inserted values live in that separate database and survive browser/device shutdowns as long as the hosted database keeps its persistent storage.

## Important limitation: name-only is not authentication

This version treats a normalized name as the profile key. Names must be unique. Anyone who enters the same name can access that profile and its database. Use only for a non-sensitive college demo. Before public/real student use, add real authentication (recommended: college email + password or an authentication provider) and authorization on every endpoint.

## Prerequisites

- Node.js 20 or newer
- MySQL 8.x, local or managed online
- A MySQL account that can create databases and tables. For a public deployment, use a dedicated database service/account and review permissions carefully.

## Run locally

1. Install Node.js and MySQL.
2. Create the shared application database, for example:

   ```sql
   CREATE DATABASE sql_mentor_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. Create a dedicated app user and grant it the permissions required by this prototype. Example for a local-only development instance (adapt host/password to your environment):

   ```sql
   CREATE USER 'sqlmentor_app'@'localhost' IDENTIFIED BY 'replace_with_a_long_password';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EXECUTE ON *.* TO 'sqlmentor_app'@'localhost';
   GRANT ALL PRIVILEGES ON sql_mentor_app.* TO 'sqlmentor_app'@'localhost';
   FLUSH PRIVILEGES;
   ```

   **Do not copy broad global privileges to a public production deployment without a security review.** This prototype creates student databases dynamically, so its administrative database account is more powerful than a normal web app account.

4. Copy `.env.example` to `.env` and fill in the real database connection values.
5. In this folder run:

   ```bash
   npm install
   npm run check
   npm start
   ```

6. Open `http://localhost:3000`. The frontend is served by Express, so it uses same-origin `/api/...` requests.

## API routes

- `GET /api/health` — health check
- `POST /api/session` with `{ "name": "Anjali" }` — find/create profile and student database
- `GET /api/progress/:studentId` — attempts, topic totals, recent activity
- `GET /api/tables/:studentId` — live table/column definitions for that student's database
- `POST /api/query` with `{ "studentId": "...", "sql": "SELECT ...", "topic": "SELECT", "question": "..." }` — execute a statement in that student's database and save the attempt

## Hosting online

Deploy this Node project to a Node-capable host and use a managed MySQL database. Configure the environment variables in the host's secret/environment settings; never upload `.env`. Set the host's build/start command to `npm install` / `npm start`. Configure MySQL network access so only the backend can connect, enable TLS where required, enable automated backups, and use persistent storage. The frontend is served by Express in this setup, so you do not need a separate static site host.

## Security status

This is a teaching prototype, not a hardened public SQL execution service. The backend restricts statement families, disables multi-statements, applies a timeout, and caps SELECT result rows, but regular expressions are not a complete SQL sandbox. Do not put this on a public URL for untrusted users with an administrator MySQL account. For a real public service, add proper authentication, rate limits, audit logging, stronger SQL parsing and authorization, and preferably isolated database credentials/containers per student. Avoid allowing dangerous SQL functions and system-schema access; test security before deployment.
