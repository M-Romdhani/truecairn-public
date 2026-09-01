// Argon2id out-of-memory detection, shared by every screen that derives the
// master key from the passphrase (enrollment and unlock).
//
// The KDF runs at the production memlimit — a single ~256 MiB WASM heap
// allocation — and it is the one step of those flows that can fail LOCALLY,
// without the network and without the passphrase being wrong: a low-memory
// device, a sandboxed or memory-capped browser tab, or a second tab that already
// holds a heap of its own will simply refuse to grow the heap.
//
// This lives here rather than beside either caller because getting it wrong is
// asymmetric. On /onboarding an unrecognised allocation failure is a confusing
// retry message; on /unlock it is the screen telling a user with the CORRECT
// passphrase that their passphrase is wrong — the worst false alarm a vault can
// raise, and the one that makes someone believe they have lost everything. One
// copy means the next screen that derives a key cannot quietly ship without it.
//
// Emscripten/libsodium surface heap-growth failures either as a RangeError (the
// WebAssembly.Memory.grow path) or as a plain Error whose message names the
// allocation ("Cannot enlarge memory arrays", "out of memory", "allocation
// failed"), so match both shapes.
export function isMemoryFailure(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /memory|allocat|enlarge|\boom\b/i.test(msg);
}
