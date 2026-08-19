# User Guide: How the Database Works

## What this means for you

The website uses a database system to help save and share graphs more reliably. You do not need to manage the database yourself, but it is helpful to understand what happens behind the scenes.

## In simple terms

There are two main ways the app stores graphs:

1. Locally on your machine
   - This is used for quick access and caching.
   - It helps the app work even when the network or remote database is unavailable.

2. In a shared online database
   - This is used for the shared graph library.
   - It allows graphs to be stored centrally so they can be reused across sessions or users.

## What happens when you use the app

When you create or load a graph:

- the app may try to use the shared database if it is available,
- otherwise it continues using local data and keeps working.

That means the app is designed to be resilient. If the shared database is down, the site should still keep functioning.

## What the shared database is used for

The shared database helps with features such as:

- storing exact graphs once they are computed
- allowing the app to retrieve previously stored graphs
- browsing and searching the graph library
- tracking popular or recently used graphs

## What you will notice as a user

You may notice the following:

- some graphs load from the shared library when available
- some graphs remain local-only if the shared service is unavailable
- the app may show a message like “couldn’t reach the shared graph library” if the backend is not available

That is expected behavior in the current setup.

## Do you need to do anything?

Usually, no. The app is designed so that you can use it without manually setting up the database.

If you are using a deployed version of the site, the database connection is handled by the server and deployment environment.

## Important note

The database is currently part of the app’s infrastructure rather than the main visible feature for everyday plotting. The project is built so that the app still works even if the shared database is not available at the moment.

## Summary

In short:

- the app stores graphs locally and remotely,
- the shared database supports the shared graph library,
- and the app is designed to keep working even if the shared database is temporarily unavailable.
