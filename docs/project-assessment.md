# Local project assessment

Vibe provides inspect_project and three original built-in skills: project-assessment, dependency-evidence and electron-security-review. These are selected by role and task topic. Reports separate static candidates from executed verification and stay UNVERIFIED until checked.

Inspection reads local bounded files, records SHA-256 fingerprints, inventories Node dependencies and lockfile integrity, identifies install-time hooks and literal Electron isolation candidates. It does not run downloaded scripts or install packages. It ignores generated/sensitive paths, rejects out-of-workspace symlinks, bounds traversal and reports truncation. CVE checks still require the project-native audit.

Research reference: https://github.com/ptn1411/skill/tree/ce2b65ec8eab91e96d21a70aab62d78ca760cc82
Reviewed: README, orchestration data model, SDK contract workflow, supply-chain guidance and Electron analyzer instructions. The source repository lacked a distribution license at that commit and some skill descriptions claimed unlimited authority. No upstream code, scripts or skill text is redistributed. Vibe uses its own implementation and existing tool permissions.
