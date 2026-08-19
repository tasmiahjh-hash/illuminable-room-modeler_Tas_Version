# Technical Database Documentation

## Overview

This project uses a hybrid storage model:

- a local file-based graph database for local caching and local graph management
- a PostgreSQL-backed shared graph library for remote/shared graph access

The database layer is not the main path for ordinary plotting. The app can still render graphs locally even if the database is unavailable.

---

## Architecture

### 1. Frontend
The browser app is a React/Vite client in the src folder.

It talks to the backend through a small API client layer:

- [src/anglePlot/apiClientUtils.js](src/anglePlot/apiClientUtils.js)
- [src/anglePlot/remoteGraphRepository.js](src/anglePlot/remoteGraphRepository.js)

The browser does not connect to PostgreSQL directly.

### 2. Backend API
The HTTP API is implemented in:

- [server/api/app.js](server/api/app.js)
- [server/api/start.js](server/api/start.js)

It exposes routes for health checks, graph browsing, searching, downloading, and uploading.

### 3. Database Connection Layer
Database access is centralized in:

- [server/db/pool.js](server/db/pool.js)

That file creates a shared PostgreSQL connection pool and provides a single query entry point.

### 4. Repository Layer
All graph-related SQL is contained in:

- [server/repositories/graphRepository.js](server/repositories/graphRepository.js)

This repository is the only place in the project that should execute SQL for the shared graph library.

### 5. Migration System
Schema changes are managed through SQL migration files in:

- [server/db/migrations](server/db/migrations)

The migration runner in:

- [server/db/migrate.js](server/db/migrate.js)

applies pending migrations automatically when the backend starts.

---

## Database Flow

When the app needs to access the shared graph library, the flow is:

1. The frontend sends a request to the backend API.
2. The API route handles the request.
3. The route calls the repository layer.
4. The repository sends SQL through the shared database pool.
5. PostgreSQL returns the data.
6. The API returns JSON to the frontend.

This separation keeps the app modular and makes the SQL usage easier to audit.

---

## PostgreSQL Schema

### users
A minimal table for future authentication and ownership support.

### graphs
The main metadata table for the shared graph library.

It stores:
- hash
- sequence_text
- angle_a
- angle_b
- angle_step_input
- base_length
- algorithm_version
- owner_user_id
- created_at
- updated_at

### graph_geometry
Stores the exact geometry for a graph.

It contains:
- graph_id
- points as JSONB
- point_count
- status
- duration_ms

### graph_jobs
Tracks background computation attempts and their outcomes.

### Usage Tracking Columns
The graphs table also tracks:
- download_count
- last_accessed_at

These support “most downloaded” and “most recently used” sorting.

---

## Search and Browse Behavior

The repository layer supports:

- listing graphs
- searching graphs
- recent graph listings
- popular graph listings
- fetching a graph by hash
- recording usage statistics

The search logic is intentionally centralized so the same rules apply to all list/search endpoints.

---

## Environment Variables

The database system relies on the following environment variables:

- DATABASE_URL: connection string for PostgreSQL
- CORS_ORIGIN: allowed frontend origins for API access
- VITE_GRAPH_API_URL: backend API URL used by the frontend
- PORT: backend server port in deployment
- PGSSL: optional SSL setting for PostgreSQL

---

## Deployment Model

The intended deployment setup is:

- Frontend: GitHub Pages
- Backend API: Render
- Database: Supabase PostgreSQL

This is described in:

- [DEPLOYMENT.md](DEPLOYMENT.md)
- [render.yaml](render.yaml)

---

## Notes on Current Status

The current implementation is a solid foundation, but it is still partly infrastructural rather than fully “production-locked” in day-to-day use.

Important points:

- the app can function without the database
- the backend is designed to fail gracefully if the database is unavailable
- the shared library becomes useful once the backend and database are configured correctly

---

## Summary

The current database system is a hybrid, layered design:

- local storage for local use
- PostgreSQL for shared graph storage
- an API layer in front of the database
- a repository layer that centralizes all SQL

It is robust, modular, and ready for expansion, but it is not yet the sole dependency of the app’s main workflow.
