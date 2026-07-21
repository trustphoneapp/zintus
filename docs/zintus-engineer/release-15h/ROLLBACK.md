# Rollback and preservation plan

1. Never test destructive migrations against the installed Engineer database.
2. Create a consistent disposable database image and a separate artifact root.
3. Record source schema version, migration rows, table counts, integrity results, and selected hash-only evidence.
4. Run migration and gateway construction only on the disposable image.
5. Compare pre/post counts, migration ancestry, foreign keys, integrity, and immutable hashes.
6. If any check fails, discard the copy and leave the installed database untouched.
7. Preserve the last verified candidate checkpoint when execution, review, hardening, or publication fails.
8. Publication ambiguity is reconciled through read-only provider discovery; it is never blind-retried.

Source rollback uses Git history. No duplicate production source tree is maintained in this release folder.
