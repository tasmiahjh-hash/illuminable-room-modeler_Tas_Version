# Database System Report

## Executive summary

The website currently uses a hybrid storage design:

- The main plotting experience is still primarily client-side and works without a database.
- A PostgreSQL-backed “shared graph library” is implemented as a backend service for sharing exact graphs across users and sessions.
- A separate local file-based graph database also exists and is used as a permanent local cache and library.

In practical terms, the database system is present and architected well, but it is not the core runtime dependency for the app’s basic rendering flow. The PostgreSQL layer becomes active only when the backend API is running and connected to a real database.

---

## 1. What the database system is doing

The project has two storage systems that are intentionally separate:

1. Local graph database
   - Stored as files on disk.
   - Used for the app’s local render cache and local graph library features.
   - Implemented under the server/graphDatabase area.

2. Remote PostgreSQL-backed shared graph library
   - Stored in a real PostgreSQL database.
   - Used for cross-user/shared graph access.
   - Implemented through the server/api, server/db, and server/repositories layers.

The frontend does not talk to PostgreSQL directly. Instead, it calls an HTTP API that sits in front of the database.

---

## 2. Architecture overview

### Frontend
The browser app is built with React/Vite and lives primarily in the src folder.

The frontend uses a small API client layer to call the backend service:

- [src/anglePlot/apiClientUtils.js](src/anglePlot/apiClientUtils.js)
- [src/anglePlot/remoteGraphRepository.js](src/anglePlot/remoteGraphRepository.js)

This means the browser asks the backend API for graph data, and the backend handles the database access.

### Backend API
The backend API is implemented under:

- [server/api/app.js](server/api/app.js)
- [server/api/start.js](server/api/start.js)

This is the HTTP layer that exposes routes such as:

- GET /health
- GET /api/graphs
- GET /api/graphs/search
- GET /api/graphs/recent
- GET /api/graphs/:hash
- POST /api/graphs

### Database access layer
The database connection logic is centralized in:

- [server/db/pool.js](server/db/pool.js)

That file creates a shared PostgreSQL connection pool and exposes a query function. The architecture deliberately centralizes database access so that the rest of the server code does not connect to PostgreSQL directly.

### Repository layer
All SQL-based logic is intentionally kept inside:

- [server/repositories/graphRepository.js](server/repositories/graphRepository.js)

This repository is the only place in the project that should execute graph-related SQL. That design makes the schema contract easier to audit and maintain.

### Migration system
Database schema changes are applied through SQL migration files in:

- [server/db/migrations](server/db/migrations)

These are executed automatically when the backend starts, using the migration runner in:

- [server/db/migrate.js](server/db/migrate.js)

---

## 3. How the system works in practice

### Request flow
When a graph-related action needs the shared database:

1. The browser sends a request to the backend API.
2. The API route receives the request.
3. The route calls the repository layer.
4. The repository calls the shared PostgreSQL pool.
5. PostgreSQL executes the query.
6. The result is returned to the browser as JSON.

This creates a clean separation between:

- UI logic in the frontend,
- HTTP endpoints in the backend,
- database logic in the repository layer.

### Example behavior

- If the user loads a graph from the shared library, the app asks the backend for the exact geometry.
- If the user uploads a freshly computed exact graph, the backend stores it in PostgreSQL if it does not already exist.
- If the database is unavailable, the frontend is designed to fail gracefully and continue plotting locally.

---

## 4. Database schema structure

The PostgreSQL schema is defined by the migration files.

### 4.1 users
The users table provides minimal account scaffolding for future authentication.

Purpose:
- Holds a future user identity reference.
- Supports a future owner_user_id relationship for graphs.

### 4.2 graphs
The graphs table is the core shared-library metadata table.

It stores:
- hash: a permanent content-based identifier for each graph
- sequence_text
- angle_a
- angle_b
- angle_step_input
- base_length
- algorithm_version
- owner_user_id
- created_at
- updated_at

This table is the main record of each graph’s identity and parameters.

### 4.3 graph_geometry
This table stores the computed geometry points for a graph.

It includes:
- graph_id
- points (stored as JSONB)
- point_count
- status
- duration_ms
- timestamps

This is the database version of the cached exact geometry that the app may otherwise compute locally.

### 4.4 graph_jobs
This table stores a historical ledger of background computation jobs.

It tracks:
- graph_id
- status
- priority
- requested/started/finished timestamps
- error_message

It is more like an audit trail than a live scheduler.

### 4.5 Usage-tracking fields
The schema also includes usage tracking columns on graphs:

- download_count
- last_accessed_at

These support sorting by “most downloaded” and “most recently used.”

### 4.6 Search indexes
The schema adds indexes for:
- hash search
- sequence text search
- created_at ordering

This improves the performance of graph browsing and search.

---

## 5. Current behavior of the website

### What is active right now
Based on the current codebase, the database system is implemented as a real backend infrastructure layer, but it is not the default path for the application’s core rendering flow.

The current behavior is:

- The app can function without the database.
- The frontend will try to use the shared backend if it is available.
- If the backend is unavailable, the app falls back gracefully.

### What this means in practice
If your website is running locally without the backend API configured:

- the plotting UI should still work,
- the database-backed shared library feature may appear unavailable,
- the app will not crash because of a database issue.

That fallback behavior is deliberate, and it is a major design feature in this project.

---

## 6. How the app decides whether to use the database

The frontend uses the API base URL from:

- [src/anglePlot/apiClientUtils.js](src/anglePlot/apiClientUtils.js)

It prefers:

- VITE_GRAPH_API_URL if it is provided
- otherwise localhost:8787

So the app expects the backend API to be reachable at that URL.

If the API is not reachable, remote lookups and uploads are treated as unavailable and the app continues without them.

---

## 7. Environment variables that control it

The system depends on a few environment variables:

### DATABASE_URL
This is the PostgreSQL connection string.

It is used by the backend server to connect to the database.

### CORS_ORIGIN
This controls which frontend origins are allowed to call the API.

### VITE_GRAPH_API_URL
This tells the frontend where the backend API lives.

### PORT
This is used by the backend server when deployed.

### PGSSL
This can control SSL behavior for PostgreSQL connections.

---

## 8. Deployment model

The deployment setup described in the project is:

- Frontend: GitHub Pages
- Backend API: Render
- Database: Supabase PostgreSQL

This is documented in:

- [DEPLOYMENT.md](DEPLOYMENT.md)
- [render.yaml](render.yaml)

The intended production flow is:

1. The browser loads the React frontend.
2. The frontend calls the Render-hosted backend API.
3. The backend API connects to the Supabase database.
4. Stored graphs become available to other users through the shared library.

---

## 9. Strengths of the current design

This database system is well structured in several ways:

- Clear separation of concerns
- Centralized database access
- Migration-based schema evolution
- Graceful failure handling
- A deliberate fallback so plotting does not break if the database is down

These are strong engineering choices for a project that is evolving from a purely local app into a more shared, networked system.

---

## 10. Limitations and current gaps

The current implementation is still fairly early-stage in a few important ways:

- No real authentication system is implemented yet.
- The users table is scaffolding rather than a fully used account system.
- The shared graph library is optional rather than mandatory for the core app flow.
- The local file-based graph database remains a parallel storage option.
- The PostgreSQL backend is intended for future/shared usage, not for being the sole source of truth in every case.

So the current website does not yet behave like a fully mature multi-user database-driven application. It is more accurately a hybrid app with a solid database architecture foundation.


---

## 11. Bottom-line assessment

The database system on your website is currently in a “prepared and partially active” state:

- The database architecture is real and well organized.
- The backend API and PostgreSQL integration are implemented.
- The app can work without that database layer because of graceful fallback behavior.
- The shared database becomes useful once the backend service is running and connected to PostgreSQL.

If you want, the next step would be to turn this into a live, fully operational database-backed experience by:

1. starting the backend API,
2. attaching it to a real PostgreSQL database,
3. ensuring the frontend points to the correct API URL,
4. verifying the shared graph library routes end to end.

---

## 12. Short version

Right now, your website has a database system that is implemented and ready, but it is not fully “in the foreground” unless the backend API and PostgreSQL are configured and running. The app is built so that it can still function even if the database layer is unavailable.

## changing selected colour to dark yellow
