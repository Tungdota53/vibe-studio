---
name: Electron security review
description: Review Electron renderer isolation, preload bridges and IPC boundaries.
---

Use inspect_project to locate literal Electron configuration candidates, then read their full surrounding source; comments and examples are not findings. Inspect BrowserWindow isolation, sandbox and Node integration; preload exposure, IPC sender validation, navigation and external URL handling. Trace actual data flow before claiming a vulnerability. Preserve source permissions and redaction. Ask tester to verify runtime behavior when available, and record gaps as UNVERIFIED. Write evidence with file/line/hash, expected behavior, executed checks, findings and remediation using write_report.
