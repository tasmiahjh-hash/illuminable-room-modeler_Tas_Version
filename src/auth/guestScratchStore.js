// Guest mode's own storage: session-only, never the permanent
// browserGraphDatabaseStore.js a signed-in Research User's saves go into.
// Deliberately a *separate* module (not a flag passed into the permanent
// store) so there is no code path by which a Guest's activity can ever
// land in the same localStorage key a Research User's private library
// lives in — see the RDS plan's own "Guest = zero backend calls, using a
// new session-only store" decision.
//
// In-memory, not sessionStorage-backed: the spec's own words are "Guests
// only use temporary browser storage" and explicitly rules out permanent
// save — an in-memory store is cleared on every reload/tab-close by
// construction, with no risk of quietly becoming "permanent" the way a
// storage-backed key eventually would if a later change forgot to clear
// it. A signed-in user's stored JWT (see authClient.js) is the only auth-
// related thing this app ever writes to persistent storage.

let scratchGraphs = [];

/** Every graph plotted this Guest session — cleared on reload; never persisted. */
export const listScratchGraphs = () => scratchGraphs;

/** Adds (or replaces, by id) a graph in this Guest session's scratch list. */
export const saveScratchGraph = (graph) => {
  scratchGraphs = [...scratchGraphs.filter((g) => g.id !== graph.id), graph];
  return graph;
};

export const deleteScratchGraph = (id) => {
  scratchGraphs = scratchGraphs.filter((g) => g.id !== id);
};

/** Test/dev-only reset — not called anywhere in the app itself (a reload already clears this module's state). */
export const clearScratchGraphs = () => { scratchGraphs = []; };
