# Parent-release database fixture

`rollinggo-parent-v22.json` is a reusable **synthetic** SQLite database, gzip encoded to keep it portable. It was created by running `JobStore` and `TaskService` from the actual pre-RollingGo parent revision `e6ce615ecf84a587ffc493813645bcfa772f6e9f` in an isolated checkout with its existing dependencies.

The generator initialized a new temporary database and submitted one local-development task (`Prepare a synthetic task brief`, request ID `rollinggo-v22-fixture`) through the default catalog with RollingGo absent. It then closed the store and encoded the database. The fixture contains the parent's original release history, active v22 metadata and a task pinned to that release. It contains no real account, credential, provider call or production data.

The upgrade regression restores this database into a fresh temporary directory and opens it using the current implementation. It verifies the original active release, task pin and request object. Do not regenerate it with the current kernel, repair its old release fingerprints, or substitute a newly initialized database: those would hide the upgrade regression.
