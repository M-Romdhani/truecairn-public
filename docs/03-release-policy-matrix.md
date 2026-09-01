# 03 — Release Policy Matrix

Which vault categories release to which contact types at which stage.

## The matrix

| Vault category | Spouse / family executor | Cofounder / business partner | Lawyer / accountant | Recovery contact | Designated heir |
|---|---|---|---|---|---|
| Recovery instructions | S1 | S1 | — | S1 | S1 |
| Operational playbooks | — | S1 | — | — | — |
| Asset inventory | S1 | S1 | S2 | — | S2 |
| Identity documents | S2 | — | S2 | — | S2 |
| Financial accounts | S2 | — | S2 | — | S2 |
| Legal documents | S2 | — | S1 | — | S2 |
| Crypto wallets | S3 | — | — | — | S3 |
| Personal archive | S3 | — | — | — | S3 |

Legend:
- **S1** — Limited release, immediately after RELEASE_REVIEW passes
- **S2** — Staged unlock, 7 days after S1
- **S3** — Full release, 14 days after S2
- **—** — Never released to this contact type, regardless of stage

## Principles encoded in this matrix

**Recovery first.** The first thing released to anyone is recovery instructions. They are the safest to leak (no immediate financial damage) and the most valuable (without them, nothing else helps). They go to almost everyone, at S1.

**Need-to-know by role.** The cofounder sees business, not personal. The lawyer sees legal/financial, not the personal archive. The spouse sees family/personal, not necessarily business infrastructure. Each contact gets only what their role requires.

**Sensitive categories last.** Crypto seed phrases and the personal archive are S3 — only after full cooldown ladder completes. Crypto because leaked seeds are permanent and catastrophic. Personal archive because intimate content shouldn't be rushed.

**Two categories never release to most contacts.** The cofounder doesn't get identity docs. The recovery contact doesn't get finances. Least-privilege principle.

## Contact types — definitions

### Spouse / family executor
The user's life partner or designated next-of-kin. Receives full personal access at S2-S3 and recovery instructions at S1. Highest emotional trust, also the most common source of relationship-breakdown attacks.

### Cofounder / business partner
Professional partner with operational dependency on the user's work. Receives business assets at S1, nothing personal. Lower personal trust, narrower scope.

### Lawyer / accountant
Professional fiduciary with formal duties of care. Receives legal and financial materials at S1-S2, no personal content. Trust is institutional rather than relational.

### Recovery contact (limited)
A designated person who can help the user recover from temporary lockouts but does not have continuity authority. Receives only recovery instructions at S1. Acts as a safety net against false negatives.

### Designated heir
The legal inheritor of the user's estate, who may or may not be the spouse. Receives the broadest access at S2-S3 for inheritance purposes. Often the same person as Spouse — kept as a separate column because they may differ legally and for non-traditional family structures.

## Things deliberately missing

- **No "Memories" row.** Folded into Personal Archive.
- **No Manual Trigger column.** When the user themselves initiates release ("I'm dying, release now"), they can choose to release anything to anyone immediately. The matrix doesn't apply.
- **No per-item override.** V1 is per-category. V2 may add "release banking but not crypto inside Financial."

## Cooldown timing

The 7-day S1→S2 and 14-day S2→S3 spacing are defaults. They feel right for "long enough to cancel if wrongful, short enough to be useful in real emergencies." Users can override per plan with floors (you cannot set S2 to "5 minutes after S1" — that defeats the staging).

Minimum S1→S2 floor: 3 days.
Minimum S2→S3 floor: 7 days.

## Open questions

These need decisions before launch:

1. Does the cofounder ever need identity docs to dissolve the company or handle tax filings? Maybe S3?
2. Should the lawyer get any personal archive access for estate purposes? Current answer: no, they get the will, which references the archive.
3. Is "Designated Heir" truly separate from Spouse, or just a permission flag? Current answer: separate column, often the same person in practice.
