# User Manual Guide

## Welcome

This guide explains how to use the website in a simple, practical way. It covers the main things you will do in the app, including creating graphs, using the graph library, and understanding what happens when the shared database is available or unavailable.

---

## 1. Getting started

When you open the app, you will see the main plotting interface.

### What you can do first
- create or edit a graph
- view the current graph output
- use the graph library panel
- save or load previously created graphs

You do not need any special setup to begin using the app.

---

## 2. How to create and view a graph

1. Open the main editor or plotting screen.
2. Enter or adjust the graph parameters.
3. Generate or render the graph.
4. Review the plotted result on the screen.

The app will compute the graph and display it visually.

If the graph has been computed before, the app may reuse a cached version instead of recomputing it.

---

## 3. How to use the Graph Library

The Graph Library is where you can browse previously stored graphs.

### To use it
1. Open the Graph Library panel from the interface.
2. Browse the available graphs.
3. Search by keywords, hash, or related parameters if the search option is available.
4. Select a graph to load it.

### What the library can do
- show graphs that were previously saved
- help you find a graph you already used
- let you load an exact graph without recomputing it

---

## 4. What happens when a graph is loaded

When you load a graph, the app may do one of two things:

- use a local cached version if it is already available
- use the shared database version if the backend service is reachable

This means the app tries to be fast and reliable.

---

## 5. How the shared database affects your experience

The shared database is part of the app’s backend system. It helps with shared graph storage and retrieval.

### When it works well
You may notice:
- faster access to graphs that were stored previously
- better reuse of shared exact graphs
- smoother browsing of the graph library

### When it is unavailable
If the backend database is not reachable, the app will usually continue working.

You may see a message such as:
- “Couldn’t reach the shared graph library”

This does not mean the app is broken. It usually means the shared database service is temporarily unavailable.

---

## 6. What to do if the shared library is unavailable

If you see a warning about the shared graph library:

1. Keep using the app as normal.
2. Continue working with locally available graphs.
3. Try refreshing the page later if you want to reconnect to the shared library.

The app is designed to keep working even if the remote database is unavailable.

---

## 7. Tips for best results

- If you want to reuse a graph, check the Graph Library first.
- If a graph is not found there, the app may need to recompute it.
- If you are expecting a graph from another session or another user, make sure the shared backend is available.
- If the app feels slow, it may be because it is recomputing rather than loading from cache.

---

## 8. Troubleshooting

### Problem: the graph library does not load
Possible cause:
- the shared backend service is down
- the network connection is unavailable
- the app is still starting up

What to do:
- refresh the page
- check whether the app still works locally
- wait a moment and try again

### Problem: a graph is not found
Possible cause:
- it was never saved to the shared library
- it only exists in local storage
- the backend is currently unavailable

What to do:
- check the local graph cache or recent graphs
- try loading it again later

### Problem: the app seems slow
Possible cause:
- the app is recomputing a graph instead of using a cached version

What to do:
- wait for the computation to finish
- check whether the same graph is already in the library

---

## 9. Summary

To use the app effectively:

- create and view graphs normally
- use the Graph Library to find saved graphs
- understand that local and shared storage both work together
- know that the app can continue working even if the shared database is temporarily unavailable

If you follow these steps, you should be able to use the app confidently and understand what is happening behind the scenes.
