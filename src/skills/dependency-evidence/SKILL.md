---
name: Dependency evidence
description: Inspect dependencies, lockfiles, install hooks and remediation evidence.
---

Use inspect_project to inventory dependencies and candidate integrity gaps. Inspect package.json, the lockfile and the exact audit advisory. Run the project-native audit through allowed tools; never equate inventory with CVE coverage. Distinguish runtime/dev impact but keep unresolved real findings visible. Coder may update assigned manifests deliberately without weakening tests; avoid blind force fixes. Rerun native tests and audit independently after remediation. Record actual command, workspace, exit code and residual findings with write_report.
