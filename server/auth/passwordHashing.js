// Thin wrapper over bcryptjs — the only module allowed to call it directly,
// so a future change of hashing algorithm/cost factor touches one file.
// bcryptjs (pure JS) rather than bcrypt/argon2 specifically to avoid a
// native-module build step (node-gyp) on Windows dev machines and Render's
// build environment — see the RDS plan's own architecture-decision note.

import bcrypt from 'bcryptjs';

// Cost factor: higher is slower (more resistant to brute-force) and slower
// per login. 12 is bcrypt's own commonly-recommended default for a
// service this size — not a high-throughput auth provider, so correctness
// and resistance to offline cracking matter more than shaving milliseconds
// off each login.
const SALT_ROUNDS = 12;

/** Hashes a plaintext password for storage. Never store the plaintext itself, anywhere. */
export const hashPassword = async (plainPassword) => bcrypt.hash(plainPassword, SALT_ROUNDS);

/** Checks a plaintext password against a previously-hashed one. */
export const verifyPassword = async (plainPassword, passwordHash) => bcrypt.compare(plainPassword, passwordHash);
