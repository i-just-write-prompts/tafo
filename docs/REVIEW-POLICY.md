# Review policy

Review is sized by how hard a change is to undo.

## Light

A light change is copy, spacing, docs, and tests only.

- Preview once CI is green.
- A quick Verifier spot check.

## Full

A full change touches data, sync, auth, secrets, or migrations.

- Full Verifier.
- Design Critic when the change has UI.
- PR Czar.

A light pull request that grows into any full-tier area becomes full.

The secret-scan job must be green on every pull request. The log scan that follows CI and the Fly review app must be green when it runs.

## Stop rule

If the same failure shows up twice, stop. Report what was tried and what was seen. Do not retry a third time.
