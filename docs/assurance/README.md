# Assurance

Dated, scoped reviews that reach a **verdict** on one capability: security, dependency trust,
exposed surface. An Assurance record answers "is this safe to ship, and what did we accept?"

Distinct from [Audit](../audits/README.md), which sweeps the whole repo for a class of defect and
reports findings. An Audit asks *what is wrong here*; an Assurance record asks *does this pass*, and
must say what it accepted when the answer is a qualified yes.

- **Authoring bar:** the scope reviewed (named exactly, not "the code"), the methods applied, a
  verdict, and — when the verdict is anything but a clean pass — the residual risks accepted and by
  whom. A review that records no accepted risk either found none or did not look.
- **Written by:** human, or an agent pass whose verdict a human adopts. The verdict is the human's;
  the evidence may be gathered.
- **Provenance:** every record carries `**Date:**` and `**Scope:**`, and states the version of what
  it reviewed (a lockfile digest, a pinned dependency set, a commit). A verdict without a scope is
  not re-checkable, and a verdict that cannot be re-checked cannot be renewed.
- **Retention:** exempt — append-only. A superseded review is kept: what was accepted, and when,
  is the record. A new review is a new file, never an edit to an old verdict.

**Renewal:** an Assurance record goes stale when what it reviewed changes — a dependency or lock
change renews dependency, threat, and trust-boundary review. Renewal means a new dated record,
not a rewrite.

## Index

No Assurance verdict has been committed yet. Proxy-auth behavior is tested and documented, but
that evidence is not represented as a human-adopted shipping verdict.
